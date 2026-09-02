/**
 * Channel Manager
 * Manages channel creation, joining, and local storage
 * 
 * DUAL-STREAM ARCHITECTURE (v2):
 * Each channel now has two streams:
 * - messageStreamId (-1): Stored messages, reactions, images
 * - ephemeralStreamId (-2): Presence, typing, media chunks (not stored)
 */

import { Logger } from './logger.js';
import { streamrController, STREAM_CONFIG, deriveEphemeralId, deriveMessageId, deriveAdminId, deriveKeysId } from './streamr.js';
import { authManager } from './auth.js';
import { identityManager } from './identity.js';
import { secureStorage } from './secureStorage.js';
import { graphAPI } from './graph.js';
import { relayManager } from './relayManager.js';
import { parseChainError } from './utils/chainErrors.js';
import { dmManager } from './dm.js';
import { dmCrypto } from './dmCrypto.js';
import { CONFIG } from './config.js';
import { StorageError } from './utils/errors.js';
import { mediaController } from './media.js';
import { adminStatePoller } from './adminStatePoller.js';
import { channelImageManager } from './channelImageManager.js';
import { channelLatestMessageManager } from './channelLatestMessageManager.js';
import { epochKeyManager } from './epochKeyManager.js';
import { readStreamRetention, keysRetentionDays, retentionInSync } from './streamRetention.js';
import { PresenceTracker } from './channels/PresenceTracker.js';
import { ImageRecovery } from './channels/ImageRecovery.js';
import { TtlRepublish } from './channels/TtlRepublish.js';
import { MessageOverrides } from './channels/MessageOverrides.js';
import { MessageFlow } from './channels/MessageFlow.js';
import { AdminState } from './channels/AdminState.js';
import { Membership } from './channels/Membership.js';

class ChannelManager {
    constructor() {
        this.channels = new Map(); // streamId -> channel object
        this.currentChannel = null;
        // Gated PREVIEW shadow (N-D): a token/NFT holder browsing from
        // Explore. The preview lives outside `channels` on purpose (it must
        // never persist or sync), but the gated paths — _gatedChannelFor,
        // epoch refresh — resolve channels through this manager, so without
        // the shadow a gated preview silently degrades to ungated handling.
        // Set/cleared by PreviewModeUI.
        this.previewChannel = null;
        this.switchGeneration = 0; // Incremented on every channel switch to detect stale async results
        this.messageHandlers = [];
        
        // Callback for post-save sync (set by app.js to avoid circular dependency)
        this.onChannelsSaved = null;
        
        // Online presence tracking
        this.presence = new PresenceTracker(this);
        
        // AbortController for in-flight history fetches - aborted on channel switch
        this.historyAbortController = null;
        
        this.imageRecovery = new ImageRecovery(this);
        this.ttlRepublish = new TtlRepublish(this);
        this.overrides = new MessageOverrides(this);
        this.messageFlow = new MessageFlow(this);
        this.adminState = new AdminState(this);
        this.membership = new Membership(this);
    }

    /**
     * Apply persisted channel metadata onto an existing runtime channel object,
     * preserving in-memory state that should survive storage reloads.
     * @param {Object} channelData - Persisted channel metadata
     * @param {Object|null} existing - Existing runtime channel, if any
     * @returns {Object}
     * @private
     */
    _hydrateStoredChannel(channelData, existing = null) {
        const target = existing || {};
        const preserved = existing ? {
            messages: Array.isArray(existing.messages) ? existing.messages : [],
            reactions: existing.reactions && typeof existing.reactions === 'object' ? existing.reactions : {},
            historyLoaded: existing.historyLoaded === true,
            hasMoreHistory: existing.hasMoreHistory !== undefined ? existing.hasMoreHistory : true,
            loadingHistory: existing.loadingHistory === true,
            oldestTimestamp: existing.oldestTimestamp ?? null,
            adminState: existing.adminState && typeof existing.adminState === 'object'
                ? existing.adminState
                : this._createEmptyAdminState(),
            adminRev: Number.isFinite(existing.adminRev) ? existing.adminRev : 0,
            adminLoaded: existing.adminLoaded === true,
            adminTs: Number.isFinite(existing.adminTs) ? existing.adminTs : 0,
            initialLoadInProgress: existing.initialLoadInProgress === true,
            _publishPermCache: existing._publishPermCache || null
        } : {
            messages: [],
            reactions: {},
            historyLoaded: false,
            hasMoreHistory: true,
            loadingHistory: false,
            oldestTimestamp: null,
            adminState: this._createEmptyAdminState(),
            adminRev: 0,
            adminLoaded: false,
            adminTs: 0,
            initialLoadInProgress: false,
            _publishPermCache: null
        };

        Object.assign(target, channelData);
        target.messages = preserved.messages;
        target.reactions = preserved.reactions;
        target.historyLoaded = preserved.historyLoaded;
        target.hasMoreHistory = preserved.hasMoreHistory;
        target.loadingHistory = preserved.loadingHistory;
        target.oldestTimestamp = preserved.oldestTimestamp;
        target.streamId = target.messageStreamId;
        if (!target.adminStreamId) {
            target.adminStreamId = deriveAdminId(target.messageStreamId);
        }
        if (!target.keysStreamId && target.type === 'gated') {
            target.keysStreamId = deriveKeysId(target.messageStreamId);
        }
        target.adminState = preserved.adminState;
        target.adminRev = preserved.adminRev;
        target.adminLoaded = preserved.adminLoaded;
        target.adminTs = preserved.adminTs;
        target.initialLoadInProgress = preserved.initialLoadInProgress;
        target._publishPermCache = preserved._publishPermCache;

        // Wire identity: records persisted (or synced) before the rename
        // carry authorMode 'members'/'everyone' — same axis, old names.
        if (!target.wireIdentity && target.authorMode) {
            target.wireIdentity = target.authorMode === 'members' ? 'sealed' : 'visible';
        }
        if (target.wireIdentity === 'members') target.wireIdentity = 'sealed';
        if (target.wireIdentity === 'everyone') target.wireIdentity = 'visible';
        // A gated channel persisted without the field is from before the mode
        // existed — Visible by definition. Channels created with the mode
        // always persist it, and the gate repair below re-reads it from the
        // on-chain metadata whenever it runs.
        if (target.type === 'gated' && !target.wireIdentity) {
            target.wireIdentity = 'visible';
        }

        // Gated channel without its gate address — persisted by an old build
        // or restored from a sync snapshot that lost it. Repair from the
        // stream's on-chain metadata, HERE in the hydrator so every restore
        // path (initial load, sync reload) heals; publishes stay loud-failing
        // until it lands.
        if (target.type === 'gated' && !target.gate?.address) {
            this._repairGateAddress(target).catch(e =>
                Logger.warn('Gate repair failed for', target.messageStreamId?.slice(-20), '—', e.message));
        }

        // The CONTRACT is the authority on the identity mode and the
        // read-only flag; the stream-metadata copies are mutable and even
        // erasable by a failed rename. Reconcile once per session — a
        // mismatch only ever means the metadata copy drifted.
        if (target.type === 'gated' && target.gate?.address) {
            this._reconcileGateAuthority(target).catch(e =>
                Logger.warn('Gate authority read failed for', target.messageStreamId?.slice(-20), '—', e.message));
        }

        return target;
    }

    async _reconcileGateAuthority(channel) {
        this._gateAuthorityChecked ??= new Set();
        if (this._gateAuthorityChecked.has(channel.messageStreamId)) return;
        this._gateAuthorityChecked.add(channel.messageStreamId);
        const { gateManager } = await import('./gate.js');
        const info = await gateManager.getGateInfo(channel.gate.address);
        const mode = info.wireIdentityName === 'sealed' ? 'sealed' : 'visible';
        let changed = false;
        if (channel.wireIdentity !== mode) {
            channel.wireIdentity = mode;
            changed = true;
        }
        if (!!channel.readOnly !== info.readOnly) {
            channel.readOnly = info.readOnly;
            changed = true;
        }
        // Session cache of "may I write here": _needsPubKey consults it so a
        // plain member of a read-only channel stops requesting the shared
        // publish key nobody may hand them.
        if (info.readOnly) {
            const self = authManager.getAddress();
            channel._selfMayPublishReadOnly = self
                ? await gateManager.canModerate(channel.gate.address, self)
                : false;
        }
        if (changed) {
            Logger.info('Gate authority corrected the local record:',
                channel.messageStreamId?.slice(-20), '→', mode, info.readOnly ? '(read-only)' : '');
            await this.saveChannels();
        }
    }

    /**
     * Load channels from secure storage (encrypted)
     */
    loadChannels() {
        if (!secureStorage.isStorageUnlocked()) {
            Logger.warn('Secure storage not unlocked - cannot load channels');
            return;
        }
        
        const channelsData = secureStorage.getChannels();
        Logger.debug('Loading channels from secure storage');

        if (channelsData && channelsData.length > 0) {
            for (const channel of channelsData) {
                const hydrated = this._hydrateStoredChannel(
                    channel,
                    this.channels.get(channel.messageStreamId) || null
                );
                this.channels.set(hydrated.messageStreamId, hydrated);
            }

            Logger.debug(`Loaded ${channelsData.length} channels from secure storage (metadata only)`);
            Logger.debug('Channels in map:', Array.from(this.channels.keys()));
        } else {
            Logger.debug('No saved channels found');
        }
    }

    /**
     * Recover a gated channel's gate address from the -1 stream's on-chain
     * metadata (the `g` field written at creation). The chain is the system
     * of record — local persistence is only a warm-start cache of it.
     * @private
     */
    async _repairGateAddress(channel) {
        // One in-flight repair per channel — the hydrator fires on every
        // load/sync pass and repairs must not stack.
        this._gateRepairsPending ??= new Set();
        if (this._gateRepairsPending.has(channel.messageStreamId)) return;
        this._gateRepairsPending.add(channel.messageStreamId);
        try {
            await this._doRepairGateAddress(channel);
        } finally {
            this._gateRepairsPending.delete(channel.messageStreamId);
        }
    }

    async _doRepairGateAddress(channel) {
        const flags = await this.readGateFromMetadata(channel.messageStreamId, { withMode: true });
        if (!flags?.gateAddress) throw new Error('no gate address in stream metadata');
        channel.gate = { address: flags.gateAddress };
        channel.wireIdentity = flags.wireIdentity;
        await this.saveChannels();
        Logger.info('Gate address repaired from metadata:', channel.messageStreamId?.slice(-20), '→', flags.gateAddress);
    }

    /**
     * The gate clone address from a stream's on-chain metadata (`g`, written
     * at creation), or null when the stream is not a gated channel. With
     * `withMode`, returns { gateAddress, wireIdentity } — the `m` flag lives in
     * the same metadata JSON and is immutable, like the gate.
     */
    async readGateFromMetadata(messageStreamId, { withMode = false } = {}) {
        const stream = await graphAPI.getStream(messageStreamId);
        if (!stream?.metadata) return null;
        try {
            const outer = JSON.parse(stream.metadata || '{}');
            const pombo = JSON.parse(outer.description || '{}');
            const gateAddress = typeof pombo.g === 'string' ? pombo.g.toLowerCase() : null;
            const valid = /^0x[0-9a-f]{40}$/.test(gateAddress || '') ? gateAddress : null;
            if (!withMode) return valid;
            return valid
                ? { gateAddress: valid, wireIdentity: pombo.m === 1 ? 'sealed' : 'visible' }
                : null;
        } catch {
            return null;
        }
    }

    /**
     * Channels without an on-chain name (hidden gated, unknown streams) land
     * with an ID-derived or invite-suggested name. When the entry flow did not
     * already ask (`named`), offer the local name + classification panel via
     * the UI hook. Fire-and-forget: the join itself never waits on this.
     * @param {Object} channel - The just-added channel record
     * @param {boolean} named - Entry flow already collected a user-typed name
     */
    _maybeRequestLocalIdentity(channel, named = false) {
        if (named || !this.onNeedsLocalIdentity || channel.type === 'dm') return;
        (async () => {
            try {
                const info = await graphAPI.getChannelInfo(channel.messageStreamId);
                if (info?.name) return;
            } catch {
                // Graph unreachable: cannot prove the name is null — skip the ask
                return;
            }
            if (!this.channels.has(channel.messageStreamId)) return;
            this.onNeedsLocalIdentity?.(channel);
        })();
    }

    /**
     * Reload channels authoritatively from the latest synced storage snapshot.
     * Preserves runtime state only for channels that still exist in the snapshot.
     * @returns {{currentChannelRemoved: boolean, totalChannels: number}}
     */
    reloadChannelsFromSync() {
        if (!secureStorage.isStorageUnlocked()) {
            Logger.warn('Secure storage not unlocked - cannot reload synced channels');
            return {
                currentChannelRemoved: false,
                totalChannels: this.channels.size
            };
        }

        const channelsData = secureStorage.getChannels() || [];
        const nextChannels = new Map();

        for (const channel of channelsData) {
            const hydrated = this._hydrateStoredChannel(
                channel,
                this.channels.get(channel.messageStreamId) || null
            );
            nextChannels.set(hydrated.messageStreamId, hydrated);
        }

        const previousCurrentChannel = this.currentChannel;
        const removedStreamIds = Array.from(this.channels.keys()).filter(
            streamId => !nextChannels.has(streamId)
        );
        const currentChannelRemoved = !!previousCurrentChannel && !nextChannels.has(previousCurrentChannel);

        if (currentChannelRemoved) {
            this.setCurrentChannel(null);
        }

        for (const streamId of removedStreamIds) {
            this.clearStreamTransientState(streamId);
            this.onlineUsers.delete(streamId);
        }

        this.channels = nextChannels;

        Logger.debug(`Reloaded ${channelsData.length} channels from sync snapshot (authoritative)`);

        return {
            currentChannelRemoved,
            totalChannels: nextChannels.size
        };
    }

    /**
     * Save channels to secure storage (encrypted)
     * NOTE: messages and reactions are NOT persisted - they come from storage
     */
    async saveChannels() {
        try {
            if (!secureStorage.isStorageUnlocked()) {
                Logger.warn('Secure storage not unlocked - cannot save channels');
                return;
            }
            
            // Strip messages and reactions from persistence - only save metadata
            // Messages are loaded from storage on demand (lazy loading)
            const channelsData = Array.from(this.channels.values()).map(ch => ({
                messageStreamId: ch.messageStreamId,
                ephemeralStreamId: ch.ephemeralStreamId,
                adminStreamId: ch.adminStreamId,
                name: ch.name,
                type: ch.type,
                // Gated (N-C): without the gate address every gated code path
                // silently degrades after a reload — the publish falls back to
                // an ephemeral key the network rejects (MISSING_PERMISSION).
                gate: ch.gate || null,
                // Author visibility — losing it would flip a Members-only
                // channel back to clone publishes (account on the wire).
                wireIdentity: ch.wireIdentity || null,
                createdAt: ch.createdAt,
                createdBy: ch.createdBy,
                // Local membership timestamp — drives per-channel latest-wins
                // in cross-device sync (join vs leave tombstone comparison)
                joinedAt: ch.joinedAt || ch.createdAt || null,
                password: ch.password,
                members: ch.members || [],
                // Access losses this device has already rotated the epoch for;
                // without it every admin open would rotate again for the same
                // cut. (rotatedForBanned is the older, narrower name of the same set.)
                rotatedForNoAccess: ch.rotatedForNoAccess || ch.rotatedForBanned || [],
                // Who had gate access at the last sweep — losing it is what
                // triggers the deferred rotation.
                accessSnapshot: ch.accessSnapshot || [],
                // Addresses banned from here, kept as gate-read candidates so
                // Moderation can still list them after a reload.
                knownBanned: ch.knownBanned || [],
                storageEnabled: ch.storageEnabled,
                // Retention per stored stream, last read off-chain. Fallbacks
                // for when the Graph is unreachable on a later open, and the
                // only value the headless epoch-key sweep can consult: unsaved,
                // every reload reverts them to the 180-day default and disarms
                // both the TTL republish and the key re-announce.
                storageDays: ch.storageDays ?? null,
                adminStorageDays: ch.adminStorageDays ?? null,
                keysStorageDays: ch.keysStorageDays ?? null,
                // Exposure and metadata
                exposure: ch.exposure || 'hidden',
                description: ch.description || '',
                language: ch.language || '',
                category: ch.category || '',
                // Timestamp of the last local on-chain metadata edit (name/description)
                // — prevents Graph indexing lag from reverting local admin edits
                metaUpdatedAt: ch.metaUpdatedAt || null,
                // Channel options
                readOnly: ch.readOnly || false,
                writeOnly: ch.writeOnly || false,
                classification: ch.classification || null,
                // DM-specific
                peerAddress: ch.peerAddress || null,
                inboxStreamId: ch.inboxStreamId || null
                // messages: excluded - loaded from storage
                // reactions: excluded - loaded from storage
                // adminState: excluded - rebuilt from -3/P0 on subscribe
            }));
            Logger.debug('Saving channels to secure storage:', channelsData.length);

            await secureStorage.setChannels(channelsData);
            Logger.debug('Channels saved to secure storage (metadata only)');

            // Schedule auto-push to sync (debounced 30s)
            this.onChannelsSaved?.();
        } catch (error) {
            Logger.error('Failed to save channels:', error);
            throw new StorageError(
                'Failed to save channels to secure storage',
                'CHANNELS_SAVE_FAILED',
                { cause: error }
            );
        }
    }

    /**
     * Clear channels when switching wallets
     */
    clearChannels() {
        this.channels.clear();
        this.setCurrentChannel(null);
        this.onlineUsers.clear();
        this.processingMessages.clear();
        this.sendingMessages.clear();
        this.pendingReactions.clear();
        // Cancel all pending batch verifications
        for (const [streamId, batch] of this.pendingVerifications) {
            if (batch.timer) clearTimeout(batch.timer);
        }
        this.pendingVerifications.clear();
        this.pendingFlushPromises.clear();
        this.pendingOverrides.clear();
        Logger.debug('Channels cleared from memory');
    }

    /**
     * Refresh channel name/description from on-chain metadata (via The Graph)
     * for all non-DM channels. Picks up admin renames so members who already
     * joined see the updated name in the sidebar.
     * @returns {Promise<boolean>} - true if any channel changed
     */
    async refreshChannelMetadataFromGraph() {
        let changed = false;

        for (const channel of this.channels.values()) {
            if (!channel || channel.type === 'dm') continue;

            let info = null;
            try {
                info = await graphAPI.getChannelInfo(channel.streamId);
            } catch (e) {
                Logger.debug('Metadata refresh: Graph lookup failed for', channel.streamId, e.message);
                continue;
            }
            if (!info) continue;

            // Skip if The Graph data predates a local admin edit — indexing lag
            // would otherwise revert the channel to its previous name/description
            if (channel.metaUpdatedAt && (!info.updatedAt || info.updatedAt <= channel.metaUpdatedAt)) {
                Logger.debug('Metadata refresh: skipping (Graph data older than local edit):', channel.streamId);
                continue;
            }

            // Name: on-chain name is authoritative for non-DM channels (admin-managed)
            if (info.name && info.name !== channel.name) {
                Logger.info('Metadata refresh: channel renamed on-chain:', channel.name, '→', info.name);
                channel.name = info.name;
                if (channel.channelInfo) channel.channelInfo.name = info.name;
                changed = true;
            }

            // Description: only for visible channels (hidden channels keep description off-chain)
            if (info.exposure === 'visible'
                && typeof info.description === 'string'
                && info.description !== (channel.description || '')) {
                channel.description = info.description;
                if (channel.channelInfo) channel.channelInfo.description = info.description;
                changed = true;
            }
        }

        if (changed) {
            await this.saveChannels();
        }
        return changed;
    }

    /**
     * Create a new channel
     * @param {string} name - Channel name
     * @param {string} type - Channel type: 'public', 'password', 'gated'
     * @param {string} password - Password for encrypted channels (optional)
     * @param {string[]} members - Initial member addresses for gated channels (optional)
     * @param {Object} options - Additional options
     * @param {string} options.exposure - 'visible' or 'hidden'
     * @param {string} options.storageProvider - 'streamr' or 'custom' (default: 'streamr')
     * @param {string} [options.customStorageAddress] - EVM address of the custom storage node (required if provider is 'custom')
     * @param {number} options.storageDays - Retention days (default: 180)
     * @returns {Promise<Object>} - Created channel
     */
    async createChannel(name, type, password = null, members = [], options = {}) {
        try {
            const realAddress = authManager.getAddress();
            if (!realAddress) {
                throw new Error('Not authenticated');
            }

            Logger.debug('Creating dual-stream channel:', { name, type, realAddress, members });

            const onProgress = typeof options.onProgress === 'function' ? options.onProgress : null;

            // Gated channels (N-C): the gate clone comes FIRST — its address
            // goes into the stream metadata and receives every permission
            // grant. One factory tx; the creator becomes the gate owner. The
            // identity mode and the read-only flag are immutable fields of
            // the clone — the contract is the authority on both, and the
            // stream-metadata flags written below are cached copies.
            const wireIdentity = type === 'gated' ? (options.wireIdentity || 'sealed') : null;
            let gateAddress = null;
            if (type === 'gated') {
                const { gateManager, GATE_MODE, WIRE_IDENTITY } = await import('./gate.js');
                const gateMode = options.gateMode ?? GATE_MODE.NONE;
                gateAddress = await gateManager.createGate({
                    mode: gateMode,
                    token: options.gateToken,
                    minBalance: options.gateMinBalance,
                    price: options.gatePrice,
                    duration: options.gateDuration,
                    wireIdentity: wireIdentity === 'sealed'
                        ? WIRE_IDENTITY.SEALED : WIRE_IDENTITY.VISIBLE,
                    readOnly: !!options.readOnly
                });
                Logger.info('Gate clone created:', gateAddress);
                try { onProgress?.(); } catch (_) { /* ignore */ }
            }

            // Members-only author visibility (Sealed, the default for new
            // gated channels): mint the SHARED publish key now so its address
            // rides the creation permission batch. The private half is
            // adopted below and distributed to members via -4 wraps.
            let publishKey = null;
            if (wireIdentity === 'sealed') {
                publishKey = epochKeyManager.mintPublishKey();
            }

            // Create dual-stream channel - streamrController handles on-chain operations
            // Returns: { messageStreamId, ephemeralStreamId, type, name }
            const streamInfo = await streamrController.createStream(
                name,
                realAddress,
                type,
                {
                    ...options, onProgress, gateAddress,
                    wireIdentity, publishKeyAddress: publishKey?.address
                }
            );
            Logger.debug('Triple-stream created:', { 
                messageStreamId: streamInfo.messageStreamId, 
                ephemeralStreamId: streamInfo.ephemeralStreamId,
                adminStreamId: streamInfo.adminStreamId
            });

            // Enable storage on persistent streams (message + admin); ephemeral never stored
            // Pass storage options (provider, days)
            let storageResult = { success: false, provider: null, storageDays: null };
            let adminStorageResult = { success: false, storageDays: null };
            let keysStorageResult = { success: false, storageDays: null };
            try {
                storageResult = await streamrController.enableStorage(streamInfo.messageStreamId, {
                    storageProvider: options.storageProvider,
                    customStorageAddress: options.customStorageAddress,
                    storageDays: options.storageDays,
                    onProgress
                });
                Logger.debug('Message storage result:', storageResult);
            } catch (storageError) {
                Logger.warn('Failed to enable storage on message stream (continuing without history):', storageError.message);
            }

            if (streamInfo.adminStreamId) {
                try {
                    adminStorageResult = await streamrController.enableStorage(streamInfo.adminStreamId, {
                        storageProvider: options.storageProvider,
                        customStorageAddress: options.customStorageAddress,
                        storageDays: options.storageDays,
                        onProgress
                    });
                    Logger.debug('Admin storage result:', adminStorageResult);
                } catch (storageError) {
                    Logger.warn('Failed to enable storage on admin stream (continuing without admin history):', storageError.message);
                }
            }

            // Keys stream (-4, gated only): storage is what makes the epoch-key
            // protocol asynchronous — KEY_REQUESTs and KEY_WRAPs must survive
            // until the counterpart comes online
            if (streamInfo.keysStreamId) {
                try {
                    keysStorageResult = await streamrController.enableStorage(streamInfo.keysStreamId, {
                        storageProvider: options.storageProvider,
                        customStorageAddress: options.customStorageAddress,
                        storageDays: options.storageDays,
                        onProgress
                    });
                    Logger.debug('Keys storage result:', keysStorageResult);
                } catch (storageError) {
                    Logger.warn('Failed to enable storage on keys stream (key exchange limited to live members):', storageError.message);
                }
            }

            // A stream whose retention transaction never landed keeps the
            // storage node default, and the record must not claim otherwise:
            // both the TTL republish and the key re-announce time themselves
            // off these values.
            const missingRetention = [
                storageResult.success && !storageResult.retentionApplied ? '-1' : null,
                adminStorageResult.success && !adminStorageResult.retentionApplied ? '-3' : null,
                keysStorageResult.success && !keysStorageResult.retentionApplied ? '-4' : null
            ].filter(Boolean);
            if (missingRetention.length) {
                Logger.warn('Retention not applied on', missingRetention.join(', '),
                    '— those streams keep the storage node default until it is set again');
            }

            // Seed PASSWORD_CHALLENGE on -3/P2 immediately, then kick off a
            // background loop that keeps republishing until the storage node
            // has actually retained it (resend last:1 returns the entry).
            //
            // Why: joiners now fail-closed when the challenge is missing, so
            // until the storage node attachment finishes and the publish is
            // retained, nobody (not even the owner from another device) can
            // join the channel. A single create-time publish is not enough
            // because storage attachment can race with publish.
            if (type === 'password' && password && streamInfo.adminStreamId) {
                try {
                    await streamrController.publishPasswordChallenge(streamInfo.adminStreamId, password);
                    Logger.debug('Initial PASSWORD_CHALLENGE published on -3/P2');
                } catch (challengeError) {
                    Logger.warn('Initial PASSWORD_CHALLENGE publish failed (background loop will retry):', challengeError.message);
                }
                // Fire-and-forget background retention loop.
                this._ensurePasswordChallengeRetained(streamInfo.adminStreamId, password).catch(() => {});
            }

            // Gated: initial members are ONE gate transaction (allowBatch on a
            // Closed gate), never stream grants. Failure is non-fatal — the
            // owner can re-add from the members UI.
            if (type === 'gated' && members.length > 0) {
                try {
                    const { gateManager } = await import('./gate.js');
                    await gateManager.allowBatch(gateAddress, members);
                    Logger.info(`Gate: ${members.length} member(s) allowed in one tx`);
                } catch (allowError) {
                    Logger.warn('Gate allowBatch failed (re-add members later):', allowError.message);
                }
                try { onProgress?.(); } catch (_) { /* ignore */ }
            }

            // Create channel object with dual-stream IDs
            // Include owner in members array for gated channels (local UI
            // list — the chain is the authority, this is a cache)
            const channelMembers = type === 'gated'
                ? [realAddress, ...members.filter(m => m.toLowerCase() !== realAddress.toLowerCase())]
                : [];

            const exposure = options.exposure || 'hidden';

            // Classification for local organization (any channel type)
            const classification = options.classification || null;
            
            const channel = {
                messageStreamId: streamInfo.messageStreamId,
                ephemeralStreamId: streamInfo.ephemeralStreamId,
                adminStreamId: streamInfo.adminStreamId || deriveAdminId(streamInfo.messageStreamId),
                keysStreamId: type === 'gated'
                    ? (streamInfo.keysStreamId || deriveKeysId(streamInfo.messageStreamId))
                    : null,
                streamId: streamInfo.messageStreamId,  // Alias for convenience
                name: name,
                type: type,
                // Gated (N-C): the PomboGate clone. Presence of `gate.address`
                // is what flips every gated code path (transport, epoch keys,
                // authorship) — keep it null elsewhere.
                gate: type === 'gated' ? { address: gateAddress } : null,
                // Identity on the wire ('sealed' | 'visible'), IMMUTABLE:
                // 'sealed' publishes -1/-2 under the shared key with
                // authorship sealed inside the epoch envelope.
                wireIdentity: wireIdentity,
                createdAt: Date.now(),
                joinedAt: Date.now(),
                createdBy: realAddress,
                password: password,
                members: channelMembers,
                messages: [],
                reactions: {}, // messageId -> { emoji -> [users] }
                // Admin moderation state (-3/P0)
                adminState: { bannedMembers: [], hiddenMessageIds: [], pins: [] },
                adminRev: 0,
                adminLoaded: false,
                storageEnabled: storageResult.success,
                // Storage configuration
                storageProvider: storageResult.provider || 'streamr',
                // Per stream, and only what actually landed.
                storageDays: storageResult.storageDays,
                adminStorageDays: adminStorageResult.storageDays,
                keysStorageDays: keysStorageResult.storageDays,
                // Exposure and metadata (for visible channels)
                exposure: exposure,
                description: exposure === 'visible' ? (options.description || '') : '',
                language: exposure === 'visible' ? (options.language || 'en') : '',
                category: exposure === 'visible' ? (options.category || 'general') : '',
                classification: classification,
                readOnly: options.readOnly || false,
                // Lazy loading state (not persisted)
                historyLoaded: false,
                hasMoreHistory: true,
                loadingHistory: false,
                oldestTimestamp: null
            };

            // Add to channels map (keyed by messageStreamId)
            this.channels.set(channel.messageStreamId, channel);
            await secureStorage.clearChannelLeftAt(channel.messageStreamId);
            await this.saveChannels();

            if (publishKey) {
                await epochKeyManager.adoptPublishKey(channel, publishKey);
            }
            
            // Add to channel order (new channels go to top)
            await secureStorage.addToChannelOrder(channel.messageStreamId);
            
            Logger.debug('Channel saved to localStorage:', channel.messageStreamId);
            Logger.debug('Total channels:', this.channels.size);

            // Subscribe to both streams
            try {
                await this.subscribeToChannel(channel.messageStreamId);
                Logger.debug('Subscribed to dual-stream channel');
            } catch (subError) {
                Logger.warn('Failed to subscribe (can retry later):', subError);
            }

            Logger.info('Dual-stream channel created successfully:', channel.messageStreamId);
            
            // Auto-enable notifications for this channel if global notifications are enabled
            if (relayManager.enabled) {
                try {
                    if (type === 'gated') {
                        await relayManager.subscribeToNativeChannel(channel.messageStreamId);
                    } else {
                        await relayManager.subscribeToChannel(channel.messageStreamId);
                    }
                    Logger.debug('Auto-enabled notifications for created channel');
                } catch (err) {
                    Logger.warn('Failed to auto-enable notifications:', err.message);
                }
            }
            
            return channel;
        } catch (error) {
            Logger.error('Failed to create channel:', error);
            // Check if it's a chain/gas error and throw with user-friendly message
            const chainError = parseChainError(error);
            throw new Error(chainError.message);
        }
    }

    /**
     * Join an existing channel (dual-stream architecture)
     * @param {string} messageStreamId - Message Stream ID to join (ends with -1)
     * @param {string} password - Password for encrypted channels (optional)
     * @param {Object} options - Additional options (name, type from invite)
     * @returns {Promise<Object>} - Joined channel
     */
    async joinChannel(messageStreamId, password = null, options = {}) {
        try {
            // Derive ephemeral and admin stream IDs from message stream ID
            const ephemeralStreamId = deriveEphemeralId(messageStreamId);
            const adminStreamId = deriveAdminId(messageStreamId);
            
            // Check if already joined (use messageStreamId as key)
            if (this.channels.has(messageStreamId)) {
                Logger.debug('Already in this channel');
                return this.channels.get(messageStreamId);
            }

            // Determine type: use provided, detect via Graph API, or infer from password
            let channelType = options.type;
            let members = [];
            let createdBy = options.createdBy || null;
            
            // OPTIMIZATION: Run SDK permission check and Graph API calls in PARALLEL
            // This significantly speeds up the join process
            Logger.debug('Checking permissions and channel info in parallel...');
            
            const needGraphData = !channelType || !createdBy;
            
            const [permissions, graphResult] = await Promise.all([
                // 1. SDK permission check (blockchain RPC calls)
                streamrController.checkPermissions(messageStreamId),
                
                // 2. Graph API calls (only if needed) - detectStreamType and getStreamMembers
                //    share cached getStreamPermissions() internally, so they're efficient together
                needGraphData ? (async () => {
                    try {
                        const [detectedType, membersResult] = await Promise.all([
                            !channelType ? graphAPI.detectStreamType(messageStreamId) : Promise.resolve(channelType),
                            graphAPI.getStreamMembers(messageStreamId)
                        ]);
                        return { success: true, detectedType, streamMembers: membersResult.ok ? membersResult.data : [] };
                    } catch (graphError) {
                        Logger.warn('Graph API failed, falling back to inference:', graphError.message);
                        return { success: false, error: graphError };
                    }
                })() : Promise.resolve({ success: true, detectedType: channelType, streamMembers: [] })
            ]);
            
            Logger.debug('Permissions result:', permissions);

            // Direct join / Hub join of a gated channel: no invite `k` field.
            // A member holds NO stream permission (grants belong to the
            // clone), so before rejecting, check whether the stream's
            // on-chain metadata names a gate — one extra graph read, and only
            // on the would-have-been-rejected path.
            if (!options.gateAddress && !permissions.canSubscribe && !permissions.canPublish) {
                try {
                    const discovered = await this.readGateFromMetadata(messageStreamId);
                    if (discovered) {
                        Logger.info('Gate discovered from stream metadata:', discovered);
                        options.gateAddress = discovered;
                    }
                } catch (e) {
                    Logger.debug('Gate discovery failed (treating as ungated):', e.message);
                }
            }

            // Gated (N-C): stream permissions belong to the gate clone, never
            // to members — the join gate is the CONTRACT. One cached eth_call.
            if (options.gateAddress) {
                channelType = 'gated';
                const { gateManager } = await import('./gate.js');
                const me = authManager.getAddress();
                const hasAccess = me && await gateManager.checkAccess(options.gateAddress, me);
                if (!hasAccess) {
                    // Typed for the UI: the gate entry screen reads the
                    // mode on-chain and offers pay() instead of a toast.
                    const err = new Error('You do not have access to this gated channel.');
                    err.code = 'GATE_ACCESS_DENIED';
                    err.gateAddress = options.gateAddress.toLowerCase();
                    throw err;
                }
                // The stream check above naturally reported no permissions
                // (grants belong to the clone) — the gate says otherwise, and
                // everything downstream (subscription, composer cache) reads
                // from this object.
                permissions.canPublish = true;
                permissions.canSubscribe = true;
            } else if (!permissions.canSubscribe && !permissions.canPublish) {
                // User needs at least one permission (publish OR subscribe) to join
                // Many-to-one streams may grant only publish (public) without subscribe
                throw new Error('You do not have permission to access this channel. This is a private channel and you are not a member.');
            }
            
            // Process Graph API results
            if (graphResult.success) {
                if (!channelType) {
                    channelType = graphResult.detectedType;
                    Logger.debug('Detected type:', channelType);
                }
                
                const streamMembers = graphResult.streamMembers;
                if (streamMembers && streamMembers.length > 0) {
                    const owner = streamMembers.find(m => m.isOwner);
                    if (!createdBy && owner) {
                        createdBy = owner.address;
                        Logger.debug('Found owner from Graph:', createdBy?.slice(0,10));
                    }
                }
            } else if (password) {
                channelType = 'password';
            }

            if (!channelType || channelType === 'unknown') {
                if (password) {
                    channelType = 'password';
                } else {
                    const err = new Error('Could not determine the channel type. The channel may still be indexing — try again shortly.');
                    err.code = 'CHANNEL_TYPE_UNKNOWN';
                    throw err;
                }
            }

            // PASSWORD VERIFICATION (blocking, fail-closed) — password channels only.
            // Reject the join with a clear error before touching local state /
            // subscribing to -1, so the user gets immediate "wrong password"
            // feedback instead of silently entering a channel where every
            // decrypt fails.
            //
            // Storage propagation: right after channel creation the challenge
            // publish may not yet be retained by the storage node. We retry a
            // few times before giving up. After retries:
            //   - `!found` → reject as UNVERIFIED (legacy channels without a
            //     challenge cannot be joined; per V0 decision we ignore legacy).
            //   - `found && !valid` → reject as WRONG_PASSWORD.
            if (channelType === 'password' && password) {
                let challenge;
                try {
                    challenge = await streamrController.verifyPasswordChallenge(
                        adminStreamId,
                        password,
                        { retries: 4, retryDelayMs: 1500 }
                    );
                } catch (verifyError) {
                    // Pure infrastructure failure (e.g. client not initialized).
                    // Surface a distinct error so the UI can suggest retrying.
                    const err = new Error('Could not verify channel password (network error). Try again.');
                    err.code = 'CHALLENGE_VERIFY_FAILED';
                    err.cause = verifyError;
                    throw err;
                }
                if (challenge.found && !challenge.valid) {
                    Logger.warn('Password challenge failed on -3/P2 — wrong password for channel', messageStreamId);
                    const err = new Error('Incorrect password for this channel');
                    err.code = 'WRONG_PASSWORD';
                    throw err;
                }
                if (!challenge.found) {
                    Logger.warn('No PASSWORD_CHALLENGE retained on -3/P2 after retries — refusing join (unverifiable channel)');
                    const err = new Error('Channel password could not be verified (no challenge available). The channel may still be initialising — try again shortly.');
                    err.code = 'CHALLENGE_NOT_FOUND';
                    throw err;
                }
                Logger.debug('Password challenge verified on -3/P2');
            }
            
            // Extract name from streamId if not provided (simplified ID format)
            // For Closed channels, use localName from options (user-provided)
            let channelName = options.localName || options.name || messageStreamId.split('/')[1]?.replace(/-\d$/, '') || messageStreamId;
            
            // Classification for local organization (any channel type)
            const classification = options.classification || null;

            // Author visibility from the -1 metadata (`m`, immutable). It has
            // to be right BEFORE the first publish — a Members-only channel
            // joined as Everyone would put the account on the wire.
            let wireIdentity = null;
            if (channelType === 'gated') {
                wireIdentity = options.wireIdentity || null;
                if (!wireIdentity) {
                    try {
                        const flags = await this.readGateFromMetadata(messageStreamId, { withMode: true });
                        wireIdentity = flags?.wireIdentity || 'visible';
                    } catch {
                        wireIdentity = 'visible';
                    }
                }
            }

            const channel = {
                messageStreamId: messageStreamId,
                ephemeralStreamId: ephemeralStreamId,
                adminStreamId: adminStreamId,
                keysStreamId: channelType === 'gated'
                    ? deriveKeysId(messageStreamId)
                    : null,
                streamId: messageStreamId,  // Alias for convenience
                name: channelName,
                type: channelType,
                // Gated (N-C): presence of gate.address flips the gated paths
                gate: channelType === 'gated' && options.gateAddress
                    ? { address: options.gateAddress.toLowerCase() }
                    : null,
                wireIdentity: wireIdentity,
                createdAt: Date.now(),
                joinedAt: Date.now(),
                createdBy: createdBy,
                password: password,
                members: members,
                messages: [],
                reactions: {}, // messageId -> { emoji -> [users] }
                // Admin moderation state (-3/P0)
                adminState: { bannedMembers: [], hiddenMessageIds: [], pins: [] },
                adminRev: 0,
                adminLoaded: false,
                classification: classification,
                readOnly: options.readOnly || false,
                writeOnly: permissions.canPublish && !permissions.canSubscribe,
                // Lazy loading state (not persisted)
                historyLoaded: false,
                hasMoreHistory: true,
                loadingHistory: false,
                oldestTimestamp: null
            };

            // Cache permissions from SDK check (done earlier)
            const currentAddress = authManager.getAddress();
            if (currentAddress) {
                channel._publishPermCache = {
                    address: currentAddress,
                    canPublish: permissions.canPublish,
                    timestamp: Date.now()
                };
            }

            // Add to channels map (keyed by messageStreamId)
            this.channels.set(messageStreamId, channel);
            
            // OPTIMIZATION: Run storage saves and subscription in parallel
            // Channel is already in memory, so subscription can start immediately
            // Skip network subscription for write-only channels (no subscribe permission)
            const tasks = [
                secureStorage.clearChannelLeftAt(messageStreamId).then(() => this.saveChannels()),
                secureStorage.addToChannelOrder(messageStreamId)
            ];
            if (permissions.canSubscribe) {
                tasks.push(this.subscribeToChannel(messageStreamId, password));
            } else {
                Logger.info('Write-only channel - skipping subscription (no subscribe permission)');
            }
            await Promise.all(tasks);

            // Notify handlers about channel join (for media seeding re-announcement)
            // Include permissions info so UI can show appropriate feedback
            this.notifyHandlers('channelJoined', { 
                streamId: messageStreamId, 
                messageStreamId,
                ephemeralStreamId,
                password, 
                channel,
                permissions: {
                    canPublish: permissions.canPublish,
                    canSubscribe: permissions.canSubscribe,
                    isOwner: permissions.isOwner
                }
            });

            // Log access mode warnings
            if (!permissions.canPublish) {
                Logger.warn('Joined channel with read-only access (no publish permission)');
            }
            if (!permissions.canSubscribe) {
                Logger.warn('Joined channel with write-only access (no subscribe permission)');
            }

            Logger.info('Joined dual-stream channel:', messageStreamId);

            this._maybeRequestLocalIdentity(channel, options.named);

            // Auto-enable notifications for this channel if global notifications are enabled
            if (relayManager.enabled) {
                try {
                    if (channelType === 'gated') {
                        await relayManager.subscribeToNativeChannel(messageStreamId);
                    } else {
                        await relayManager.subscribeToChannel(messageStreamId);
                    }
                    Logger.debug('Auto-enabled notifications for new channel');
                } catch (err) {
                    Logger.warn('Failed to auto-enable notifications:', err.message);
                }
            }
            
            return channel;
        } catch (error) {
            Logger.error('Failed to join channel:', error);
            throw error;
        }
    }

    /**
     * OPTIMIZED: Persist a channel from preview mode (already subscribed)
     * This is much faster than joinChannel() because:
     * - Skips permission checks (preview already worked = has permission)
     * - Skips Graph API calls (uses info from preview)
     * - Skips subscription (already subscribed via preview)
     * 
     * @param {string} messageStreamId - Message Stream ID
     * @param {Object} previewInfo - Info from preview: { name, type, createdBy, readOnly, messages, reactions }
     * @returns {Promise<Object>} - Persisted channel
     */
    async persistChannelFromPreview(messageStreamId, previewInfo = {}) {
        try {
            const ephemeralStreamId = deriveEphemeralId(messageStreamId);
            const adminStreamId = deriveAdminId(messageStreamId);
            
            // Check if already joined
            if (this.channels.has(messageStreamId)) {
                Logger.debug('Channel already in list');
                return this.channels.get(messageStreamId);
            }

            Logger.debug('Persisting channel from preview:', messageStreamId);

            // Extract info from preview (already validated by successful preview)
            const channelType = previewInfo.type || 'public';
            const channelName = previewInfo.name || messageStreamId.split('/')[1]?.replace(/-\d$/, '') || messageStreamId;
            // Classification for local organization (any channel type)
            const classification = previewInfo.classification || null;

            // IMPORTANT: Transfer messages and reactions from preview
            const previewMessages = Array.isArray(previewInfo.messages) ? previewInfo.messages : [];
            const previewReactions = previewInfo.reactions || {};

            // Carry over preview's pending P1 overrides (edit/delete whose
            // target P0 message hasn't landed yet) so late-arriving content
            // delivered through the reused subscription post-promote still
            // gets the correct override applied via applyPendingOverrides.
            const previewPendingOverrides = previewInfo.pendingOverrides instanceof Map
                ? new Map(previewInfo.pendingOverrides)
                : new Map();

            const channel = {
                messageStreamId: messageStreamId,
                ephemeralStreamId: ephemeralStreamId,
                adminStreamId: adminStreamId,
                keysStreamId: channelType === 'gated'
                    ? deriveKeysId(messageStreamId) : null,
                streamId: messageStreamId,
                name: channelName,
                type: channelType,
                // Gated (N-D preview promote): the gate MUST survive this
                // path like every other restore path — without it the type
                // says gated, every gated path is dead, and the composer
                // reads our grantless address as read-only (brief Trap 2).
                gate: channelType === 'gated' && previewInfo.gateAddress
                    ? { address: String(previewInfo.gateAddress).toLowerCase() }
                    : null,
                createdAt: Date.now(),
                joinedAt: Date.now(),
                createdBy: previewInfo.createdBy || null,
                password: null, // Preview doesn't support password channels yet
                members: [],
                messages: previewMessages,  // Transfer messages from preview
                _pendingOverrides: previewPendingOverrides,
                reactions: previewReactions, // Transfer reactions from preview
                // Admin moderation state (-3/P0). Carry over whatever the
                // preview already collected so pins / bans / hidden ids stay
                // visible immediately after Join (the underlying admin stream
                // subscription is rewired to channelManager by the caller).
                adminState: previewInfo.adminState && typeof previewInfo.adminState === 'object'
                    ? {
                        bannedMembers: Array.isArray(previewInfo.adminState.bannedMembers) ? [...previewInfo.adminState.bannedMembers] : [],
                        hiddenMessageIds: Array.isArray(previewInfo.adminState.hiddenMessageIds) ? [...previewInfo.adminState.hiddenMessageIds] : [],
                        pins: Array.isArray(previewInfo.adminState.pins) ? [...previewInfo.adminState.pins] : []
                    }
                    : { bannedMembers: [], hiddenMessageIds: [], pins: [] },
                adminRev: Number.isFinite(previewInfo.adminRev) ? previewInfo.adminRev : 0,
                adminTs: Number.isFinite(previewInfo.adminTs) ? previewInfo.adminTs : 0,
                adminLoaded: !!previewInfo.adminLoaded,
                classification: classification,
                readOnly: previewInfo.readOnly || false,
                historyLoaded: previewMessages.length > 0,  // Mark as loaded if we have messages
                hasMoreHistory: true,
                loadingHistory: false,
                oldestTimestamp: previewMessages.length > 0 
                    ? previewMessages[0]?.timestamp 
                    : (previewInfo.oldestTimestamp || null)
            };

            // Add to channels map
            this.channels.set(messageStreamId, channel);

            // Apply any carried-over pending overrides immediately and prune
            // _deleted entries so the first render after Join already reflects
            // the moderation state preview computed.
            if (previewPendingOverrides.size > 0) {
                this.applyPendingOverrides(channel);
            }
            channel.messages = channel.messages.filter(m => !m._deleted);

            // Save to storage (parallel)
            await Promise.all([
                secureStorage.clearChannelLeftAt(messageStreamId).then(() => this.saveChannels()),
                secureStorage.addToChannelOrder(messageStreamId)
            ]);

            // Notify handlers
            this.notifyHandlers('channelJoined', { 
                streamId: messageStreamId, 
                messageStreamId,
                ephemeralStreamId,
                channel,
                fromPreview: true
            });

            Logger.info('Channel persisted from preview:', messageStreamId);

            this._maybeRequestLocalIdentity(channel, previewInfo.named);
            
            // Auto-enable notifications for this channel if global notifications are enabled
            if (relayManager.enabled) {
                try {
                    if (channelType === 'gated') {
                        await relayManager.subscribeToNativeChannel(messageStreamId);
                    } else {
                        await relayManager.subscribeToChannel(messageStreamId);
                    }
                    Logger.debug('Auto-enabled notifications for channel from preview');
                } catch (err) {
                    Logger.warn('Failed to auto-enable notifications:', err.message);
                }
            }
            
            return channel;
        } catch (error) {
            Logger.error('Failed to persist channel from preview:', error);
            throw error;
        }
    }

    /**
     * Sync channel info from The Graph (members, type, owner)
     * Use this to refresh on-chain data for a channel
     * @param {string} messageStreamId - Message Stream ID
     * @returns {Promise<Object|null>} - Updated channel or null if not found
     */
    async syncChannelFromGraph(messageStreamId) {
        const channel = this.channels.get(messageStreamId);
        if (!channel) {
            Logger.warn('Channel not found for sync:', messageStreamId);
            return null;
        }

        try {
            Logger.debug('Syncing channel from The Graph:', messageStreamId);
            
            // OPTIMIZATION: Fetch all Graph data in parallel
            const [streamData, type, membersResult] = await Promise.all([
                graphAPI.getStream(messageStreamId),
                graphAPI.detectStreamType(messageStreamId),
                graphAPI.getStreamMembers(messageStreamId)
            ]);
            
            if (!streamData) {
                Logger.warn('Stream not found in The Graph');
                return channel;
            }

            // Update type based on permissions
            if (type !== 'unknown') {
                channel.type = type;
            }

            const members = membersResult.ok ? membersResult.data : [];

            // Update members
            channel.members = members.map(m => m.address);

            // Get owner
            const owner = members.find(m => m.isOwner);
            if (owner) {
                channel.createdBy = owner.address;
            }

            // Save updated info
            await this.saveChannels();
            
            Logger.debug('Channel synced:', {
                type: channel.type,
                members: channel.members.length,
                owner: channel.createdBy?.slice(0, 10)
            });

            return channel;
        } catch (error) {
            Logger.warn('Failed to sync channel from Graph:', error);
            return channel;
        }
    }

    // Lives in channels/Membership.js; the manager keeps the entry points
    // its callers already use.

    addMember(messageStreamId, address) { return this.membership.addMember(messageStreamId, address); }
    addMembers(messageStreamId, addresses) { return this.membership.addMembers(messageStreamId, addresses); }
    removeMember(messageStreamId, address) { return this.membership.removeMember(messageStreamId, address); }
    banMemberLevels(messageStreamId, address, levels) { return this.membership.banMemberLevels(messageStreamId, address, levels); }
    unbanMemberLevels(messageStreamId, address) { return this.membership.unbanMemberLevels(messageStreamId, address); }
    getGateMemberFlags(streamId) { return this.membership.getGateMemberFlags(streamId); }
    _rememberBanned(channel, flags) { return this.membership._rememberBanned(channel, flags); }
    getGateBannedMembers(streamId) { return this.membership.getGateBannedMembers(streamId); }
    getChannelMembers(streamId) { return this.membership.getChannelMembers(streamId); }
    updateMemberPermissions(streamId, address, permissions) { return this.membership.updateMemberPermissions(streamId, address, permissions); }
    isChannelOwner(streamId) { return this.membership.isChannelOwner(streamId); }
    canAddMembers(streamId) { return this.membership.canAddMembers(streamId); }
    preloadDeletePermission(streamId) { return this.membership.preloadDeletePermission(streamId); }
    getCachedDeletePermission(streamId) { return this.membership.getCachedDeletePermission(streamId); }

    // ===== STORAGE MANAGEMENT (POST-CREATION) ========================================

    /**
     * Get aggregated storage info for a channel: every stored stream, which
     * is -1 message, -3 admin, and -4 keys on gated channels. The ephemeral
     * stream (-2) never has storage by design, and a DM's inbox is an
     * account-level stream rather than part of any one conversation.
     *
     * The user-facing view stays a single list and a single retention
     * figure. `onMessage`/`onAdmin`/`onKeys` per node, and `retentionInSync`
     * across the streams, are what let the panel flag a channel whose
     * streams drifted apart after a partial update.
     *
     * @param {string} messageStreamId
     * @returns {Promise<{enabled: boolean, nodes: Array<{address:string,onMessage:boolean,onAdmin:boolean,onKeys:boolean}>, storageDays: number|null, retention: {message:number|null,admin:number|null,keys:number|null}, retentionInSync: boolean, hasKeysStream: boolean}>}
     */
    /**
     * The stored streams of a channel: -1 message, -3 admin, and -4 keys on
     * gated. Never the ephemeral -2, which has no storage by design, and
     * never a DM inbox, which is an account-level stream.
     *
     * @returns {Array<{id: string, kind: 'message'|'admin'|'keys'}>}
     * @private
     */
    _storedStreamIds(messageStreamId, channel) {
        const out = [{ id: messageStreamId, kind: 'message' }];
        const adminStreamId = channel?.adminStreamId || deriveAdminId(messageStreamId);
        if (adminStreamId) out.push({ id: adminStreamId, kind: 'admin' });
        if (channel?.type === 'gated') {
            out.push({ id: channel.keysStreamId || deriveKeysId(messageStreamId), kind: 'keys' });
        }
        return out;
    }

    /**
     * What the chain currently says about each stored stream.
     *
     * `read` is false when the lookup failed. Every decision that would SKIP
     * a write has to treat that as nothing known and write anyway: a wrong
     * skip leaves the stream diverged with the UI reporting success, while a
     * redundant write only costs gas.
     *
     * @returns {Promise<Array<{id, kind, read: boolean, nodes: string[], storageDays: number|null}>>}
     * @private
     */
    async _readStoredStreams(messageStreamId, channel) {
        return Promise.all(this._storedStreamIds(messageStreamId, channel).map(async ({ id, kind }) => {
            const info = await streamrController.getStreamStorageInfo(id)
                .catch(() => ({ ok: false, nodes: [], storageDays: null }));
            return {
                id,
                kind,
                read: info.ok !== false,
                nodes: info.nodes || [],
                storageDays: typeof info.storageDays === 'number' ? info.storageDays : null
            };
        }));
    }

    async getChannelStorageInfo(messageStreamId) {
        const channel = this.channels.get(messageStreamId);
        const keysStreamId = channel?.type === 'gated'
            ? (channel.keysStreamId || deriveKeysId(messageStreamId))
            : null;

        const streams = await this._readStoredStreams(messageStreamId, channel);
        const byKind = (kind) => streams.find(st => st.kind === kind)
            || { read: false, nodes: [], storageDays: null };
        const msgInfo = byKind('message');
        const adminInfo = byKind('admin');
        const keysInfo = byKind('keys');
        // A node's absence from a stream we could not read proves nothing.
        const allStreamsRead = streams.every(st => st.read);

        const map = new Map(); // address(lower) -> { address, onMessage, onAdmin, onKeys }
        const mark = (info, flag) => {
            for (const n of info.nodes || []) {
                const key = String(n).toLowerCase();
                const existing = map.get(key);
                if (existing) {
                    existing[flag] = true;
                } else {
                    map.set(key, { address: n, onMessage: false, onAdmin: false, onKeys: false, [flag]: true });
                }
            }
        };
        mark(msgInfo, 'onMessage');
        mark(adminInfo, 'onAdmin');
        mark(keysInfo, 'onKeys');

        const retention = {
            message: msgInfo.storageDays,
            admin: adminInfo.storageDays,
            keys: keysStreamId ? keysInfo.storageDays : null
        };
        const nodes = Array.from(map.values());

        return {
            enabled: nodes.length > 0,
            nodes,
            allStreamsRead,
            // One figure for the panel: the message stream's, as before.
            // `retentionInSync` is what says the others do not match it.
            storageDays: retention.message,
            retention,
            retentionInSync: retentionInSync([retention.message, retention.admin, retention.keys]),
            hasKeysStream: !!keysStreamId
        };
    }

    /**
     * Apply an operation to only the stored streams that still need it, then
     * read back to confirm.
     *
     * Every storage operation here is one on-chain transaction per stream, so
     * a channel already half-configured should cost what is missing, not the
     * whole set again. `needs` decides per stream; it must answer true for a
     * stream that could not be read, because skipping on an unknown leaves
     * the channel diverged while the UI reports success.
     *
     * @param {string} messageStreamId
     * @param {(stream: Object) => boolean} needs - does this stream need the write?
     * @param {(streamId: string) => Promise<{success: boolean, error?: string}>} apply
     * @returns {Promise<{results: Object, sent: number, verified: boolean|null}>}
     *          results maps kind -> 'unchanged' | 'applied' | 'failed'
     * @private
     */
    async _applyToStoredStreams(messageStreamId, needs, apply) {
        const channel = this.channels.get(messageStreamId);
        if (!channel) throw new Error('Channel not found');

        const before = await this._readStoredStreams(messageStreamId, channel);
        const results = {};
        let sent = 0;

        // Sequential to avoid nonce conflicts (REPLACEMENT_UNDERPRICED).
        for (const stream of before) {
            if (!needs(stream)) { results[stream.kind] = 'unchanged'; continue; }
            sent += 1;
            const res = await apply(stream.id).catch(e => ({ success: false, error: e?.message }));
            results[stream.kind] = res?.success ? 'applied' : 'failed';
            if (!res?.success) {
                Logger.warn('Storage write failed on', stream.kind, stream.id?.slice(-20), res?.error);
            }
        }

        // Nothing was sent, so the read that said so is all we have.
        if (sent === 0) return { results, sent, verified: null };

        const after = await this._readStoredStreams(messageStreamId, channel);
        const verified = after.every(st => st.read && !needs(st));
        if (!verified) {
            Logger.warn('Storage write did not converge; the channel streams are still out of sync');
        }
        return { results, sent, verified };
    }

    /**
     * Put a storage node on every stored stream that does not already carry
     * it: -1, -3, and -4 on gated channels. A node already assigned to a
     * stream costs nothing, which is what makes this the cheap repair for the
     * "partial" state instead of removing and re-adding everywhere.
     *
     * @param {string} messageStreamId
     * @param {Object} options
     * @param {string} options.storageProvider - 'streamr' or 'custom'
     * @param {string} [options.customStorageAddress] - EVM address (required if provider is 'custom')
     * @param {number} [options.storageDays] - Retention days (applied to each stream written)
     * @returns {Promise<{results: Object, sent: number, verified: boolean|null}>}
     */
    async addChannelStorageNode(messageStreamId, options = {}) {
        const provider = options.storageProvider || CONFIG.storage.defaultProvider;
        const address = (provider === 'custom'
            ? options.customStorageAddress
            : STREAM_CONFIG.NODE_ADDRESS) || '';
        const has = (stream) => stream.nodes
            .some(n => String(n).toLowerCase() === address.toLowerCase());

        return this._applyToStoredStreams(
            messageStreamId,
            // Unread streams are written to: absence proves nothing.
            (stream) => !stream.read || !has(stream),
            (streamId) => streamrController.addStorageNodeToStream(streamId, options)
        );
    }

    /**
     * Take a storage node off every stored stream that still carries it.
     * Streams that never had it cost nothing.
     *
     * @param {string} messageStreamId
     * @param {string} nodeAddress
     * @returns {Promise<{results: Object, sent: number, verified: boolean|null}>}
     */
    async removeChannelStorageNode(messageStreamId, nodeAddress) {
        const addr = String(nodeAddress || '').toLowerCase();
        const has = (stream) => stream.nodes.some(n => String(n).toLowerCase() === addr);

        return this._applyToStoredStreams(
            messageStreamId,
            (stream) => !stream.read || has(stream),
            (streamId) => streamrController.removeStorageFromStream(streamId, nodeAddress)
        );
    }

    /**
     * Set the retention of every stored stream that is not already at
     * `days`: -1, -3, and -4 for gated channels.
     *
     * Only the streams that differ are written, so re-saving the same figure
     * to heal a divergence costs one transaction per diverged stream instead
     * of one per stream.
     *
     * @param {string} messageStreamId
     * @param {number} days
     * @returns {Promise<{results: Object, sent: number, verified: boolean|null}>}
     */
    async setChannelStorageDays(messageStreamId, days) {
        const channel = this.channels.get(messageStreamId);
        if (!channel) throw new Error('Channel not found');

        const outcome = await this._applyToStoredStreams(
            messageStreamId,
            (stream) => !stream.read || stream.storageDays !== days,
            (streamId) => streamrController.setStorageDays(streamId, days)
                .then(okFlag => ({ success: okFlag === true }))
        );

        // Keep the local copies in sync, per stream: each is a separate
        // transaction and the Graph lags them by enough to answer a reopen
        // with the previous retention. A stream already at `days` counts as
        // in sync too, which is the whole point of not writing to it.
        if (typeof days === 'number' && days > 0) {
            const settled = (kind) => outcome.results[kind] === 'applied'
                || outcome.results[kind] === 'unchanged';
            let changed = false;
            if (settled('message') && channel.storageDays !== days) { channel.storageDays = days; changed = true; }
            if (settled('admin') && channel.adminStorageDays !== days) { channel.adminStorageDays = days; changed = true; }
            if (settled('keys') && channel.keysStorageDays !== days) { channel.keysStorageDays = days; changed = true; }
            if (changed) await this.saveChannels();
        }

        return outcome;
    }

    // ===== ADMIN STREAM (-3/P0) =====================================================

    // Lives in channels/AdminState.js; the manager keeps the entry points
    // its callers already use.

    get _adminPublishChain() { return this.adminState._adminPublishChain; }

    _createEmptyAdminState() { return this.adminState._createEmptyAdminState(); }
    _isValidAdminState(msg) { return this.adminState._isValidAdminState(msg); }
    _normalizeAdminState(state) { return this.adminState._normalizeAdminState(state); }
    applyAdminState(channel, adminMsg) { return this.adminState.applyAdminState(channel, adminMsg); }
    handleAdminMessage(messageStreamId, data) { return this.adminState.handleAdminMessage(messageStreamId, data); }
    bootstrapAdminState(messageStreamId, adminStreamId, password = null) { return this.adminState.bootstrapAdminState(messageStreamId, adminStreamId, password); }
    refreshAdminState(messageStreamId) { return this.adminState.refreshAdminState(messageStreamId); }
    publishAdminState(messageStreamId, update = {}) { return this.adminState.publishAdminState(messageStreamId, update); }
    _publishAdminStateInner(messageStreamId, update = {}) { return this.adminState._publishAdminStateInner(messageStreamId, update); }
    banMember(messageStreamId, address) { return this.adminState.banMember(messageStreamId, address); }
    unbanMember(messageStreamId, address) { return this.adminState.unbanMember(messageStreamId, address); }
    hideMessage(messageStreamId, targetId) { return this.adminState.hideMessage(messageStreamId, targetId); }
    pinMessage(messageStreamId, targetId, snapshot = null) { return this.adminState.pinMessage(messageStreamId, targetId, snapshot); }
    unpinMessage(messageStreamId, targetId) { return this.adminState.unpinMessage(messageStreamId, targetId); }

    /**
     * Background loop that republishes the PASSWORD_CHALLENGE on -3/P2 until
     * the storage node has actually retained it. Used right after channel
     * creation, when the storage attachment may still be racing with the
     * initial publish. Joiners now fail-closed on missing challenge, so we
     * MUST guarantee retention before remote users can verify and join.
     *
     * Fire-and-forget; safe to ignore the returned promise. Self-terminates
     * once a verify succeeds, or after a hard cap on attempts.
     *
     * @param {string} adminStreamId - Admin stream id (-3)
     * @param {string} password - Channel password
     * @param {Object} [options]
     * @param {number} [options.maxAttempts=12] Total publish/verify cycles
     * @param {number} [options.delayMs=5000]   Delay between cycles
     */
    async _ensurePasswordChallengeRetained(adminStreamId, password, { maxAttempts = 12, delayMs = 5000 } = {}) {
        if (!adminStreamId || !password) return;
        for (let attempt = 1; attempt <= maxAttempts; attempt++) {
            await new Promise(r => setTimeout(r, delayMs));
            let res;
            try {
                res = await streamrController.verifyPasswordChallenge(adminStreamId, password);
            } catch (e) {
                Logger.debug(`PASSWORD_CHALLENGE retention check #${attempt} errored:`, e?.message);
                continue;
            }
            if (res.found && res.valid) {
                Logger.info(`PASSWORD_CHALLENGE retained on -3/P2 (after ${attempt} verify cycle${attempt > 1 ? 's' : ''})`);
                return;
            }
            // Not retained yet — republish and try again next cycle.
            try {
                await streamrController.publishPasswordChallenge(adminStreamId, password);
                Logger.debug(`PASSWORD_CHALLENGE republished (retention attempt ${attempt}/${maxAttempts})`);
            } catch (e) {
                Logger.debug(`PASSWORD_CHALLENGE republish #${attempt} failed:`, e?.message);
            }
        }
        Logger.warn(`PASSWORD_CHALLENGE not retained on -3/P2 after ${maxAttempts} attempts — joiners will see CHALLENGE_NOT_FOUND until storage catches up`);
    }

    /**
     * TTL-aware republish of the -3 artifacts on owner open
     * (channels/TtlRepublish.js).
     * @param {Object} channel - Channel object
     * @param {string} adminStreamId - Admin stream id (-3)
     * @param {string|null} pwd - Channel password (null for public channels)
     */
    _ttlRepublishOnOpen(channel, adminStreamId, pwd) {
        return this.ttlRepublish.republishOnOpen(channel, adminStreamId, pwd);
    }

    /**
     * Publish a new CHANNEL_IMAGE on -3/P1.
     * Owner-only; encryption is opt-in via `encrypt` flag (default false).
     *
     * @param {string} messageStreamId - Channel key (-1)
     * @param {Object} input - { dataUrl: 'data:image/jpeg;base64,...', hash: 'hex' }
     * @param {Object} [options]
     * @param {boolean} [options.encrypt=false] - Encrypt with channel password
     * @returns {Promise<{rev:number, hash:string}>}
     */
    async publishChannelImage(messageStreamId, input, { encrypt = false } = {}) {
        const channel = this.channels.get(messageStreamId);
        if (!channel) throw new Error('Channel not found');

        const adminStreamId = channel.adminStreamId || deriveAdminId(messageStreamId);
        if (!adminStreamId) throw new Error('Channel has no admin stream');

        const senderAddress = authManager.getAddress();
        if (!senderAddress) throw new Error('Not authenticated');
        if (channel.createdBy && senderAddress.toLowerCase() !== channel.createdBy.toLowerCase()) {
            throw new Error('Only the channel admin can publish channel image');
        }

        if (!input?.dataUrl || !input?.hash) {
            throw new Error('publishChannelImage requires { dataUrl, hash }');
        }
        if (encrypt && !channel.password) {
            throw new Error('Cannot encrypt: channel has no password');
        }

        const newRev = ((channel.channelImageRev) || 0) + 1;
        // Derive mime from the data URL prefix so PNGs (with transparency)
        // and JPEGs round-trip honestly.
        const mimeMatch = /^data:([^;]+);/i.exec(input.dataUrl);
        const mime = mimeMatch ? mimeMatch[1].toLowerCase() : 'image/jpeg';
        const payload = {
            type: 'CHANNEL_IMAGE',
            v: 1,
            rev: newRev,
            ts: Date.now(),
            createdBy: senderAddress,
            encrypted: !!encrypt,
            mime,
            hash: input.hash,
            data: input.dataUrl
        };

        await streamrController.publishChannelImage(
            adminStreamId,
            payload,
            encrypt ? channel.password : null
        );

        channel.channelImageRev = newRev;

        // Optimistically update the shared cache so all surfaces re-render.
        await channelImageManager.setLocal(adminStreamId, {
            hash: input.hash,
            dataUrl: input.dataUrl,
            encrypted: !!encrypt,
            ts: payload.ts,
            rev: newRev,
            owner: senderAddress
        });

        Logger.info('Channel image published', {
            streamId: messageStreamId.slice(-20),
            rev: newRev,
            encrypted: !!encrypt,
            bytes: input.dataUrl.length
        });

        return { rev: newRev, hash: input.hash };
    }

    // ===== END ADMIN STREAM =========================================================

    /**
     * Subscribe to a channel's dual-stream with message history
     * In dual-stream architecture:
     * - messageStream: messages with history
     * - ephemeralStream: control/media without history
     * 
     * @param {string} messageStreamId - Message Stream ID (ends with -1)
     * @param {string} password - Password for encrypted channels (optional)
     */
    async subscribeToChannel(messageStreamId, password = null) {
        const channel = this.channels.get(messageStreamId);
        const pwd = password || (channel ? channel.password : null);
        
        // DM-2 ephemeral lifecycle: unsubscribe when leaving a DM conversation
        if (channel?.type !== 'dm') {
            dmManager.unsubscribeDMEphemeral();
        }
        
        // Gate the initial-history-complete event AS EARLY AS POSSIBLE so the
        // empty-channel render that just happened in setActiveChannel cannot
        // trigger `_autoLoadIfContentShort` → `loadMoreHistory` concurrently
        // with the subscribe path. Without this guard, two storage resends run
        // in parallel and — under CPU/network pressure — the older-history
        // resend's iterator can be cut short by storage WebSocket
        // disconnects, leaving `allMessages` populated with the OLDEST
        // messages instead of the most recent. `slice(-50)` then returns a
        // batch of stale messages and `oldestTimestamp` jumps far back,
        // causing a permanent gap between the batch and the live history.
        // Cleared in `onHistoryComplete` (and on any error path below).
        if (channel && !channel.writeOnly && channel.type !== 'dm') {
            channel.initialLoadInProgress = true;
        }

        // Skip network subscription for write-only channels (no subscribe permission)
        // Instead, load locally persisted sent messages and reactions
        if (channel?.writeOnly) {
            Logger.debug('Write-only channel - loading local data:', messageStreamId);
            const sentMessages = secureStorage.getSentMessages(messageStreamId);
            if (sentMessages.length > 0) {
                // Filter out messages already in channel (avoid duplicates on re-select)
                const existingIds = new Set(channel.messages.map(m => m.id));
                const newMessages = sentMessages.filter(m => !existingIds.has(m.id));
                if (newMessages.length > 0) {
                    // Mark all as verified (they're our own messages)
                    for (const msg of newMessages) {
                        msg.verified = { valid: true, trustLevel: 2 };
                        channel.messages.push(msg);
                    }
                    this.sortMessagesByTimestamp(channel);
                    Logger.info(`Loaded ${newMessages.length} local sent messages for write-only channel`);
                }
            }
            // Load persisted reactions
            const sentReactions = secureStorage.getSentReactions(messageStreamId);
            if (Object.keys(sentReactions).length > 0) {
                channel.reactions = sentReactions;
                Logger.info('Loaded local reactions for write-only channel');
            }
            channel.historyLoaded = true;
            channel.hasMoreHistory = false;
            return;
        }

        // DM channels: load merged timeline (sent local + received from inbox)
        if (channel?.type === 'dm') {
            Logger.debug('DM channel - loading merged timeline:', messageStreamId);
            // Gate renders while loading — inbox messages may still arrive via routeInboxMessage()
            channel.initialLoadInProgress = true;
            await dmManager.loadDMTimeline(channel.peerAddress);
            channel.historyLoaded = true;
            // Enable scroll-up pagination for DMs — set oldestTimestamp from loaded messages
            if (channel.messages.length > 0) {
                const oldest = channel.messages.reduce((min, m) => m.timestamp < min ? m.timestamp : min, channel.messages[0].timestamp);
                channel.oldestTimestamp = oldest;
            }
            // DMs ALWAYS start optimistic about pagination. `loadDMTimeline`
            // only seeds from the local cache + a small recent inbox window,
            // so it can't truthfully claim exhaustion. The real determination
            // happens inside `fetchOlderDMMessages`, which uses
            // `fetchOlderHistoryWindowed` and reports `hasMore = windowStart > 0`
            // — i.e. only flips to `false` once we've scanned back to t=0.
            // Without this, an empty/sparse cache would mark the channel
            // exhausted on open, suppressing both the IntersectionObserver
            // sentinel and the "Search older messages" banner forever.
            channel.hasMoreHistory = true;
            // Subscribe to DM-2 ephemeral on-demand (typing/presence)
            dmManager.subscribeDMEphemeral();
            // Clear gate and notify UI to re-render with ENS data
            channel.initialLoadInProgress = false;
            this.notifyHandlers('initial_history_complete', { streamId: messageStreamId });
            return;
        }

        // Get or derive ephemeral and admin stream IDs
        const ephemeralStreamId = channel?.ephemeralStreamId || deriveEphemeralId(messageStreamId);
        const adminStreamId = channel?.adminStreamId || deriveAdminId(messageStreamId);

        // Step 1: Bootstrap admin state from -3/P0 BEFORE subscribing to content.
        // This ensures hiddenMessageIds, bannedMembers and pins are applied
        // before the timeline renders.
        if (adminStreamId) {
            try {
                await this.bootstrapAdminState(messageStreamId, adminStreamId, pwd);
            } catch (e) {
                Logger.warn('Admin stream bootstrap failed (continuing without admin state):', e.message);
            }
            // Fire-and-forget: pull channel image (-3/P1). Skipped for DMs.
            // The manager dedups across UI surfaces and caches in IDB.
            if (channel && channel.type !== 'dm') {
                channelImageManager.get(adminStreamId, { password: pwd }).catch(() => {});
            }

            // Fire-and-forget: TTL-aware owner republish of the -3 artifacts
            // (docs/TTL_REPUBLISH_PLAN.md). Covers the challenge redundancy
            // check that used to live inline here (storage attachment racing
            // the create-time publish), plus proactive refresh of ADMIN_STATE,
            // CHANNEL_IMAGE and PASSWORD_CHALLENGE when the retained entry is
            // nearing the end of the channel's storage TTL — the purge deletes
            // by message timestamp, and nothing else ever republishes these.
            if (channel) {
                this._ttlRepublishOnOpen(channel, adminStreamId, pwd).catch(e => {
                    Logger.debug('TTL republish check failed (will retry next open):', e?.message);
                });
            }
        }

        // Epoch keys (N-A): subscribe -4 and bring key state up to date
        // BEFORE the -1 history pull below, so envelopes can already be opened.
        // Failure is non-fatal — messages park as "waiting for key" and the
        // refresh fired on key adoption recovers them.
        if (channel?.gate?.address) {
            try {
                await this._setupEpochKeys(channel);
                channel._epochSetupRetry = 0;
            } catch (e) {
                Logger.warn('Epoch key setup failed (messages will wait for key):', e.message);
                this._scheduleEpochSetupRetry(channel);
            }
            this._rotateForLostAccess(channel).catch(() => {});
        }

        // Fire-and-forget: pull latest-message preview (-1/P0). Sidebar
        // and Explore consume the cache via channelLatestMessageManager.
        // Skipped for DMs (E2EE — handled exclusively from the local path).
        if (channel && channel.type !== 'dm') {
            channelLatestMessageManager.get(messageStreamId, { password: pwd }).catch(() => {});
        }

        // Detect whether this stream supports dedicated control partition (P1)
        let hasControlPartition = true;
        try {
            const partitionCount = await streamrController.getStreamPartitionCount(messageStreamId);
            hasControlPartition = partitionCount >= 2;
            channel._controlPartitionSupported = hasControlPartition;
            Logger.debug('Message stream partition capability:', {
                streamId: messageStreamId.slice(-20),
                partitionCount,
                hasControlPartition
            });
        } catch (e) {
            // Fail-open for compatibility if partition introspection fails
            hasControlPartition = true;
            channel._controlPartitionSupported = true;
            Logger.warn('Could not determine stream partition count, assuming control partition support:', e.message);
        }

        // Mark channel as loading initial history (suppresses per-message renders)
        if (channel) {
            channel.initialLoadInProgress = true;
        }

        // Safety net: the SDK resend iterator does not deterministically
        // signal `done` on every backend (custom storage, legacy single-
        // partition streams). Release the UI gate after 30s so the
        // "Loading messages..." spinner is not permanent. `hasMoreHistory`
        // is left untouched — exhaustion is determined later by the
        // bounded windowed paginate (`loadMoreHistory`).
        const INITIAL_HISTORY_SAFETY_MS = 30000;
        let initialHistorySafetyTimer = setTimeout(() => {
            if (!channel || !channel.initialLoadInProgress) return;
            Logger.warn(`Initial history safety timeout fired for ${messageStreamId.slice(-20)}`);
            channel.initialLoadInProgress = false;
            this.notifyHandlers('initial_history_complete', { streamId: messageStreamId });
            this.recoverIncompleteImages(messageStreamId).catch(err => {
                Logger.debug('recoverIncompleteImages (safety) failed:', err?.message || err);
            });
        }, INITIAL_HISTORY_SAFETY_MS);

        // Use dual-stream subscription with onHistoryComplete callback
        const onHistoryComplete = async (stats) => {
            // Cancel safety net — real completion took over.
            if (initialHistorySafetyTimer) {
                clearTimeout(initialHistorySafetyTimer);
                initialHistorySafetyTimer = null;
            }
            if (!channel || !channel.initialLoadInProgress) return;
            
            // Flush any remaining batch verifications
            await this.flushBatchVerification(messageStreamId);
            
            // Await ALL in-flight flush promises (may have been fired before onHistoryComplete)
            await this.awaitAllFlushes(messageStreamId);
            
            // Apply pending overrides and remove deleted messages before first render
            this.applyPendingOverrides(channel);
            channel.messages = channel.messages.filter(m => !m._deleted);

            // Exhaustion is NOT inferred from `loaded < requested` — that
            // heuristic is unsound (storage WS drops, decrypt errors, SDK
            // early termination all produce short responses). The bounded
            // `loadMoreHistory` windowed query is the single source of
            // truth for `hasMoreHistory`.
            Logger.debug(
                `Initial history complete for ${messageStreamId.slice(-20)}: ` +
                `content ${stats?.contentLoaded ?? '?'}/${stats?.contentRequested ?? '?'}, ` +
                `control ${stats?.controlLoaded ?? '?'}/${stats?.controlRequested ?? '?'}`
            );

            channel.initialLoadInProgress = false;
            
            this.notifyHandlers('initial_history_complete', { streamId: messageStreamId });

            this.recoverIncompleteImages(messageStreamId).catch(err => {
                Logger.debug('recoverIncompleteImages failed:', err?.message || err);
            });
        };

        try {
            await streamrController.subscribeToDualStream(
                messageStreamId,
                ephemeralStreamId,
                {
                    onMessage: (data) => this.handleTextMessage(messageStreamId, data),
                    onOverride: hasControlPartition
                        ? (data) => this.handleOverrideMessage(
                            messageStreamId,
                            data,
                            channel?.initialLoadInProgress ?? false
                        )
                        : null,
                    allowOverridesInContentPartition: !hasControlPartition,
                    onControl: (data) => this.handleControlMessage(messageStreamId, data),
                    onMedia: (data, account) => this.handleMediaMessage(messageStreamId, data, account)
                },
                pwd,
                STREAM_CONFIG.INITIAL_MESSAGES,
                onHistoryComplete
            );
        } catch (subscribeError) {
            // Release UI gate so the user is not stranded on the spinner.
            if (initialHistorySafetyTimer) {
                clearTimeout(initialHistorySafetyTimer);
                initialHistorySafetyTimer = null;
            }
            if (channel) {
                channel.initialLoadInProgress = false;
                this.notifyHandlers('initial_history_complete', { streamId: messageStreamId });
            }
            throw subscribeError;
        }
        
        Logger.debug('Subscribed to dual-stream channel:', messageStreamId);

        // Re-announce persisted seed files for this channel (fire-and-forget).
        // This runs on every subscribe path (initial join, post-refresh select,
        // re-activation from background) so peers learn we're still seeding
        // files we previously shared here. Safe to call when we have nothing
        // persisted — reannounceForChannel() is a no-op in that case.
        if (typeof mediaController?.reannounceForChannel === 'function') {
            Promise.resolve(mediaController.reannounceForChannel(messageStreamId, pwd))
                .catch(err => Logger.debug('reannounceForChannel failed (non-critical):', err?.message));
        }
    }

    /**
     * Refresh the cached retention of a gated channel's KEYS stream (-4),
     * which is what ages out its KEY_ANNOUNCEs.
     *
     * Resolved on open and cached on the record because the epoch-key sweep
     * that consumes it runs every 45s, far too often to look up; a channel
     * the sweep answers headlessly reads whatever the last open persisted.
     *
     * @param {Object} channel - Channel object (the live record in `channels`)
     * @private
     */
    async _resolveKeysRetention(channel) {
        const keysStreamId = channel.keysStreamId || deriveKeysId(channel.messageStreamId);
        const days = await readStreamRetention(keysStreamId);
        if (days !== null && channel.keysStorageDays !== days) {
            channel.keysStorageDays = days;
            await this.saveChannels();
        }
        // The sweep that consumes this is headless and silent, so without
        // a line here a wrong retention is invisible until the announces
        // are already gone.
        Logger.debug('Keys retention', {
            streamId: keysStreamId.slice(-20),
            read: days,
            using: keysRetentionDays(channel)
        });
    }

    /**
     * Wire a gated channel into the epoch-key protocol: live -4
     * subscription, refresh-on-adopt listener, and initial key state
     * (bootstrap as admin, or request as member). Idempotent per channel.
     */
    async _setupEpochKeys(channel) {
        const keysStreamId = channel.keysStreamId || deriveKeysId(channel.messageStreamId);
        channel.keysStreamId = keysStreamId;

        // Not awaited: the open must not wait on the Graph, and one stale
        // pass of a decision measured in months costs nothing.
        this._resolveKeysRetention(channel).catch(e =>
            Logger.debug('Keys retention refresh failed:', e?.message));

        if (!channel._epochAdoptListener) {
            channel._epochAdoptListener = true;
            epochKeyManager.onKeyAdopted(channel.messageStreamId, () =>
                this._refreshAfterEpochKey(channel.messageStreamId));
        }

        await streamrController.subscribeToKeysStream(keysStreamId, (data, publisherId, timestamp) =>
            epochKeyManager.handleKeysMessage(channel, data, publisherId, timestamp));

        // FAST PATH: with persisted keys+announces the channel decrypts
        // immediately — the -4 resend becomes a background reconcile (which
        // also runs the admin's TTL re-announce) instead of blocking history.
        epochKeyManager.loadPersistedState(channel.messageStreamId);
        if (epochKeyManager.hasCurrentKey(channel.messageStreamId)) {
            setTimeout(() => {
                epochKeyManager.ensureChannelKeys(channel).catch(e => {
                    // Reading still works, but this pass is what answers
                    // retained requests, re-announces and picks up new
                    // epochs/revs — a silent give-up leaves all of that
                    // undone until the next open. Same capped retry as the
                    // cold path.
                    Logger.warn('Background epoch reconcile failed (will retry):', e.message);
                    this._scheduleEpochSetupRetry(channel);
                });
            }, 8_000);
            return;
        }

        await epochKeyManager.ensureChannelKeys(channel);

        // A first KEY_REQUEST from a cold node can miss every live subscriber
        // (§7.2 R2) — retry fast while the topology warms; stop as soon as
        // the keys land or the channel is switched away.
        if (!epochKeyManager.hasCurrentKey(channel.messageStreamId)) {
            let laps = 0;
            const timer = setInterval(async () => {
                laps += 1;
                const still = this.currentChannel === channel.messageStreamId
                    && !epochKeyManager.hasCurrentKey(channel.messageStreamId);
                if (!still || laps > 6) { clearInterval(timer); return; }
                try { await epochKeyManager.retryRequestIfWaiting(channel); } catch { /* next lap */ }
            }, 10_000);
        }
    }

    /**
     * Rotate the epoch for anyone who LOST access since the last sweep —
     * bans made while the admin was away, expired PAID subscriptions, sold
     * tokens/NFTs, Closed revokes.
     *
     * Only the channel admin can announce an epoch, so a cut elsewhere leaves
     * the ex-member holding the current key until an admin shows up. The
     * flags read is the one the members panel already makes; comparing it
     * with the previous sweep's snapshot closes the window on the admin's
     * next open. No event scan: free RPCs cap eth_getLogs at 10k blocks.
     *
     * Two triggers, deliberately different:
     * - banned now and never rotated for: rotate even without a snapshot
     *   (the original pending-bans semantics — a ban is explicit intent);
     * - in the last snapshot with access, now without: rotate (lost access).
     * A candidate who never had access (refused requester) never triggers.
     */
    async _rotateForLostAccess(channel) {
        if (!channel?.gate?.address) return;
        if (!epochKeyManager.isOwnAdmin(channel)) return;

        const flags = await this.getGateMemberFlags(channel.messageStreamId);
        if (flags.length === 0) return;   // unreadable gate — judge nothing

        const lower = a => a.toLowerCase();
        const withAccess = new Set(flags.filter(m => m.access).map(m => lower(m.address)));
        const noAccessNow = new Set(flags.filter(m => !m.access && !m.isOwner).map(m => lower(m.address)));
        const bannedNow = flags.filter(m => m.banned).map(m => lower(m.address));
        const previously = new Set((channel.accessSnapshot || []).map(lower));

        // Regained access clears the cover, so losing it AGAIN rotates again.
        const covered = new Set(
            (channel.rotatedForNoAccess || channel.rotatedForBanned || [])
                .map(lower).filter(a => !withAccess.has(a)));

        const pending = [...new Set([
            ...[...noAccessNow].filter(a => previously.has(a)),
            ...bannedNow
        ])].filter(a => !covered.has(a));

        try {
            if (pending.length > 0) {
                await epochKeyManager.rotateEpoch(channel);
                Logger.info('Rotated the epoch for lost access:',
                    pending.length, 'address(es) on', channel.messageStreamId.slice(-20));
            }
            // Persist the PRUNED cover even when nothing is pending — a member
            // who regained access must leave the cover now, or the record of
            // the regain is lost and their next loss never rotates.
            channel.rotatedForNoAccess = [...covered, ...pending];
            channel.accessSnapshot = [...withAccess];
            await this.saveChannels();
        } catch (e) {
            Logger.warn('Deferred rotation for lost access failed (will retry next open):', e.message);
        }
    }

    /**
     * Epoch key setup threw (a cold node can miss every entrypoint on the
     * first try, and the transport then keeps returning the cached failure):
     * retry on a backoff instead of leaving the channel keyless — for the
     * ADMIN that means the bootstrap announce never went out at all — until
     * the next open. Capped: a genuinely offline session must not loop.
     */
    _scheduleEpochSetupRetry(channel) {
        const attempt = (channel._epochSetupRetry || 0) + 1;
        if (attempt > 5) return;
        channel._epochSetupRetry = attempt;
        clearTimeout(channel._epochSetupRetryTimer);
        channel._epochSetupRetryTimer = setTimeout(async () => {
            if (!this.channels.has(channel.messageStreamId)) return;
            try {
                await this._setupEpochKeys(channel);
                channel._epochSetupRetry = 0;
                Logger.info(`Epoch key setup recovered on retry ${attempt}:`, channel.messageStreamId.slice(-20));
            } catch (e) {
                Logger.warn(`Epoch key setup retry ${attempt} failed:`, e.message);
                this._scheduleEpochSetupRetry(channel);
            }
        }, Math.min(15_000 * attempt, 60_000));
    }

    /**
     * A key was adopted: messages skipped as "waiting for key" are sitting in
     * storage — re-pull the recent window through the normal handlers (which
     * dedupe by id) so they surface without a manual reload. Debounced:
     * adopting N epochs in a burst (join) fires one refresh.
     */
    _refreshAfterEpochKey(messageStreamId) {
        const channel = this.channels.get(messageStreamId);
        if (!channel?.gate?.address) return;
        clearTimeout(channel._epochRefreshTimer);
        channel._epochRefreshTimer = setTimeout(() => {
            this._runEpochRefresh(messageStreamId).catch(e =>
                Logger.warn('Epoch refresh failed:', e.message));
        }, 1500);
    }

    async _runEpochRefresh(messageStreamId) {
        const channel = this.channels.get(messageStreamId);
        if (!channel) return;

        // Never overlap the initial load or another refresh: concurrent P0/P1
        // fetches let an override land before its target and park forever in
        // _pendingOverrides. Reschedule through the debounce instead.
        if (channel.initialLoadInProgress || channel._epochRefreshRunning) {
            this._refreshAfterEpochKey(messageStreamId);
            return;
        }
        channel._epochRefreshRunning = true;
        Logger.info('epochKeys: refreshing history after key adoption:', messageStreamId.slice(-20));

        // Same discipline as the initial-load pipeline: gate per-message
        // renders (no flash of pre-override originals), P0 before P1, then
        // flush verifications, apply pending overrides (which also prunes
        // deleted messages), and render ONCE.
        channel.initialLoadInProgress = true;
        try {
            await streamrController.fetchHistoryAsync(
                messageStreamId,
                STREAM_CONFIG.MESSAGE_STREAM.MESSAGES,
                STREAM_CONFIG.INITIAL_MESSAGES,
                (data) => this.handleTextMessage(messageStreamId, data),
                channel.password || null,
                null,
                false,
                { quiet: true }
            );
            if (channel._controlPartitionSupported !== false) {
                await streamrController.fetchHistoryAsync(
                    messageStreamId,
                    STREAM_CONFIG.MESSAGE_STREAM.CONTROL,
                    STREAM_CONFIG.INITIAL_MESSAGES,
                    (data) => this.handleOverrideMessage(messageStreamId, data, true),
                    channel.password || null,
                    null,
                    false,
                    { quiet: true }
                );
            }

            await this.flushBatchVerification(messageStreamId);
            await this.awaitAllFlushes(messageStreamId);
            this.applyPendingOverrides(channel);
            this.sortMessagesByTimestamp(channel);
        } finally {
            channel.initialLoadInProgress = false;
            channel._epochRefreshRunning = false;
        }
        // The -3 artifacts fetched at open were epoch-sealed and unreadable
        // until this key arrived — pins/moderation and a hidden channel's
        // image need their own re-pull (the refresh above only covers -1;
        // the admin poller would take up to a full tick to converge).
        await this.refreshAdminState(messageStreamId);
        const adminId = channel.adminStreamId || deriveAdminId(messageStreamId);
        if (adminId) {
            channelImageManager.get(adminId, { password: channel.password || null, force: true })
                .catch(() => {});
        }
        this.notifyHandlers('initial_history_complete', { streamId: messageStreamId });
    }

    // ==================== Message Overrides ====================
    // Lives in channels/MessageOverrides.js; the manager keeps the entry
    // points its callers already use.

    get pendingReactions() { return this.overrides.pendingReactions; }
    get REACTION_DEBOUNCE_MS() { return this.overrides.REACTION_DEBOUNCE_MS; }
    get pendingOverrides() { return this.overrides.pendingOverrides; }

    storeReaction(channel, messageId, emoji, user, action = 'add') { return this.overrides.storeReaction(channel, messageId, emoji, user, action); }
    getChannelReactions(streamId) { return this.overrides.getChannelReactions(streamId); }
    handleOverrideMessage(streamId, data, fromHistory = false) { return this.overrides.handleOverrideMessage(streamId, data, fromHistory); }
    applyPendingOverrides(channel) { return this.overrides.applyPendingOverrides(channel); }
    sendEdit(streamId, targetId, newText) { return this.overrides.sendEdit(streamId, targetId, newText); }
    sendDelete(streamId, targetId) { return this.overrides.sendDelete(streamId, targetId); }
    sendReaction(streamId, messageId, emoji, isRemoving = false) { return this.overrides.sendReaction(streamId, messageId, emoji, isRemoving); }

    // ==================== End Message Overrides ====================

    // ==================== Presence Tracking ====================
    // Lives in channels/PresenceTracker.js; the manager keeps the entry
    // points its callers already use.

    get onlineUsers() { return this.presence.onlineUsers; }
    get ONLINE_TIMEOUT() { return this.presence.ONLINE_TIMEOUT; }
    get onlineUsersHandlers() { return this.presence.onlineUsersHandlers; }
    set onlineUsersHandlers(handlers) { this.presence.onlineUsersHandlers = handlers; }
    get presenceInterval() { return this.presence.presenceInterval; }
    set presenceInterval(interval) { this.presence.presenceInterval = interval; }

    onOnlineUsersChange(handler) { return this.presence.onOnlineUsersChange(handler); }
    notifyOnlineUsersChange(streamId) { return this.presence.notifyOnlineUsersChange(streamId); }
    getOnlineUsers(streamId) { return this.presence.getOnlineUsers(streamId); }
    handlePresenceMessage(streamId, presenceData) { return this.presence.handlePresenceMessage(streamId, presenceData); }
    publishPresence(messageStreamId) { return this.presence.publishPresence(messageStreamId); }
    startPresenceTracking(streamId) { return this.presence.startPresenceTracking(streamId); }
    stopPresenceTracking() { return this.presence.stopPresenceTracking(); }

    // ==================== End Presence Tracking ====================

    // ==================== Message Flow ====================
    // Lives in channels/MessageFlow.js; the manager keeps the entry
    // points its callers already use.

    get processingMessages() { return this.messageFlow.processingMessages; }
    get sendingMessages() { return this.messageFlow.sendingMessages; }
    get pendingVerifications() { return this.messageFlow.pendingVerifications; }
    get pendingFlushPromises() { return this.messageFlow.pendingFlushPromises; }
    get BATCH_WINDOW_MS() { return this.messageFlow.BATCH_WINDOW_MS; }
    get BATCH_MAX_SIZE() { return this.messageFlow.BATCH_MAX_SIZE; }
    get MAX_RETRIES() { return this.messageFlow.MAX_RETRIES; }
    get RETRY_DELAY() { return this.messageFlow.RETRY_DELAY; }
    set RETRY_DELAY(ms) { this.messageFlow.RETRY_DELAY = ms; }

    handleControlMessage(streamId, data) { return this.messageFlow.handleControlMessage(streamId, data); }
    handleTextMessage(streamId, data) { return this.messageFlow.handleTextMessage(streamId, data); }
    queueMessageForBatchVerification(streamId, data, channel) { return this.messageFlow.queueMessageForBatchVerification(streamId, data, channel); }
    flushBatchVerification(streamId) { return this.messageFlow.flushBatchVerification(streamId); }
    _trackFlush(streamId, promise) { return this.messageFlow._trackFlush(streamId, promise); }
    awaitAllFlushes(streamId) { return this.messageFlow.awaitAllFlushes(streamId); }
    handleMediaMessage(streamId, data, account) { return this.messageFlow.handleMediaMessage(streamId, data, account); }
    sendMessage(messageStreamId, text, replyTo = null) { return this.messageFlow.sendMessage(messageStreamId, text, replyTo); }
    publishWithRetry(messageStreamId, message, password = null, retryCount = 0) { return this.messageFlow.publishWithRetry(messageStreamId, message, password, retryCount); }
    sortMessagesByTimestamp(channel) { return this.messageFlow.sortMessagesByTimestamp(channel); }
    loadMoreHistory(messageStreamId) { return this.messageFlow.loadMoreHistory(messageStreamId); }
    sendWakeSignals(messageStreamId) { return this.messageFlow.sendWakeSignals(messageStreamId); }
    cancelPendingVerifications(streamId) { return this.messageFlow.cancelPendingVerifications(streamId); }

    // ==================== End Message Flow ====================

    // ===== Image recovery =====
    // Lives in channels/ImageRecovery.js; the manager keeps the entry
    // points its callers already use.

    get _imageRecoveryInFlight() { return this.imageRecovery._imageRecoveryInFlight; }

    recoverIncompleteImages(messageStreamId, maxRounds = CONFIG.media.recoveryMaxRounds) {
        return this.imageRecovery.recoverIncompleteImages(messageStreamId, maxRounds);
    }

    _recoverIncompleteImagesInner(messageStreamId, channel, maxRounds) {
        return this.imageRecovery._recoverIncompleteImagesInner(messageStreamId, channel, maxRounds);
    }

    _recoverChunksViaWindow(messageStreamId, channel, incompleteIds, generationAtStart) {
        return this.imageRecovery._recoverChunksViaWindow(messageStreamId, channel, incompleteIds, generationAtStart);
    }

    _markChannelImagesUnavailable(messageStreamId, imageIds) {
        return this.imageRecovery._markChannelImagesUnavailable(messageStreamId, imageIds);
    }

    /**
     * Send typing indicator to EPHEMERAL stream
     * @param {string} messageStreamId - Message Stream ID (channel key)
     */
    async sendTypingIndicator(messageStreamId) {
        try {
            const channel = this.channels.get(messageStreamId);
            if (!channel) return;

            // Use ephemeral stream for typing (not stored)
            const ephemeralStreamId = channel.ephemeralStreamId || deriveEphemeralId(messageStreamId);

            // DM channels: sealed sender, no user field (identity travels inside)
            if (channel.type === 'dm' && channel.peerAddress) {
                await dmManager.sealAndPublish(ephemeralStreamId, channel.peerAddress, {
                    type: 'typing',
                    nickname: identityManager.getUsername?.() || null,
                    timestamp: Date.now()
                }, STREAM_CONFIG.EPHEMERAL_STREAM.CONTROL);
                return;
            }

            // Non-DM channels: no self-reported user field (account from SDK provides identity)
            await streamrController.publishControl(
                ephemeralStreamId,
                { type: 'typing', nickname: identityManager.getUsername?.() || null, timestamp: Date.now() },
                channel.password
            );
        } catch (error) {
            if (error.message?.includes('No epoch key')) {
                Logger.debug('Typing indicator skipped (waiting for epoch key)');
            } else {
                Logger.error('Failed to send typing indicator:', error);
            }
        }
    }

    /**
     * Leave a channel (unsubscribe from both streams)
     * @param {string} messageStreamId - Message Stream ID (channel key)
     * @param {Object} [options] - Leave options
     * @param {boolean} [options.block] - If true, block the peer (DM only). All future messages ignored.
     */
    async leaveChannel(messageStreamId, options = {}) {
        try {
            const channel = this.channels.get(messageStreamId);
            const ephemeralStreamId = channel?.ephemeralStreamId || deriveEphemeralId(messageStreamId);
            
            // DM-specific cleanup: clear local sent data and cached keys
            if (channel?.type === 'dm' && channel.peerAddress) {
                if (options.block) {
                    // Leave and Block: permanently ignore all messages from this peer
                    await secureStorage.addBlockedPeer(channel.peerAddress);
                    Logger.info('DM: Blocked peer', channel.peerAddress);
                } else {
                    // Soft leave: mark timestamp so older messages are ignored,
                    // but new messages after this point will resurface the conversation
                    await secureStorage.setDMLeftAt(channel.peerAddress, Date.now());
                    Logger.info('DM: Soft-left conversation with', channel.peerAddress);
                }
                await secureStorage.clearSentMessages(messageStreamId);
                await secureStorage.clearSentReactions(messageStreamId);
                dmCrypto.peerPublicKeys.delete(channel.peerAddress);
                dmManager.conversations.delete(channel.peerAddress);
                Logger.debug('DM: Cleaned up local data for', channel.peerAddress);
            }
            
            // Unsubscribe from both streams. There is no admin-stream (-3)
            // subscription to drop — the resend-based admin model holds no
            // live websocket on -3 (see adminStatePoller).
            await streamrController.unsubscribeFromDualStream(messageStreamId, ephemeralStreamId);

            // Gated: drop the -4 subscription and the channel's epoch keys
            if (channel?.gate?.address) {
                const keysStreamId = channel.keysStreamId || deriveKeysId(messageStreamId);
                try { await streamrController.unsubscribe(keysStreamId); } catch { /* not subscribed */ }
                await epochKeyManager.forgetChannel(messageStreamId);
            }
            
            // Cancel any pending batch verifications for this channel
            this.cancelPendingVerifications(messageStreamId);
            
            // Clean up online users tracking for this channel
            this.onlineUsers.delete(messageStreamId);
            
            this.channels.delete(messageStreamId);
            // Tombstone so sync propagates the leave without deleting
            // channels re-joined later (per-channel latest-wins)
            await secureStorage.setChannelLeftAt(messageStreamId, Date.now());
            await this.saveChannels();
            
            // Remove from channel order
            await secureStorage.removeFromChannelOrder(messageStreamId);

            if (this.currentChannel === messageStreamId) {
                this.setCurrentChannel(null);
            }

            Logger.debug('Left channel:', messageStreamId);
        } catch (error) {
            Logger.error('Failed to leave channel:', error);
            throw error;
        }
    }

    /**
     * Leave all channels (used on disconnect)
     */
    async leaveAllChannels() {
        try {
            const channelIds = Array.from(this.channels.keys());
            for (const streamId of channelIds) {
                try {
                    await streamrController.unsubscribe(streamId);
                } catch (e) {
                    Logger.warn('Failed to unsubscribe from', streamId, e);
                }
            }
            this.channels.clear();
            this.setCurrentChannel(null);
            this.onlineUsers.clear();
            this.processingMessages.clear();
            this.sendingMessages.clear();
            this.pendingReactions.clear();
            this.pendingOverrides.clear();
            // Cancel all pending batch verifications
            for (const [, batch] of this.pendingVerifications) {
                if (batch.timer) clearTimeout(batch.timer);
            }
            this.pendingVerifications.clear();
            this.pendingFlushPromises.clear();
            // Don't clear from localStorage - keep for reconnect
            Logger.debug('Left all channels');
        } catch (error) {
            Logger.error('Failed to leave all channels:', error);
        }
    }

    /**
     * Delete a channel completely (deletes the stream from Streamr network)
     * Only the channel owner can delete a channel
     * @param {string} streamId - Stream ID
     */
    async deleteChannel(streamId) {
        try {
            if (!this.isChannelOwner(streamId)) {
                throw new Error('Only the channel owner can delete a channel');
            }

            // Try to delete the stream from Streamr network
            try {
                await streamrController.deleteStream(streamId);
                Logger.debug('Stream deleted from Streamr network:', streamId);
            } catch (networkError) {
                const chainError = parseChainError(networkError);
                
                // Gas/transaction errors should stop the delete and inform user
                if (chainError.isGasError) {
                    throw new Error(chainError.message);
                }
                
                // Stream might not exist on network or other non-critical error
                // - that's OK, proceed to remove locally
                Logger.warn('Could not delete from network (may not exist):', networkError.message);
            }
            
            // Remove from local storage
            this.channels.delete(streamId);
            await epochKeyManager.forgetChannel(streamId);
            // Tombstone so sync doesn't resurrect the deleted channel
            await secureStorage.setChannelLeftAt(streamId, Date.now());
            await this.saveChannels();
            
            // Clear transient async/send state for this channel
            this.clearStreamTransientState(streamId);
            
            // Remove from channel order
            await secureStorage.removeFromChannelOrder(streamId);

            if (this.currentChannel === streamId) {
                this.setCurrentChannel(null);
            }

            Logger.info('Channel removed:', streamId);
        } catch (error) {
            Logger.error('Failed to delete channel:', error);
            throw error;
        }
    }

    /**
     * Set current active channel
     * @param {string} streamId - Stream ID
     */
    setCurrentChannel(streamId) {
        const previousChannel = this.currentChannel;
        this.currentChannel = streamId;
        this.switchGeneration++;
        
        // Abort any in-flight history fetch for the previous channel
        if (this.historyAbortController) {
            this.historyAbortController.abort();
            this.historyAbortController = null;
        }
        
        // Cancel any pending batch verifications for the previous channel
        // to avoid stale messages being processed after the switch
        if (previousChannel && previousChannel !== streamId) {
            this.clearStreamTransientState(previousChannel);
        }
    }

    /**
     * Clear transient async/send state for a specific stream.
     * Used on channel switch/delete to isolate stale in-flight work.
     * @param {string} streamId - Stream ID
     */
    clearStreamTransientState(streamId) {
        if (!streamId) return;
        this.cancelPendingVerifications(streamId);
        this.pendingFlushPromises.delete(streamId);

        // Remove send-side override dedupe keys for this stream (format: streamId:targetId:type)
        for (const key of [...this.pendingOverrides]) {
            if (key.startsWith(`${streamId}:`)) {
                this.pendingOverrides.delete(key);
            }
        }
    }

    /**
     * Get current channel
     * @returns {Object|null} - Current channel object
     */
    getCurrentChannel() {
        return this.currentChannel ? this.channels.get(this.currentChannel) : null;
    }

    /**
     * Get channel by stream ID
     * @param {string} streamId - Stream ID
     * @returns {Object|null} - Channel object or null
     */
    getChannel(streamId) {
        return this.channels.get(streamId) || null;
    }

    /**
     * Whether a stream's channel publishes under the ACCOUNT (gated or
     * read-only) rather than an ephemeral per-channel key. Read-only channels
     * are owner-publish — an ephemeral key holds no grant, so those must use
     * the primary identity (D3). Accepts any of a channel's three stream ids
     * (-1/-2/-3). Injected into streamrController.channelUsesAccount so
     * publishAsChannel can decide without importing channelManager (that
     * would be circular).
     */
    usesAccountPublish(streamId) {
        if (!streamId) return false;
        const base = String(streamId).replace(/-[123]$/, '');
        const ch = this.channels.get(base + '-1');
        // Gated included: the ACCOUNT signs the envelope (that signature is
        // the authorship) even though the on-wire publisher is the gate clone.
        // By TYPE, not by gate.address — a gated channel whose gate is still
        // being repaired must fail loudly in the gated path, never fall
        // through to an ephemeral publish the network rejects.
        return !!ch && (ch.type === 'gated'
            || ch.readOnly === true || !!ch.gate?.address);
    }

    /**
     * Get all channels
     * @returns {Array} - Array of channel objects
     */
    getAllChannels() {
        return Array.from(this.channels.values());
    }

    /**
     * Register a message handler
     * @param {Function} handler - Handler function (event, data)
     */
    onMessage(handler) {
        this.messageHandlers.push(handler);
    }

    /**
     * Notify all handlers
     * @param {string} event - Event name
     * @param {Object} data - Event data
     */
    notifyHandlers(event, data) {
        // Side-effect: keep `channelLatestMessageManager` in sync so the
        // sidebar/Explore preview reflects new content / edits / deletes
        // without each UI subscribing to the channel itself.
        try {
            this._updateLatestPreview(event, data);
        } catch (e) {
            Logger.debug('latest preview update error:', e?.message);
        }

        for (const handler of this.messageHandlers) {
            try {
                handler(event, data);
            } catch (error) {
                Logger.error('Handler error:', error);
            }
        }
    }

    /**
     * @private
     * Update the latest-message preview cache from notifyHandlers events.
     * - 'message'         → straight setFromLocal with the incoming payload.
     * - 'reaction'        → synthesize a reaction-shape entry.
     * - 'message_edited'  → re-feed the (now mutated) message from
     *                       channel.messages so the cache picks up the new text.
     * - 'message_deleted' → walk channel.messages backwards for the next
     *                       visible (non-deleted, non-override) message and
     *                       feed that; if none, clear the cache.
     */
    _updateLatestPreview(event, data) {
        if (!data || !data.streamId) return;
        const streamId = data.streamId;
        const channel = this.channels.get(streamId);
        if (!channel) return;

        if (event === 'message' && data.message) {
            channelLatestMessageManager.setFromLocal(streamId, data.message);
            return;
        }
        if (event === 'reaction') {
            // data: { streamId, messageId, emoji, user, action, senderName?, timestamp? }
            // The reaction's real timestamp is required \u2014 without it an
            // OLD reaction replayed during history backfill would appear
            // "newer" than the actual latest message. Drop the event when
            // it's missing rather than masking the bug with Date.now().
            if (!data.timestamp) return;
            channelLatestMessageManager.setFromLocal(streamId, {
                type: 'reaction',
                emoji: data.emoji,
                action: data.action || 'add',
                messageId: data.messageId,
                sender: data.user,
                senderName: data.senderName || null,
                timestamp: data.timestamp
            });
            return;
        }
        if (event === 'message_edited' && data.targetId) {
            const msg = (channel.messages || []).find(m => m.id === data.targetId);
            if (msg) channelLatestMessageManager.setFromLocal(streamId, msg);
            return;
        }
        if (event === 'message_deleted' && data.targetId) {
            const cached = channelLatestMessageManager.getCached(streamId);
            // Only react if the deleted message is currently the preview
            if (!cached || cached.id !== data.targetId) return;
            // Walk backwards for the next visible message
            const list = channel.messages || [];
            for (let i = list.length - 1; i >= 0; i--) {
                const m = list[i];
                if (!m) continue;
                if (m._deleted) continue;
                if (m.type === 'edit' || m.type === 'delete') continue;
                if (m.type === 'text' || m.type === 'image' || m.type === 'file_announce' || m.type === 'storage_file_announce' || m.type === 'reaction') {
                    channelLatestMessageManager.setFromLocal(streamId, m);
                    return;
                }
            }
            // Nothing left → clear
            channelLatestMessageManager.clear(streamId);
        }
    }

    /**
     * Convert bytes to URL-safe base64 without padding
     * @param {Uint8Array} bytes
     * @returns {string}
     */
    bytesToBase64Url(bytes) {
        let binary = '';
        for (let i = 0; i < bytes.length; i++) {
            binary += String.fromCharCode(bytes[i]);
        }
        return btoa(binary)
            .replace(/\+/g, '-')
            .replace(/\//g, '_')
            .replace(/=+$/g, '');
    }

    /**
     * Convert URL-safe base64 to bytes
     * @param {string} value
     * @returns {Uint8Array}
     */
    base64UrlToBytes(value) {
        const normalized = value
            .replace(/-/g, '+')
            .replace(/_/g, '/');
        const padding = '='.repeat((4 - (normalized.length % 4)) % 4);
        const binary = atob(normalized + padding);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) {
            bytes[i] = binary.charCodeAt(i);
        }
        return bytes;
    }

    /**
     * Generate invite link for a channel.
     *
     * A password is the only part of an invite that cannot be recovered from
     * the chain, so it is the only case that still needs the encrypted token.
     * Everything else — name, type, gate address — is in the channel's stream
     * metadata, which the joiner reads for itself, so those channels get the
     * plain `#/channel/<streamId>` route instead: shorter, a smaller QR code,
     * and readable by a human deciding whether to open it.
     *
     * @param {string} streamId - Stream ID
     * @returns {string} - Invite link
     */
    async generateInviteLink(streamId) {
        const channel = this.channels.get(streamId);
        if (!channel) {
            throw new Error('Channel not found');
        }

        const base = `${window.location.origin}${window.location.pathname}`;
        if (!channel.password) {
            return `${base}#/channel/${streamId}`;
        }

        // Use short keys to minimize QR code data size
        const inviteData = {
            s: streamId,      // streamId
            n: channel.name,  // name
            t: channel.type   // type
        };

        inviteData.p = channel.password;  // password

        // Gated (N-C, §7.14): the gate clone address. Everything else about
        // the gate (mode, token, price, duration) is read from the chain by
        // the joiner — one address is the whole invite surface.
        if (channel.gate?.address) {
            inviteData.k = channel.gate.address;
        }

        const keyBytes = crypto.getRandomValues(new Uint8Array(32));
        const iv = crypto.getRandomValues(new Uint8Array(12));
        const key = await crypto.subtle.importKey(
            'raw',
            keyBytes,
            { name: 'AES-GCM' },
            false,
            ['encrypt']
        );

        const payloadBytes = new TextEncoder().encode(JSON.stringify(inviteData));
        const ciphertext = await crypto.subtle.encrypt(
            { name: 'AES-GCM', iv },
            key,
            payloadBytes
        );

        const token = [
            this.bytesToBase64Url(iv),
            this.bytesToBase64Url(new Uint8Array(ciphertext)),
            this.bytesToBase64Url(keyBytes)
        ].join('.');

        return `${base}#/invite/${token}`;
    }

    /**
     * Parse invite link
     * @param {string} inviteCode - Encrypted invite token (iv.cipher.key)
     * @returns {Object} - Invite data
     */
    async parseInviteLink(inviteCode) {
        try {
            const parts = inviteCode.split('.');
            if (parts.length !== 3) {
                throw new Error('Invalid invite token format');
            }

            const iv = this.base64UrlToBytes(parts[0]);
            const ciphertext = this.base64UrlToBytes(parts[1]);
            const keyBytes = this.base64UrlToBytes(parts[2]);

            if (iv.length !== 12 || keyBytes.length !== 32) {
                throw new Error('Invalid invite token length');
            }

            const key = await crypto.subtle.importKey(
                'raw',
                keyBytes,
                { name: 'AES-GCM' },
                false,
                ['decrypt']
            );

            const decrypted = await crypto.subtle.decrypt(
                { name: 'AES-GCM', iv },
                key,
                ciphertext
            );

            const decoded = new TextDecoder().decode(decrypted);
            const data = JSON.parse(decoded);
            
            // Compact format: s=streamId, n=name, t=type, p=password,
            // k=gate clone address (gated channels)
            return {
                streamId: data.s,
                name: data.n,
                type: data.t,
                password: data.p,
                gateAddress: data.k
            };
        } catch (error) {
            Logger.error('Failed to parse invite link:', error);
            return null;
        }
    }

    // ==================== PUBLIC CHANNEL DISCOVERY ====================

    /**
     * Get public Pombo channels
     * Queries The Graph for streams with Pombo metadata and public permissions
     * @returns {Promise<Array>} - List of public channels
     */
    async getPublicChannels() {
        const channelsMap = new Map(); // Use map to deduplicate by streamId

        // 1. Query The Graph for public Pombo channels
        try {
            Logger.debug('Fetching public channels from The Graph...');
            const graphChannels = await graphAPI.getPublicPomboChannels();
            
            for (const ch of graphChannels) {
                channelsMap.set(ch.streamId, ch);
            }
            Logger.debug(`Found ${graphChannels.length} public channels from The Graph`);
        } catch (error) {
            Logger.warn('Failed to fetch from The Graph:', error.message);
        }

        // 2. Add own public channels (in case Graph hasn't indexed them yet)
        for (const channel of this.channels.values()) {
            if (channel.type === 'public' && !channelsMap.has(channel.streamId)) {
                channelsMap.set(channel.streamId, {
                    streamId: channel.streamId,
                    name: channel.name,
                    createdBy: channel.createdBy,
                    createdAt: channel.createdAt,
                    type: 'public'
                });
            }
        }

        // Convert to array and sort by creation date (newest first)
        const channels = Array.from(channelsMap.values());
        channels.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));

        return channels;
    }
}

// Export singleton instance
export const channelManager = new ChannelManager();
