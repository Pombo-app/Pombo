// sw.js - Service Worker for Push Notifications with Client Verification
// ================================================
// This file MUST be at the root of the site
// to have scope over all pages.
// ================================================

const SW_VERSION = '2.5.0';

// ================================================
// INDEXEDDB CONFIGURATION
// ================================================

const DB_NAME = 'pombo-sw';
const DB_VERSION = 3;
const STORES = {
    CHANNELS: 'channels',
    LAST_SEEN: 'lastSeen',
    CONFIG: 'config',
    DM_PEERS: 'dmPeers'
};

let db = null;

// Used only until a channel's registration carries the providers resolved on
// chain, so an install upgraded mid-flight keeps notifying until the next sync.
const LEGACY_STORAGE_ENDPOINTS = [
    'https://blob-storage-streamr.online',
    'https://vps2.blob-storage-streamr.online',
];

const API_PATH = '/streams/{streamId}/data/partitions/{partition}/last?count=1';

// A page has to sign for us, so it must answer while the push event is alive.
const SIGNATURE_TIMEOUT_MS = 3000;

// ================================================
// INDEXEDDB FUNCTIONS
// ================================================

async function openDatabase() {
    if (db) return db;
    
    return new Promise((resolve, reject) => {
        const request = indexedDB.open(DB_NAME, DB_VERSION);
        
        request.onerror = () => {
            console.error('[SW] IndexedDB error:', request.error);
            reject(request.error);
        };
        
        request.onsuccess = () => {
            db = request.result;
            console.log('[SW] IndexedDB opened');
            resolve(db);
        };
        
        request.onupgradeneeded = (event) => {
            const database = event.target.result;
            
            // Channels store with index on tag. The index is NOT unique: a tag
            // is one byte, so two of this user's own channels collide often
            // enough to matter, and a unique index made the whole sync fail.
            if (!database.objectStoreNames.contains(STORES.CHANNELS)) {
                const channelsStore = database.createObjectStore(STORES.CHANNELS, { keyPath: 'streamId' });
                channelsStore.createIndex('tag', 'tag', { unique: false });
                console.log('[SW] Created channels store with tag index');
            } else {
                const channelsStore = event.target.transaction.objectStore(STORES.CHANNELS);
                if (channelsStore.indexNames.contains('tag')) {
                    channelsStore.deleteIndex('tag');
                }
                channelsStore.createIndex('tag', 'tag', { unique: false });
                console.log('[SW] Tag index rebuilt as non-unique');
            }
            
            // LastSeen store
            if (!database.objectStoreNames.contains(STORES.LAST_SEEN)) {
                database.createObjectStore(STORES.LAST_SEEN, { keyPath: 'streamId' });
                console.log('[SW] Created lastSeen store');
            }
            
            // Config store
            if (!database.objectStoreNames.contains(STORES.CONFIG)) {
                database.createObjectStore(STORES.CONFIG, { keyPath: 'key' });
                console.log('[SW] Created config store');
            }
            
            // DM Peers store (address -> name mapping)
            if (!database.objectStoreNames.contains(STORES.DM_PEERS)) {
                database.createObjectStore(STORES.DM_PEERS, { keyPath: 'address' });
                console.log('[SW] Created dmPeers store');
            }
        };
    });
}

/**
 * Every channel registered under a tag, with the watermark we already notified
 * about. All of them, not the first: one byte of tag means this user's own
 * channels collide, and answering with one left the others silent forever.
 */
async function getChannelsByTag(tag) {
    if (!db) await openDatabase();

    return new Promise((resolve, reject) => {
        const tx = db.transaction([STORES.CHANNELS, STORES.LAST_SEEN], 'readonly');
        const channelsStore = tx.objectStore(STORES.CHANNELS);
        const lastSeenStore = tx.objectStore(STORES.LAST_SEEN);

        const request = channelsStore.index('tag').getAll(tag);

        request.onsuccess = () => {
            const channels = request.result || [];
            if (channels.length === 0) {
                resolve([]);
                return;
            }
            let pending = channels.length;
            const out = [];
            for (const channel of channels) {
                const lastSeenReq = lastSeenStore.get(channel.streamId);
                const done = (timestamp) => {
                    out.push({ ...channel, lastTimestamp: timestamp });
                    if (--pending === 0) resolve(out);
                };
                lastSeenReq.onsuccess = () => done(lastSeenReq.result?.timestamp || 0);
                lastSeenReq.onerror = () => done(0);
            }
        };

        request.onerror = () => reject(request.error);
    });
}

async function updateLastSeen(streamId, timestamp) {
    if (!db) await openDatabase();
    
    return new Promise((resolve, reject) => {
        const tx = db.transaction(STORES.LAST_SEEN, 'readwrite');
        const store = tx.objectStore(STORES.LAST_SEEN);
        
        store.put({
            streamId,
            timestamp,
            updatedAt: Date.now()
        });
        
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
    });
}

async function syncChannelsToIndexedDB(channels) {
    if (!db) await openDatabase();
    
    return new Promise((resolve, reject) => {
        const tx = db.transaction(STORES.CHANNELS, 'readwrite');
        const store = tx.objectStore(STORES.CHANNELS);
        
        // Clear old channels
        const clearReq = store.clear();
        
        clearReq.onsuccess = () => {
            // Add new channels
            for (const channel of channels) {
                store.put({
                    streamId: channel.streamId,
                    type: channel.type,
                    name: channel.name || 'Channel',
                    tag: channel.tag,
                    storageEndpoints: channel.storageEndpoints || [],
                    // Whether the node serves this stream only to a signed
                    // read. The page decides it: it knows the channel's real
                    // type, which the labels here do not carry.
                    needsSignature: !!channel.needsSignature,
                    lastChecked: Date.now()
                });
            }
        };
        
        tx.oncomplete = () => {
            console.log('[SW] Synced', channels.length, 'channels to IndexedDB');
            resolve();
        };
        tx.onerror = () => reject(tx.error);
    });
}

// DM peer name sync/lookup removed: sealed sender makes the SW unable to
// identify a DM's sender, so there was nothing left to look a name up for.
// The empty DM_PEERS object store is left in place on existing installs
// (harmless) rather than forcing an IndexedDB migration.

// ================================================
// HTTP VERIFICATION FUNCTIONS
// ================================================

function buildUrl(endpoint, streamId, partition = 0) {
    const encoded = encodeURIComponent(streamId);
    return endpoint + API_PATH
        .replace('{streamId}', encoded)
        .replace('{partition}', partition);
}

async function fetchWithTimeout(url, timeout = 5000, extraHeaders = null) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeout);

    try {
        const response = await fetch(url, {
            method: 'GET',
            headers: { 'Accept': 'application/json', ...(extraHeaders || {}) },
            signal: controller.signal
        });

        clearTimeout(timeoutId);

        if (!response.ok) {
            return { success: false, status: response.status, error: `HTTP ${response.status}` };
        }
        
        const data = await response.json();
        
        if (!data || data.length === 0) {
            return { success: true, timestamp: 0 };
        }
        
        const msg = data[0];
        return {
            success: true,
            timestamp: msg.timestamp,
            content: msg.content,
            publisherId: msg.publisherId
        };
        
    } catch (error) {
        clearTimeout(timeoutId);
        throw error;
    }
}

/**
 * Asks an open page to sign a storage read. The key lives in the page, behind
 * the user's unlock, and must never be held here — so a wake that arrives with
 * every window closed cannot verify a private stream, and stays silent.
 * @returns {Promise<Object|null>} the x-pombo-* headers, or null
 */
async function requestSignature(url) {
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const client of windows) {
        const headers = await askClientToSign(client, url);
        if (headers) return headers;
    }
    return null;
}

function askClientToSign(client, url) {
    return new Promise((resolve) => {
        let settled = false;
        const finish = (value) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            resolve(value);
        };
        const timer = setTimeout(() => finish(null), SIGNATURE_TIMEOUT_MS);
        try {
            const channel = new MessageChannel();
            channel.port1.onmessage = (event) => finish(event.data?.headers || null);
            client.postMessage({ type: 'SIGN_STORAGE_READ', url }, [channel.port2]);
        } catch (error) {
            finish(null);
        }
    });
}

async function verifyChannel(channel) {
    const { streamId, lastTimestamp, storageEndpoints, needsSignature } = channel;

    const endpoints = storageEndpoints?.length > 0
        ? storageEndpoints
        : LEGACY_STORAGE_ENDPOINTS;

    for (const endpoint of endpoints) {
        try {
            const url = buildUrl(endpoint, streamId, 0);
            let headers = null;
            if (needsSignature) {
                headers = await requestSignature(url);
                if (!headers) {
                    // No page to sign: every endpoint would refuse the same way.
                    console.log('[SW] No open window to sign for', streamId);
                    return { hasNew: false, error: 'No signer' };
                }
            }
            const result = await fetchWithTimeout(url, 5000, headers);

            if (result.success) {
                const hasNew = result.timestamp > lastTimestamp;
                return {
                    hasNew,
                    timestamp: result.timestamp,
                    content: hasNew ? result.content : null,
                    publisherId: hasNew ? result.publisherId : null
                };
            }
            // A 4xx is the node answering ABOUT the request (unsigned, no
            // access, stream gone); the next node answers the same. Only a
            // node that failed as a node is worth asking again.
            if (result.status >= 400 && result.status < 500) {
                console.warn(`[SW] ${result.error} for ${streamId}`);
                return { hasNew: false, error: result.error };
            }
            console.warn(`[SW] Endpoint ${endpoint}: ${result.error}`);
        } catch (error) {
            console.warn(`[SW] Endpoint ${endpoint} failed:`, error.message);
        }
    }

    console.warn('[SW] All storage endpoints failed for', streamId);
    return { hasNew: false, error: 'All endpoints failed' };
}

// ================================================
// MESSAGE PREVIEW FOR NOTIFICATIONS
// ================================================

function getMessagePreview(channel) {
    const { type, content } = channel;

    // Nothing here holds the key to a channel's own encryption, and a direct
    // message arrives sealed to a key that lives in the page: all this can say
    // is that something arrived. (The native app opens the DM envelope and
    // shows its text; a service worker cannot.)
    if (type === 'dm') {
        return 'You have a new message';
    }
    if (type === 'private' || type === 'native') {
        return 'New message';
    }

    // Public channels - show content
    if (!content) {
        return 'New message';
    }
    
    switch (content.type) {
        case 'text':
            const text = content.text || '';
            return text.length > 100 ? text.substring(0, 100) + '...' : text;
        case 'image':
            return '📷 Image';
        case 'file':
            return `📎 ${content.fileName || 'File'}`;
        case 'audio':
            return '🎵 Audio message';
        case 'video':
            return '🎬 Video';
        case 'gif':
            return '🎞️ GIF';
        case 'reaction':
            return `Reacted with ${content.emoji || '👍'}`;
        default:
            return 'New message';
    }
}

// ================================================
// INSTALLATION
// ================================================

self.addEventListener('install', (event) => {
    console.log('[SW] Installed v' + SW_VERSION);
    self.skipWaiting();
});

self.addEventListener('activate', (event) => {
    console.log('[SW] Activated');
    event.waitUntil(
        (async () => {
            await openDatabase();
            await self.clients.claim();
            console.log('[SW] Ready for push verification');
        })()
    );
});

// ================================================
// PUSH NOTIFICATION WITH VERIFICATION
// ================================================

self.addEventListener('push', (event) => {
    console.log('[SW] Push received');
    
    let data = {};
    try {
        if (event.data) {
            data = event.data.json();
        }
    } catch (e) {
        console.warn('[SW] Push data is not JSON:', e);
    }
    
    event.waitUntil(handlePushWithVerification(data));
});

async function handlePushWithVerification(pushData) {
    try {
        if (!db) {
            await openDatabase();
        }
        
        const { tag } = pushData;

        // If no tag, can't verify - ignore (K-anonymity noise)
        if (!tag) {
            console.log('[SW] Push without tag - ignoring (K-anonymity noise)');
            return;
        }

        // Key-request wake: silent by contract. The key responder runs in an
        // open tab (its own sweep loop) — the SW neither sweeps nor notifies.
        if (pushData.channelType === 'keys') {
            console.log('[SW] Keys wake - silent (key responder handles it in-tab)');
            return;
        }
        
        // Every channel under this tag, since one byte collides by design.
        const channels = await getChannelsByTag(tag);

        if (channels.length === 0) {
            console.log('[SW] Channel not found for tag - ignoring (not subscribed)');
            return;
        }

        for (const channel of channels) {
            console.log('[SW] Verifying channel:', channel.name || channel.streamId);
            const result = await verifyChannel(channel);

            if (!result.hasNew) {
                console.log('[SW] No new messages - false positive');
                continue;
            }

            await updateLastSeen(channel.streamId, result.timestamp);

            await showVerifiedNotification({
                ...channel,
                newTimestamp: result.timestamp,
                content: result.content,
                publisherId: result.publisherId
            });
        }

    } catch (error) {
        console.error('[SW] Verification error:', error);
        // Fallback: show generic notification
        await showFallbackNotification(pushData);
    }
}

async function showVerifiedNotification(channelWithNews) {
    // Title. DMs are deliberately MINIMAL and never name the sender.
    //
    // Under sealed sender the row's publisherId is a throwaway key and the
    // real sender lives inside the ECDH ciphertext — unreadable without the
    // wallet private key, which the service worker does not have and must
    // never hold (it lives behind the page's unlock-derived AES key, in page
    // memory only). Attributing from the throwaway publisherId would be
    // wrong, so we don't try: a DM notification says only that one arrived.
    // Per-peer mute is unavailable here for the same reason — the sender
    // cannot be known — so a muted peer may still produce this generic
    // notification when no tab is open; the app-layer honours the mute
    // whenever a tab is alive. See the port brief.
    let title;
    if (channelWithNews.type === 'dm' || channelWithNews.type === 'dm-inbox') {
        title = 'Pombo';
    } else if (channelWithNews.type === 'private' || channelWithNews.type === 'native') {
        title = channelWithNews.name || 'Pombo';
    } else {
        // Public channel: content is public by design, so the channel name
        // and a preview are not a disclosure.
        title = channelWithNews.name || 'Pombo';
    }

    const body = getMessagePreview(channelWithNews);
    
    const options = {
        body: body,
        icon: '/favicon/web-app-manifest-192x192.png',
        badge: '/favicon/favicon-96x96.png',
        tag: 'pombo-' + Date.now(),
        renotify: true,
        requireInteraction: false,
        silent: false,
        vibrate: [200, 100, 200],
        data: {
            url: '/',
            channelStreamId: channelWithNews.streamId,
            timestamp: channelWithNews.newTimestamp
        },
        actions: [
            { action: 'open', title: 'Open' },
            { action: 'dismiss', title: 'Dismiss' }
        ]
    };
    
    // Check if app is focused
    const clients = await self.clients.matchAll({ 
        type: 'window', 
        includeUncontrolled: true 
    });
    
    const focusedClient = clients.find(c => c.focused);
    if (focusedClient) {
        console.log('[SW] App already focused - notifying via postMessage');
        focusedClient.postMessage({
            type: 'NEW_MESSAGE',
            streamId: channelWithNews.streamId,
            timestamp: channelWithNews.newTimestamp,
            content: channelWithNews.content
        });
        return;
    }
    
    return self.registration.showNotification(title, options);
}

async function showFallbackNotification(pushData) {
    const options = {
        body: pushData.channelType === 'private' 
            ? 'New message in private channel' 
            : 'You may have new messages',
        icon: '/favicon/web-app-manifest-192x192.png',
        badge: '/favicon/favicon-96x96.png',
        tag: 'pombo-fallback-' + Date.now(),
        renotify: true,
        vibrate: [200, 100, 200],
        data: {
            url: '/'
        }
    };
    
    return self.registration.showNotification('Pombo', options);
}

// ================================================
// NOTIFICATION CLICK
// ================================================

self.addEventListener('notificationclick', (event) => {
    console.log('[SW] Notification clicked:', event.action);
    
    event.notification.close();
    
    if (event.action === 'dismiss') {
        return;
    }
    
    // Open or focus the app
    event.waitUntil(
        self.clients.matchAll({ type: 'window', includeUncontrolled: true })
            .then((clients) => {
                // If we already have a window, focus it
                if (clients.length > 0) {
                    const client = clients[0];
                    client.focus();
                    // Notify that it was clicked
                    client.postMessage({
                        type: 'NOTIFICATION_CLICKED'
                    });
                    return;
                }
                
                // Otherwise, open new window
                return self.clients.openWindow(event.notification.data?.url || '/');
            })
    );
});

// ================================================
// NOTIFICATION CLOSE
// ================================================

self.addEventListener('notificationclose', (event) => {
    console.log('[SW] Notification closed');
});

// ================================================
// WEB SHARE TARGET
// Receives images shared from any Android app (Tenor, Gallery,
// Samsung Keyboard long-press → Share, etc.) when Pombo is installed
// as a PWA. Files are stashed in a Cache and the page is redirected
// to /?share=1 so the SPA can pick them up on boot.
// ================================================

const SHARE_CACHE = 'pombo-share-v1';
const SHARE_ALLOWED_MIME = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];

self.addEventListener('fetch', (event) => {
    const url = new URL(event.request.url);
    if (event.request.method !== 'POST' || url.pathname !== '/share') return;
    event.respondWith(handleShareTarget(event.request));
});

async function handleShareTarget(request) {
    try {
        const formData = await request.formData();
        const files = formData.getAll('shared').filter(f =>
            f instanceof File && SHARE_ALLOWED_MIME.includes(f.type)
        );
        const cache = await caches.open(SHARE_CACHE);
        // Wipe previous shares so we never replay stale files.
        const old = await cache.keys();
        await Promise.all(old.map(req => cache.delete(req)));
        for (let i = 0; i < files.length; i++) {
            const file = files[i];
            await cache.put(
                `/__shared/${i}`,
                new Response(file, {
                    headers: {
                        'Content-Type': file.type,
                        'X-Pombo-Filename': encodeURIComponent(file.name || `shared-${i}`)
                    }
                })
            );
        }
    } catch (err) {
        console.warn('[SW] Share target handling failed:', err?.message);
    }
    return Response.redirect('/?share=1', 303);
}

// ================================================
// CLIENT MESSAGES
// ================================================

self.addEventListener('message', async (event) => {
    const { type } = event.data || {};
    
    // Sync channels from app
    if (type === 'SYNC_CHANNELS') {
        console.log('[SW] Syncing channels:', event.data.channels?.length || 0);
        await syncChannelsToIndexedDB(event.data.channels || []);
        // DM peer names are no longer synced: under sealed sender the SW cannot
        // know a DM's sender (see showVerifiedNotification), so a peer
        // address→name map here would be unused identity data — dropped.
        return;
    }
    
    // Update last seen timestamp
    if (type === 'UPDATE_LAST_SEEN') {
        await updateLastSeen(event.data.streamId, event.data.timestamp);
        return;
    }
    
    // Force update
    if (type === 'SKIP_WAITING') {
        self.skipWaiting();
        return;
    }
    
    console.log('[SW] Unknown message type:', type);
});
