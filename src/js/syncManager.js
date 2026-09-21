/**
 * Sync Manager
 * Cross-device synchronization using DM inbox.
 * 
 * Architecture:
 * - Partition 1 (SYNC): state payloads (channels, messages metadata, reactions)
 * - Partition 2 (SYNC_BLOBS): image blobs (heavy, incremental)
 * - ECDH self-encryption: only the owner can decrypt
 * - Pull fetches history from storage nodes, merges chronologically
 * - Push uploads current local state + unsynced blobs
 * 
 * Requirements:
 * - User must have created their DM inbox first (dmManager.createInbox)
 * - Sync operations silently skip if inbox doesn't exist
 */

import { Logger } from './logger.js';
import { CONFIG } from './config.js';
import { streamrController, STREAM_CONFIG } from './streamr.js';
import { secureStorage } from './secureStorage.js';
import { authManager } from './auth.js';
import { dmCrypto } from './dmCrypto.js';
import { channelManager } from './channels.js';
import { dmManager } from './dm.js';
import { identityManager } from './identity.js';
import { mergePayloadSeries as mergeSyncPayloadSeries, mergeSentMessages as mergeSyncSentMessages, mergeSentReactions as mergeSyncSentReactions, mergeState as mergeSyncState, mergeChannels as mergeSyncChannels, mergeEpochKeys as mergeSyncEpochKeys } from './syncMerge.js';
import { syncWorkerClient } from './workers/syncWorkerClient.js';
import { cryptoManager } from './crypto.js';
import { splitSyncPayload, reassembleSyncPayloads } from './syncChunks.js';

/** A snapshot is a RUN of messages, so the window must hold several of them. */
const SYNC_FETCH_COUNT = 60;

const getNow = () => (
    typeof performance !== 'undefined' && typeof performance.now === 'function'
        ? performance.now()
        : Date.now()
);

const roundDuration = (duration) => Number(duration.toFixed(1));

/**
 * How eagerly cross-device sync runs (Settings → Device Sync). These gate the
 * unprompted triggers only — the manual "Sync Devices" action runs in every
 * mode.
 */
export const SYNC_MODES = {
    /** Connect, foreground return, after a local change, and on hide. */
    AUTOMATIC: 'automatic',
    /** Skips the connect-time run; the foreground pull catches up. */
    NOT_ON_START: 'not_on_start',
    /** Nothing unprompted. Local changes wait for the next manual run. */
    MANUAL_ONLY: 'manual_only'
};

export const SYNC_MODE_LABELS = {
    [SYNC_MODES.AUTOMATIC]: 'Automatic',
    [SYNC_MODES.NOT_ON_START]: 'Skip on start',
    [SYNC_MODES.MANUAL_ONLY]: 'Manual only'
};

class SyncManager {
    constructor() {
        this.syncSubscription = null;
        this.lastSyncTs = null;
        this.handlers = [];
        this.isSyncing = false;
        this.foregroundSyncDepth = 0;
        this.foregroundSyncLabel = null;
        this.autoPushTimeout = null;
        this.autoPushRetryCount = 0;
        this.pushQueued = false;
    }

    // ==================== Sync Mode (which unprompted triggers fire) ====================

    /**
     * localStorage key for the per-account sync mode.
     * @returns {string|null}
     */
    _syncModeKey() {
        const address = authManager.getAddress();
        if (!address) return null;
        const keyFn = CONFIG.storageKeys?.syncMode;
        return keyFn ? keyFn(address) : `pombo_sync_mode_${address.toLowerCase()}`;
    }

    /**
     * An unrecognised stored value falls back to AUTOMATIC.
     * @returns {string} - One of SYNC_MODES
     */
    getSyncMode() {
        const key = this._syncModeKey();
        if (!key) return SYNC_MODES.AUTOMATIC;
        try {
            const stored = localStorage.getItem(key);
            return Object.values(SYNC_MODES).includes(stored) ? stored : SYNC_MODES.AUTOMATIC;
        } catch {
            return SYNC_MODES.AUTOMATIC;
        }
    }

    /**
     * Persist the sync mode for the current account.
     * @param {string} mode - One of SYNC_MODES
     * @returns {boolean} - False if the mode was rejected or could not be saved
     */
    setSyncMode(mode) {
        if (!Object.values(SYNC_MODES).includes(mode)) return false;
        const key = this._syncModeKey();
        if (!key) return false;
        try {
            localStorage.setItem(key, mode);
        } catch {
            return false;
        }
        // A push already on the debounce timer would still fire after the switch.
        if (mode === SYNC_MODES.MANUAL_ONLY) this.cancelAutoPush();
        Logger.info(`Sync: mode set to ${mode}`);
        this.notifyHandlers('sync_mode_changed', { mode });
        return true;
    }

    /**
     * Whether an unprompted sync may run now.
     * @param {string} trigger - 'start' | 'foreground' | 'change' | 'hide'
     * @returns {boolean}
     */
    isAutoSyncAllowed(trigger) {
        const mode = this.getSyncMode();
        if (mode === SYNC_MODES.MANUAL_ONLY) return false;
        if (mode === SYNC_MODES.NOT_ON_START && trigger === 'start') return false;
        return true;
    }

    // ==================== Dirty Flag (unsynced local state) ====================

    /**
     * localStorage key for the per-account dirty flag.
     * @returns {string|null}
     */
    _dirtyFlagKey() {
        const address = authManager.getAddress();
        if (!address) return null;
        const keyFn = CONFIG.storageKeys?.syncDirty;
        return keyFn ? keyFn(address) : `pombo_sync_dirty_${address.toLowerCase()}`;
    }

    /**
     * Mark local state as having changes not yet pushed to the storage node.
     * Survives reloads so startup can flush pending state with a push-first sync.
     */
    markDirty() {
        const key = this._dirtyFlagKey();
        if (!key) return;
        try {
            localStorage.setItem(key, '1');
        } catch { /* storage unavailable — non-critical */ }
    }

    /**
     * Clear the dirty flag (all local changes reached the storage node).
     */
    clearDirty() {
        const key = this._dirtyFlagKey();
        if (!key) return;
        try {
            localStorage.removeItem(key);
        } catch { /* non-critical */ }
    }

    /**
     * @returns {boolean} - True if local changes may not have been pushed yet
     */
    isDirty() {
        const key = this._dirtyFlagKey();
        if (!key) return false;
        try {
            return localStorage.getItem(key) === '1';
        } catch {
            return false;
        }
    }

    /**
     * If a push was requested while another sync operation was running,
     * run it now that the operation finished (short debounce).
     */
    _flushQueuedPush() {
        if (!this.pushQueued) return;
        this.pushQueued = false;
        this.scheduleAutoPush(1000);
    }

    // ==================== Applied Payload Tracking ====================
    // Storage node replicas can diverge (LOCAL_ONE round-robin reads): a
    // "last N" resend may return stale payloads that were already merged in
    // a previous pull. Re-merging them is redundant and can regress
    // remote-wins slices (sentReactions). We track the ts of every payload
    // already applied so stale reads become no-ops — and when a read is
    // provably stale (newest fetched < newest applied), one fresh resend
    // usually hits the other replica.

    /**
     * localStorage key for the per-account applied-payload ledger.
     * @returns {string|null}
     */
    _appliedTsKey() {
        const address = authManager.getAddress();
        if (!address) return null;
        const keyFn = CONFIG.storageKeys?.syncAppliedTs;
        return keyFn ? keyFn(address) : `pombo_sync_applied_ts_${address.toLowerCase()}`;
    }

    /**
     * @returns {Set<number>} - Payload timestamps already merged into local state
     */
    _getAppliedTsSet() {
        const key = this._appliedTsKey();
        if (!key) return new Set();
        try {
            const raw = localStorage.getItem(key);
            const list = raw ? JSON.parse(raw) : [];
            return new Set(Array.isArray(list) ? list : []);
        } catch {
            return new Set();
        }
    }

    /**
     * Record payload timestamps as applied (pruned to the newest 300).
     * @param {number[]} tsList
     */
    _recordAppliedTs(tsList) {
        const key = this._appliedTsKey();
        if (!key || !tsList.length) return;
        try {
            const set = this._getAppliedTsSet();
            for (const ts of tsList) {
                if (typeof ts === 'number') set.add(ts);
            }
            const pruned = Array.from(set).sort((a, b) => b - a).slice(0, 300);
            localStorage.setItem(key, JSON.stringify(pruned));
        } catch { /* storage unavailable — non-critical */ }
    }

    /**
     * Register event handler
     * @param {string} event - Event name
     * @param {Function} handler - Handler function
     */
    on(event, handler) {
        this.handlers.push({ event, handler });
    }

    /**
     * Remove event handler
     * @param {string} event - Event name
     * @param {Function} handler - Handler function to remove
     */
    off(event, handler) {
        this.handlers = this.handlers.filter(
            h => !(h.event === event && h.handler === handler)
        );
    }

    /**
     * Notify handlers of an event
     * @param {string} event - Event name
     * @param {Object} data - Event data
     */
    notifyHandlers(event, data) {
        for (const { event: e, handler } of this.handlers) {
            if (e === event) {
                try {
                    handler(data);
                } catch (err) {
                    Logger.error('Sync handler error:', err);
                }
            }
        }
    }

    /**
     * Emit the current foreground sync activity state.
     */
    notifyForegroundSyncState() {
        this.notifyHandlers('sync_activity', {
            active: this.foregroundSyncDepth > 0,
            label: this.foregroundSyncLabel || 'Syncing your data'
        });
    }

    /**
     * Run a user-visible sync task with a persistent header activity indicator.
     * @param {string} label - Header label shown while the task is running
     * @param {Function} task - Async task to execute
     * @returns {Promise<*>}
     */
    async runForegroundSync(label, task) {
        const activityLabel = label || this.foregroundSyncLabel || 'Syncing your data';
        this.foregroundSyncDepth += 1;
        this.foregroundSyncLabel = activityLabel;
        this.notifyForegroundSyncState();
        let succeeded = false;

        try {
            const result = await task();
            succeeded = true;
            return result;
        } finally {
            this.foregroundSyncDepth = Math.max(0, this.foregroundSyncDepth - 1);
            const shouldNotifySuccess = succeeded && this.foregroundSyncDepth === 0;
            if (this.foregroundSyncDepth === 0) {
                this.foregroundSyncLabel = null;
            }
            this.notifyForegroundSyncState();
            if (shouldNotifySuccess) {
                this.notifyHandlers('sync_activity_success', {
                    label: 'Sync complete',
                    activityLabel
                });
            }
        }
    }

    /**
     * Get the inbox stream ID for sync operations
     * @returns {string|null}
     */
    getInboxStreamId() {
        const myAddress = authManager.getAddress();
        if (!myAddress) return null;
        return streamrController.getDMInboxId(myAddress);
    }

    /**
     * Push current local state to sync partition.
     * Encrypts with self-ECDH so only the owner can decrypt.
     * @returns {Promise<Object|null>} - Published payload snapshot, or null if skipped
     */
    async pushSync() {
        if (authManager.isGuestMode()) {
            Logger.debug('Sync: Skipping push in guest mode');
            return null;
        }

        if (this.isSyncing) {
            Logger.warn('Sync: Already syncing, queueing push');
            this.pushQueued = true;
            return null;
        }

        // Check if inbox exists (required for sync)
        const hasInbox = await dmManager.hasInbox();
        if (!hasInbox) {
            Logger.debug('Sync: No inbox yet, skipping push');
            return null;
        }

        const privateKey = authManager.wallet?.privateKey;
        if (!privateKey) {
            throw new Error('Sync: No wallet private key available');
        }

        const inboxStreamId = this.getInboxStreamId();
        if (!inboxStreamId) {
            throw new Error('Sync: DM inbox not available');
        }

        this.isSyncing = true;

        try {
            // Gather state from secureStorage
            const state = secureStorage.exportForSync();

            const payload = {
                type: 'sync',
                v: 1,
                ts: Date.now(),
                data: state
            };

            // Sealed to ourselves, published under a throwaway identity.
            //
            // The inbox stream ID already names us, so this hides less than it
            // does for a real DM. What it does buy: our sync traffic becomes
            // indistinguishable from an incoming message, so an observer can no
            // longer read "this account is online and syncing right now" off
            // the publisherId.
            const myAddress = authManager.getAddress();
            const messages = splitSyncPayload(payload, cryptoManager.generateRandomHex(8));
            Logger.info('Sync: push', {
                bytes: JSON.stringify(payload).length,
                channels: state.channels?.length ?? 0,
                messages: messages.length
            });
            for (const message of messages) {
                await dmManager.sealAndPublish(
                    inboxStreamId, myAddress, message, STREAM_CONFIG.MESSAGE_STREAM.SYNC);
            }

            this.lastSyncTs = payload.ts;
            Logger.info('Sync: Pushed state to storage nodes', { ts: payload.ts });

            // Our own payload's data IS local state — mark as applied so a
            // later pull doesn't redundantly re-merge it.
            this._recordAppliedTs([payload.ts]);

            // All local changes up to this snapshot reached the storage node.
            // Keep the dirty flag if new mutations were scheduled meanwhile.
            if (!this.autoPushTimeout && !this.pushQueued) {
                this.clearDirty();
            }

            this.notifyHandlers('sync_pushed', { ts: payload.ts });
            return payload;
        } finally {
            this.isSyncing = false;
            this._flushQueuedPush();
        }
    }

    /**
     * Pull sync history and merge with local state.
     * Fetches all payloads, merges chronologically (older first, newer overwrites).
     * @param {Object} options
     * @param {number} options.limit - Max payloads to fetch (default: 10)
     * @returns {Promise<Object|null>} - Merged state or null if no sync data
     */
    async pullSync(options = {}) {
        if (authManager.isGuestMode()) {
            Logger.debug('Sync: Skipping pull in guest mode');
            return null;
        }

        if (this.isSyncing) {
            Logger.warn('Sync: Already syncing, skipping pull');
            return null;
        }

        // Check if inbox exists (required for sync)
        const hasInbox = await dmManager.hasInbox();
        if (!hasInbox) {
            Logger.debug('Sync: No inbox yet, skipping pull');
            return null;
        }

        const privateKey = authManager.wallet?.privateKey;
        if (!privateKey) {
            throw new Error('Sync: No wallet private key available');
        }

        const myAddress = authManager.getAddress()?.toLowerCase();
        const inboxStreamId = this.getInboxStreamId();
        if (!inboxStreamId) {
            throw new Error('Sync: DM inbox not available');
        }

        this.isSyncing = true;

        try {
            const pullStartedAt = getNow();
            Logger.info('Sync: Pulling from storage nodes...', {
                streamId: inboxStreamId,
                partition: STREAM_CONFIG.MESSAGE_STREAM.SYNC
            });

            // Fetch history from Partition 1 (SYNC)
            const messages = await streamrController.fetchPartitionHistory(
                inboxStreamId,
                STREAM_CONFIG.MESSAGE_STREAM.SYNC,
                options.limit || SYNC_FETCH_COUNT
            );
            const fetchCompletedAt = getNow();

            Logger.info('Sync: Fetched messages:', { count: messages.length });

            if (!messages.length) {
                Logger.info('Sync: No remote state found');
                return null;
            }

            // Decrypt payloads
            const decryptStartedAt = getNow();
            const myPubKey = dmCrypto.getMyPublicKey(privateKey);
            const aesKey = await dmCrypto.deriveSharedKey(privateKey, myPubKey);

            const decryptBatch = async (batch) => {
                const out = [];
                for (const msg of batch) {
                    // No publisherId check. Sealed pushes carry a throwaway
                    // publisher, so "is the publisher me?" is false for every
                    // one of our own payloads — it rejected the whole sync.
                    //
                    // But opening is NOT the whole check for a v2 envelope:
                    // it only proves the payload was ADDRESSED to us, and our
                    // static public key is in the inbox stream metadata for
                    // anyone to read. A stranger can seal {type:'sync'} to it
                    // and inject channels/contacts/bans into our merge. What
                    // proves AUTHORSHIP is the proof inside the ciphertext —
                    // the recovered sender must be this very wallet. (v1
                    // self-ECDH did not need this: deriving that key required
                    // our PRIVATE key on the sealing side too.)
                    try {
                        // Sealed (v2) or legacy self-ECDH — both appear here
                        // while old history is still in storage.
                        let payload = null;
                        if (dmCrypto.isSealed(msg.content)) {
                            const opened = await dmCrypto.open(msg.content, {
                                myPrivateKey: privateKey,
                                myAddress: authManager.getAddress()
                            });
                            if (opened.sender?.toLowerCase() ===
                                authManager.getAddress()?.toLowerCase()) {
                                payload = opened.message;
                            } else {
                                Logger.warn('Sync: sealed payload not authored by this wallet — dropped',
                                    { sender: opened.sender });
                            }
                        } else if (dmCrypto.isEncrypted(msg.content)) {
                            payload = await dmCrypto.decrypt(msg.content, aesKey);
                        }

                        if (!payload) {
                            Logger.debug('Sync: Message not encrypted, skipping');
                            continue;
                        }
                        Logger.debug('Sync: Decrypted payload', { type: payload.type, v: payload.v });
                        if (payload.v === 1
                                && ['sync', 'sync_chunk', 'sync_manifest'].includes(payload.type)) {
                            out.push(payload);
                        }
                    } catch (e) {
                        Logger.warn('Sync: Failed to decrypt payload', e.message);
                    }
                }
                return out;
            };

            const reassemble = (list) => reassembleSyncPayloads(
                list, (info) => Logger.warn('Sync: dropped an incomplete run', info));

            const decrypted = reassemble(await decryptBatch(messages));
            const decryptCompletedAt = getNow();

            Logger.info('Sync: Valid payloads found:', { count: decrypted.length });

            if (!decrypted.length) {
                Logger.info('Sync: No valid sync payloads found');
                return null;
            }

            // Skip payloads already merged in previous pulls/pushes — stale
            // replica reads must not re-merge old snapshots over newer state.
            const appliedTs = this._getAppliedTsSet();
            let freshPayloads = decrypted.filter(payload => !appliedTs.has(payload.ts));

            if (!freshPayloads.length) {
                const newestFetched = Math.max(...decrypted.map(payload => payload.ts));
                const newestApplied = appliedTs.size ? Math.max(...appliedTs) : 0;

                if (newestFetched < newestApplied) {
                    // Provably stale read: we've already applied something newer
                    // than everything this resend returned. Round-robin replica
                    // reads mean one fresh resend usually hits the other replica.
                    Logger.warn('Sync: Stale resend detected — retrying once', {
                        newestFetched: new Date(newestFetched).toISOString(),
                        newestApplied: new Date(newestApplied).toISOString()
                    });
                    const retryMessages = await streamrController.fetchPartitionHistory(
                        inboxStreamId,
                        STREAM_CONFIG.MESSAGE_STREAM.SYNC,
                        options.limit || SYNC_FETCH_COUNT
                    );
                    const retryDecrypted = reassemble(await decryptBatch(retryMessages));
                    freshPayloads = retryDecrypted.filter(payload => !appliedTs.has(payload.ts));
                }

                if (!freshPayloads.length) {
                    Logger.info('Sync: No new sync payloads (all previously applied)');
                    return null;
                }
            }

            // Sort by timestamp (oldest first) and merge all
            freshPayloads.sort((a, b) => a.ts - b.ts);

            const payloadsToMerge = [...freshPayloads];
            const optimisticPayload = options.optimisticPayload;
            if (optimisticPayload?.type === 'sync' && optimisticPayload.v === 1) {
                const optimisticAlreadyVisible = payloadsToMerge.some(
                    payload => payload.ts === optimisticPayload.ts
                );

                if (!optimisticAlreadyVisible) {
                    payloadsToMerge.push(optimisticPayload);
                    payloadsToMerge.sort((a, b) => a.ts - b.ts);
                    Logger.info('Sync: Using optimistic local snapshot until push propagates', {
                        ts: optimisticPayload.ts
                    });
                }
            }

            // Progressive merge: start with local state (preserving imageData),
            // apply each remote chronologically. Using exportForBackup() instead
            // of exportForSync() so local imageData is not stripped before merge.
            // The merge dedup keeps local versions, so images we already have
            // won't be lost when the remote version lacks imageData.
            const mergeStartedAt = getNow();
            const merged = await syncWorkerClient.mergePayloads(
                secureStorage.exportForBackup(),
                payloadsToMerge.map(payload => payload.data),
                CONFIG.dm.maxSentMessages
            );
            const mergeCompletedAt = getNow();

            // The worker merged against a snapshot, and importFromSync
            // replaces the channel slice wholesale — a channel added while
            // the merge ran (a backup import, a join) would be dropped.
            // Channels form an LWW-element-set, so re-merging against the
            // live cache is idempotent and keeps every entry added since the
            // snapshot while leave tombstones still remove theirs.
            const liveState = secureStorage.exportForBackup();
            const rebasedChannels = mergeSyncChannels(
                liveState.channels,
                merged.channels,
                liveState.channelsLeftAt,
                merged.channelsLeftAt
            );
            merged.channels = rebasedChannels.channels;
            merged.channelsLeftAt = rebasedChannels.channelsLeftAt;
            // Same race, worse cost: an epoch key adopted while the merge ran
            // would be dropped by the slice replace, and for a paid gate the
            // network never re-serves it.
            merged.epochKeys = mergeSyncEpochKeys(liveState.epochKeys, merged.epochKeys);

            // Apply final merged state
            const importStartedAt = getNow();
            const importResult = await secureStorage.importFromSync(merged);
            const importCompletedAt = getNow();
            importResult.currentChannelRemoved = false;

            // Reload channelManager if channels were updated
            if (importResult.channelsUpdated) {
                const reloadResult = channelManager.reloadChannelsFromSync();
                importResult.currentChannelRemoved = !!reloadResult.currentChannelRemoved;
                Logger.info('Sync: Reloaded channel list from sync snapshot', reloadResult);
            }

            if (importResult.contactsUpdated) {
                identityManager.loadTrustedContacts();
                Logger.info('Sync: Reloaded trusted contacts');
            }

            // Reload username in identity manager
            if (importResult.usernameUpdated) {
                identityManager.loadUsername();
            }

            const latestTs = payloadsToMerge[payloadsToMerge.length - 1].ts;
            this.lastSyncTs = latestTs;

            // Mark all merged payloads as applied so future stale replica
            // reads returning them become no-ops.
            this._recordAppliedTs(payloadsToMerge.map(payload => payload.ts));

            Logger.info('Sync: Merged remote state', {
                payloads: payloadsToMerge.length,
                latestTs: new Date(latestTs).toISOString()
            });
            Logger.info('Sync: Pull timings', {
                fetchMs: roundDuration(fetchCompletedAt - pullStartedAt),
                decryptMs: roundDuration(decryptCompletedAt - decryptStartedAt),
                mergeMs: roundDuration(mergeCompletedAt - mergeStartedAt),
                importMs: roundDuration(importCompletedAt - importStartedAt),
                totalMs: roundDuration(importCompletedAt - pullStartedAt)
            });

            this.notifyHandlers('sync_pulled', { ts: latestTs, changes: importResult });

            return merged;
        } finally {
            this.isSyncing = false;
            this._flushQueuedPush();
        }
    }

    /**
     * Merge two states together.
    * Strategy: channels, blockedPeers, dmLeftAt and trustedContacts use latest-wins snapshots
    * (incoming replaces base); sentMessages/sentReactions merge per-key with dedup;
    * ensCache uses union with incoming precedence.
     * @param {Object} base - Base state (local or accumulated)
     * @param {Object} incoming - Incoming state to merge
     * @returns {Object} - Merged state
     */
    mergeState(base, incoming) {
        return mergeSyncState(base, incoming, CONFIG.dm.maxSentMessages);
    }

    /**
     * Merge sent messages from two states.
     * Deduplicates by message ID, sorts by timestamp, trims to max.
     * @param {Object} local - Local sentMessages { streamId: [...messages] }
     * @param {Object} remote - Remote sentMessages
     * @returns {Object} - Merged sentMessages
     */
    mergeSentMessages(local, remote) {
        return mergeSyncSentMessages(local, remote, CONFIG.dm.maxSentMessages);
    }

    /**
     * Merge sent reactions from two states.
     * Per messageId: incoming (newer) state wins over base (handles removals correctly).
     * Entries only in base (local-only, not yet synced) are preserved.
     * @param {Object} local - Local sentReactions { streamId: { messageId: { emoji: [users] } } }
     * @param {Object} remote - Remote sentReactions (from newer sync payloads)
     * @returns {Object} - Merged sentReactions
     */
    mergeSentReactions(local, remote) {
        return mergeSyncSentReactions(local, remote);
    }

    /**
     * Push unsynced image blobs to Partition 2 (SYNC_BLOBS).
     * Small images travel as a single sync_blob message; larger images are split
     * across sync_blob_chunk messages followed by a sync_blob_manifest so the
     * payload always fits the Streamr per-message size limit.
     * Uses async generator to stream images one-at-a-time.
     */
    async pushImageBlobs() {
        if (authManager.isGuestMode()) return;
        if (this.isSyncing) return;

        const hasInbox = await dmManager.hasInbox();
        if (!hasInbox) return;

        const privateKey = authManager.wallet?.privateKey;
        if (!privateKey) return;

        const inboxStreamId = this.getInboxStreamId();
        if (!inboxStreamId) return;

        const myAddress = authManager.getAddress();

        // Match the chat-image protocol's raw chunk budget so each encrypted
        // sync_blob_chunk envelope stays under media.imagePayloadMaxBytes.
        const chunkChars = Math.max(1024, CONFIG?.media?.imageChunkInitialRawBytes || 150 * 1024);

        // Sealed to ourselves — see pushState. One ECDH per chunk rather than
        // one per push; blobs are chunked at ~150KB, so this is tens of
        // operations per image, not thousands.
        const publishPayload = async (payload) => {
            await dmManager.sealAndPublish(
                inboxStreamId,
                myAddress,
                payload,
                STREAM_CONFIG.MESSAGE_STREAM.SYNC_BLOBS
            );
        };

        let count = 0;
        let scanned = 0;
        for await (const record of secureStorage.getUnsyncedImages()) {
            scanned++;
            let imageData;
            try {
                imageData = await secureStorage.decryptBlob(record.encryptedData, record.iv);
            } catch (decryptErr) {
                Logger.warn('Sync: Corrupt local blob, removing from ledger', record.imageId, decryptErr.name || decryptErr.message);
                await secureStorage._deleteLedgerRecord(record.imageId);
                continue;
            }
            try {
                if (typeof imageData !== 'string' || imageData.length === 0) {
                    Logger.warn('Sync: Skipping blob with empty data', record.imageId);
                    continue;
                }

                if (imageData.length <= chunkChars) {
                    await publishPayload({
                        type: 'sync_blob',
                        v: 2,
                        ts: Date.now(),
                        imageId: record.imageId,
                        streamId: record.streamId,
                        data: imageData
                    });
                    Logger.debug('Sync: Pushed blob (single)', record.imageId, { bytes: imageData.length });
                } else {
                    const chunkCount = Math.ceil(imageData.length / chunkChars);
                    for (let i = 0; i < chunkCount; i++) {
                        const slice = imageData.slice(i * chunkChars, (i + 1) * chunkChars);
                        await publishPayload({
                            type: 'sync_blob_chunk',
                            v: 2,
                            ts: Date.now(),
                            imageId: record.imageId,
                            streamId: record.streamId,
                            chunkIndex: i,
                            chunkCount,
                            data: slice
                        });
                    }
                    await publishPayload({
                        type: 'sync_blob_manifest',
                        v: 2,
                        ts: Date.now(),
                        imageId: record.imageId,
                        streamId: record.streamId,
                        chunkCount,
                        totalLength: imageData.length
                    });
                    Logger.debug('Sync: Pushed blob (chunked)', record.imageId, { chunkCount, bytes: imageData.length });
                }

                await secureStorage.markImageSynced(record.imageId);
                count++;
            } catch (err) {
                Logger.warn('Sync: Failed to push blob', record.imageId, err.message);
            }
        }

        Logger.debug(`Sync: pushImageBlobs done — scanned=${scanned} pushed=${count}`);
    }

    /**
     * Pull image blobs from Partition 2 (SYNC_BLOBS).
     * Imports blobs from other devices into the local IndexedDB ledger.
     * @param {Object} options
     * @param {number} options.limit - Max messages to fetch (default: 200).
     *   Chunked images consume many messages (one per ~150KB chunk plus a
     *   manifest), so a small window can cut off older chunks and make blob
     *   assembly fail with "incomplete" even though the data is stored.
     */
    async pullImageBlobs(options = {}) {
        if (authManager.isGuestMode()) return;
        if (this.isSyncing) return;

        const hasInbox = await dmManager.hasInbox();
        if (!hasInbox) return;

        const privateKey = authManager.wallet?.privateKey;
        if (!privateKey) return;

        const myAddress = authManager.getAddress()?.toLowerCase();
        const inboxStreamId = this.getInboxStreamId();
        if (!inboxStreamId) return;

        const messages = await streamrController.fetchPartitionHistory(
            inboxStreamId,
            STREAM_CONFIG.MESSAGE_STREAM.SYNC_BLOBS,
            options.limit || 200
        );

        if (!messages.length) return;

        const myPubKey = dmCrypto.getMyPublicKey(privateKey);
        const aesKey = await dmCrypto.deriveSharedKey(privateKey, myPubKey);

        const importBlob = async (imageId, streamId, data) => {
            const saved = await secureStorage.saveImageToLedger(imageId, data, streamId);
            await secureStorage.markImageSynced(imageId);
            if (saved) {
                this.notifyHandlers('blob_pulled', { imageId, data });
                return true;
            }
            return false;
        };

        // Decrypt every payload up front. Streamr resend(...) does not guarantee
        // chronological delivery and chunks/manifest published in rapid succession
        // can share the same millisecond timestamp, so we cannot rely on ordering.
        // Two-pass: gather chunks first, then resolve manifests against them.
        const decoded = [];
        for (const msg of messages) {
            // No publisherId filter: sealed blobs carry a throwaway publisher,
            // so `publisherId === me` would drop every one of our own. Opening
            // proves the blob was addressed to us; authorship comes from the
            // proof inside — the recovered sender must be this wallet, or a
            // stranger could plant image blobs in our synced state (same rule
            // as decryptBatch above; our static pubkey is public).
            try {
                let payload = null;
                if (dmCrypto.isSealed(msg.content)) {
                    const opened = await dmCrypto.open(msg.content, {
                        myPrivateKey: privateKey,
                        myAddress: authManager.getAddress()
                    });
                    if (opened.sender?.toLowerCase() === myAddress) {
                        payload = opened.message;
                    } else {
                        Logger.warn('Sync: sealed blob not authored by this wallet — dropped',
                            { sender: opened.sender });
                    }
                } else if (msg.publisherId?.toLowerCase() === myAddress && dmCrypto.isEncrypted(msg.content)) {
                    payload = await dmCrypto.decrypt(msg.content, aesKey);
                }

                if (payload && payload.v === 2) decoded.push(payload);
            } catch (err) {
                Logger.debug('Sync: Could not open blob payload', err.message);
            }
        }

        const pendingChunkedBlobs = new Map();
        const manifests = [];
        const singles = [];

        for (const payload of decoded) {
            if (payload.type === 'sync_blob') {
                singles.push(payload);
            } else if (payload.type === 'sync_blob_chunk') {
                const entry = pendingChunkedBlobs.get(payload.imageId) || {
                    parts: new Map(),
                    chunkCount: payload.chunkCount,
                    streamId: payload.streamId
                };
                entry.parts.set(payload.chunkIndex, payload.data);
                if (Number.isInteger(payload.chunkCount)) entry.chunkCount = payload.chunkCount;
                if (!entry.streamId && payload.streamId) entry.streamId = payload.streamId;
                pendingChunkedBlobs.set(payload.imageId, entry);
            } else if (payload.type === 'sync_blob_manifest') {
                manifests.push(payload);
            }
        }

        const chunkedImageIds = pendingChunkedBlobs.size;
        let imported = 0;

        for (const payload of singles) {
            try {
                if (await importBlob(payload.imageId, payload.streamId, payload.data)) {
                    imported++;
                }
            } catch (err) {
                Logger.warn('Sync: Failed to import blob', err.message);
            }
        }

        for (const payload of manifests) {
            const entry = pendingChunkedBlobs.get(payload.imageId);
            pendingChunkedBlobs.delete(payload.imageId);
            if (!entry) {
                Logger.warn('Sync: blob manifest without chunks', payload.imageId);
                continue;
            }
            const chunkCount = payload.chunkCount;
            if (entry.parts.size !== chunkCount) {
                Logger.warn('Sync: blob assembly incomplete', payload.imageId, {
                    expected: chunkCount,
                    got: entry.parts.size
                });
                continue;
            }
            let assembled = '';
            let ok = true;
            for (let i = 0; i < chunkCount; i++) {
                const slice = entry.parts.get(i);
                if (typeof slice !== 'string') { ok = false; break; }
                assembled += slice;
            }
            if (!ok) {
                Logger.warn('Sync: blob assembly missing chunk', payload.imageId);
                continue;
            }
            if (Number.isFinite(payload.totalLength) && assembled.length !== payload.totalLength) {
                Logger.warn('Sync: blob assembly length mismatch', payload.imageId, {
                    expected: payload.totalLength,
                    got: assembled.length
                });
                continue;
            }
            const streamId = payload.streamId || entry.streamId;
            try {
                if (await importBlob(payload.imageId, streamId, assembled)) {
                    imported++;
                }
            } catch (err) {
                Logger.warn('Sync: Failed to import blob', err.message);
            }
        }

        Logger.debug(`Sync: pullImageBlobs done — fetched=${messages.length} singles=${singles.length} chunkedImageIds=${chunkedImageIds} manifests=${manifests.length} imported=${imported}`);
    }

    /**
     * Smart sync: push first (snapshot local state), then pull (accept latest remote).
     * Push-first ensures our state is on the storage node before we pull,
     * so leaving a channel is respected (our push without the channel is the latest).
     * Also syncs image blobs via Partition 2.
     *
     * Phases are independent: a push failure (e.g. transient RPC error during
     * the publish permission check) must not abort the pull, and vice versa.
     * Throws only when BOTH phases fail; partial failures are reported in the
     * result (pushError/pullError) — the dirty flag stays set on push failure,
     * so a later auto-push recovers.
     * @returns {Promise<{pulled: boolean, pushed: boolean, noInbox: boolean, pushError?: string, pullError?: string}>}
     */
    async smartSync() {
        if (authManager.isGuestMode()) {
            Logger.debug('Sync: Skipping smart sync in guest mode');
            return { pulled: false, pushed: false, noInbox: false };
        }

        // Check if inbox exists
        const hasInbox = await dmManager.hasInbox();
        if (!hasInbox) {
            Logger.info('Sync: No inbox yet, skipping smart sync');
            return { pulled: false, pushed: false, noInbox: true };
        }

        Logger.info('Sync: Starting smart sync...');
        const result = { pulled: false, pushed: false, noInbox: false };
        let optimisticPayload = null;
        let pushError = null;
        let pullError = null;

        // Push phase (partition 1 state + partition 2 blobs)
        try {
            optimisticPayload = await this.pushSync();
            result.pushed = true;
            await this.pushImageBlobs();
        } catch (err) {
            pushError = err;
            result.pushError = err.message;
            Logger.warn('Sync: Smart sync push phase failed (continuing to pull)', err.message);
            // Local state didn't reach the storage node — the dirty flag is
            // still set; schedule a recovery push instead of waiting for the
            // next mutation/foreground event.
            this.scheduleAutoPush(30000);
        }

        // Pull phase (partition 1 state + partition 2 blobs)
        try {
            const pullResult = await this.pullSync(
                optimisticPayload ? { optimisticPayload } : undefined
            );
            result.pulled = pullResult !== null;
            await this.pullImageBlobs();
        } catch (err) {
            pullError = err;
            result.pullError = err.message;
            Logger.warn('Sync: Smart sync pull phase failed', err.message);
        }

        if (pushError && pullError) {
            Logger.error('Sync: Smart sync failed (both phases)', pushError);
            throw pushError;
        }

        Logger.info('Sync: Smart sync completed', result);
        this.notifyHandlers('sync_complete', result);

        return result;
    }

    /**
     * Full sync with verification: push, wait, then pull to verify.
     * Used when user wants to ensure data is synced.
     * @param {number} delay - Delay in ms to wait for storage propagation (default: 5000)
     * @returns {Promise<{pushed: boolean, verified: boolean}>}
     */
    async fullSyncWithVerify(delay = 5000) {
        if (authManager.isGuestMode()) {
            return { pushed: false, verified: false };
        }

        const hasInbox = await dmManager.hasInbox();
        if (!hasInbox) {
            return { pushed: false, verified: false, noInbox: true };
        }

        try {
            // Push first (state + blobs)
            await this.pushSync();
            await this.pushImageBlobs();
            
            // Wait for storage propagation
            Logger.info(`Sync: Waiting ${delay}ms for storage propagation...`);
            await new Promise(resolve => setTimeout(resolve, delay));
            
            // Pull to verify (state + blobs)
            const pullResult = await this.pullSync();
            await this.pullImageBlobs();
            
            return { 
                pushed: true, 
                verified: pullResult !== null 
            };
        } catch (err) {
            Logger.error('Sync: Full sync with verify failed', err);
            throw err;
        }
    }

    /**
     * Schedule an auto-push with debounce.
     * Useful for triggering sync after user actions.
     * Marks the account dirty so a missed push is recovered at next startup.
     * On success also pushes unsynced image blobs; on failure retries with
     * exponential backoff (capped at 5 minutes).
     * @param {number} delay - Debounce delay in ms (default: 15000)
     */
    scheduleAutoPush(delay = 15000) {
        if (authManager.isGuestMode()) return;

        // Recorded before the gate: "Manual only" defers the publish, it does
        // not discard the change.
        this.markDirty();
        if (!this.isAutoSyncAllowed('change')) return;

        // Clear existing timeout
        if (this.autoPushTimeout) {
            clearTimeout(this.autoPushTimeout);
        }

        this.autoPushTimeout = setTimeout(async () => {
            this.autoPushTimeout = null;
            try {
                const pushed = await this.pushSync();
                if (pushed) {
                    await this.pushImageBlobs();
                }
                this.autoPushRetryCount = 0;
                Logger.info('Sync: Auto-push completed');
            } catch (err) {
                this.autoPushRetryCount += 1;
                const retryDelay = Math.min(15000 * 2 ** this.autoPushRetryCount, 300000);
                Logger.warn('Sync: Auto-push failed', err.message);
                Logger.debug(`Sync: Auto-push retry in ${retryDelay}ms (attempt ${this.autoPushRetryCount})`);
                this.scheduleAutoPush(retryDelay);
            }
        }, delay);
    }

    /**
     * Cancel any pending auto-push
     */
    cancelAutoPush() {
        if (this.autoPushTimeout) {
            clearTimeout(this.autoPushTimeout);
            this.autoPushTimeout = null;
        }
        this.autoPushRetryCount = 0;
        this.pushQueued = false;
    }

    /**
     * Force immediate push (e.g., on page unload)
     * Uses synchronous-friendly approach
     */
    async forcePushNow() {
        this.cancelAutoPush();
        // Leaving the page is still an unprompted publish; the dirty flag survives.
        if (!this.isAutoSyncAllowed('hide')) return;
        if (!authManager.isGuestMode() && !this.isSyncing) {
            try {
                await this.pushSync();
            } catch (err) {
                Logger.warn('Sync: Force push failed', err.message);
            }
        }
    }

    /**
     * Full sync: push then pull (state + blobs).
     * Push first to snapshot local state, then pull and merge remote changes.
     */
    async fullSync() {
        await this.pushSync();
        await this.pushImageBlobs();
        await this.pullSync();
        await this.pullImageBlobs();
    }

    /**
     * Get sync status
     * @returns {Object} - { lastSyncTs, isSyncing }
     */
    getStatus() {
        return {
            lastSyncTs: this.lastSyncTs,
            isSyncing: this.isSyncing
        };
    }
}

export const syncManager = new SyncManager();
