/**
 * ChannelLatestMessageManager
 *
 * Single source of truth for the "latest message preview" rendered in the
 * sidebar (ChannelListUI) and the Explore grid (ExploreUI).
 *
 * Responsibilities:
 *   - In-memory cache keyed by messageStreamId so every UI surface reads
 *     from the same Map without redundant work.
 *   - Inflight de-duplication: parallel `get()` calls for the same channel
 *     reuse a single in-flight resend Promise — at most one round-trip
 *     per channel, regardless of how many UI surfaces ask for the preview.
 *   - Persistent IndexedDB cache so cold starts don't refetch unchanged
 *     entries (DB: PomboChannelLastMessages, store: messages).
 *   - Listener API for reactive re-render: UIs subscribe by messageStreamId
 *     and get notified whenever a fresher entry lands.
 *
 * Source of truth precedence (highest first):
 *   1. `setFromLocal()` — fed by channels.js when a message is added /
 *      edited / deleted in `channel.messages` (live updates after the user
 *      has the channel subscribed).
 *   2. `_fetch()` — `streamrController.resendLatestContentMessages(...)`,
 *      used for cold start / channels not subscribed yet (sidebar of a
 *      channel the user hasn't opened, or Explore cards).
 *
 * Stored entry shape:
 *   {
 *     id?: string,            // message id when known
 *     ts: number,              // ms epoch
 *     type: 'text' | 'image' | 'file_announce' | 'reaction',
 *     sender: string|null,     // 0x... lowercased; null for empty caches
 *     text?: string,
 *     emoji?: string,          // reactions
 *     action?: 'add'|'remove', // reactions
 *     targetId?: string        // reactions
 *   }
 *
 * Edits / deletes are intentionally NOT applied on the resend path: the
 * preview must stay snappy. Edits surface only after the user has opened
 * the channel (live path via `setFromLocal`).
 */

import { Logger } from './logger.js';
import { streamrController } from './streamr.js';
import { isMessageStream } from './streamConstants.js';
import { CONFIG } from './config.js';

const DB_NAME = 'PomboChannelLastMessages';
const STORE_NAME = 'messages';
const DB_VERSION = 1;

class ChannelLatestMessageManager {
    constructor() {
        // messageStreamId -> entry
        this.cache = new Map();
        // messageStreamId -> Promise<entry|null>
        this.inflight = new Map();
        // messageStreamId -> Set<callback>
        this.listeners = new Map();
        this.db = null;
        this._initPromise = null;
    }

    /**
     * Open the IndexedDB. Idempotent.
     * @returns {Promise<void>}
     */
    async init() {
        if (this.db) return;
        if (this._initPromise) return this._initPromise;
        this._initPromise = new Promise((resolve) => {
            try {
                const req = indexedDB.open(DB_NAME, DB_VERSION);
                req.onupgradeneeded = (e) => {
                    const db = e.target.result;
                    if (!db.objectStoreNames.contains(STORE_NAME)) {
                        db.createObjectStore(STORE_NAME, { keyPath: 'messageStreamId' });
                    }
                };
                req.onsuccess = (e) => {
                    this.db = e.target.result;
                    Logger.debug('ChannelLatestMessageManager IDB opened');
                    // Block init resolution on hydrate to close the
                    // race where _fetch / setFromLocal land before the
                    // IDB rows are merged — otherwise the stale row
                    // would clobber the fresh in-memory entry.
                    this._hydrateFromIDB().catch(() => {}).then(() => resolve());
                };
                req.onerror = (e) => {
                    Logger.warn('ChannelLatestMessageManager IDB open failed:', e.target.error?.message);
                    resolve();
                };
            } catch (e) {
                Logger.warn('ChannelLatestMessageManager IDB unavailable:', e?.message);
                resolve();
            }
        });
        return this._initPromise;
    }

    async _hydrateFromIDB() {
        if (!this.db) return;
        try {
            const entries = await new Promise((resolve, reject) => {
                const tx = this.db.transaction(STORE_NAME, 'readonly');
                const req = tx.objectStore(STORE_NAME).getAll();
                req.onsuccess = () => resolve(req.result || []);
                req.onerror = () => reject(req.error);
            });
            let merged = 0;
            for (const row of entries) {
                if (!row?.messageStreamId || !row?.entry) continue;
                const prev = this.cache.get(row.messageStreamId);
                if (prev) {
                    // Stale guard — never let an IDB row clobber a
                    // fresher in-memory entry that arrived via
                    // setFromLocal or _fetch while hydrate was pending.
                    if ((prev.ts || 0) >= (row.entry.ts || 0)) continue;
                    if (prev.id && row.entry.id
                        && prev.id === row.entry.id
                        && prev.type === row.entry.type) continue;
                }
                this.cache.set(row.messageStreamId, row.entry);
                merged++;
            }
            Logger.debug(`ChannelLatestMessageManager hydrated ${merged}/${entries.length} entries from IDB`);
        } catch (e) {
            Logger.debug('ChannelLatestMessageManager hydrate failed:', e?.message);
        }
    }

    async _persistToIDB(messageStreamId, entry) {
        if (!this.db) return;
        try {
            await new Promise((resolve, reject) => {
                const tx = this.db.transaction(STORE_NAME, 'readwrite');
                tx.objectStore(STORE_NAME).put({ messageStreamId, entry });
                tx.oncomplete = () => resolve();
                tx.onerror = () => reject(tx.error);
            });
        } catch (e) {
            Logger.debug('ChannelLatestMessageManager persist failed:', e?.message);
        }
    }

    /**
     * Synchronously read cached entry. Returns null if not loaded yet.
     * @param {string} messageStreamId
     * @returns {Object|null}
     */
    getCached(messageStreamId) {
        if (!messageStreamId) return null;
        return this.cache.get(messageStreamId) || null;
    }

    /**
     * Fetch (or refresh) the latest preview entry for `messageStreamId`.
     * - If cached and not `force`, returns immediately AND triggers a
     *   background refresh (so subsequent reads see the latest entry).
     * - If not cached or `force`, awaits a fresh resend.
     * - Concurrent calls for the same id share a single Promise.
     *
     * @param {string} messageStreamId
     * @param {Object} [opts]
     * @param {string|null} [opts.password]
     * @param {boolean} [opts.force]
     * @param {number} [opts.last]
     * @returns {Promise<Object|null>}
     */
    async get(messageStreamId, { password = null, force = false, last = null } = {}) {
        if (!messageStreamId) return null;
        if (!isMessageStream(messageStreamId)) {
            // Defensive: callers should always pass -1 ids
            Logger.debug('ChannelLatestMessageManager.get: not a -1 id', messageStreamId);
        }
        await this.init();

        const cached = this.cache.get(messageStreamId);
        if (cached && !force) {
            if (!this.inflight.has(messageStreamId)) {
                this._fetch(messageStreamId, password, last).catch(() => {});
            }
            return cached;
        }

        if (this.inflight.has(messageStreamId)) {
            return this.inflight.get(messageStreamId);
        }

        const promise = this._fetch(messageStreamId, password, last);
        this.inflight.set(messageStreamId, promise);
        try {
            return await promise;
        } finally {
            this.inflight.delete(messageStreamId);
        }
    }

    async _fetch(messageStreamId, password, last) {
        try {
            const entries = await streamrController.resendLatestContentMessages(
                messageStreamId,
                {
                    last: last || CONFIG.channels?.latestMessageFetchLast || 10,
                    password
                }
            );
            if (!Array.isArray(entries) || entries.length === 0) {
                return this.cache.get(messageStreamId) || null;
            }
            // Reactions never make a preview line. They live on the -5 now, so
            // this window holds none — except on channels created before that
            // stream existed, which still carry them on P0. Entries are
            // newest-first; the first content one wins, and a window with
            // nothing but reactions leaves the previous preview standing.
            let normalized = null;
            for (const raw of entries) {
                if (raw?.type === 'reaction') continue;
                const n = this._normalizeRemoteEntry(raw);
                if (n) { normalized = n; break; }
            }
            if (!normalized) {
                return this.cache.get(messageStreamId) || null;
            }

            const prev = this.cache.get(messageStreamId);
            // Stale guard: never overwrite a fresher local entry
            if (prev && (prev.ts || 0) > (normalized.ts || 0)) {
                return prev;
            }
            // Same id + same type → no-op, UNLESS the new fetch enriches
            // missing metadata (e.g. payloads from older sessions stored
            // without `senderName` are now arriving with it populated).
            if (prev && prev.id && prev.id === normalized.id && prev.type === normalized.type) {
                const enriches = (!prev.senderName && normalized.senderName);
                if (!enriches) return prev;
            }

            this.cache.set(messageStreamId, normalized);
            this._persistToIDB(messageStreamId, normalized).catch(() => {});
            this._emit(messageStreamId, normalized);
            return normalized;
        } catch (e) {
            Logger.debug('ChannelLatestMessageManager._fetch error:', e?.message);
            return this.cache.get(messageStreamId) || null;
        }
    }

    /**
     * @private
     * Convert a `resendLatestContentMessages` entry into the canonical
     * preview shape used by the cache / listeners.
     */
    _normalizeRemoteEntry(raw) {
        if (!raw || typeof raw !== 'object') return null;
        const t = raw.type;
        // Same forged-timestamp clamp the message ingest applies — this resend path does
        // not pass through MessageFlow, so a future-dated payload would
        // otherwise still surface in the sidebar/Explore preview line.
        const payloadTs = Number(raw.timestamp || 0);
        const envTs = Number(raw._timestamp || 0);
        const skew = CONFIG.gate.timestampSkewMs;
        if (payloadTs && (payloadTs > Date.now() + skew
            || (envTs && payloadTs > envTs + skew))) return null;
        const ts = Number(raw._timestamp || raw.timestamp || 0) || Date.now();
        // Reactions carry no `sender`; use the publisher injected by streamr.js
        const sender = (raw.sender || raw._publisherId || null);
        const senderText = sender ? String(sender) : null;
        // User-set display name carried in the message payload (set by
        // identityManager when publishing). Highest-priority preview label.
        const senderName = typeof raw.senderName === 'string' && raw.senderName.trim()
            ? raw.senderName.trim()
            : null;

        if (t === 'text') {
            return {
                id: raw.id || null,
                ts,
                type: 'text',
                sender: senderText,
                senderName,
                text: typeof raw.text === 'string' ? raw.text : ''
            };
        }
        if (t === 'image') {
            return {
                id: raw.id || null,
                ts,
                type: 'image',
                sender: senderText,
                senderName
            };
        }
        if (t === 'file_announce' || t === 'storage_file_announce') {
            return {
                id: raw.id || null,
                ts,
                type: t,
                sender: senderText,
                senderName
            };
        }
        if (t === 'reaction') {
            // Reaction removals are ignored — they are noise for the
            // preview line (would flicker "reacted" → "removed" → next msg).
            if (raw.action === 'remove') return null;
            return {
                id: null,                   // reactions don't have a stable preview id
                ts,
                type: 'reaction',
                sender: senderText,
                senderName,
                emoji: typeof raw.emoji === 'string' ? raw.emoji : '',
                action: 'add',
                targetId: raw.messageId || null
            };
        }
        return null;
    }

    /**
     * Update the cache from a local message object that just landed in
     * `channel.messages` (or is being mutated by an edit/delete).
     *
     * Accepts the same shapes used elsewhere in the app:
     *   - text:           { type:'text', id, text, sender, timestamp }
     *   - image:          { type:'image', id, sender, timestamp, ... }
     *   - file_announce: { type:'file_announce', id, sender, timestamp, ... }
     *   - reaction:       { type:'reaction', emoji, action, messageId, sender, timestamp }
     *
     * For deletes, callers should pass the *previous* visible message
     * (already resolved by `channels.js`); this manager doesn't walk
     * `channel.messages` itself.
     *
     * @param {string} messageStreamId
     * @param {Object} message - app-shape message
     * @returns {Object|null} stored entry (or null if rejected)
     */
    setFromLocal(messageStreamId, message) {
        if (!messageStreamId || !message || typeof message !== 'object') return null;
        const t = message.type;
        if (t !== 'text' && t !== 'image' && t !== 'file_announce' && t !== 'storage_file_announce' && t !== 'reaction') {
            return null;
        }
        // Reaction removals never enter the preview — see _normalizeRemoteEntry.
        if (t === 'reaction' && message.action === 'remove') return null;
        const ts = Number(message.timestamp || message._timestamp || Date.now()) || Date.now();
        const sender = message.sender || message._publisherId || null;
        const senderText = sender ? String(sender) : null;
        const senderName = typeof message.senderName === 'string' && message.senderName.trim()
            ? message.senderName.trim()
            : null;

        let entry;
        if (t === 'text') {
            entry = {
                id: message.id || null,
                ts,
                type: 'text',
                sender: senderText,
                senderName,
                text: typeof message.text === 'string' ? message.text : ''
            };
        } else if (t === 'image') {
            entry = { id: message.id || null, ts, type: 'image', sender: senderText, senderName };
        } else if (t === 'file_announce' || t === 'storage_file_announce') {
            entry = { id: message.id || null, ts, type: t, sender: senderText, senderName };
        } else {
            entry = {
                id: null,
                ts,
                type: 'reaction',
                sender: senderText,
                senderName,
                emoji: typeof message.emoji === 'string' ? message.emoji : '',
                action: 'add',
                targetId: message.messageId || null
            };
        }

        const prev = this.cache.get(messageStreamId);
        // Stale guard: don't overwrite with an older entry
        if (prev && (prev.ts || 0) > entry.ts) return prev;
        // Same id + same type → no-op (prevents re-render flicker),
        // unless the new entry enriches metadata that was missing
        // (e.g. senderName arriving on a re-publish path).
        if (prev && prev.id && entry.id && prev.id === entry.id && prev.type === entry.type) {
            const enriches = (!prev.senderName && entry.senderName);
            if (!enriches) return prev;
        }

        this.cache.set(messageStreamId, entry);
        this._persistToIDB(messageStreamId, entry).catch(() => {});
        this._emit(messageStreamId, entry);
        return entry;
    }

    /**
     * Clear the cache for a channel (e.g. on delete-leave).
     */
    clear(messageStreamId) {
        if (!messageStreamId) return;
        this.cache.delete(messageStreamId);
        this._emit(messageStreamId, null);
        if (this.db) {
            try {
                const tx = this.db.transaction(STORE_NAME, 'readwrite');
                tx.objectStore(STORE_NAME).delete(messageStreamId);
            } catch {}
        }
    }

    /**
     * Subscribe to updates for one channel. Returns an unsubscribe function.
     * @param {string} messageStreamId
     * @param {(entry: Object|null) => void} cb
     */
    subscribe(messageStreamId, cb) {
        if (!messageStreamId || typeof cb !== 'function') return () => {};
        let set = this.listeners.get(messageStreamId);
        if (!set) {
            set = new Set();
            this.listeners.set(messageStreamId, set);
        }
        set.add(cb);
        return () => {
            const s = this.listeners.get(messageStreamId);
            if (s) {
                s.delete(cb);
                if (!s.size) this.listeners.delete(messageStreamId);
            }
        };
    }

    _emit(messageStreamId, entry) {
        const set = this.listeners.get(messageStreamId);
        if (!set) return;
        for (const cb of set) {
            try { cb(entry); } catch (e) { Logger.debug('ChannelLatestMessage listener error:', e?.message); }
        }
    }
}

export const channelLatestMessageManager = new ChannelLatestMessageManager();
