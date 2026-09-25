/**
 * Secure Storage Module
 * Encrypts all localStorage data using a key derived from wallet signature
 * 
 * Security Model:
 * - Storage key derived from: PBKDF2(wallet_signature, deterministic_salt)
 * - Data encrypted with AES-256-GCM
 * - Only the wallet owner can decrypt their data
 * - Each wallet has completely isolated encrypted storage
 */

import { Logger } from './logger.js';
import { CONFIG } from './config.js';
import { StorageError } from './utils/errors.js';
import { cryptoWorkerPool } from './workers/cryptoWorkerPool.js';
import { stampedSliceTs } from './syncMerge.js';

class SecureStorage {
    constructor() {
        this.storageKey = null;       // AES-256-GCM key
        this.address = null;          // Current wallet address
        this.isUnlocked = false;      // Whether storage is decrypted
        this.cache = null;            // Decrypted data cache
        this.isGuestMode = false;     // Guest mode - no persistence
        this.onBlockedPeersChanged = null;
        this.onSentDataChanged = null; // Fired on sent-message/reaction/dmLeftAt mutations (sync auto-push)
        this.PBKDF2_ITERATIONS = CONFIG.crypto.pbkdf2Iterations;
        // Encrypted state store (IndexedDB)
        this.stateDB = null;          // IDBDatabase for PomboStateStore
        // Image ledger (IndexedDB)
        this.imageDB = null;          // IDBDatabase for PomboImageStore
        this.imageBlobCache = null;   // Map<imageId, imageData> in-memory LRU
        this.imageBlobCacheBytes = 0; // Tracked size for eviction
        this.IMAGE_CACHE_MAX_BYTES = 10 * 1024 * 1024; // 10 MB cap for in-memory cache
    }

    /**
     * Derive encryption key from wallet signature
     * Uses the local signer (no MetaMask popup needed)
     * @param {Object} signer - ethers.js signer (local wallet)
     * @param {string} address - Wallet address
     * @returns {Promise<CryptoKey>}
     */
    async deriveStorageKey(signer, address) {
        const normalizedAddress = address.toLowerCase();
        
        // Create a deterministic message for signing
        // This ensures the same key is derived each time
        const message = `Pombo Secure Storage\n\nUnlock encrypted storage for:\n${normalizedAddress}\n\nThis signature is used to derive an encryption key.`;
        
        Logger.debug('Deriving storage encryption key...');
        
        // Get signature from local wallet (instant, no popup)
        const signature = await signer.signMessage(message);
        
        // Create deterministic salt from address
        const salt = new TextEncoder().encode(`pombo_salt_${normalizedAddress}`);
        
        // Offload PBKDF2 (310k iterations, ~500-800ms) to worker pool
        // to avoid blocking the main thread during app init.
        // Falls back to main-thread crypto if the worker task fails.
        try {
            const key = await cryptoWorkerPool.execute('DERIVE_KEY', {
                password: signature,
                salt: Array.from(salt),
                iterations: this.PBKDF2_ITERATIONS
            });
            Logger.debug('Storage key derived successfully');
            return key;
        } catch (workerError) {
            Logger.warn('Worker DERIVE_KEY failed, falling back to main thread:', workerError.message);
            const keyMaterial = await crypto.subtle.importKey(
                'raw', new TextEncoder().encode(signature), 'PBKDF2', false, ['deriveKey']
            );
            const key = await crypto.subtle.deriveKey(
                { name: 'PBKDF2', salt, iterations: this.PBKDF2_ITERATIONS, hash: 'SHA-256' },
                keyMaterial, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']
            );
            Logger.debug('Storage key derived successfully (main-thread fallback)');
            return key;
        }
    }

    /**
     * Initialize secure storage for a wallet
     * @param {Object} signer - ethers.js signer (local wallet)
     * @param {string} address - Wallet address
     */
    async init(signer, address) {
        this.address = address.toLowerCase();
        this.isGuestMode = false;
        
        try {
            // Derive encryption key from wallet signature
            this.storageKey = await this.deriveStorageKey(signer, address);

            // Initialize persistent encrypted state backend first so load can use IDB.
            await this.initStateStore();
            
            // Load existing encrypted data or initialize empty
            await this.loadFromStorage();
            
            // Initialize image ledger (IndexedDB)
            await this.initImageStore();

            // Ensure any cached images are flushed to IDB
            // (guards against data loss if images were cached before IDB was available)
            await this._flushCachedImagesToLedger();
            
            this.isUnlocked = true;

            // Sync username to plain localStorage for pre-unlock display
            if (this.cache.username) {
                localStorage.setItem(CONFIG.storageKeys.username(this.address), this.cache.username);
            } else {
                localStorage.removeItem(CONFIG.storageKeys.username(this.address));
            }

            this.mirrorEnsAvatarsEnabled();

            Logger.info('🔓 Secure storage unlocked for:', this.address.slice(0, 8) + '...');
            
            return true;
        } catch (error) {
            Logger.error('Failed to initialize secure storage:', error);
            throw error;
        }
    }

    /**
     * Initialize secure storage for Guest mode (memory only, no persistence)
     * @param {string} address - Guest wallet address
     */
    initAsGuest(address) {
        this.address = address.toLowerCase();
        this.isGuestMode = true;
        this.isUnlocked = true;
        this.storageKey = null; // No encryption needed for in-memory only
        
        // Initialize empty cache in memory (never persisted)
        this.cache = this.createEmptyCache();
        this.mirrorEnsAvatarsEnabled();
        
        Logger.info('🔓 Guest storage initialized (memory only):', this.address.slice(0, 8) + '...');
        return true;
    }

    /**
     * Create a fresh empty cache object.
     * @returns {Object}
     */
    createEmptyCache() {
        return {
            channels: [],
            trustedContacts: {},
            ensCache: {},
            username: null,
            graphApiKey: null,
            sessionData: null,
            channelLastAccess: {},
            channelOrder: [],
            lastOpenedChannel: null,
            blockedPeers: [],
            dmLeftAt: {},
            channelsLeftAt: {},
            sentDeletedAt: {},
            pendingInvites: [],
            sliceTs: {},
            version: 2
        };
    }

    /**
     * Stamp a latest-wins sync slice with the current time.
     * The sync merge uses these timestamps to decide which side's snapshot
     * wins, so local changes not yet pushed can't be clobbered by a pull.
     * @param {string} key - Slice name (trustedContacts, blockedPeers, dmLeftAt, username, graphApiKey)
     */
    _stampSliceTs(key) {
        if (!this.cache.sliceTs) {
            this.cache.sliceTs = {};
        }
        this.cache.sliceTs[key] = Date.now();
    }

    /**
     * Get the localStorage key for current wallet
     */
    getStorageKey() {
        return CONFIG.storageKeys.secure(this.address);
    }

    /**
     * Open (or create) the PomboStateStore IndexedDB.
     * Schema: { storageKey (PK), encryptedData, updatedAt }
     */
    async initStateStore() {
        if (this.isGuestMode || this.stateDB || typeof indexedDB === 'undefined') return;

        return new Promise((resolve) => {
            const request = indexedDB.open('PomboStateStore', 1);

            request.onupgradeneeded = (event) => {
                const db = event.target.result;
                if (!db.objectStoreNames.contains('state')) {
                    db.createObjectStore('state', { keyPath: 'storageKey' });
                }
            };

            request.onsuccess = (event) => {
                this.stateDB = event.target.result;
                Logger.info('📦 PomboStateStore opened');
                resolve();
            };

            request.onerror = (event) => {
                Logger.error('Failed to open PomboStateStore:', event.target.error);
                resolve();
            };
        });
    }

    /**
     * Read encrypted state from the IndexedDB state store.
     * @param {string} storageKey
     * @returns {Promise<Object|null>}
     */
    async readStateRecord(storageKey) {
        if (!this.stateDB) return null;

        return new Promise((resolve, reject) => {
            const tx = this.stateDB.transaction('state', 'readonly');
            const req = tx.objectStore('state').get(storageKey);
            req.onsuccess = () => resolve(req.result || null);
            req.onerror = () => reject(req.error);
        });
    }

    /**
     * Persist encrypted state to the IndexedDB state store.
     * @param {string} storageKey
     * @param {Object} encryptedData
     * @returns {Promise<void>}
     */
    async writeStateRecord(storageKey, encryptedData) {
        if (!this.stateDB) return;

        return new Promise((resolve, reject) => {
            const tx = this.stateDB.transaction('state', 'readwrite');
            tx.objectStore('state').put({
                storageKey,
                encryptedData,
                updatedAt: Date.now()
            });
            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(tx.error);
        });
    }

    /**
     * Delete encrypted state for an account from both legacy localStorage and IDB.
     * @param {string} address
     */
    async deletePersistentState(address) {
        const normalizedAddress = address?.toLowerCase?.() || address;
        if (!normalizedAddress) return;

        const storageKey = CONFIG.storageKeys.secure(normalizedAddress);
        localStorage.removeItem(storageKey);

        if (!this.stateDB && typeof indexedDB !== 'undefined' && !this.isGuestMode) {
            await this.initStateStore();
        }

        if (!this.stateDB) return;

        try {
            await new Promise((resolve, reject) => {
                const tx = this.stateDB.transaction('state', 'readwrite');
                tx.objectStore('state').delete(storageKey);
                tx.oncomplete = () => resolve();
                tx.onerror = () => reject(tx.error);
            });
            Logger.info('🗑️ Deleted encrypted state for:', normalizedAddress.slice(0, 8) + '...');
        } catch (error) {
            Logger.error('Failed to delete encrypted state:', error);
        }
    }

    /**
     * Encrypt data using AES-256-GCM
     * @param {any} data - Data to encrypt (will be JSON stringified)
     * @returns {Promise<Object>} - { iv, ciphertext }
     */
    async encrypt(data) {
        if (!this.storageKey) {
            throw new Error('Storage not initialized');
        }
        
        const iv = crypto.getRandomValues(new Uint8Array(12));
        const plaintext = new TextEncoder().encode(JSON.stringify(data));
        
        const ciphertext = await crypto.subtle.encrypt(
            { name: 'AES-GCM', iv: iv },
            this.storageKey,
            plaintext
        );
        
        return {
            iv: Array.from(iv),
            ciphertext: Array.from(new Uint8Array(ciphertext))
        };
    }

    /**
     * Decrypt data using AES-256-GCM
     * @param {Object} encryptedData - { iv, ciphertext }
     * @returns {Promise<any>} - Decrypted data
     */
    async decrypt(encryptedData) {
        if (!this.storageKey) {
            throw new Error('Storage not initialized');
        }
        
        const iv = new Uint8Array(encryptedData.iv);
        const ciphertext = new Uint8Array(encryptedData.ciphertext);
        
        const plaintext = await crypto.subtle.decrypt(
            { name: 'AES-GCM', iv: iv },
            this.storageKey,
            ciphertext
        );
        
        return JSON.parse(new TextDecoder().decode(plaintext));
    }

    /**
     * Load and decrypt data from persistent storage.
     * Prefers IndexedDB state storage and falls back to legacy localStorage.
     */
    async loadFromStorage() {
        const storageKey = this.getStorageKey();

        if (this.stateDB) {
            try {
                const record = await this.readStateRecord(storageKey);
                if (record?.encryptedData) {
                    this.cache = await this.decrypt(record.encryptedData);
                    Logger.info('📦 Loaded and decrypted data from IndexedDB state store');
                    return;
                }
            } catch (error) {
                Logger.warn('Failed to read IndexedDB state, falling back to localStorage:', error);
            }
        }

        const stored = localStorage.getItem(storageKey);
        
        if (!stored) {
            // No existing data - initialize empty cache
            this.cache = this.createEmptyCache();
            Logger.info('📦 Initialized empty secure storage');
            return;
        }
        
        try {
            const encryptedData = JSON.parse(stored);
            this.cache = await this.decrypt(encryptedData);

            if (this.stateDB) {
                try {
                    await this.writeStateRecord(storageKey, encryptedData);
                    localStorage.removeItem(storageKey);
                    Logger.info('📦 Migrated encrypted state from localStorage to IndexedDB');
                } catch (migrationError) {
                    Logger.warn('Failed to migrate encrypted state to IndexedDB:', migrationError);
                }
            }

            Logger.info('📦 Loaded and decrypted data from legacy storage');
        } catch (error) {
            Logger.error('Failed to decrypt storage - may be corrupted or from different key');
            throw new StorageError(
                'Failed to decrypt storage — data may be corrupted or encrypted with a different key',
                'STORAGE_DECRYPT_FAILED',
                { cause: error }
            );
        }
    }

    /**
     * Save encrypted data to localStorage
     * Automatically trims imageData from old messages if quota is exceeded
     */
    async saveToStorage() {
        // Guest mode: keep in memory only, don't persist
        if (this.isGuestMode) {
            Logger.debug('💾 Guest mode - data kept in memory only');
            return;
        }
        
        if (!this.isUnlocked || !this.cache) {
            Logger.warn('Cannot save - storage not unlocked');
            return;
        }

        if (this.stateDB) {
            try {
                const encrypted = await this.encrypt(this.cache);
                await this.writeStateRecord(this.getStorageKey(), encrypted);
                // Remove any legacy localStorage payload once IDB is the source of truth.
                localStorage.removeItem(this.getStorageKey());
                Logger.debug('💾 Saved encrypted data to IndexedDB state store');
                return;
            } catch (error) {
                Logger.warn('Failed to save to IndexedDB state store, falling back to localStorage:', error);
            }
        }
        
        try {
            const encrypted = await this.encrypt(this.cache);
            localStorage.setItem(this.getStorageKey(), JSON.stringify(encrypted));
            Logger.debug('💾 Saved encrypted data to storage');
        } catch (error) {
            if (!this._isQuotaError(error)) {
                Logger.error('Failed to save to secure storage:', error);
                throw new StorageError(
                    'Failed to save encrypted data to storage',
                    'STORAGE_SAVE_FAILED',
                    { cause: error }
                );
            }
            // Progressive trim: oldest half first, then all imageData
            const passes = ['half', 'all'];
            for (const pass of passes) {
                Logger.warn(`localStorage quota reached — trimming image data (${pass})`);
                this._trimImageDataFromCache(pass === 'all');
                try {
                    const encrypted = await this.encrypt(this.cache);
                    localStorage.setItem(this.getStorageKey(), JSON.stringify(encrypted));
                    Logger.info(`💾 Saved after trimming image data (${pass})`);
                    return;
                } catch (retryError) {
                    if (!this._isQuotaError(retryError)) {
                        throw new StorageError(
                            'Failed to save encrypted data to storage',
                            'STORAGE_SAVE_FAILED',
                            { cause: retryError }
                        );
                    }
                    // Continue to next pass
                }
            }
            Logger.error('Failed to save even after stripping all image data');
            throw new StorageError(
                'Failed to save encrypted data to storage — quota exceeded',
                'STORAGE_SAVE_FAILED',
                { cause: error }
            );
        }
    }

    /**
     * Check if an error is a localStorage quota exceeded error
     * @param {Error} error
     * @returns {boolean}
     */
    _isQuotaError(error) {
        return error?.name === 'QuotaExceededError' ||
               error?.code === 22 ||
               error?.code === 1014;  // Firefox
    }

    /**
     * Remove imageData from old sent messages in cache to free localStorage space.
     * Trims oldest-first. When forceAll is false, strips half the image messages;
     * when true (or IDB unavailable), strips all to guarantee the save succeeds.
     * Images remain accessible via getImageBlob() (IndexedDB ledger).
     * @param {boolean} [forceAll=false] - Strip all imageData regardless of IDB
     */
    _trimImageDataFromCache(forceAll = false) {
        const allImageMsgs = [];
        for (const [streamId, msgs] of Object.entries(this.cache.sentMessages || {})) {
            for (const msg of msgs) {
                if (msg.type === 'image' && msg.imageData) {
                    allImageMsgs.push({ streamId, msg });
                }
            }
        }
        if (allImageMsgs.length === 0) return;
        allImageMsgs.sort((a, b) => a.msg.timestamp - b.msg.timestamp);
        // Strip all when forced or IDB unavailable; otherwise strip oldest half
        const trimCount = (forceAll || !this.imageDB)
            ? allImageMsgs.length
            : Math.max(Math.ceil(allImageMsgs.length / 2), 1);
        for (let i = 0; i < trimCount; i++) {
            delete allImageMsgs[i].msg.imageData;
        }
    }

    /**
     * Add an entry to imageBlobCache, evicting oldest entries if over cap.
     * @param {string} imageId
     * @param {string} data - base64 image data
     */
    _warmImageCache(imageId, data) {
        if (!this.imageBlobCache) return;
        if (this.imageBlobCache.has(imageId)) return;
        this.imageBlobCache.set(imageId, data);
        this.imageBlobCacheBytes += data.length;
        // LRU eviction: drop oldest entries (Map insertion order) until under cap
        while (this.imageBlobCacheBytes > this.IMAGE_CACHE_MAX_BYTES && this.imageBlobCache.size > 1) {
            const oldest = this.imageBlobCache.keys().next().value;
            const oldLen = this.imageBlobCache.get(oldest)?.length || 0;
            this.imageBlobCache.delete(oldest);
            this.imageBlobCacheBytes -= oldLen;
        }
    }

    // ==================== Data Accessors ====================

    /**
     * Get channels
     */
    getChannels() {
        if (!this.isUnlocked) return [];
        return this.cache.channels || [];
    }

    /**
     * Set channels
     */
    async setChannels(channels) {
        if (!this.isUnlocked) return;
        this.cache.channels = channels;
        await this.saveToStorage();
    }

    /**
     * Get all channel leave tombstones { messageStreamId: leftTs }.
     * Used by sync merge so a leave propagates across devices without
     * deleting channels re-joined later (per-channel latest-wins).
     */
    getChannelsLeftAt() {
        if (!this.isUnlocked) return {};
        return this.cache.channelsLeftAt || {};
    }

    /**
     * Record a channel leave tombstone.
     * @param {string} messageStreamId
     * @param {number} timestamp
     */
    async setChannelLeftAt(messageStreamId, timestamp) {
        if (!this.isUnlocked) return;
        if (!this.cache.channelsLeftAt) {
            this.cache.channelsLeftAt = {};
        }
        this.cache.channelsLeftAt[messageStreamId] = timestamp;
        await this.saveToStorage();
    }

    /**
     * Clear a channel leave tombstone (on re-join).
     * @param {string} messageStreamId
     */
    async clearChannelLeftAt(messageStreamId) {
        if (!this.isUnlocked) return;
        if (this.cache.channelsLeftAt?.[messageStreamId]) {
            delete this.cache.channelsLeftAt[messageStreamId];
            await this.saveToStorage();
        }
    }

    /**
     * Get persisted epoch keys for a channel (keys stream protocol state).
     * Epoch keys are CHANNEL keys, not ephemeral identities — persisting them
     * is what avoids a KEY_REQUEST round-trip on every session (D14). They
     * live inside the encrypted cache, out of the service worker's reach.
     * @param {string} messageStreamId
     * @returns {Object|null} { epochs: {keyId: {keyHex, keyHash, epoch}}, currentEpoch }
     */
    getEpochKeys(messageStreamId) {
        if (!this.isUnlocked) return null;
        return this.cache.epochKeys?.[messageStreamId] || null;
    }

    /**
     * Persist epoch keys for a channel.
     * @param {string} messageStreamId
     * @param {Object} data - { epochs, currentEpoch }
     */
    async setEpochKeys(messageStreamId, data) {
        if (!this.isUnlocked) return;
        if (!this.cache.epochKeys) {
            this.cache.epochKeys = {};
        }
        this.cache.epochKeys[messageStreamId] = data;
        await this.saveToStorage();
    }

    /**
     * Drop persisted epoch keys for a channel (on leave/delete).
     * @param {string} messageStreamId
     */
    async clearEpochKeys(messageStreamId) {
        if (!this.isUnlocked) return;
        if (this.cache.epochKeys?.[messageStreamId]) {
            delete this.cache.epochKeys[messageStreamId];
            await this.saveToStorage();
        }
    }

    /**
     * Get trusted contacts
     */
    getTrustedContacts() {
        if (!this.isUnlocked) return {};
        return this.cache.trustedContacts || {};
    }

    /**
     * Set trusted contacts
     */
    async setTrustedContacts(contacts) {
        if (!this.isUnlocked) return;
        this.cache.trustedContacts = contacts;
        this._stampSliceTs('trustedContacts');
        await this.saveToStorage();
    }

    /**
     * Get ENS cache
     */
    getENSCache() {
        if (!this.isUnlocked) return {};
        return this.cache.ensCache || {};
    }

    /**
     * Set ENS cache
     */
    async setENSCache(cache) {
        if (!this.isUnlocked) return;
        this.cache.ensCache = cache;
        await this.saveToStorage();
    }

    /**
     * Get username
     */
    getUsername() {
        if (!this.isUnlocked) return null;
        return this.cache.username;
    }

    /**
     * Set username
     */
    async setUsername(username) {
        if (!this.isUnlocked) return;
        this.cache.username = username;
        this._stampSliceTs('username');
        // Also store in plain localStorage for pre-unlock display (unlock modal)
        // Skip in guest mode — guest sessions are memory-only
        if (this.address && !this.isGuestMode) {
            if (username) {
                localStorage.setItem(CONFIG.storageKeys.username(this.address), username);
            } else {
                localStorage.removeItem(CONFIG.storageKeys.username(this.address));
            }
        }
        await this.saveToStorage();
    }

    /**
     * Get NSFW content enabled setting
     */
    getNsfwEnabled() {
        if (!this.isUnlocked) return false;
        return this.cache.nsfwEnabled || false;
    }

    /**
     * Set NSFW content enabled setting
     */
    async setNsfwEnabled(enabled) {
        if (!this.isUnlocked) return;
        this.cache.nsfwEnabled = enabled;
        await this.saveToStorage();
    }

    /**
     * Get YouTube embeds enabled setting (default: true)
     */
    getYouTubeEmbedsEnabled() {
        if (!this.isUnlocked) return true;
        return this.cache.youtubeEmbedsEnabled !== false; // Default true
    }

    /**
     * Set YouTube embeds enabled setting
     */
    async setYouTubeEmbedsEnabled(enabled) {
        if (!this.isUnlocked) return;
        this.cache.youtubeEmbedsEnabled = enabled;
        await this.saveToStorage();
    }

    /**
     * Get remote ENS avatar images enabled setting (default: true)
     */
    getEnsAvatarsEnabled() {
        if (!this.isUnlocked) return true;
        return this.cache.ensAvatarsEnabled !== false; // Default true
    }

    /**
     * Set remote ENS avatar images enabled setting
     */
    async setEnsAvatarsEnabled(enabled) {
        if (!this.isUnlocked) return;
        this.cache.ensAvatarsEnabled = enabled;
        this.mirrorEnsAvatarsEnabled();
        await this.saveToStorage();
    }

    /**
     * Republish the setting to plain localStorage. The avatar renderer is a
     * leaf module with no access to this store, and the unlock/account modals
     * draw avatars while it is still locked.
     */
    mirrorEnsAvatarsEnabled() {
        if (this.cache?.ensAvatarsEnabled === false) {
            localStorage.setItem(CONFIG.storageKeys.ensAvatarsEnabled, '0');
        } else {
            localStorage.removeItem(CONFIG.storageKeys.ensAvatarsEnabled);
        }
    }

    /**
     * Get The Graph API key
     */
    getGraphApiKey() {
        if (!this.isUnlocked) return null;
        return this.cache.graphApiKey || null;
    }

    /**
     * Set The Graph API key
     */
    async setGraphApiKey(apiKey) {
        if (!this.isUnlocked) return;
        this.cache.graphApiKey = apiKey;
        this._stampSliceTs('graphApiKey');
        await this.saveToStorage();
    }

    /**
     * Get session data
     */
    getSessionData() {
        if (!this.isUnlocked) return null;
        return this.cache.sessionData;
    }

    /**
     * Set session data
     */
    async setSessionData(sessionData) {
        if (!this.isUnlocked) return;
        this.cache.sessionData = sessionData;
        await this.saveToStorage();
    }

    /**
     * Clear session data (on disconnect)
     */
    async clearSessionData() {
        if (!this.isUnlocked) return;
        this.cache.sessionData = null;
        await this.saveToStorage();
    }

    // ==================== Pending Channel Invites ====================

    /**
     * Get pending channel invites (encrypted at rest — invites carry channel
     * passwords, so they must never live in plain localStorage)
     * @returns {Array} - Array of invite objects
     */
    getPendingInvites() {
        if (!this.isUnlocked) return [];
        return this.cache.pendingInvites || [];
    }

    /**
     * Persist pending channel invites
     * @param {Array} invites - Array of invite objects
     */
    async setPendingInvites(invites) {
        if (!this.isUnlocked) return;
        this.cache.pendingInvites = Array.isArray(invites) ? invites : [];
        await this.saveToStorage();
    }

    // ==================== Channel Last Access ====================

    /**
     * Get last access timestamp for a channel
     * Checks both encrypted storage AND emergency localStorage (from beforeunload)
     * @param {string} streamId - Channel stream ID
     * @returns {number|null} - Timestamp or null if never accessed
     */
    getChannelLastAccess(streamId) {
        if (!this.isUnlocked) return null;
        
        // Get from encrypted cache
        const cachedAccess = this.cache.channelLastAccess?.[streamId] || 0;
        
        // Check emergency localStorage (saved on beforeunload/pagehide)
        const emergencyKey = CONFIG.storageKeys.channelAccess(streamId);
        const emergencyValue = localStorage.getItem(emergencyKey);
        const emergencyAccess = emergencyValue ? parseInt(emergencyValue, 10) : 0;
        
        // Use the most recent timestamp
        const latestAccess = Math.max(cachedAccess, emergencyAccess);
        
        // If emergency value was newer, sync it to encrypted storage and cleanup
        if (emergencyAccess > cachedAccess && emergencyAccess > 0) {
            if (!this.cache.channelLastAccess) {
                this.cache.channelLastAccess = {};
            }
            this.cache.channelLastAccess[streamId] = emergencyAccess;
            // Clean up emergency key (async, fire-and-forget — must not produce
            // an unhandled rejection if storage is locked mid-flight, e.g. logout)
            localStorage.removeItem(emergencyKey);
            this.saveToStorage().catch((e) => {
                Logger.debug('channelLastAccess sync save failed (non-fatal):', e?.message || e);
            });
        }
        
        return latestAccess > 0 ? latestAccess : null;
    }

    /**
     * Set last access timestamp for a channel (marks as read)
     * @param {string} streamId - Channel stream ID
     * @param {number} timestamp - Access timestamp (defaults to now)
     */
    async setChannelLastAccess(streamId, timestamp = Date.now()) {
        if (!this.isUnlocked) return;
        if (!this.cache.channelLastAccess) {
            this.cache.channelLastAccess = {};
        }
        this.cache.channelLastAccess[streamId] = timestamp;
        
        // Clean up any emergency localStorage value for this channel
        const emergencyKey = CONFIG.storageKeys.channelAccess(streamId);
        localStorage.removeItem(emergencyKey);
        
        await this.saveToStorage();
    }

    /**
     * Get all channel last access timestamps
     * @returns {Object} - { streamId: timestamp }
     */
    getAllChannelLastAccess() {
        if (!this.isUnlocked) return {};
        return this.cache.channelLastAccess || {};
    }

    // ==================== Channel Order ====================

    /**
     * Get channel order (array of streamIds in user-defined order)
     * @returns {string[]} - Array of streamIds
     */
    getChannelOrder() {
        if (!this.isUnlocked) return [];
        return this.cache.channelOrder || [];
    }

    /**
     * Set channel order
     * @param {string[]} order - Array of streamIds in desired order
     */
    async setChannelOrder(order) {
        if (!this.isUnlocked) return;
        this.cache.channelOrder = order;
        await this.saveToStorage();
    }

    /**
     * Remove a channel from the order (when leaving/deleting)
     * @param {string} streamId - Channel to remove
     */
    async removeFromChannelOrder(streamId) {
        if (!this.isUnlocked) return;
        if (!this.cache.channelOrder) return;
        this.cache.channelOrder = this.cache.channelOrder.filter(id => id !== streamId);
        await this.saveToStorage();
    }

    /**
     * Add a channel to the order (at the end by default)
     * @param {string} streamId - Channel to add
     */
    async addToChannelOrder(streamId) {
        if (!this.isUnlocked) return;
        if (!this.cache.channelOrder) {
            this.cache.channelOrder = [];
        }
        // Don't add duplicates
        if (!this.cache.channelOrder.includes(streamId)) {
            this.cache.channelOrder.push(streamId);
            await this.saveToStorage();
        }
    }

    // ==================== Sent Messages (Write-Only Channels) ====================

    /**
     * Get locally stored sent messages for a write-only channel
     * @param {string} streamId - Stream ID
     * @returns {Array} - Array of sent messages
     */
    getSentMessages(streamId) {
        if (!this.isUnlocked) return [];
        return this.cache.sentMessages?.[streamId] || [];
    }

    /**
     * Add a sent message to local storage (for write-only channels)
     * Stores text, image, and file_announce messages
     * Keeps last 200 messages per channel to avoid storage bloat
     * @param {string} streamId - Stream ID
     * @param {Object} message - Message object to store
     */
    async addSentMessage(streamId, message) {
        if (!this.isUnlocked) return;
        if (!this.cache.sentMessages) {
            this.cache.sentMessages = {};
        }
        if (!this.cache.sentMessages[streamId]) {
            this.cache.sentMessages[streamId] = [];
        }
        // Store fields based on message type
        const stored = {
            id: message.id,
            sender: message.sender,
            timestamp: message.timestamp,
            signature: message.signature,
            channelId: message.channelId
        };
        if (message.type === 'image') {
            stored.type = 'image';
            stored.imageId = message.imageId;
            stored.imageData = message.imageData;
            stored.transport = message.transport || null;
            stored.v = message.v || null;
            stored.originalMime = message.originalMime || null;
            stored.finalMime = message.finalMime || null;
            stored.finalSizeBytes = Number.isFinite(message.finalSizeBytes) ? message.finalSizeBytes : null;
            stored.chunkCount = Number.isInteger(message.chunkCount) ? message.chunkCount : null;
            stored.chunkHashes = Array.isArray(message.chunkHashes) ? [...message.chunkHashes] : null;
            stored.assembledSha256 = message.assembledSha256 || null;
            stored.preservedOriginal = typeof message.preservedOriginal === 'boolean' ? message.preservedOriginal : null;
            stored.convertedTo = message.convertedTo || null;
            stored.qualityUsed = Number.isFinite(message.qualityUsed) ? message.qualityUsed : null;
        } else if (message.type === 'file_announce') {
            stored.type = 'file_announce';
            stored.metadata = message.metadata;
        } else if (message.type === 'storage_file_announce') {
            stored.type = 'storage_file_announce';
            stored.metadata = message.metadata;
            stored.signature = message.signature || null;
        } else {
            // Text message
            stored.text = message.text;
            stored.replyTo = message.replyTo || null;
        }
        // Dedup check: avoid adding same message twice
        const existing = this.cache.sentMessages[streamId];
        if (existing.some(m => m.id === stored.id)) {
            return;
        }
        existing.push(stored);
        // Cap at 200 messages per channel
        if (this.cache.sentMessages[streamId].length > 200) {
            this.cache.sentMessages[streamId] = this.cache.sentMessages[streamId].slice(-200);
        }
        // Flush image to IndexedDB ledger before saving to localStorage
        if (message.type === 'image' && message.imageData) {
            await this.saveImageToLedger(message.imageId, message.imageData, streamId);
            // Image is safe in IDB — strip from cache to avoid bloating localStorage
            delete stored.imageData;
        }
        await this.saveToStorage();
        this.onSentDataChanged?.({ type: 'sentMessage', streamId });
    }

    /**
     * Clear sent messages for a channel
     * @param {string} streamId - Stream ID
     */
    async clearSentMessages(streamId) {
        if (!this.isUnlocked) return;
        if (this.cache.sentMessages?.[streamId]) {
            delete this.cache.sentMessages[streamId];
            await this.saveToStorage();
            await this.clearImagesForStream(streamId);
        }
    }

    /**
     * Update a sent message in local storage (for edits)
     * @param {string} streamId - Stream ID
     * @param {string} messageId - Message ID to update
     * @param {Object} fields - Fields to merge into the stored message
     */
    async updateSentMessage(streamId, messageId, fields) {
        if (!this.isUnlocked) return;
        const messages = this.cache.sentMessages?.[streamId];
        if (!messages) return;
        const msg = messages.find(m => m.id === messageId);
        if (!msg) return;
        Object.assign(msg, fields);
        await this.saveToStorage();
        this.onSentDataChanged?.({ type: 'sentMessage', streamId });
    }

    /**
     * Delete a sent message: drop it here and record the deletion, which the
     * sync carries to the account's other devices.
     * @param {string} streamId - Stream ID
     * @param {string} messageId - Message ID to remove
     */
    async removeSentMessage(streamId, messageId) {
        if (!this.isUnlocked) return;
        if (!this.cache.sentDeletedAt) this.cache.sentDeletedAt = {};
        if (!this.cache.sentDeletedAt[streamId]) this.cache.sentDeletedAt[streamId] = {};
        this.cache.sentDeletedAt[streamId][messageId] = Date.now();
        const messages = this.cache.sentMessages?.[streamId];
        const idx = messages ? messages.findIndex(m => m.id === messageId) : -1;
        if (idx >= 0) messages.splice(idx, 1);
        await this.saveToStorage();
        this.onSentDataChanged?.({ type: 'sentMessage', streamId });
    }

    /**
     * Clear sent reactions for a channel
     * @param {string} streamId - Stream ID
     */
    async clearSentReactions(streamId) {
        if (!this.isUnlocked) return;
        if (this.cache.sentReactions?.[streamId]) {
            delete this.cache.sentReactions[streamId];
            await this.saveToStorage();
        }
    }

    /**
     * Get locally stored reactions for a write-only channel
     * @param {string} streamId - Stream ID
     * @returns {Object} - Reactions object { messageId -> { emoji -> [users] } }
     */
    getSentReactions(streamId) {
        if (!this.isUnlocked) return {};
        return this.cache.sentReactions?.[streamId] || {};
    }

    /**
     * Add a reaction to local storage (for write-only channels)
     * @param {string} streamId - Stream ID
     * @param {string} messageId - Message ID
     * @param {string} emoji - Emoji
     * @param {string} user - User address
     * @param {string} action - 'add' or 'remove'
     */
    async addSentReaction(streamId, messageId, emoji, user, action = 'add') {
        if (!this.isUnlocked) return;
        if (!this.cache.sentReactions) {
            this.cache.sentReactions = {};
        }
        if (!this.cache.sentReactions[streamId]) {
            this.cache.sentReactions[streamId] = {};
        }
        const reactions = this.cache.sentReactions[streamId];
        if (!reactions[messageId]) {
            reactions[messageId] = {};
        }
        if (!reactions[messageId][emoji]) {
            reactions[messageId][emoji] = [];
        }
        const normalizedUser = user.toLowerCase();
        const idx = reactions[messageId][emoji].findIndex(u => u.toLowerCase() === normalizedUser);
        if (action === 'remove') {
            if (idx >= 0) {
                reactions[messageId][emoji].splice(idx, 1);
                if (reactions[messageId][emoji].length === 0) delete reactions[messageId][emoji];
                if (Object.keys(reactions[messageId]).length === 0) delete reactions[messageId];
            }
        } else {
            if (idx < 0) reactions[messageId][emoji].push(user);
        }
        await this.saveToStorage();
        this.onSentDataChanged?.({ type: 'sentReaction', streamId });
    }

    // ==================== Blocked Peers (DM) ====================

    /**
     * Get list of blocked peer addresses
     * @returns {string[]} - Array of lowercase addresses
     */
    getBlockedPeers() {
        if (!this.isUnlocked) return [];
        return this.cache.blockedPeers || [];
    }

    /**
     * Check if a peer is blocked
     * @param {string} address - Peer address
     * @returns {boolean}
     */
    isBlocked(address) {
        if (!this.isUnlocked) return false;
        const normalized = address.toLowerCase();
        return (this.cache.blockedPeers || []).includes(normalized);
    }

    /**
     * Block a peer (all DM messages from this peer will be ignored)
     * @param {string} address - Peer address
     */
    async addBlockedPeer(address) {
        if (!this.isUnlocked) return;
        const normalized = address.toLowerCase();
        if (!this.cache.blockedPeers) {
            this.cache.blockedPeers = [];
        }
        if (!this.cache.blockedPeers.includes(normalized)) {
            this.cache.blockedPeers.push(normalized);
            this._stampSliceTs('blockedPeers');
            await this.saveToStorage();
            this.onBlockedPeersChanged?.({ type: 'add', address: normalized });
        }
    }

    /**
     * Unblock a peer
     * @param {string} address - Peer address
     */
    async removeBlockedPeer(address) {
        if (!this.isUnlocked) return;
        const normalized = address.toLowerCase();
        if (!this.cache.blockedPeers) return;
        const idx = this.cache.blockedPeers.indexOf(normalized);
        if (idx >= 0) {
            this.cache.blockedPeers.splice(idx, 1);
            this._stampSliceTs('blockedPeers');
            await this.saveToStorage();
            this.onBlockedPeersChanged?.({ type: 'remove', address: normalized });
        }
    }

    // ==================== DM Left At (Soft Leave) ====================

    /**
     * Get the leftAt timestamp for a DM peer (soft leave).
     * Messages with timestamp <= leftAt are ignored; newer messages resurface the conversation.
     * @param {string} address - Peer address
     * @returns {number|null} - Timestamp or null if not left
     */
    getDMLeftAt(address) {
        if (!this.isUnlocked) return null;
        const normalized = address.toLowerCase();
        return this.cache.dmLeftAt?.[normalized] ?? null;
    }

    /**
     * Get all dmLeftAt entries
     * @returns {Object} - { peerAddress: timestamp }
     */
    getAllDMLeftAt() {
        if (!this.isUnlocked) return {};
        return this.cache.dmLeftAt || {};
    }

    /**
     * Set leftAt timestamp for a DM peer (soft leave)
     * @param {string} address - Peer address
     * @param {number} timestamp - Leave timestamp
     */
    async setDMLeftAt(address, timestamp) {
        if (!this.isUnlocked) return;
        const normalized = address.toLowerCase();
        if (!this.cache.dmLeftAt) {
            this.cache.dmLeftAt = {};
        }
        this.cache.dmLeftAt[normalized] = timestamp;
        this._stampSliceTs('dmLeftAt');
        await this.saveToStorage();
        this.onSentDataChanged?.({ type: 'dmLeftAt', address: normalized });
    }

    /**
     * Clear leftAt for a DM peer (conversation resurfaced by new message)
     * @param {string} address - Peer address
     */
    async clearDMLeftAt(address) {
        if (!this.isUnlocked) return;
        const normalized = address.toLowerCase();
        if (this.cache.dmLeftAt?.[normalized]) {
            delete this.cache.dmLeftAt[normalized];
            this._stampSliceTs('dmLeftAt');
            await this.saveToStorage();
            this.onSentDataChanged?.({ type: 'dmLeftAt', address: normalized });
        }
    }

    // ==================== Last Opened Channel ====================

    /**
     * Get last opened channel (for session restore)
     * @returns {string|null} - streamId or null
     */
    getLastOpenedChannel() {
        if (!this.isUnlocked) return null;
        return this.cache.lastOpenedChannel || null;
    }

    /**
     * Set last opened channel
     * @param {string|null} streamId - Channel streamId or null to clear
     */
    async setLastOpenedChannel(streamId) {
        if (!this.isUnlocked) return;
        this.cache.lastOpenedChannel = streamId;
        await this.saveToStorage();
    }

    // ==================== Image Ledger (IndexedDB) ====================

    /**
     * Open (or create) the PomboImageStore IndexedDB.
     * Schema: { imageId (PK), streamId (indexed), encryptedData, iv, synced, ts }
     */
    async initImageStore() {
        if (this.isGuestMode) return;
        this.imageBlobCache = new Map();
        this.imageBlobCacheBytes = 0;

        return new Promise((resolve, reject) => {
            const request = indexedDB.open('PomboImageStore', 1);

            request.onupgradeneeded = (event) => {
                const db = event.target.result;
                if (!db.objectStoreNames.contains('images')) {
                    const store = db.createObjectStore('images', { keyPath: 'imageId' });
                    store.createIndex('byStream', 'streamId', { unique: false });
                    store.createIndex('bySynced', 'synced', { unique: false });
                }
            };

            request.onsuccess = (event) => {
                this.imageDB = event.target.result;
                Logger.info('📦 PomboImageStore opened');
                // Housekeeping: trim oldest images if ledger exceeds threshold
                this.evictOldImagesFromLedger().catch(() => {});
                // Request persistent storage to prevent browser eviction
                navigator.storage?.persist?.().catch(() => {});
                resolve();
            };

            request.onerror = (event) => {
                Logger.error('Failed to open PomboImageStore:', event.target.error);
                // Non-fatal: app keeps working, only IDB persistence lost
                resolve();
            };
        });
    }

    /**
     * Flush any images with inline imageData in sentMessages to the IDB ledger.
     * Idempotent: saveImageToLedger deduplicates by imageId.
     */
    async _flushCachedImagesToLedger() {
        if (!this.imageDB) return;
        for (const [streamId, msgs] of Object.entries(this.cache?.sentMessages || {})) {
            for (const msg of msgs) {
                if (msg.type === 'image' && msg.imageData && msg.imageId) {
                    await this.saveImageToLedger(msg.imageId, msg.imageData, streamId);
                }
            }
        }
    }

    /**
     * Encrypt a base64 image string with the current storage key.
     * Crypto is done OUTSIDE the IDB transaction to avoid TransactionInactiveError.
     * @param {string} data - base64 image data
     * @returns {Promise<{encryptedData: ArrayBuffer, iv: Uint8Array}>}
     */
    async encryptBlob(data) {
        const iv = crypto.getRandomValues(new Uint8Array(12));
        const encoded = new TextEncoder().encode(data);
        const encryptedData = await crypto.subtle.encrypt(
            { name: 'AES-GCM', iv },
            this.storageKey,
            encoded
        );
        return { encryptedData, iv };
    }

    /**
     * Decrypt a blob previously encrypted with encryptBlob.
     * @param {ArrayBuffer} encryptedData
     * @param {Uint8Array} iv
     * @returns {Promise<string>} base64 image data
     */
    async decryptBlob(encryptedData, iv) {
        const decrypted = await crypto.subtle.decrypt(
            { name: 'AES-GCM', iv: new Uint8Array(iv) },
            this.storageKey,
            encryptedData
        );
        return new TextDecoder().decode(decrypted);
    }

    /**
     * Persist an image to the IndexedDB ledger.
     * Deduplicates by imageId, encrypts outside transaction.
     * @param {string} imageId
     * @param {string} imageData - base64 data
     * @param {string} streamId
     */
    async saveImageToLedger(imageId, imageData, streamId) {
        if (!this.imageDB) return;

        try {
            // Check if already stored (read tx)
            const exists = await new Promise((resolve, reject) => {
                const tx = this.imageDB.transaction('images', 'readonly');
                const req = tx.objectStore('images').count(imageId);
                req.onsuccess = () => resolve(req.result > 0);
                req.onerror = () => reject(req.error);
            });
            if (exists) return false;

            // Encrypt OUTSIDE transaction
            const { encryptedData, iv } = await this.encryptBlob(imageData);

            // Write (new tx after async gap)
            await new Promise((resolve, reject) => {
                const tx = this.imageDB.transaction('images', 'readwrite');
                tx.objectStore('images').put({
                    imageId,
                    streamId,
                    encryptedData,
                    iv: Array.from(iv),
                    synced: 0,
                    ts: Date.now()
                });
                tx.oncomplete = () => resolve();
                tx.onerror = () => reject(tx.error);
            });

            // Update in-memory cache
            this._warmImageCache(imageId, imageData);
            Logger.debug(`📦 Image ${imageId.slice(0, 8)} saved to ledger`);
            return true;
        } catch (error) {
            Logger.error('saveImageToLedger failed:', error);
            // Non-fatal: image stays in localStorage cache anyway
            return false;
        }
    }

    /**
     * Retrieve image data with fallback chain:
     * 1. In-memory imageBlobCache
     * 2. cache.sentMessages scan
     * 3. IndexedDB ledger
     * @param {string} imageId
     * @returns {Promise<string|null>} base64 image data or null
     */
    async getImageBlob(imageId) {
        // 1. In-memory cache
        if (this.imageBlobCache?.has(imageId)) {
            return this.imageBlobCache.get(imageId);
        }

        // 2. Cache sentMessages scan
        if (this.cache?.sentMessages) {
            for (const msgs of Object.values(this.cache.sentMessages)) {
                for (const m of msgs) {
                    if (m.imageId === imageId && m.imageData) {
                        return m.imageData;
                    }
                }
            }
        }

        // 3. IndexedDB
        if (!this.imageDB || !this.storageKey) return null;
        let record;
        try {
            record = await new Promise((resolve, reject) => {
                const tx = this.imageDB.transaction('images', 'readonly');
                const req = tx.objectStore('images').get(imageId);
                req.onsuccess = () => resolve(req.result);
                req.onerror = () => reject(req.error);
            });
        } catch (error) {
            Logger.error('getImageBlob IDB read failed:', error);
            return null;
        }
        if (!record) return null;
        try {
            const data = await this.decryptBlob(record.encryptedData, record.iv);
            this._warmImageCache(imageId, data);
            return data;
        } catch (error) {
            // Corrupt record (storage key changed, partial write, etc.). Drop it
            // so the image can be recovered from the network on the next sync.
            Logger.warn('getImageBlob: corrupt record, removing from ledger', imageId, error.name || error.message);
            await this._deleteLedgerRecord(imageId);
            return null;
        }
    }

    /**
     * Delete a single image record from the IndexedDB ledger.
     * @param {string} imageId
     */
    async _deleteLedgerRecord(imageId) {
        if (!this.imageDB) return;
        try {
            await new Promise((resolve, reject) => {
                const tx = this.imageDB.transaction('images', 'readwrite');
                tx.objectStore('images').delete(imageId);
                tx.oncomplete = () => resolve();
                tx.onerror = () => reject(tx.error);
            });
            if (this.imageBlobCache?.has(imageId)) {
                this.imageBlobCacheBytes -= (this.imageBlobCache.get(imageId)?.length || 0);
                this.imageBlobCache.delete(imageId);
            }
        } catch (error) {
            Logger.error('_deleteLedgerRecord failed:', imageId, error);
        }
    }

    /**
     * Public API: delete a single image record from the IndexedDB ledger.
     * Called when the corresponding message is deleted by its author so the
     * blob does not linger locally and cannot be re-served by a stale
     * `loadImageFromLedger` triggered by a re-render race.
     * @param {string} imageId
     */
    async deleteImageFromLedger(imageId) {
        if (!imageId) return;
        await this._deleteLedgerRecord(imageId);
    }

    /**
     * Delete all images for a given stream from the IndexedDB ledger.
     * @param {string} streamId
     */
    async clearImagesForStream(streamId) {
        if (!this.imageDB) return;
        try {
            await new Promise((resolve, reject) => {
                const tx = this.imageDB.transaction('images', 'readwrite');
                const store = tx.objectStore('images');
                const index = store.index('byStream');
                const req = index.openCursor(IDBKeyRange.only(streamId));
                req.onsuccess = (event) => {
                    const cursor = event.target.result;
                    if (cursor) {
                        // Evict from memory cache too
                        const id = cursor.value.imageId;
                        if (this.imageBlobCache?.has(id)) {
                            this.imageBlobCacheBytes -= (this.imageBlobCache.get(id)?.length || 0);
                            this.imageBlobCache.delete(id);
                        }
                        cursor.delete();
                        cursor.continue();
                    }
                };
                tx.oncomplete = () => resolve();
                tx.onerror = () => reject(tx.error);
            });
            Logger.debug(`📦 Cleared images for stream ${streamId.slice(0, 12)}`);
        } catch (error) {
            Logger.error('clearImagesForStream failed:', error);
        }
    }

    /**
     * Evict oldest images when ledger exceeds a threshold.
     * Uses cursor on the default key (imageId) sorted by ts.
     * @param {number} [maxRecords=500] - Max images to keep
     */
    async evictOldImagesFromLedger(maxRecords = 500) {
        if (!this.imageDB) return;
        try {
            const count = await new Promise((resolve, reject) => {
                const tx = this.imageDB.transaction('images', 'readonly');
                const req = tx.objectStore('images').count();
                req.onsuccess = () => resolve(req.result);
                req.onerror = () => reject(req.error);
            });
            if (count <= maxRecords) return;

            // Collect all records sorted by ts, delete oldest
            const toDelete = await new Promise((resolve, reject) => {
                const ids = [];
                const tx = this.imageDB.transaction('images', 'readonly');
                const req = tx.objectStore('images').openCursor();
                const allRecords = [];
                req.onsuccess = (event) => {
                    const cursor = event.target.result;
                    if (cursor) {
                        allRecords.push({ imageId: cursor.value.imageId, ts: cursor.value.ts });
                        cursor.continue();
                    }
                };
                tx.oncomplete = () => {
                    allRecords.sort((a, b) => a.ts - b.ts);
                    const excess = allRecords.slice(0, count - maxRecords);
                    resolve(excess.map(r => r.imageId));
                };
                tx.onerror = () => reject(tx.error);
            });

            if (toDelete.length === 0) return;
            await new Promise((resolve, reject) => {
                const tx = this.imageDB.transaction('images', 'readwrite');
                const store = tx.objectStore('images');
                for (const id of toDelete) {
                    store.delete(id);
                    if (this.imageBlobCache?.has(id)) {
                        this.imageBlobCacheBytes -= (this.imageBlobCache.get(id)?.length || 0);
                        this.imageBlobCache.delete(id);
                    }
                }
                tx.oncomplete = () => resolve();
                tx.onerror = () => reject(tx.error);
            });
            Logger.info(`📦 Evicted ${toDelete.length} old images from ledger`);
        } catch (error) {
            Logger.error('evictOldImagesFromLedger failed:', error);
        }
    }

    /**
     * Get all unsynced image records (for partition 2 blob sync).
     * Returns an async generator to avoid loading all blobs at once.
     * @yields {{ imageId: string, streamId: string, encryptedData: ArrayBuffer, iv: number[] }}
     */
    async *getUnsyncedImages() {
        if (!this.imageDB) return;
        const keys = await new Promise((resolve, reject) => {
            const tx = this.imageDB.transaction('images', 'readonly');
            const index = tx.objectStore('images').index('bySynced');
            const req = index.getAllKeys(IDBKeyRange.only(0));
            req.onsuccess = () => resolve(req.result);
            req.onerror = () => reject(req.error);
        });
        for (const imageId of keys) {
            const record = await new Promise((resolve, reject) => {
                const tx = this.imageDB.transaction('images', 'readonly');
                const req = tx.objectStore('images').get(imageId);
                req.onsuccess = () => resolve(req.result);
                req.onerror = () => reject(req.error);
            });
            if (record) yield record;
        }
    }

    /**
     * Mark an image as synced in the ledger.
     * @param {string} imageId
     */
    async markImageSynced(imageId) {
        if (!this.imageDB) return;
        try {
            await new Promise((resolve, reject) => {
                const tx = this.imageDB.transaction('images', 'readwrite');
                const store = tx.objectStore('images');
                const req = store.get(imageId);
                req.onsuccess = () => {
                    const record = req.result;
                    if (record) {
                        record.synced = 1;
                        store.put(record);
                    }
                };
                tx.oncomplete = () => resolve();
                tx.onerror = () => reject(tx.error);
            });
        } catch (error) {
            Logger.error('markImageSynced failed:', error);
        }
    }

    // ==================== Lifecycle ==

    /**
     * Lock storage (on disconnect)
     */
    lock() {
        this.storageKey = null;
        this.cache = null;
        this.isUnlocked = false;
        this.address = null;
        this.isGuestMode = false;
        if (this.stateDB) {
            this.stateDB.close();
            this.stateDB = null;
        }
        if (this.imageDB) {
            this.imageDB.close();
            this.imageDB = null;
        }
        this.imageBlobCache = null;
        this.imageBlobCacheBytes = 0;
        Logger.info('🔒 Secure storage locked');
    }

    /**
     * Check if storage is unlocked/initialized
     */
    isStorageUnlocked() {
        return this.isUnlocked;
    }

    /**
     * Get current address
     */
    getCurrentAddress() {
        return this.address;
    }

    /**
     * Get storage statistics
     * @returns {Object} - Storage stats
     */
    getStats() {
        if (!this.isUnlocked || !this.cache) {
            return null;
        }

        const channels = this.cache.channels || [];

        return {
            channels: channels.length,
            contacts: Object.keys(this.cache.trustedContacts || {}).length,
            ensEntries: Object.keys(this.cache.ensCache || {}).length,
            hasUsername: !!this.cache.username,
            hasApiKey: !!this.cache.graphApiKey,
            version: this.cache.version
        };
    }

    // ==================== Cross-Device Sync ====================

    /**
     * Export state for cross-device sync.
     * Same data as account backup, but without sensitive session data.
     * @returns {Object} - State to sync
     */
    exportForSync() {
        if (!this.isUnlocked || !this.cache) {
            throw new Error('Storage not unlocked');
        }

        // Strip imageData from sent messages (synced separately via blob sync)
        const sentMessages = {};
        for (const [streamId, msgs] of Object.entries(this.cache.sentMessages || {})) {
            sentMessages[streamId] = msgs.map(m => {
                if (m.type === 'image') {
                    const { imageData, ...rest } = m;
                    return rest;
                }
                return m;
            });
        }

        return {
            sentMessages,
            sentDeletedAt: this.cache.sentDeletedAt || {},
            sentReactions: this.cache.sentReactions || {},
            channels: this.cache.channels || [],
            channelsLeftAt: this.cache.channelsLeftAt || {},
            epochKeys: this.cache.epochKeys || {},
            blockedPeers: this.cache.blockedPeers || [],
            dmLeftAt: this.cache.dmLeftAt || {},
            trustedContacts: this.cache.trustedContacts || {},
            ensCache: this.cache.ensCache || {},
            username: this.cache.username || null,
            graphApiKey: this.cache.graphApiKey || null,
            sliceTs: stampedSliceTs(this.cache)
        };
    }

    /**
     * Import merged state from sync.
     * Replaces local state with merged data from sync process.
     * @param {Object} data - Merged state from syncManager
     * @param {Object} [options]
     * @param {Function} [options.onChannelsWritten] - Called synchronously right after
     *   the channel slice is written, before any await: the channel map has to be
     *   reloaded in that same tick (a concurrent saveChannels() writes the map over it).
     * @returns {Promise<Object>} - Change summary for imported state slices
     */
    async importFromSync(data, { onChannelsWritten } = {}) {
        if (!this.isUnlocked || !this.cache) {
            throw new Error('Storage not unlocked');
        }

        const isEqual = (currentValue, nextValue) => JSON.stringify(currentValue) === JSON.stringify(nextValue);
        const changes = {
            hasChanges: false,
            channelsUpdated: false,
            epochKeysUpdated: false,
            contactsUpdated: false,
            blockedPeersUpdated: false,
            usernameUpdated: false,
            sentMessagesUpdated: false
        };

        if (data.sentMessages !== undefined && !isEqual(this.cache.sentMessages, data.sentMessages)) {
            this.cache.sentMessages = data.sentMessages;
            changes.sentMessagesUpdated = true;
            changes.hasChanges = true;
        }
        if (data.sentDeletedAt !== undefined && !isEqual(this.cache.sentDeletedAt, data.sentDeletedAt)) {
            this.cache.sentDeletedAt = data.sentDeletedAt;
            changes.hasChanges = true;
        }
        if (data.sentReactions !== undefined && !isEqual(this.cache.sentReactions, data.sentReactions)) {
            this.cache.sentReactions = data.sentReactions;
            changes.sentMessagesUpdated = true;
            changes.hasChanges = true;
        }
        if (data.channels !== undefined) {
            if (!isEqual(this.cache.channels, data.channels)) {
                this.cache.channels = data.channels;
                changes.channelsUpdated = true;
                changes.hasChanges = true;
                onChannelsWritten?.();
            }
        }
        if (data.channelsLeftAt !== undefined && !isEqual(this.cache.channelsLeftAt, data.channelsLeftAt)) {
            this.cache.channelsLeftAt = data.channelsLeftAt;
            changes.hasChanges = true;
        }
        if (data.epochKeys !== undefined && !isEqual(this.cache.epochKeys, data.epochKeys)) {
            this.cache.epochKeys = data.epochKeys;
            changes.epochKeysUpdated = true;
            changes.hasChanges = true;
        }
        if (data.blockedPeers !== undefined && !isEqual(this.cache.blockedPeers, data.blockedPeers)) {
            this.cache.blockedPeers = data.blockedPeers;
            changes.blockedPeersUpdated = true;
            changes.hasChanges = true;
        }
        if (data.dmLeftAt !== undefined && !isEqual(this.cache.dmLeftAt, data.dmLeftAt)) {
            this.cache.dmLeftAt = data.dmLeftAt;
            changes.hasChanges = true;
        }
        if (data.trustedContacts !== undefined && !isEqual(this.cache.trustedContacts, data.trustedContacts)) {
            this.cache.trustedContacts = data.trustedContacts;
            changes.contactsUpdated = true;
            changes.hasChanges = true;
        }
        if (data.ensCache !== undefined && !isEqual(this.cache.ensCache, data.ensCache)) {
            this.cache.ensCache = data.ensCache;
            changes.hasChanges = true;
        }
        if (data.username !== undefined) {
            if (this.cache.username !== data.username) {
                this.cache.username = data.username;
                changes.usernameUpdated = true;
                changes.hasChanges = true;
                // Also store in plain localStorage for pre-unlock display (unlock modal)
                if (this.address) {
                    if (data.username) {
                        localStorage.setItem(CONFIG.storageKeys.username(this.address), data.username);
                    } else {
                        localStorage.removeItem(CONFIG.storageKeys.username(this.address));
                    }
                }
            }
        }
        if (data.graphApiKey !== undefined && this.cache.graphApiKey !== data.graphApiKey) {
            this.cache.graphApiKey = data.graphApiKey;
            changes.hasChanges = true;
        }
        if (data.sliceTs !== undefined && !isEqual(this.cache.sliceTs, data.sliceTs)) {
            this.cache.sliceTs = data.sliceTs;
            changes.hasChanges = true;
        }

        if (!changes.hasChanges) {
            Logger.debug('📥 Sync import skipped - no state changes detected');
            return changes;
        }

        await this.saveToStorage();
        // Flush any imageData present in imported messages to IDB ledger
        // (preserves images that survived the merge but aren't yet in IDB)
        await this._flushCachedImagesToLedger();
        Logger.info('📥 Imported sync data');
        
        return changes;
    }

    // ==================== Account Backup with Scrypt ====================

    /**
     * Export complete account backup using scrypt (same security as Keystore V3)
     * Uses the same password as the account keystore
     * @param {Object} keystore - The account's Keystore V3 object
     * @param {string} password - Account password (verified against keystore before calling)
     * @param {Function} progressCallback - Optional progress callback (0-1)
     * @returns {Promise<Object>} - Complete backup object
     */
    async exportAccountBackup(keystore, password, progressCallback = null, options = {}) {
        if (!this.isUnlocked || !this.cache) {
            throw new Error('Storage not unlocked');
        }
        const includeSentDmMedia = options.includeSentDmMedia !== false;

        // Backup policy: only state with no other durable copy. Received
        // messages and media re-fetch from the storage nodes within retention;
        // the ENS cache re-resolves; slice timestamps describe the sync merge,
        // not the account. Epoch keys DO enter (via exportForBackup): paid
        // gates never re-distribute past epochs (D14), and an announce older
        // than the -4 retention can no longer anchor a re-adopted key — the
        // backup is the only recovery path for that history.
        const data = this.exportForBackup();
        delete data.ensCache;
        delete data.sliceTs;

        const dataToBackup = {
            version: 1,
            exportedAt: new Date().toISOString(),
            address: this.address,
            data,
            imageBlobs: includeSentDmMedia
                ? await this.exportImageBlobs(this.sentImageIds())
                : []
        };

        // Generate random salt for scrypt (different from keystore's salt)
        const salt = ethers.randomBytes(32);
        const iv = ethers.randomBytes(16);

        // Scrypt parameters (same as Keystore V3)
        const N = 131072;  // 2^17
        const r = 8;
        const p = 1;
        const dkLen = 32;

        // Derive key using scrypt (password must be UTF-8 bytes for ethers v6)
        Logger.debug('Deriving backup encryption key with scrypt...');
        const passwordBytes = ethers.toUtf8Bytes(password);
        let derivedKey;
        if (progressCallback) {
            derivedKey = await ethers.scrypt(passwordBytes, salt, N, r, p, dkLen, (progress) => {
                progressCallback(progress * 0.5); // 0-50% for key derivation
            });
        } else {
            derivedKey = await ethers.scrypt(passwordBytes, salt, N, r, p, dkLen);
        }

        // Convert hex string to bytes for Web Crypto
        const keyBytes = ethers.getBytes(derivedKey);

        // Import key for AES-GCM
        const cryptoKey = await crypto.subtle.importKey(
            'raw',
            keyBytes,
            { name: 'AES-GCM' },
            false,
            ['encrypt']
        );

        // Encrypt data
        if (progressCallback) progressCallback(0.6);
        const plaintext = new TextEncoder().encode(JSON.stringify(dataToBackup));
        const ciphertext = await crypto.subtle.encrypt(
            { name: 'AES-GCM', iv: iv },
            cryptoKey,
            plaintext
        );

        if (progressCallback) progressCallback(0.9);

        Logger.info('📤 Account backup created with scrypt encryption');

        return {
            format: 'pombo-account-backup',
            version: 1,
            exportedAt: new Date().toISOString(),
            // Include the keystore (already encrypted with scrypt)
            keystore: keystore,
            // Include encrypted data (also scrypt-protected)
            encryptedData: {
                kdf: 'scrypt',
                kdfparams: {
                    n: N,
                    r: r,
                    p: p,
                    dklen: dkLen,
                    salt: ethers.hexlify(salt)
                },
                cipher: 'aes-256-gcm',
                cipherparams: {
                    iv: ethers.hexlify(iv)
                },
                ciphertext: ethers.hexlify(new Uint8Array(ciphertext))
            }
        };
    }

    /**
     * Import complete account backup
     * @param {Object} backup - Backup object from exportAccountBackup
     * @param {string} password - Account password
     * @param {Function} progressCallback - Optional progress callback (0-1)
     * @returns {Promise<Object>} - { wallet, summary }
     */
    async importAccountBackup(backup, password, progressCallback = null) {
        if (backup.format !== 'pombo-account-backup' || backup.version !== 1) {
            throw new Error('Invalid backup format. Expected pombo-account-backup v1');
        }

        // Step 1: Decrypt keystore to recover wallet (verifies password)
        Logger.debug('Decrypting keystore from backup...');
        let wallet;
        try {
            if (progressCallback) {
                wallet = await ethers.Wallet.fromEncryptedJson(
                    JSON.stringify(backup.keystore),
                    password,
                    (progress) => progressCallback(progress * 0.4) // 0-40%
                );
            } else {
                wallet = await ethers.Wallet.fromEncryptedJson(
                    JSON.stringify(backup.keystore),
                    password
                );
            }
        } catch (error) {
            throw new Error('Incorrect password or corrupted backup');
        }

        // Step 2: Decrypt data using scrypt
        const enc = backup.encryptedData;
        const salt = ethers.getBytes(enc.kdfparams.salt);
        const iv = ethers.getBytes(enc.cipherparams.iv);
        const ciphertext = ethers.getBytes(enc.ciphertext);

        Logger.debug('Deriving data decryption key with scrypt...');
        const passwordBytes = ethers.toUtf8Bytes(password);
        let derivedKey;
        if (progressCallback) {
            derivedKey = await ethers.scrypt(
                passwordBytes, 
                salt, 
                enc.kdfparams.n, 
                enc.kdfparams.r, 
                enc.kdfparams.p, 
                enc.kdfparams.dklen,
                (progress) => progressCallback(0.4 + progress * 0.4) // 40-80%
            );
        } else {
            derivedKey = await ethers.scrypt(
                passwordBytes, 
                salt, 
                enc.kdfparams.n, 
                enc.kdfparams.r, 
                enc.kdfparams.p, 
                enc.kdfparams.dklen
            );
        }

        const keyBytes = ethers.getBytes(derivedKey);

        // Import key for AES-GCM
        const cryptoKey = await crypto.subtle.importKey(
            'raw',
            keyBytes,
            { name: 'AES-GCM' },
            false,
            ['decrypt']
        );

        // Decrypt data
        if (progressCallback) progressCallback(0.85);
        let decryptedData;
        try {
            const plaintext = await crypto.subtle.decrypt(
                { name: 'AES-GCM', iv: iv },
                cryptoKey,
                ciphertext
            );
            decryptedData = JSON.parse(new TextDecoder().decode(plaintext));
        } catch (error) {
            throw new Error('Failed to decrypt backup data');
        }

        if (progressCallback) progressCallback(1.0);

        Logger.info('📥 Account backup decrypted successfully');

        return {
            wallet: wallet,
            keystore: backup.keystore,
            data: decryptedData.data,
            address: decryptedData.address,
            exportedAt: decryptedData.exportedAt,
            imageBlobs: decryptedData.imageBlobs || []
        };
    }

    /**
     * Export full state for backup (includes imageData in sent messages).
     * Unlike exportForSync(), does NOT strip imageData.
     * @returns {Object} - Full state
     */
    exportForBackup() {
        if (!this.isUnlocked || !this.cache) {
            throw new Error('Storage not unlocked');
        }

        return {
            sentMessages: this.cache.sentMessages || {},
            sentDeletedAt: this.cache.sentDeletedAt || {},
            sentReactions: this.cache.sentReactions || {},
            channels: this.cache.channels || [],
            channelsLeftAt: this.cache.channelsLeftAt || {},
            epochKeys: this.cache.epochKeys || {},
            blockedPeers: this.cache.blockedPeers || [],
            dmLeftAt: this.cache.dmLeftAt || {},
            trustedContacts: this.cache.trustedContacts || {},
            ensCache: this.cache.ensCache || {},
            username: this.cache.username || null,
            graphApiKey: this.cache.graphApiKey || null,
            sliceTs: stampedSliceTs(this.cache)
        };
    }

    /**
     * Image ids referenced by the sent-message record — DMs and write-only
     * channels. These blobs have no other durable copy anywhere: an outgoing
     * DM lands in the PEER's inbox (owner-only reads) and a write-only stream
     * cannot be resent.
     * @returns {Set<string>}
     */
    sentImageIds() {
        const ids = new Set();
        for (const msgs of Object.values(this.cache?.sentMessages || {})) {
            for (const m of msgs) {
                if (m?.type === 'image' && m.imageId) ids.add(m.imageId);
            }
        }
        return ids;
    }

    /**
     * Export images from the IndexedDB ledger for backup.
     * Decrypts each image so the backup is self-contained.
     * @param {Set<string>|null} filterIds - When given, only these imageIds are exported
     * @returns {Promise<Array<{imageId: string, streamId: string, data: string}>>}
     */
    async exportImageBlobs(filterIds = null) {
        if (!this.imageDB || !this.storageKey) return [];
        try {
            const records = await new Promise((resolve, reject) => {
                const tx = this.imageDB.transaction('images', 'readonly');
                const all = [];
                const req = tx.objectStore('images').openCursor();
                req.onsuccess = (event) => {
                    const cursor = event.target.result;
                    if (cursor) {
                        all.push(cursor.value);
                        cursor.continue();
                    }
                };
                tx.oncomplete = () => resolve(all);
                tx.onerror = () => reject(tx.error);
            });
            const blobs = [];
            for (const record of records) {
                if (filterIds && !filterIds.has(record.imageId)) continue;
                try {
                    const data = await this.decryptBlob(record.encryptedData, record.iv);
                    blobs.push({ imageId: record.imageId, streamId: record.streamId, data });
                } catch {
                    Logger.warn(`Backup: Failed to decrypt image ${record.imageId}, skipping`);
                }
            }
            Logger.info(`📤 Exported ${blobs.length} image(s) for backup`);
            return blobs;
        } catch (error) {
            Logger.error('exportImageBlobs failed:', error);
            return [];
        }
    }

    /**
     * Import image blobs from a backup into the IndexedDB ledger.
     * @param {Array<{imageId: string, streamId: string, data: string}>} blobs
     */
    async importImageBlobs(blobs) {
        if (!this.imageDB) {
            await this.initImageStore();
        }
        let imported = 0;
        for (const { imageId, data, streamId } of blobs) {
            try {
                await this.saveImageToLedger(imageId, data, streamId);
                // Mark as synced — came from backup, no need to push
                await this.markImageSynced(imageId);
                imported++;
            } catch {
                Logger.warn(`Backup: Failed to import image ${imageId}, skipping`);
            }
        }
        Logger.info(`📥 Imported ${imported} image(s) from backup`);
    }
}

// Export singleton instance
export const secureStorage = new SecureStorage();
