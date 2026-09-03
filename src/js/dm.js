/**
 * DM Manager
 * Manages Direct Messages using paired many-to-one Streamr streams.
 * 
 * Architecture:
 * - Each user has a deterministic inbox: {address}/Pombo-DM-1 (stored) + {address}/Pombo-DM-2 (ephemeral)
 * - Permissions: public PUBLISH, owner-only SUBSCRIBE (protects social graph)
 * - No Streamr-layer encryption (P6): everything publishes EncryptionType.NONE
 *   under a throwaway key; E2E security is the sealed-sender v2 envelope
 *   (dmCrypto.seal — ECDH against a per-message ephemeral key + AES-256-GCM)
 * - To DM Bob: Alice publishes to Bob's inbox. Bob reads from his own inbox.
 * - The sender is identified AFTER opening, from the proof inside the
 *   ciphertext — the publisherId is a throwaway and names nobody.
 * - Conversations are keyed by peerAddress and stored locally.
 */

import { Logger } from './logger.js';
import { applyAccount, stripLocalFields } from './publisherProof.js';
import { CONFIG } from './config.js';
import { CryptoError } from './utils/errors.js';
import { streamrController, STREAM_CONFIG } from './streamr.js';
import { channelManager } from './channels.js';
import { secureStorage } from './secureStorage.js';
import { authManager } from './auth.js';
import { identityManager } from './identity.js';
import { relayManager } from './relayManager.js';
import { dmCrypto } from './dmCrypto.js';
import { mediaController } from './media.js';

class DMManager {
    constructor() {
        // My inbox stream IDs
        this.inboxMessageStreamId = null;
        this.inboxEphemeralStreamId = null;

        // Active inbox subscriptions (when app is open)
        this.inboxSubscription = null;
        this.inboxEphemeralSubscription = null;
        this.inboxNotificationSub = null;

        // Conversations: peerAddress (lowercase) → messageStreamId in channelManager
        this.conversations = new Map();

        // Guards against concurrent getOrCreateConversation for the same peer
        // peerAddress → Promise<channel>
        this.pendingConversations = new Map();

        // Whether inbox has been verified/created
        this.inboxReady = false;

        // Positive-result cache for hasInbox() — avoids a network getStream
        // per sync operation. Keyed by stream ID so account switches invalidate.
        this._inboxExistsCache = null;

        // Event handlers (UI notifications)
        this.handlers = [];
    }

    /**
     * Initialize DM system — called after wallet connection (non-guest only)
     * Checks if inbox exists, loads saved DM conversations, sets up routing.
     */
    async init() {
        if (authManager.isGuestMode()) {
            Logger.debug('DM: Skipping init for guest mode');
            return;
        }

        const myAddress = authManager.getAddress();
        if (!myAddress) {
            Logger.warn('DM: No address available, skipping init');
            return;
        }

        this.inboxMessageStreamId = streamrController.getDMInboxId(myAddress);
        this.inboxEphemeralStreamId = streamrController.getDMEphemeralId(myAddress);
        this._inboxExistsCache = null;

        // Rebuild conversations map from saved channels
        this.loadConversationsFromChannels();

        Logger.info('DM: Initialized', {
            inbox: this.inboxMessageStreamId,
            conversations: this.conversations.size
        });

        // Auto-subscribe to inbox if it exists (loads history + real-time)
        try {
            const exists = await this.hasInbox();
            if (exists) {
                this.inboxReady = true;
                await this.subscribeToInbox();

                // Also re-register push notifications for inbox
                this.subscribeInboxPush().catch(e => {
                    Logger.debug('DM: Push re-registration failed (non-critical):', e.message);
                });
            }
        } catch (e) {
            Logger.warn('DM: Auto-subscribe to inbox failed (non-critical):', e.message);
        }
    }

    /**
     * Rebuild the conversations map from existing DM channels in channelManager
     */
    loadConversationsFromChannels() {
        this.conversations.clear();
        for (const [streamId, channel] of channelManager.channels) {
            if (channel.type === 'dm' && channel.peerAddress) {
                this.conversations.set(channel.peerAddress.toLowerCase(), streamId);
            }
        }
    }

    /**
     * Check if the current user's inbox already exists on-chain.
     * A positive result is cached for the session (streams aren't deleted
     * mid-session); a negative result is re-checked every call so transient
     * network failures don't disable sync until reload.
     * @returns {Promise<boolean>}
     */
    async hasInbox() {
        if (!this.inboxMessageStreamId) return false;
        if (this._inboxExistsCache === this.inboxMessageStreamId) return true;

        try {
            await streamrController.client.getStream(this.inboxMessageStreamId);
            this._inboxExistsCache = this.inboxMessageStreamId;
            return true;
        } catch (e) {
            return false;
        }
    }

    /**
     * Create inbox streams (idempotent — skips if already exists)
     * @param {Object} options - Storage options
     * @param {string} options.storageProvider - 'streamr' or 'custom' (default: 'streamr')
     * @param {string} [options.customStorageAddress] - EVM address of the custom storage node (required if provider is 'custom')
     * @param {number} options.storageDays - Retention days (default: 180)
     * @param {Function} [options.onProgress] - Called once per on-chain step
     * @returns {Promise<{messageStreamId: string, ephemeralStreamId: string}>}
     */
    async createInbox(options = {}) {
        // Compute our public key for ECDH key exchange (stored in stream metadata)
        const privateKey = authManager.wallet?.privateKey;
        const publicKey = privateKey ? dmCrypto.getMyPublicKey(privateKey) : null;

        const result = await streamrController.createDMInbox(publicKey, options);
        this.inboxMessageStreamId = result.messageStreamId;
        this.inboxEphemeralStreamId = result.ephemeralStreamId;
        this.inboxReady = true;
        this._inboxExistsCache = result.messageStreamId;

        Logger.info('DM: Inbox created/verified');
        this.notifyHandlers('inbox_ready', { streamId: this.inboxMessageStreamId });

        // Subscribe to inbox for real-time messages
        await this.subscribeToInbox();

        // Auto-subscribe to push notifications for our inbox
        this.subscribeInboxPush().catch(e => {
            Logger.debug('DM: Push subscription for inbox failed (non-critical):', e.message);
        });

        return result;
    }

    /**
     * Diagnose inbox health — read-only, no gas.
     * @returns {Promise<Object>} Diagnosis report from streamrController.diagnoseInbox()
     */
    async diagnoseInbox() {
        const address = authManager.getAddress();
        if (!address) throw new Error('No wallet connected');
        return streamrController.diagnoseInbox(address);
    }

    /**
     * Repair inbox based on diagnosis — only runs missing/broken steps.
     * @param {Object} diagnosis - Result from diagnoseInbox()
     * @param {Object} options - Storage options { storageProvider, customStorageAddress, storageDays }
     * @param {Function} onStep - Progress callback: (stepName, status)
     * @returns {Promise<Object>} Repair result
     */
    async repairInbox(diagnosis, options = {}, onStep = () => {}) {
        const privateKey = authManager.wallet?.privateKey;
        const publicKey = privateKey ? dmCrypto.getMyPublicKey(privateKey) : null;

        const result = await streamrController.repairInbox(diagnosis, publicKey, options, onStep);

        this.inboxMessageStreamId = result.messageStreamId;
        this.inboxEphemeralStreamId = result.ephemeralStreamId;
        this.inboxReady = true;

        Logger.info('DM: Inbox repaired');
        this.notifyHandlers('inbox_ready', { streamId: this.inboxMessageStreamId });

        // Re-subscribe to inbox after repair
        this.inboxSubscription = null; // Force re-subscribe
        await this.subscribeToInbox();

        return result;
    }

    /**
     * Subscribe to own inbox (real-time messages from others)
     * Call when user opens the Personal/DM tab or on startup.
     */
    async subscribeToInbox() {
        if (!this.inboxMessageStreamId) {
            Logger.warn('DM: Cannot subscribe — inbox not initialized');
            return;
        }

        if (this.inboxSubscription) {
            Logger.debug('DM: Already subscribed to inbox');
            return;
        }

        try {
            Logger.info('DM: Subscribing to inbox', this.inboxMessageStreamId);

            // Subscribe to message stream (DM-1 partition 0) with history
            this.inboxSubscription = await streamrController.subscribeWithHistory(
                this.inboxMessageStreamId,
                0,  // partition 0 = messages
                (data) => this.routeInboxMessage(data),
                CONFIG.dm.inboxHistoryCount,
                null  // No Streamr password; messages encrypted E2E at app layer (ECDH+AES-256-GCM)
            );

            Logger.info('DM: Inbox message subscription active');

            // Subscribe to notification partition (DM-1 partition 3) for channel invites
            // Skip if user has muted invites
            const { notificationManager } = await import('./notifications.js');
            if (!notificationManager.isMuted()) {
                try {
                    this.inboxNotificationSub = await streamrController.subscribeToPartition(
                        this.inboxMessageStreamId,
                        STREAM_CONFIG.MESSAGE_STREAM.NOTIFICATIONS,
                        (data) => this.routeNotification(data),
                        null
                    );
                    Logger.info('DM: Notification subscription active (P3)');
                } catch (e) {
                    Logger.warn('DM: Failed to subscribe to notification partition:', e.message);
                    this.inboxNotificationSub = null;
                }
            } else {
                Logger.info('DM: Notification invites muted — skipping P3 subscription');
            }

            // DM-2 ephemeral (typing/presence) is on-demand only:
            // subscribed when user opens a DM conversation, unsubscribed when they leave.
        } catch (error) {
            Logger.error('DM: Failed to subscribe to inbox:', error.message);
            this.inboxSubscription = null;
        }
    }

    /**
     * Unsubscribe from inbox (when leaving DM tab or disconnecting)
     */
    async unsubscribeFromInbox() {
        try {
            if (this.inboxSubscription) {
                await streamrController.unsubscribe(this.inboxMessageStreamId);
            }
            Logger.info('DM: Unsubscribed from inbox');
        } catch (error) {
            Logger.warn('DM: Error unsubscribing:', error.message);
        }
        this.inboxSubscription = null;
        this.inboxNotificationSub = null;
        // Also tear down ephemeral if active. Forced: this path is disconnect, not
        // navigation, so nothing should survive it.
        await this.unsubscribeDMEphemeral({ force: true });
    }

    /**
     * Subscribe to notification partition (P3) on demand.
     * Called when user unmutes channel invites.
     */
    async subscribeNotifications() {
        if (!this.inboxMessageStreamId || this.inboxNotificationSub) return;
        try {
            this.inboxNotificationSub = await streamrController.subscribeToPartition(
                this.inboxMessageStreamId,
                STREAM_CONFIG.MESSAGE_STREAM.NOTIFICATIONS,
                (data) => this.routeNotification(data),
                null
            );
            Logger.info('DM: Notification subscription active (P3)');
        } catch (e) {
            Logger.warn('DM: Failed to subscribe to notification partition:', e.message);
            this.inboxNotificationSub = null;
        }
    }

    /**
     * Unsubscribe from notification partition (P3).
     * Called when user mutes channel invites.
     */
    async unsubscribeNotifications() {
        if (!this.inboxNotificationSub) return;
        try {
            await streamrController.unsubscribeFromPartition(
                this.inboxMessageStreamId,
                STREAM_CONFIG.MESSAGE_STREAM.NOTIFICATIONS
            );
            Logger.info('DM: Unsubscribed from notification partition (P3)');
        } catch (e) {
            Logger.warn('DM: Error unsubscribing from P3:', e.message);
        }
        this.inboxNotificationSub = null;
    }

    /**
     * Subscribe to DM-2 ephemeral (typing/presence) — on-demand.
     * Called when user opens a DM conversation.
     */
    async subscribeDMEphemeral() {
        if (!this.inboxEphemeralStreamId) return;
        if (this.inboxEphemeralSubscription) {
            Logger.debug('DM: Ephemeral already subscribed');
            return;
        }

        try {
            // Partition 0: Control (presence, typing)
            this.inboxEphemeralSubscription = await streamrController.subscribeWithHistory(
                this.inboxEphemeralStreamId,
                STREAM_CONFIG.EPHEMERAL_STREAM.CONTROL,
                (data) => this.routeInboxControl(data),
                0,  // no history — ephemeral
                null
            );

            // Partitions 1 and 2 may still be live: unsubscribeDMEphemeral() keeps them
            // when transfers are in flight, and subscribeToPartition() does not dedupe.

            // Partition 1: Media signals (piece_request, source_request, etc.)
            if (!streamrController.isSubscribedToPartition(
                this.inboxEphemeralStreamId, STREAM_CONFIG.EPHEMERAL_STREAM.MEDIA_SIGNALS
            )) {
                await streamrController.subscribeToPartition(
                    this.inboxEphemeralStreamId,
                    STREAM_CONFIG.EPHEMERAL_STREAM.MEDIA_SIGNALS,
                    (data) => this.routeInboxMedia(data),
                    null
                );
            }

            // Partition 2: Media data (file_piece — binary)
            if (!streamrController.isSubscribedToPartition(
                this.inboxEphemeralStreamId, STREAM_CONFIG.EPHEMERAL_STREAM.MEDIA_DATA
            )) {
                await streamrController.subscribeToPartition(
                    this.inboxEphemeralStreamId,
                    STREAM_CONFIG.EPHEMERAL_STREAM.MEDIA_DATA,
                    (data, account) => this.routeInboxMedia(data, account),
                    null
                );
            }

            Logger.info('DM: Ephemeral subscription active (control + media signals + media data)');
        } catch (error) {
            Logger.warn('DM: Ephemeral subscription failed (non-critical):', error.message);
            this.inboxEphemeralSubscription = null;
        }
    }

    /**
     * Unsubscribe from DM-2 ephemeral — called when user leaves DM conversation.
     */
    /**
     * @param {Object} [options]
     * @param {boolean} [options.force=false] - Drop the whole stream even when transfers
     *   are active. Used on disconnect, where preserving partitions would leak them.
     */
    async unsubscribeDMEphemeral({ force = false } = {}) {
        if (!this.inboxEphemeralSubscription) return;

        try {
            // Mirrors the non-DM path in subscriptionManager.downgradeToBackground():
            // presence/typing on P0 are only meaningful while a conversation is open,
            // but P1/P2 are how a seeder hears piece requests. Dropping the whole
            // stream stopped every DM transfer the instant the user navigated away —
            // the peer's download stalled and only resumed on coming back.
            if (!force && mediaController.hasActiveDMTransfers()) {
                await streamrController.unsubscribeFromPartition(
                    this.inboxEphemeralStreamId,
                    STREAM_CONFIG.EPHEMERAL_STREAM.CONTROL
                );
                Logger.info('DM: Ephemeral control unsubscribed — media partitions kept alive for active transfers');
            } else {
                await streamrController.unsubscribe(this.inboxEphemeralStreamId);
                Logger.info('DM: Ephemeral unsubscribed');
            }
        } catch (error) {
            Logger.warn('DM: Error unsubscribing ephemeral:', error.message);
        }
        this.inboxEphemeralSubscription = null;
    }

    /**
     * Seal a payload for a peer and publish it under a throwaway identity.
     *
     * The v1 path published with our own wallet as the Streamr publisher, so
     * the (sender → recipient) edge sat in the clear on the inbox stream: the
     * recipient is in the stream ID, and we were in the publisherId. Anyone
     * running a storage node, or joining the partition topology, could read the
     * social graph straight off the wire.
     *
     * Here the ephemeral key produced by `seal()` doubles as the Streamr
     * publishing identity, so the publisherId is a throwaway address too. The
     * real sender travels inside the ciphertext, where only the recipient
     * reaches it.
     *
     * Published with `encryptionType: NONE` (see streamrController.publishAs):
     * the SDK's own AES layer would drag the group-key exchange back in, and it
     * was never protecting anything — its key is a constant in this repo.
     *
     * @param {string} peerInboxStreamId - Peer's inbox (message stream)
     * @param {string} peerAddress - Peer's address
     * @param {Object} payload - Plaintext payload to seal
     * @param {number} [partition=0] - Message-stream partition
     * @returns {Promise<Object>} - The published StreamMessage
     */
    async sealAndPublish(peerInboxStreamId, peerAddress, payload, partition = STREAM_CONFIG.MESSAGE_STREAM.MESSAGES) {
        const sealed = await this.sealFor(peerAddress, payload);
        return this.publishSealed(peerInboxStreamId, sealed, partition);
    }

    /**
     * Seal a payload for a peer without publishing it.
     *
     * Split out of sealAndPublish for callers that must know the envelope's
     * wire size before committing to it — the stored-image path has a hard
     * per-payload byte limit, and sizing one envelope then sending a freshly
     * sealed second one would measure a different ephemeral key than the one
     * actually sent.
     *
     * @param {string} peerAddress - Peer's address
     * @param {Object} payload - Plaintext payload to seal
     * @returns {Promise<{envelope: Object, ephemeralPrivateKey: string}>}
     */
    async sealFor(peerAddress, payload) {
        const privateKey = authManager.wallet?.privateKey;
        if (!privateKey) throw new Error('Cannot send DM: no private key');

        const peerPubKey = await this.getPeerPublicKey(peerAddress);
        if (!peerPubKey) {
            throw new Error('Cannot send DM: peer public key not available. The recipient may need to open Pombo first to create their inbox.');
        }

        // Same strip as the channel path (D6): the seal already proves who we
        // are, so `sender`/`account` inside would be an unverified second copy
        // of a claim the proof settles — and openDMEnvelope overwrites them from
        // the proof on arrival regardless.
        return dmCrypto.seal(stripLocalFields(payload), {
            senderPrivateKey: privateKey,
            recipientAddress: peerAddress,
            recipientPublicKey: peerPubKey
        });
    }

    /**
     * Publish an already-sealed envelope under its own ephemeral identity.
     *
     * @param {string} peerInboxStreamId - Peer's inbox (message stream)
     * @param {{envelope: Object, ephemeralPrivateKey: string}} sealed - From sealFor()
     * @param {number} [partition=0] - Message-stream partition
     * @returns {Promise<Object>} - The published StreamMessage
     */
    /**
     * Build a binary sealer for one transfer to one peer.
     *
     * The caller must hold on to it for the whole transfer: it carries the
     * single ephemeral identity every piece is published under, so creating one
     * per piece would both waste an ECDH and hand an observer a fresh key to
     * count pieces with.
     *
     * @param {string} peerAddress - Peer's address
     * @returns {Promise<{ephemeralPublicKey: string, seal: Function}>}
     */
    async createBinarySealer(peerAddress) {
        const privateKey = authManager.wallet?.privateKey;
        if (!privateKey) throw new Error('Cannot send DM media: no private key');

        const peerPubKey = await this.getPeerPublicKey(peerAddress);
        if (!peerPubKey) {
            throw new Error('Cannot send DM media: peer public key not available');
        }

        const sealer = await dmCrypto.createBinarySealer({
            senderPrivateKey: privateKey,
            recipientAddress: peerAddress,
            recipientPublicKey: peerPubKey
        });

        // The same ephemeral key doubles as the Streamr publisher, exactly as in
        // sealAndPublish. It costs nothing: `epk` already travels in the
        // envelope's cleartext header, so the publisherId reveals no more.
        const EthereumKeyPairIdentity = window.EthereumKeyPairIdentity;
        if (!EthereumKeyPairIdentity) {
            throw new Error('EthereumKeyPairIdentity not exposed — check streamr-bundle.js');
        }

        return {
            seal: sealer.seal,
            identity: EthereumKeyPairIdentity.fromPrivateKey(sealer.ephemeralPrivateKey)
        };
    }

    async publishSealed(peerInboxStreamId, sealed, partition = STREAM_CONFIG.MESSAGE_STREAM.MESSAGES) {
        const EthereumKeyPairIdentity = window.EthereumKeyPairIdentity;
        if (!EthereumKeyPairIdentity) {
            throw new Error('EthereumKeyPairIdentity not exposed — check streamr-bundle.js');
        }
        const ephemeralIdentity = EthereumKeyPairIdentity.fromPrivateKey(sealed.ephemeralPrivateKey);

        return streamrController.publishAs(
            ephemeralIdentity, peerInboxStreamId, partition, sealed.envelope);
    }

    /**
     * Open an incoming DM envelope, whichever scheme it uses.
     *
     * v2 (sealed): the sender is unknown until the envelope is open — that is
     * the point. `data.account`, stamped at ingest from the publisherId, is a
     * throwaway address and gets REPLACED by the real sender recovered from the
     * proof inside.
     *
     * v1 (legacy): the sender had to be known up front to pick the key, so
     * `data.account` is already the real sender. Kept for history published
     * before the migration.
     *
     * @param {Object} data - Raw payload from the inbox
     * @returns {Promise<Object|null>} - Decrypted payload with `account` set to
     *   the true sender, or null when it cannot be opened
     */
    async openDMEnvelope(data) {
        if (dmCrypto.isSealed(data)) {
            const privateKey = authManager.wallet?.privateKey;
            const myAddress = authManager.getAddress();
            if (!privateKey || !myAddress) {
                Logger.warn('DM: Cannot open sealed envelope — no credentials');
                return null;
            }
            try {
                const { sender, message } = await dmCrypto.open(data, {
                    myPrivateKey: privateKey,
                    myAddress
                });
                // The transport-level account was the ephemeral key; the proof
                // is authoritative.
                applyAccount(message, sender.toLowerCase());
                return message;
            } catch (e) {
                // Not addressed to us, or tampered with. Either way it is not
                // actionable — and with sealed sender we cannot tell which,
                // by design.
                Logger.debug('DM: Could not open sealed envelope:', e.message);
                return null;
            }
        }

        return this.decryptDMEnvelope(data, data?.account);
    }

    /**
     * Decrypt an E2E encrypted DM envelope.
     * @param {Object} data - Encrypted envelope { ct, iv, e } with account
     * @param {string} senderAddress - Sender's address (lowercase)
     * @returns {Promise<Object|null>} - Decrypted data with account restored, or null if not encrypted / missing keys
     * @throws {CryptoError} If decryption fails on a genuinely encrypted envelope
     */
    async decryptDMEnvelope(data, senderAddress) {
        if (!dmCrypto.isEncrypted(data)) {
            return data;
        }

        try {
            const privateKey = authManager.wallet?.privateKey;
            if (!privateKey) {
                Logger.warn('DM: Cannot decrypt — no private key');
                return null;
            }

            const peerPubKey = await this.getPeerPublicKey(senderAddress);
            if (!peerPubKey) {
                Logger.warn('DM: Cannot decrypt — missing peer public key for', senderAddress);
                return null;
            }

            const aesKey = await dmCrypto.getSharedKey(privateKey, senderAddress, peerPubKey);
            const decrypted = await dmCrypto.decrypt(data, aesKey);
            
            // Restore account (not part of encrypted payload)
            applyAccount(decrypted, senderAddress);
            
            return decrypted;
        } catch (e) {
            Logger.error('DM: Decryption failed from', senderAddress, e.message);
            throw new CryptoError(
                `DM decryption failed from ${senderAddress}`,
                'DM_DECRYPT_FAILED',
                { cause: e }
            );
        }
    }

    /**
     * Route an incoming ephemeral/control message (typing, presence) to the correct conversation.
     * Messages arrive on MY DM-2, routed by account to the matching conversation.
     * E2E encrypted envelopes are decrypted before forwarding.
     * @param {Object} data - Control data (possibly encrypted) with account from Streamr publisherId
     */
    async routeInboxControl(data) {
        if (!data) return;

        // Sealed envelopes must be opened before the sender is known — see
        // routeInboxMessage. Control traffic goes out sealed-sender v2 too
        // (channels.js presence/typing → sealAndPublish); the legacy branch
        // below only serves rows still sitting in storage.
        try {
            data = await this.openDMEnvelope(data);
        } catch {
            return;
        }
        if (!data || !data.account) return;

        const senderAddress = data.account.toLowerCase();
        const myAddress = authManager.getAddress()?.toLowerCase();
        if (senderAddress === myAddress) return;

        // Block check: ignore control messages from blocked peers
        if (secureStorage.isBlocked(senderAddress)) return;

        // Soft-leave check: ignore control messages from peers we left
        if (secureStorage.getDMLeftAt(senderAddress)) return;

        // Find the conversation for this sender
        const channelStreamId = this.conversations.get(senderAddress);
        if (!channelStreamId) return;

        const controlData = data;   // already opened above

        // Inject identity fields for control messages
        if (controlData.type === 'typing') {
            controlData.user = senderAddress;
        } else if (controlData.type === 'presence') {
            controlData.userId = controlData.userId || senderAddress;
            controlData.address = controlData.address || senderAddress;
        }

        // Forward to channelManager with the conversation's messageStreamId
        channelManager.handleControlMessage(channelStreamId, controlData);
    }

    /**
     * Route an incoming media message from DM inbox ephemeral to mediaController.
     * @param {Object|Uint8Array} data - Media data (JSON or binary)
     * @param {string} [account] - Publisher ID (provided for binary messages)
     */
    async routeInboxMedia(data, account) {
        if (!data) return;

        let senderAddress = null;
        let payload = data;
        let opened = false;

        if (dmCrypto.isSealedBinary(data)) {
            // A legacy v1 binary starts with a random IV byte, so 1 in 256 of
            // them also matches the version check. Failing to open is therefore
            // not an error — it falls through to the legacy path below.
            try {
                const privateKey = authManager.wallet?.privateKey;
                const myAddress = authManager.getAddress();
                const result = await dmCrypto.openBinary(data, {
                    myPrivateKey: privateKey, myAddress
                });
                senderAddress = result.sender.toLowerCase();
                payload = result.bytes;
                opened = true;
            } catch {
                Logger.debug('DM: binary did not open as sealed — trying legacy');
            }
        }

        if (!opened && dmCrypto.isSealed(data)) {
            // Open FIRST, identify after — same rule as routeInboxMessage. The
            // publisherId on a sealed signal is a throwaway key, so resolving
            // the conversation from it would find nothing and drop the signal
            // silently. The sender only exists once the envelope is open.
            payload = await this.openDMEnvelope(data);
            if (!payload) return;
            senderAddress = payload.account?.toLowerCase();
            opened = true;
        }

        if (!opened) {
            // Legacy v1: pieces and signals still travel under the real
            // publisher, so the transport account is both the identity and the
            // key selector.
            senderAddress = (account || data?.account)?.toLowerCase();
        }

        if (!senderAddress) return;

        const myAddress = authManager.getAddress()?.toLowerCase();
        if (senderAddress === myAddress) return;

        if (secureStorage.isBlocked(senderAddress)) return;

        const channelStreamId = this.conversations.get(senderAddress);
        if (!channelStreamId) return;

        if (!opened) {
            // Legacy path: decrypt with the static pair-wise ECDH key
            try {
                const privateKey = authManager.wallet?.privateKey;
                const peerPubKey = await this.getPeerPublicKey(senderAddress);

                if (privateKey && peerPubKey) {
                    const aesKey = await dmCrypto.getSharedKey(privateKey, senderAddress, peerPubKey);

                    if (data instanceof Uint8Array) {
                        payload = await dmCrypto.decryptBinary(data, aesKey);
                    } else if (dmCrypto.isEncrypted(data)) {
                        payload = await dmCrypto.decrypt(data, aesKey);
                        applyAccount(payload, senderAddress);
                    }
                }
            } catch (e) {
                Logger.warn('DM: Media decryption failed from', senderAddress, e.message);
                return;
            }
        }

        // Forward to mediaController — it handles binary decode and dispatch
        mediaController.handleMediaMessage(channelStreamId, payload, senderAddress);
    }

    /**
     * Route an incoming inbox message to the correct DM conversation.
     * If the sender has no conversation yet, auto-create one.
     * @param {Object} data - Message with account from Streamr publisherId
     */
    async routeInboxMessage(data) {
        if (!data) return;

        // Open FIRST, identify after.
        //
        // With sealed sender the publisherId is a throwaway key, so the account
        // stamped at ingest says nothing about who wrote this. The real sender
        // only exists once the envelope is open. Checking blocks or ownership
        // before that would be checking a random address.
        //
        // The cost is that a blocked peer's message is decrypted before being
        // dropped — one ECDH plus one AES-GCM, about a millisecond. That is the
        // trade sealed sender makes, and it is a good one.
        try {
            data = await this.openDMEnvelope(data);
        } catch {
            return; // Already logged inside
        }
        if (!data || !data.account) {
            Logger.debug('DM: Message could not be attributed, ignoring');
            return;
        }

        const senderAddress = data.account.toLowerCase();
        const myAddress = authManager.getAddress()?.toLowerCase();

        // Ignore our own messages (echoed back from inbox)
        if (senderAddress === myAddress) return;

        // Block check: permanently blocked peers are always ignored
        if (secureStorage.isBlocked(senderAddress)) {
            Logger.debug('DM: Ignoring message from blocked peer', senderAddress);
            return;
        }

        // Soft-leave check: ignore messages older than the leave timestamp
        const leftAt = secureStorage.getDMLeftAt(senderAddress);
        if (leftAt) {
            const messageTs = data.timestamp || 0;
            if (messageTs <= leftAt) {
                // Old message from before we left — ignore
                return;
            }
            // New message after we left — conversation resurfaces
            await secureStorage.clearDMLeftAt(senderAddress);
            Logger.info('DM: Conversation resurfaced from', senderAddress, '(new message after leave)');
        }

        // Clean sender-side flags
        delete data.pending;
        delete data._dmSent;

        // Find or create conversation for this sender
        let channelStreamId = this.conversations.get(senderAddress);
        let channel;

        if (channelStreamId) {
            channel = channelManager.channels.get(channelStreamId);
        }

        if (!channel) {
            // Auto-create conversation for new sender.
            // Name priority: trusted contact → ENS → sender's display name from the
            // first message (senderName, if the user set one) → truncated address.
            Logger.info('DM: New conversation from', senderAddress);
            const senderDisplayName = typeof data.senderName === 'string'
                ? data.senderName.trim().slice(0, 50)
                : null;
            try {
                channel = await this.getOrCreateConversation(senderAddress, null, senderDisplayName || null);
            } catch (e) {
                Logger.error('DM: Failed to create conversation for', senderAddress, e);
                return;
            }
            if (!channel) {
                Logger.error('DM: Failed to create conversation for', senderAddress);
                return;
            }
        }

        if (typeof mediaController?.isStoredImageChunkMessage === 'function' && mediaController.isStoredImageChunkMessage(data)) {
            if (typeof mediaController.registerStoredImageChunk === 'function') {
                await mediaController.registerStoredImageChunk(channel.messageStreamId, data);
            }
            return;
        }

        // Route reactions through handleControlMessage (not as text messages)
        if (data.type === 'reaction') {
            applyAccount(data, senderAddress);
            channelManager.handleControlMessage(channel.messageStreamId, data);
            return;
        }

        // Route edit/delete overrides
        if (data.type === 'edit' || data.type === 'delete') {
            applyAccount(data, senderAddress);
            channelManager.handleOverrideMessage(channel.messageStreamId, data);
            return;
        }

        if (
            typeof mediaController?.isStoredChunkedImageManifest === 'function'
            && mediaController.isStoredChunkedImageManifest(data)
            && typeof mediaController.registerStoredImageManifest === 'function'
        ) {
            await mediaController.registerStoredImageManifest(channel.messageStreamId, data);
        }

        // Deduplicate: check if message already exists
        if (data.id && channel.messages.some(m => m.id === data.id)) {
            return;
        }

        // Tag message as received (not sent by us)
        data._dmReceived = true;

        // Add verification info for display (ENS + trust level)
        data.verified = {
            valid: true,
            trustLevel: await identityManager.getTrustLevel(senderAddress),
            ensName: await identityManager.resolveENS(senderAddress)
        };

        // Add to channel messages
        channel.messages.push(data);
        channel.messages.sort((a, b) => a.timestamp - b.timestamp);

        // Notify UI
        channelManager.notifyHandlers('message', {
            streamId: channel.messageStreamId,
            message: data
        });

        this.notifyHandlers('dm_message', {
            peerAddress: senderAddress,
            streamId: channel.messageStreamId,
            message: data
        });
    }

    /**
     * On-demand P3 replay backing the bell's "All" invites view. The live
     * subscription only ever sees invites that arrive while a tab is open;
     * the storage node holds the rest for the inbox's retention. Every
     * replayed envelope goes through the same open/attribute funnel as
     * routeNotification, but the notification manager files it SILENTLY —
     * answered ids become dismissed records, unseen ones become pending,
     * and no toast fires per row. Once per session: the toggle is a filter,
     * not a refresh button.
     * @param {number} count - How many P3 entries to ask the storage node for
     */
    async replayInvites(count = 100) {
        if (this._invitesReplayed) return;
        if (!this.inboxMessageStreamId || !streamrController.client) return;
        this._invitesReplayed = true;

        const { notificationManager } = await import('./notifications.js');
        const myAddress = authManager.getAddress()?.toLowerCase();
        try {
            // Raw — inboxes are never gated; the envelope check replaces the
            // SDK validation, and the sealed invite carries its own proof.
            const { verifyEnvelopeAuthenticity } = await import('./envelopeSigner.js');
            const resend = await streamrController.client.resend(
                { streamId: this.inboxMessageStreamId, partition: STREAM_CONFIG.MESSAGE_STREAM.NOTIFICATIONS },
                { last: count, raw: true }
            );
            const iterator = resend[Symbol.asyncIterator]();
            for (;;) {
                let message;
                try {
                    const result = await iterator.next();
                    if (result.done) break;
                    message = result.value;
                } catch {
                    // Undecryptable/foreign rows are expected on a shared inbox
                    continue;
                }
                try {
                    if (!verifyEnvelopeAuthenticity(message)) continue;
                    let data = message.content ?? message;
                    data = await this.openDMEnvelope(data);
                    if (!data?.account) continue;
                    const sender = data.account.toLowerCase();
                    if (sender === myAddress) continue;
                    if (secureStorage.isBlocked(sender)) continue;
                    if (data.type === 'CHANNEL_INVITE') {
                        await notificationManager.handleChannelInvite(data, { replay: true });
                    }
                } catch { /* not for us */ }
            }
        } catch (e) {
            Logger.warn('DM: invite replay failed:', e.message);
        }
    }

    /**
     * Route an incoming notification from DM-1 partition 3.
     * Decrypts the E2E envelope and delegates to NotificationManager.
     * @param {Object} data - Encrypted notification with account from Streamr publisherId
     */
    async routeNotification(data) {
        if (!data) return;

        // Open before identifying — see routeInboxMessage
        try {
            data = await this.openDMEnvelope(data);
        } catch {
            return;
        }
        if (!data || !data.account) {
            Logger.debug('DM: Notification could not be attributed, ignoring');
            return;
        }

        const senderAddress = data.account.toLowerCase();
        const myAddress = authManager.getAddress()?.toLowerCase();
        if (senderAddress === myAddress) return;
        if (secureStorage.isBlocked(senderAddress)) return;

        // Already opened above

        // Delegate to NotificationManager (lazy import to avoid circular dep)
        const { notificationManager } = await import('./notifications.js');
        notificationManager.handleNotification(data);
    }

    /**
     * Get existing or create a new DM conversation with a peer
     * @param {string} peerAddress - Peer's Ethereum address
     * @param {string} [localName] - Optional local name for the conversation
     * @param {string} [fallbackName] - Optional fallback name (e.g. sender's display name
     *                                  from the first message) used if no contact/ENS name
     * @returns {Object} - Channel object
     */
    async getOrCreateConversation(peerAddress, localName, fallbackName) {
        const normalizedPeer = peerAddress.toLowerCase();

        // Check if conversation already exists
        const existingStreamId = this.conversations.get(normalizedPeer);
        if (existingStreamId) {
            const existing = channelManager.channels.get(existingStreamId);
            if (existing) return existing;
            // Stale entry — channel was removed from channelManager; clean up and recreate
            this.conversations.delete(normalizedPeer);
        }

        // Guard against concurrent creation for the same peer:
        // If another call is already creating this conversation, wait for it
        const pending = this.pendingConversations.get(normalizedPeer);
        if (pending) {
            return pending;
        }

        // Create the promise and store it SYNCHRONOUSLY before any await
        const creationPromise = this._createConversation(normalizedPeer, localName, fallbackName);
        this.pendingConversations.set(normalizedPeer, creationPromise);

        try {
            return await creationPromise;
        } finally {
            this.pendingConversations.delete(normalizedPeer);
        }
    }

    /**
     * Internal: actually create a DM conversation (called only once per peer)
     * @param {string} normalizedPeer - Lowercase peer address
     * @param {string} [localName] - Optional local name
     * @param {string} [fallbackName] - Optional fallback name used after contact/ENS lookup
     * @returns {Promise<Object>} - Channel object
     */
    async _createConversation(normalizedPeer, localName, fallbackName) {
        // Build deterministic stream IDs for the PEER's inbox (where we publish TO)
        const peerInboxId = streamrController.getDMInboxId(normalizedPeer);
        const peerEphemeralId = streamrController.getDMEphemeralId(normalizedPeer);

        // Resolve a display name
        const displayName = localName || await this.resolveDisplayName(normalizedPeer, fallbackName);

        // Create channel object
        const channel = {
            messageStreamId: peerInboxId,
            ephemeralStreamId: peerEphemeralId,
            streamId: peerInboxId,
            inboxStreamId: this.inboxMessageStreamId,
            name: displayName,
            type: 'dm',
            peerAddress: normalizedPeer,
            classification: 'personal',
            createdAt: Date.now(),
            createdBy: authManager.getAddress(),
            password: null,
            members: [],
            readOnly: false,
            writeOnly: false,  // We can read from our own inbox
            storageEnabled: false,
            exposure: 'hidden',
            description: '',
            language: '',
            category: '',
            messages: [],
            reactions: {},
            historyLoaded: false,
            hasMoreHistory: true,
            loadingHistory: false,
            oldestTimestamp: null,
        };

        // Register in channelManager and conversations map
        channelManager.channels.set(peerInboxId, channel);
        this.conversations.set(normalizedPeer, peerInboxId);

        // Persist channels
        await channelManager.saveChannels();

        // NOTE: Sent messages and reactions are loaded via loadDMTimeline() when channel is opened
        // This avoids duplicating merge logic here

        // Notify UI about new conversation
        channelManager.notifyHandlers('channelJoined', {
            channel,
            streamId: peerInboxId
        });

        this.notifyHandlers('dm_conversation_created', {
            peerAddress: normalizedPeer,
            streamId: peerInboxId,
            name: displayName
        });

        Logger.info('DM: Conversation created for', normalizedPeer, displayName);
        return channel;
    }

    /**
     * Start a new DM by user action (e.g. "New DM" button)
     * @param {string} peerAddress - Peer's Ethereum address (or ENS name to resolve)
     * @param {string} [localName] - Local name for the conversation
     * @returns {Object} - Channel object
     */
    async startDM(peerAddress, localName) {
        let resolvedAddress = peerAddress;

        // If it looks like an ENS name, resolve it
        if (peerAddress.includes('.') && !peerAddress.startsWith('0x')) {
            const resolved = await identityManager.resolveAddress(peerAddress);
            if (!resolved) {
                throw new Error(`Could not resolve ENS name: ${peerAddress}`);
            }
            resolvedAddress = resolved;
            // Use the ENS name as display name if no local name provided
            if (!localName) localName = peerAddress;
        }

        // Validate Ethereum address format
        if (!/^0x[a-fA-F0-9]{40}$/.test(resolvedAddress)) {
            throw new Error('Invalid Ethereum address');
        }

        // Don't allow DM to yourself
        const myAddress = authManager.getAddress()?.toLowerCase();
        if (resolvedAddress.toLowerCase() === myAddress) {
            throw new Error('Cannot send a DM to yourself');
        }

        // Check if the peer has a DM inbox before creating the conversation
        // Skip check if we already have a conversation with this peer (they had an inbox before)
        const normalizedPeer = resolvedAddress.toLowerCase();
        if (!this.conversations.has(normalizedPeer)) {
            const peerInboxId = streamrController.getDMInboxId(normalizedPeer);
            try {
                await streamrController.client.getStream(peerInboxId);
            } catch {
                throw new Error('This user has not enabled DMs yet. They need to open Pombo and create their inbox first.');
            }
        }

        const channel = await this.getOrCreateConversation(resolvedAddress, localName);

        // Switch to the DM channel
        channelManager.setCurrentChannel(channel.messageStreamId);
        channelManager.notifyHandlers('channelSwitched', {
            streamId: channel.messageStreamId,
            channel
        });

        return channel;
    }

    /**
     * Send a DM message to a peer.
     * Publishes to the PEER's inbox, persists locally.
     * @param {string} peerInboxStreamId - The peer's inbox message stream ID
     * @param {string} text - Message text
     * @param {string} [replyTo] - Reply-to message ID
     * @returns {Object} - The sent message
     */
    async sendMessage(peerInboxStreamId, text, replyTo = null) {
        const channel = channelManager.channels.get(peerInboxStreamId);
        if (!channel || channel.type !== 'dm') {
            throw new Error('DM channel not found');
        }

        // Create signed message
        const message = await identityManager.createSignedMessage(text, peerInboxStreamId, replyTo);

        // Add verification info for local display
        message.verified = {
            valid: true,
            trustLevel: await identityManager.getTrustLevel(message.sender),
            ensName: await identityManager.resolveENS(message.sender)
        };

        // Mark as pending
        message.pending = true;
        message._dmSent = true;

        // Add to local messages immediately
        channel.messages.push(message);

        // Notify UI
        channelManager.notifyHandlers('message', {
            streamId: peerInboxStreamId,
            message
        });

        try {
            // E2E encrypt before publishing — NEVER send plaintext DMs
            const privateKey = authManager.wallet?.privateKey;
            const peerAddress = channel.peerAddress;

            if (!privateKey) {
                throw new Error('Cannot send DM: wallet private key not available (required for E2E encryption)');
            }
            if (!peerAddress) {
                throw new Error('Cannot send DM: peer address not found');
            }

            const { pending, _dmSent, verified, ...cleanMessage } = message;

            // Sealed sender: published under a throwaway identity, so the inbox
            // stream no longer carries the (sender → recipient) edge.
            await this.sealAndPublish(peerInboxStreamId, peerAddress, cleanMessage);

            // Mark as sent
            message.pending = false;

            // Persist locally (we can't read from peer's inbox, so save our sent copy)
            await secureStorage.addSentMessage(peerInboxStreamId, message);

            // Notify confirmed
            channelManager.notifyHandlers('message_confirmed', {
                streamId: peerInboxStreamId,
                messageId: message.id
            });

            Logger.debug('DM: Message sent to', peerInboxStreamId);

            // Send wake signal so the peer gets a push notification
            channelManager.sendWakeSignals(peerInboxStreamId).catch(err => {
                Logger.debug('DM: Wake signal failed (non-critical):', err.message);
            });
        } catch (error) {
            Logger.error('DM: Failed to send message:', error.message);
            channelManager.notifyHandlers('message_failed', {
                streamId: peerInboxStreamId,
                messageId: message.id,
                error: error.message
            });
            throw error;
        }

        return message;
    }

    /**
     * Send an edit override for a DM message
     * @param {string} peerInboxStreamId - Peer's inbox stream ID
     * @param {string} targetId - ID of the message to edit
     * @param {string} newText - New text content
     */
    async sendEdit(peerInboxStreamId, targetId, newText) {
        const channel = channelManager.channels.get(peerInboxStreamId);
        if (!channel || channel.type !== 'dm') throw new Error('DM channel not found');

        const original = channel.messages.find(m => m.id === targetId);
        if (!original) throw new Error('Message not found');

        const myAddress = authManager.getAddress();
        if (original.sender?.toLowerCase() !== myAddress?.toLowerCase()) {
            throw new Error('Can only edit your own messages');
        }

        const override = { type: 'edit', targetId, text: newText.trim(), timestamp: Date.now() };

        // E2E encrypt and publish to peer's inbox FIRST — only mutate/persist
        // local state after the publish succeeds. Applying (and persisting)
        // before publishing meant a failed publish left local state
        // permanently divergent from what the peer sees, with no rollback.
        const privateKey = authManager.wallet?.privateKey;
        const peerAddress = channel.peerAddress;
        if (!privateKey || !peerAddress) throw new Error('Cannot send DM edit: missing credentials');

        await this.sealAndPublish(peerInboxStreamId, peerAddress, override);

        // Publish succeeded — apply locally and persist
        original.text = override.text;
        original._edited = true;
        original._editedAt = override.timestamp;
        secureStorage.updateSentMessage(peerInboxStreamId, targetId, { text: override.text, _edited: true, _editedAt: override.timestamp });

        channelManager.notifyHandlers('message_edited', { streamId: peerInboxStreamId, targetId });

        Logger.debug('DM: Edit sent for message:', targetId);
    }

    /**
     * Send a delete override for a DM message
     * @param {string} peerInboxStreamId - Peer's inbox stream ID
     * @param {string} targetId - ID of the message to delete
     */
    async sendDelete(peerInboxStreamId, targetId) {
        const channel = channelManager.channels.get(peerInboxStreamId);
        if (!channel || channel.type !== 'dm') throw new Error('DM channel not found');

        const original = channel.messages.find(m => m.id === targetId);
        if (!original) throw new Error('Message not found');

        const myAddress = authManager.getAddress();
        if (original.sender?.toLowerCase() !== myAddress?.toLowerCase()) {
            throw new Error('Can only delete your own messages');
        }

        const override = { type: 'delete', targetId, timestamp: Date.now() };

        // E2E encrypt and publish to peer's inbox FIRST — only mutate/persist
        // local state after the publish succeeds (see sendEdit rationale).
        const privateKey = authManager.wallet?.privateKey;
        const peerAddress = channel.peerAddress;
        if (!privateKey || !peerAddress) throw new Error('Cannot send DM delete: missing credentials');

        await this.sealAndPublish(peerInboxStreamId, peerAddress, override);

        // Publish succeeded — remove locally and from persisted copy
        const idx = channel.messages.indexOf(original);
        if (idx >= 0) channel.messages.splice(idx, 1);
        secureStorage.removeSentMessage(peerInboxStreamId, targetId);

        channelManager.notifyHandlers('message_deleted', { streamId: peerInboxStreamId, targetId });

        Logger.debug('DM: Delete sent for message:', targetId);
    }

    /**
     * Load the merged timeline for a DM conversation.
     * Merges locally-stored sent messages/reactions with received from inbox.
     * @param {string} peerAddress - Peer's address
     */
    async loadDMTimeline(peerAddress) {
        const normalizedPeer = peerAddress.toLowerCase();
        const channelStreamId = this.conversations.get(normalizedPeer);
        if (!channelStreamId) return;

        const channel = channelManager.channels.get(channelStreamId);
        if (!channel) return;

        // Sent messages (from local storage)
        const sent = secureStorage.getSentMessages(channelStreamId);

        // Received messages (already in channel.messages from inbox subscription)
        const received = channel.messages.filter(m => m._dmReceived);

        // Merge: combine sent + received, deduplicate by id, sort by timestamp
        // Prefer versions that have imageData (storage-backed messages may have it when sentMessages lost it)
        const allMessages = [...sent, ...received];
        const unique = new Map();
        for (const msg of allMessages) {
            if (!msg.id) continue;
            const existing = unique.get(msg.id);
            if (!existing) {
                unique.set(msg.id, msg);
            } else if (msg.type === 'image' && msg.imageData && !existing.imageData) {
                unique.set(msg.id, msg);
            }
        }

        channel.messages = Array.from(unique.values())
            .sort((a, b) => a.timestamp - b.timestamp);

        // Resolve ENS for all unique senders in the timeline
        const senders = new Set(channel.messages.map(m => m.sender?.toLowerCase()).filter(Boolean));
        const ensCache = {};
        const trustCache = {};
        await Promise.all([...senders].map(async (addr) => {
            ensCache[addr] = await identityManager.resolveENS(addr);
            trustCache[addr] = await identityManager.getTrustLevel(addr);
        }));
        for (const msg of channel.messages) {
            if (!msg.verified) {
                const addr = msg.sender?.toLowerCase();
                msg.verified = {
                    valid: true,
                    trustLevel: trustCache[addr] ?? 0,
                    ensName: ensCache[addr] || null
                };
            } else if (!msg.verified.ensName) {
                const addr = msg.sender?.toLowerCase();
                msg.verified.ensName = ensCache[addr] || null;
                msg.verified.trustLevel = trustCache[addr] ?? msg.verified.trustLevel;
            }
        }

        // Merge locally-stored reactions (we don't receive our own from peer's inbox)
        const sentReactions = secureStorage.getSentReactions(channelStreamId);
        if (Object.keys(sentReactions).length > 0) {
            if (!channel.reactions) channel.reactions = {};
            for (const [messageId, emojis] of Object.entries(sentReactions)) {
                if (!channel.reactions[messageId]) channel.reactions[messageId] = {};
                for (const [emoji, users] of Object.entries(emojis)) {
                    if (!channel.reactions[messageId][emoji]) {
                        channel.reactions[messageId][emoji] = [];
                    }
                    // Merge users without duplicates
                    for (const user of users) {
                        const normalized = user.toLowerCase();
                        if (!channel.reactions[messageId][emoji].some(u => u.toLowerCase() === normalized)) {
                            channel.reactions[messageId][emoji].push(user);
                        }
                    }
                }
            }
        }
    }

    /**
     * Fetch older DM messages from the inbox stream for a specific peer.
     * Uses a time-windowed query to avoid scanning the entire stream from epoch.
     * Messages from all peers arrive on the same inbox; we filter for the target peer.
     * 
     * @param {string} peerAddress - Peer's address
     * @param {AbortSignal} [signal] - Optional abort signal
     * @returns {Promise<{loaded: number, hasMore: boolean, noResultsInWindow: boolean}>}
     */
    async fetchOlderDMMessages(peerAddress, signal) {
        const normalizedPeer = peerAddress.toLowerCase();
        const channelStreamId = this.conversations.get(normalizedPeer);
        if (!channelStreamId) return { loaded: 0, hasMore: false, noResultsInWindow: false };

        const channel = channelManager.channels.get(channelStreamId);
        if (!channel) return { loaded: 0, hasMore: false, noResultsInWindow: false };

        if (!this.inboxMessageStreamId) return { loaded: 0, hasMore: false, noResultsInWindow: false };

        // Determine the timestamp to search before
        const beforeTimestamp = channel.oldestTimestamp || Date.now();
        const windowMs = CONFIG.dm.searchWindowMs;

        try {
            Logger.info('DM: Fetching older messages for', normalizedPeer, 'before', new Date(beforeTimestamp).toISOString());

            // Fetch from OUR inbox (not the peer's) using a time window
            const result = await streamrController.fetchOlderHistoryWindowed(
                this.inboxMessageStreamId,
                0, // partition 0 = messages
                beforeTimestamp,
                windowMs,
                signal
            );

            if (signal?.aborted) return { loaded: 0, hasMore: channel.hasMoreHistory, noResultsInWindow: false };

            let addedCount = 0;
            const privateKey = authManager.wallet?.privateKey;

            for (const rawMsg of result.messages) {
                if (signal?.aborted) break;

                // Sealed messages cannot be filtered by publisherId — it is a
                // throwaway key. Open everything in the window, then keep what
                // turns out to be from this peer. Costs one ECDH + AES-GCM per
                // message (~1ms); the alternative is not knowing who wrote what.
                //
                // Legacy v1 messages still carry the real sender as publisherId,
                // and openDMEnvelope routes them to the old path.
                const publisherId = rawMsg.publisherId?.toLowerCase();

                let data;
                try {
                    const content = rawMsg.content;
                    if (content && typeof content === 'object' && publisherId) {
                        applyAccount(content, publisherId);
                    }
                    data = await this.openDMEnvelope(content);
                } catch {
                    continue; // Could not be opened — not ours, or corrupt
                }
                if (!data || !data.account) continue;

                const sender = data.account.toLowerCase();

                // Skip our own echoed messages
                const myAddress = authManager.getAddress()?.toLowerCase();
                if (sender === myAddress) continue;

                // Only keep messages from the target peer
                if (sender !== normalizedPeer) continue;

                // Skip reactions (they're handled separately)
                if (data.type === 'reaction') {
                    if (data.messageId && data.emoji) {
                        channelManager.storeReaction(channel, data.messageId, data.emoji, sender, data.action || 'add');
                    }
                    continue;
                }

                // Skip non-content messages
                if (!data.id || !data.timestamp) continue;

                // Deduplicate
                if (channel.messages.some(m => m.id === data.id)) continue;

                // Tag as received and add verification
                data._dmReceived = true;
                data.verified = {
                    valid: true,
                    trustLevel: await identityManager.getTrustLevel(normalizedPeer),
                    ensName: await identityManager.resolveENS(normalizedPeer)
                };

                channel.messages.push(data);
                addedCount++;

                // Track oldest timestamp
                if (!channel.oldestTimestamp || data.timestamp < channel.oldestTimestamp) {
                    channel.oldestTimestamp = data.timestamp;
                }
            }

            if (addedCount > 0) {
                channel.messages.sort((a, b) => a.timestamp - b.timestamp);
            } else if (result.hasMore && typeof result.windowStart === 'number') {
                // Empty window but stream still has older data: advance the
                // pagination cursor past this window so the next call (e.g.
                // user clicks "Search older messages") scans the PREVIOUS
                // window instead of re-scanning the same empty one forever.
                channel.oldestTimestamp = result.windowStart;
            }

            // Update hasMore based on whether the stream has older data
            channel.hasMoreHistory = result.hasMore;

            const noResultsInWindow = addedCount === 0 && result.hasMore;

            Logger.info(`DM: Fetched ${addedCount} older messages for ${normalizedPeer} (noResultsInWindow: ${noResultsInWindow}, hasMore: ${result.hasMore})`);

            return { loaded: addedCount, hasMore: result.hasMore, noResultsInWindow };
        } catch (error) {
            Logger.error('DM: fetchOlderDMMessages failed:', error.message);
            return { loaded: 0, hasMore: channel.hasMoreHistory, noResultsInWindow: false };
        }
    }

    /**
     * Resolve a display name for a peer address.
     * Tries: trusted contact name → ENS → fallback name → truncated address.
     * @param {string} address - Ethereum address
     * @param {string} [fallbackName] - Optional fallback (e.g. sender's self-assigned display name)
     * @returns {Promise<string>} - Display name
     */
    async resolveDisplayName(address, fallbackName = null) {
        const normalized = address.toLowerCase();

        // Check trusted contacts
        const contacts = secureStorage.getTrustedContacts() || {};
        if (contacts[normalized]?.name) {
            return contacts[normalized].name;
        }

        // Try ENS (async, non-blocking fallback)
        try {
            const ensName = await identityManager.resolveENS(normalized);
            if (ensName) return ensName;
        } catch (e) {
            // ENS lookup failed, use fallback
        }

        // Sender's self-assigned display name (e.g. from the first DM message)
        if (fallbackName && typeof fallbackName === 'string' && fallbackName.trim()) {
            return fallbackName.trim();
        }

        // Fallback: truncated address
        return `${address.slice(0, 6)}...${address.slice(-4)}`;
    }

    /**
     * Get all DM conversations, sorted by last message timestamp
     * @returns {Array<Object>} - Array of channel objects
     */
    getConversations() {
        const dmChannels = [];
        const orphanedPeers = [];

        for (const [peerAddress, streamId] of this.conversations) {
            const channel = channelManager.channels.get(streamId);
            if (channel) {
                dmChannels.push(channel);
            } else {
                // Mark orphaned entry for cleanup
                orphanedPeers.push(peerAddress);
            }
        }

        // Clean up orphaned entries
        for (const peer of orphanedPeers) {
            this.conversations.delete(peer);
            Logger.debug('DM: Cleaned orphaned conversation entry for', peer);
        }

        // Sort by last message timestamp (newest first)
        dmChannels.sort((a, b) => {
            const aLast = a.messages.length > 0 ? a.messages[a.messages.length - 1].timestamp : a.createdAt;
            const bLast = b.messages.length > 0 ? b.messages[b.messages.length - 1].timestamp : b.createdAt;
            return bLast - aLast;
        });

        return dmChannels;
    }

    /**
     * Check if a channel is a DM conversation
     * @param {string} streamId - Message stream ID
     * @returns {boolean}
     */
    isDMChannel(streamId) {
        const channel = channelManager.channels.get(streamId);
        return channel?.type === 'dm';
    }

    /**
     * Register an event handler
     * @param {Function} handler - Handler function (event, data)
     */
    onEvent(handler) {
        this.handlers.push(handler);
    }

    /**
     * Notify all registered handlers
     * @param {string} event - Event name
     * @param {Object} data - Event data
     */
    notifyHandlers(event, data) {
        for (const handler of this.handlers) {
            try {
                handler(event, data);
            } catch (error) {
                Logger.error('DM handler error:', error);
            }
        }
    }

    /**
     * Subscribe our inbox to push notifications.
     * Uses the existing relay system with the inbox streamId as tag source.
     * @param {boolean} force - If true, skip preference check (for explicit toggle)
     */
    async subscribeInboxPush(force = false) {
        if (!this.inboxMessageStreamId) return;
        if (!relayManager.enabled) return;

        // Check user preference unless forced
        if (!force) {
            const address = authManager.getAddress();
            if (address) {
                const storageKey = CONFIG.storageKeys.dmPush(address);
                const dmPushEnabled = localStorage.getItem(storageKey) === 'true';
                if (!dmPushEnabled) {
                    Logger.debug('DM: Push notifications preference disabled, skipping registration');
                    return;
                }
            }
        }

        await relayManager.subscribeToChannel(this.inboxMessageStreamId);
        Logger.info('DM: Push notifications registered for inbox');
    }

    /**
     * Fetch and cache the peer's ECDH public key from their inbox stream metadata.
     * @param {string} peerAddress - Peer's Ethereum address (lowercase)
     * @returns {Promise<string|null>} - Compressed public key hex, or null
     */
    async getPeerPublicKey(peerAddress) {
        const normalized = peerAddress.toLowerCase();

        // Check dmCrypto cache first
        if (dmCrypto.peerPublicKeys.has(normalized)) {
            return dmCrypto.peerPublicKeys.get(normalized);
        }

        // Fetch from stream metadata
        const pubKey = await streamrController.getDMPublicKey(normalized);
        if (pubKey) {
            dmCrypto.peerPublicKeys.set(normalized, pubKey);
        }
        return pubKey;
    }

    /**
     * Cleanup on disconnect
     */
    async destroy() {
        await this.unsubscribeFromInbox();
        this.conversations.clear();
        this.pendingConversations.clear();
        this.inboxMessageStreamId = null;
        this.inboxEphemeralStreamId = null;
        this.inboxSubscription = null;
        this.inboxEphemeralSubscription = null;
        this.inboxReady = false;
        this._inboxExistsCache = null;
        this.handlers = [];
        dmCrypto.clear();
    }
}

// Singleton export (same pattern as other modules)
export const dmManager = new DMManager();
