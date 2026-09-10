/**
 * The message path itself: what arrives on a channel's streams, what we send
 * on them, and the history pulled from storage. Batch verification lives here
 * too, since the batches only exist to keep history loading off the main path.
 */

import { Logger } from '../logger.js';
import { streamrController, STREAM_CONFIG } from '../streamr.js';
import { authManager } from '../auth.js';
import { identityManager } from '../identity.js';
import { secureStorage } from '../secureStorage.js';
import { relayManager } from '../relayManager.js';
import { dmManager } from '../dm.js';
import { CONFIG } from '../config.js';
import { mediaController } from '../media.js';
import { adminStatePoller } from '../adminStatePoller.js';
import { messageTime } from '../utils/messageTime.js';

export class MessageFlow {
    /**
     * Self-calls go through `manager` on purpose: while the manager is still
     * the entry point, anything that replaces one of its methods has to keep
     * intercepting the calls this class makes. `switchGeneration` and
     * `historyAbortController` stay on the manager because the channel switch
     * that owns them does not live here.
     * @param {Object} manager - the channel manager
     */
    constructor(manager) {
        this.manager = manager;
        // Deduplication: track message IDs currently being processed (receive-side)
        this.processingMessages = new Set();
        // Deduplication: track messages currently being sent (send-side)
        // Prevents duplicate sends on rapid clicks or retries
        this.sendingMessages = new Set(); // streamId:messageId
        this.MAX_RETRIES = CONFIG.channels.maxRetries;
        this.RETRY_DELAY = CONFIG.channels.retryDelayMs;
        // OPTIMIZATION: Batch message verification for history loading
        // Messages arriving within BATCH_WINDOW_MS are batched and verified in parallel
        this.pendingVerifications = new Map(); // streamId -> { messages: [], timer: null }
        this.pendingFlushPromises = new Map(); // streamId -> Set<Promise>
        this.BATCH_WINDOW_MS = CONFIG.channels.batchWindowMs;
        this.BATCH_MAX_SIZE = CONFIG.channels.batchMaxSize;
    }

    /**
     * Handle control/metadata message
     * @param {string} streamId - Stream ID
     * @param {Object} data - Control data
     */
    async handleControlMessage(streamId, data) {
        // CRITICAL: Check if still connected before processing
        if (!authManager.isConnected()) {
            return;
        }
        if (!data || typeof data !== 'object') return;
        
        // Handle different control message types
        // Use account from Streamr SDK (cryptographically guaranteed) instead of self-reported fields
        if (data.type === 'typing') {
            this.manager.notifyHandlers('typing', { streamId, user: data.account || data.user, nickname: data.nickname || null });
        } else if (data.type === 'presence') {
            // Handle presence update
            this.manager.handlePresenceMessage(streamId, data);
        } else if (data.type === 'admin_invalidate') {
            // Low-latency notification that ADMIN_STATE was updated by the
            // channel admin. We only honour signals that came from the
            // channel creator (network-level publish permission already
            // restricts this to the owner, but we double-check locally
            // before triggering work) and only when the announced rev is
            // strictly newer than what we have applied. The actual snapshot
            // is fetched canonically via the resend path so the signal
            // itself cannot be used to inject state.
            const channel = this.manager.channels.get(streamId);
            if (!channel) return;
            const sender = (data.account || data.user || '').toLowerCase();
            const owner = (channel.createdBy || '').toLowerCase();
            if (owner && sender && sender !== owner) {
                Logger.debug('Ignoring admin_invalidate from non-admin:', sender);
                return;
            }
            const incomingRev = typeof data.rev === 'number' ? data.rev : 0;
            if (incomingRev <= (channel.adminRev || 0)) return;
            if (!this.manager._isValidAdminState(data.snapshot)) return;

            // Sender authenticity is already validated above (account ===
            // channel.createdBy). Inject createdBy into the snapshot so
            // applyAdminState's owner check passes even if the publisher
            // omitted it from the body.
            if (!data.snapshot.createdBy && sender) {
                data.snapshot.createdBy = sender;
            }
            this.manager.handleAdminMessage(streamId, data.snapshot);
            // Reset the poller window so the next periodic tick is one full
            // interval away (avoids redundant resend right after this).
            if (adminStatePoller.getStreamId() === streamId) {
                adminStatePoller.markFresh();
            }
        } else if (data.type === 'reaction') {
            // Someone reacted to a message - store in memory only
            const reactionUser = data.account || data.user;
            const channel = this.manager.channels.get(streamId);
            if (channel && data.messageId && data.emoji && reactionUser) {
                this.manager.storeReaction(channel, data.messageId, data.emoji, reactionUser, data.action || 'add');
                // NOTE: No saveChannels() - reactions are not persisted, only in RAM
            }
            
            // Notify handlers to update UI
            this.manager.notifyHandlers('reaction', { 
                streamId, 
                messageId: data.messageId,
                emoji: data.emoji,
                user: reactionUser,
                senderName: data.senderName || null,
                action: data.action || 'add',
                // Propagate the reaction's own timestamp (set when published).
                // Without this, _updateLatestPreview falls back to Date.now()
                // and an OLD reaction replayed during history backfill would
                // appear "newer" than the actual latest message and clobber
                // it via the cache stale-guard.
                timestamp: data.timestamp || null
            });
        } else if (data.type === 'member_update') {
            const channel = this.manager.channels.get(streamId);
            if (channel) {
                channel.members = data.members;
                try {
                    await this.manager.saveChannels();
                } catch (e) {
                    Logger.error('Failed to persist member update:', e);
                }
            }
        }
    }

    /**
     * Handle text message (real-time and historical)
     * Uses batch processing for historical messages to improve performance
     * @param {string} streamId - Stream ID
     * @param {Object} data - Message data
     */
    async handleTextMessage(streamId, data) {
        // CRITICAL: Check if still connected before processing
        // This prevents messages from being processed after disconnect
        if (!authManager.isConnected()) {
            return;
        }
        
        // Skip presence/typing - these are ephemeral
        if (data?.type === 'presence' || data?.type === 'typing') {
            return;
        }
        
        // Reactions go to partition 0 now (for storage), but handle them via control handler
        if (data?.type === 'reaction') {
            this.manager.handleControlMessage(streamId, data);
            return;
        }
        
        // Edit/Delete overrides are normally handled on message stream partition 1 via onOverride.
        // For streams without control partition support, accept overrides on content path.
        if (data?.type === 'edit' || data?.type === 'delete') {
            const channel = this.manager.channels.get(streamId);
            if (channel?._controlPartitionSupported === false) {
                this.manager.handleOverrideMessage(streamId, data, channel?.initialLoadInProgress ?? false);
                return;
            }
            Logger.debug('Ignoring override on content handler path:', data?.type);
            return;
        }

        if (typeof mediaController?.isStoredImageChunkMessage === 'function' && mediaController.isStoredImageChunkMessage(data)) {
            if (typeof mediaController.registerStoredImageChunk === 'function') {
                await mediaController.registerStoredImageChunk(streamId, data);
            }
            return;
        }
        
        // Validate that this looks like a message (has required properties)
        // Text messages need: id, text, sender, timestamp
        // Image messages need: id, imageId, sender, timestamp
        // Video messages need: id, metadata, sender, timestamp
        const isTextMessage = data?.text;
        const isImageMessage = data?.type === 'image' && data?.imageId;
        const isVideoMessage = (data?.type === 'file_announce' || data?.type === 'storage_file_announce') && data?.metadata;
        
        if (!data?.id || !data?.sender || !data?.timestamp) {
            return;
        }
        
        if (!isTextMessage && !isImageMessage && !isVideoMessage) {
            Logger.debug('Unknown message type, skipping:', data?.type);
            return;
        }

        // Timestamp forgery clamps: the payload timestamp is what the
        // UI orders, pages and ages by, and the publisher writes it freely.
        // Reject a payload dated ahead of the wall clock or ahead of its own
        // signed envelope beyond clock skew. One-sided on purpose: a payload
        // OLDER than its envelope is a legitimate republish.
        const skew = CONFIG.gate.timestampSkewMs;
        if (data.timestamp > Date.now() + skew) {
            Logger.warn('Rejecting future-dated message:', data.id, new Date(data.timestamp).toISOString());
            return;
        }
        if (Number.isFinite(data._timestamp) && data.timestamp > data._timestamp + skew) {
            Logger.warn('Rejecting message dated ahead of its envelope:', data.id);
            return;
        }
        
        Logger.debug('handleTextMessage:', { messageId: data.id, type: data.type || 'text', sender: data.sender?.slice(0,10) });
        
        // Early deduplication check using processing set (prevents race conditions)
        const messageKey = `${streamId}:${data.id}`;
        if (this.processingMessages.has(messageKey)) {
            Logger.debug('Message already being processed, skipping:', data.id);
            return;
        }
        this.processingMessages.add(messageKey);
        
        // Clean up after processing (with timeout to handle async operations)
        setTimeout(() => this.processingMessages.delete(messageKey), 5000);
        
        const channel = this.manager.channels.get(streamId);
        if (!channel) {
            Logger.warn('Channel not found for streamId:', streamId);
            return;
        }

        // Read-only is enforced by READERS in Visible channels: the contract
        // deliberately validates a member's signature (their reactions,
        // presence and key requests must pass), so a member-authored MESSAGE
        // is dropped here instead. Reactions never reach this point (routed
        // to the control handler above) and stay allowed. In Sealed the
        // content-key distribution already makes this unreachable.
        if (channel.gate?.address && channel.readOnly) {
            const author = (data.sender || '').toLowerCase();
            const ownerAddr = (channel.createdBy
                || streamId.split('/')[0] || '').toLowerCase();
            if (author && author !== ownerAddr) {
                const { gateManager } = await import('../gate.js');
                const mod = await gateManager
                    ._isModerator(channel.gate.address, author)
                    .catch(() => false);
                if (!mod) {
                    Logger.debug('read-only: dropping member message', data.id);
                    return;
                }
            }
        }

        // Check if message already exists (deduplication)
        // This handles duplicates from network AND historical messages
        const existing = channel.messages.find(m => m.id === data.id);

        if (existing) {
            // The echo of an own message is where its envelope coordinates
            // arrive; the local copy needs them to be addressed on storage.
            if (Number.isFinite(data._timestamp) && !Number.isFinite(existing._timestamp)) {
                existing._timestamp = data._timestamp;
                if (Number.isFinite(data._seq)) existing._seq = data._seq;
            }
            Logger.debug('Message already exists, skipping duplicate:', data.id);
            return;
        }
        
        // For real-time messages (not from history), skip our own messages
        // since they were already added locally in sendMessage()
        // Historical messages from ourselves should be processed normally
        const myAddress = authManager.getAddress();
        const isOwnMessage = data.sender?.toLowerCase() === myAddress?.toLowerCase();
        
        // Check if this is a very recent message (likely real-time, not historical)
        const messageAge = Date.now() - (data.timestamp || 0);
        const isRecentMessage = messageAge < 30000; // 30 seconds
        
        if (isOwnMessage && isRecentMessage) {
            Logger.debug('Skipping own recent message (already added locally):', data.id);
            return;
        }
        
        // Add channelId if missing (for backwards compatibility)
        if (!data.channelId) {
            data.channelId = streamId;
        }

        // OPTIMIZATION: Use batch processing for historical messages
        // Real-time messages are processed immediately for best UX
        if (!isRecentMessage) {
            this.manager.queueMessageForBatchVerification(streamId, data, channel);
            return;
        }

        // Real-time message: verify immediately
        try {
            const verification = await identityManager.verifyMessage(data, streamId, {
                skipTimestampCheck: false
            });
            data.verified = verification;
            
            if (!verification.valid) {
                Logger.warn('Message signature verification failed:', verification.error);
                Logger.warn('   Claimed sender:', data.sender);
                if (verification.actualSigner) {
                    Logger.warn('   Actual signer:', verification.actualSigner);
                }
            } else if (verification.pendingVerification) {
                Logger.debug('Message signature valid, identity pending:', data.sender);
            } else if (verification.verifiedViaSession) {
                Logger.debug('Message verified via session key:', verification.ensName || data.sender);
            } else {
                Logger.debug('Message verified from:', verification.ensName || data.sender);
            }
        } catch (error) {
            Logger.error('Verification error:', error);
            data.verified = { valid: false, error: error.message, trustLevel: -1 };
        }

        if (
            typeof mediaController?.isStoredChunkedImageManifest === 'function'
            && mediaController.isStoredChunkedImageManifest(data)
            && data.verified?.valid !== false
            && typeof mediaController.registerStoredImageManifest === 'function'
        ) {
            await mediaController.registerStoredImageManifest(streamId, data);
        }

        // Add to channel messages
        channel.messages.push(data);
        
        // Update oldest timestamp for pagination
        if (!channel.oldestTimestamp || messageTime(data) < channel.oldestTimestamp) {
            channel.oldestTimestamp = messageTime(data);
        }
        
        // Sort to maintain chronological order (in case of out-of-order delivery)
        this.manager.sortMessagesByTimestamp(channel);

        // Apply any override (edit/delete) that arrived BEFORE this message
        // and was queued in `_pendingOverrides`. The SDK delivers P0
        // (content) and P1 (overrides) independently, and async verification
        // means a delete can be queued before its target lands here.
        // Without this, the override would only flush on
        // `initial_history_complete` / batch flush — both unreliable for
        // streams whose resend iterator never signals `done`.
        this.manager.applyPendingOverrides(channel);

        // Notify handlers
        this.manager.notifyHandlers('message', { streamId, message: data });
    }
    
    /**
     * Queue a historical message for batch verification
     * Messages are batched and verified in parallel for better performance
     * @private
     */
    queueMessageForBatchVerification(streamId, data, channel) {
        // Get or create batch queue for this stream
        if (!this.pendingVerifications.has(streamId)) {
            this.pendingVerifications.set(streamId, { messages: [], timer: null });
        }
        
        const batch = this.pendingVerifications.get(streamId);
        batch.messages.push({ data, channel });
        
        // Flush immediately if batch is full
        if (batch.messages.length >= this.BATCH_MAX_SIZE) {
            if (batch.timer) {
                clearTimeout(batch.timer);
                batch.timer = null;
            }
            this.manager._trackFlush(streamId, this.manager.flushBatchVerification(streamId));
            return;
        }
        
        // Set or reset timer for batch flush
        if (batch.timer) {
            clearTimeout(batch.timer);
        }
        batch.timer = setTimeout(() => {
            this.manager._trackFlush(streamId, this.manager.flushBatchVerification(streamId));
        }, this.BATCH_WINDOW_MS);
    }
    
    /**
     * Flush pending batch verifications for a stream
     * @private
     */
    async flushBatchVerification(streamId) {
        const batch = this.pendingVerifications.get(streamId);
        if (!batch || batch.messages.length === 0) {
            return;
        }
        
        // Clear the batch
        const messagesToProcess = batch.messages;
        batch.messages = [];
        batch.timer = null;
        
        const generationAtStart = this.manager.switchGeneration;
        
        Logger.debug(`Batch verifying ${messagesToProcess.length} historical messages for ${streamId.slice(-20)}`);
        
        // Verify all messages in parallel using Promise.all
        const verificationPromises = messagesToProcess.map(async ({ data, channel }) => {
            try {
                const verification = await identityManager.verifyMessage(data, streamId, {
                    skipTimestampCheck: true
                });
                data.verified = verification;
            } catch (error) {
                data.verified = { valid: false, error: error.message, trustLevel: -1 };
            }
            return { data, channel };
        });
        
        const verifiedMessages = await Promise.all(verificationPromises);
        
        // Discard results if user switched channels during batch verification
        if (this.manager.switchGeneration !== generationAtStart) {
            Logger.debug('Channel switched during batch verification, discarding results for', streamId.slice(-20));
            return;
        }
        
        // Add all verified messages to channel
        let addedCount = 0;
        for (const { data, channel } of verifiedMessages) {
            // Double-check channel still exists and message not already added
            if (!channel || !this.manager.channels.has(streamId)) {
                continue;
            }
            if (channel.messages.some(m => m.id === data.id)) {
                continue;
            }

            if (
                typeof mediaController?.isStoredChunkedImageManifest === 'function'
                && mediaController.isStoredChunkedImageManifest(data)
                && data.verified?.valid !== false
                && typeof mediaController.registerStoredImageManifest === 'function'
            ) {
                await mediaController.registerStoredImageManifest(streamId, data);
            }
            
            channel.messages.push(data);
            addedCount++;
            
            // Update oldest timestamp
            if (!channel.oldestTimestamp || messageTime(data) < channel.oldestTimestamp) {
                channel.oldestTimestamp = messageTime(data);
            }
        }
        
        if (addedCount > 0) {
            // Sort messages once after adding all
            const channel = this.manager.channels.get(streamId);
            if (channel) {
                this.manager.sortMessagesByTimestamp(channel);
                
                // Apply any pending overrides whose targets were just added
                this.manager.applyPendingOverrides(channel);
            }
            
            // Notify handlers with batch completion event
            this.manager.notifyHandlers('history_batch_loaded', { 
                streamId, 
                loaded: addedCount,
                total: messagesToProcess.length
            });
            
            Logger.debug(`Batch verification complete: ${addedCount}/${messagesToProcess.length} messages added`);
        }
    }

    /**
     * Track a flush promise for later awaiting
     * @private
     */
    _trackFlush(streamId, promise) {
        if (!this.pendingFlushPromises.has(streamId)) {
            this.pendingFlushPromises.set(streamId, new Set());
        }
        const set = this.pendingFlushPromises.get(streamId);
        set.add(promise);
        promise.finally(() => {
            set.delete(promise);
            if (set.size === 0) {
                this.pendingFlushPromises.delete(streamId);
            }
        });
    }

    /**
     * Await all in-flight flush promises for a stream
     * @private
     */
    async awaitAllFlushes(streamId) {
        const set = this.pendingFlushPromises.get(streamId);
        if (set && set.size > 0) {
            await Promise.all([...set]);
        }
    }

    /**
     * Handle media message (JSON from MEDIA_SIGNALS or binary from MEDIA_DATA)
     * @param {string} streamId - Stream ID
     * @param {Object|Uint8Array} data - Media data (JSON object or binary)
     * @param {string} [account] - Publisher ID (provided for binary messages)
     */
    handleMediaMessage(streamId, data, account) {
        // CRITICAL: Check if still connected before processing
        if (!authManager.isConnected()) {
            return;
        }
        
        // Binary data from MEDIA_DATA partition — delegate to mediaController for decoding
        if (data instanceof Uint8Array) {
            mediaController.handleMediaMessage(streamId, data, account);
            return;
        }
        
        // Skip control messages (presence, typing, reactions) - these belong on control partition
        if (data?.type === 'presence' || data?.type === 'typing' || data?.type === 'reaction') {
            return;
        }
        
        // Skip if it doesn't look like media
        if (!data?.type) {
            return;
        }
        
        Logger.debug('Media message received:', data?.type);

        // Notify handlers
        this.manager.notifyHandlers('media', { streamId, media: data });
    }

    /**
     * Send a text message to MESSAGE stream
     * @param {string} messageStreamId - Message Stream ID (channel key)
     * @param {string} text - Message text
     * @param {Object|null} replyTo - Reply context (optional)
     */
    async sendMessage(messageStreamId, text, replyTo = null) {
        let message = null;
        let sendKey = null;
        
        try {
            const channel = this.manager.channels.get(messageStreamId);
            if (!channel) {
                throw new Error('Channel not found');
            }

            // DM channels: route through DMManager
            if (channel.type === 'dm') {
                return await dmManager.sendMessage(messageStreamId, text, replyTo);
            }

            // Check publish permission using Streamr SDK (real-time on-chain check)
            // This applies to ALL channel types - the SDK handles public permissions correctly
            const currentAddress = authManager.getAddress();
            if (!currentAddress) {
                throw new Error('Not authenticated');
            }

            // Check cached permission first (set by UI or previous check)
            let canPublish = false;
            const cacheValid = channel._publishPermCache?.address?.toLowerCase() === currentAddress.toLowerCase() &&
                              channel._publishPermCache?.timestamp && 
                              (Date.now() - channel._publishPermCache.timestamp) < 60000; // 1 min cache
            
            if (cacheValid) {
                canPublish = channel._publishPermCache.canPublish;
            } else {
                // Check via Streamr SDK (real-time on-chain)
                try {
                    const result = await streamrController.hasPublishPermission(messageStreamId, true);
                    
                    // Handle RPC error - be optimistic and try to publish anyway
                    if (result.rpcError) {
                        Logger.warn('RPC error checking publish permission, proceeding optimistically');
                        canPublish = true;
                    } else {
                        canPublish = result.hasPermission;
                        // Cache the result (only if we got a definitive answer)
                        channel._publishPermCache = {
                            address: currentAddress,
                            canPublish: canPublish,
                            timestamp: Date.now()
                        };
                    }
                    Logger.debug('Publish permission check via SDK:', { streamId: messageStreamId, canPublish, rpcError: result.rpcError });
                } catch (error) {
                    Logger.warn('Failed to check publish permission via SDK:', error);
                    // On error, try to publish anyway - the network will reject if no permission
                    canPublish = true;
                }
            }

            if (!canPublish) {
                throw new Error('You do not have permission to send messages in this channel.');
            }

            // DEDUPLICATION: Use content-based key to block duplicate sends synchronously
            // This key is created BEFORE the async createSignedMessage to prevent
            // two rapid clicks from both passing the check before either adds to the Set
            sendKey = `${messageStreamId}:${text}:${replyTo || ''}`;
            if (this.sendingMessages.has(sendKey)) {
                Logger.warn('Duplicate send blocked (same content already in flight)');
                return;
            }
            this.sendingMessages.add(sendKey);

            // Create signed message using identity manager
            message = await identityManager.createSignedMessage(text, messageStreamId, replyTo);

            // Add verification info for local display (includes ENS for badge + display name)
            message.verified = {
                valid: true,
                trustLevel: await identityManager.getTrustLevel(message.sender),
                ensName: await identityManager.resolveENS(message.sender)
            };
            
            // Mark as pending until confirmed sent
            message.pending = true;

            // Add to local messages FIRST (before publishing)
            channel.messages.push(message);
            // NOTE: No saveChannels() - messages are not persisted

            // Notify handlers to update UI immediately (with pending indicator)
            this.manager.notifyHandlers('message', { streamId: messageStreamId, message: message });

            // Publish to MESSAGE stream (stored)
            await this.manager.publishWithRetry(messageStreamId, message, channel.password);
            
            // Mark as sent (remove pending flag)
            message.pending = false;
            
            // For write-only channels, persist sent messages locally
            // (no subscribe permission = can't fetch history from network)
            if (channel.writeOnly) {
                await secureStorage.addSentMessage(messageStreamId, message);
            }
            
            // Notify UI that message is confirmed
            this.manager.notifyHandlers('message_confirmed', { streamId: messageStreamId, messageId: message.id });

            // Send wake signals to other channel members (async, don't await)
            this.manager.sendWakeSignals(messageStreamId).catch(err => {
                Logger.debug('Wake signals failed (non-critical):', err.message);
            });

            Logger.debug('Message sent to messageStream:', message.id);
        } catch (error) {
            Logger.error('Failed to send message:', error);
            // Message stays in local storage with pending flag
            // User can see it failed and retry manually
            this.manager.notifyHandlers('message_failed', { streamId: messageStreamId, messageId: message?.id, error: error.message });
            throw error;
        } finally {
            // Always clean up the sending lock
            if (sendKey) {
                this.sendingMessages.delete(sendKey);
            }
        }
    }
    
    /**
     * Publish message with retry mechanism
     * @param {string} messageStreamId - Message Stream ID
     * @param {Object} message - Message to publish
     * @param {string} password - Channel password (optional)
     * @param {number} retryCount - Current retry attempt
     */
    async publishWithRetry(messageStreamId, message, password = null, retryCount = 0) {
        try {
            await streamrController.publishMessage(messageStreamId, message, password);
            Logger.info('Text message published to messageStream:', message.id);
        } catch (error) {
            if (retryCount < this.MAX_RETRIES) {
                Logger.warn(`Publish failed, retrying (${retryCount + 1}/${this.MAX_RETRIES})...`);
                await new Promise(resolve => setTimeout(resolve, this.RETRY_DELAY));
                return this.manager.publishWithRetry(messageStreamId, message, password, retryCount + 1);
            }
            throw error;
        }
    }
    
    /**
     * Sort messages by timestamp
     * @param {Object} channel - Channel object
     */
    sortMessagesByTimestamp(channel) {
        if (!channel || !channel.messages) return;
        channel.messages.sort((a, b) => messageTime(a) - messageTime(b));
    }

    /**
     * Load more (older) history from MESSAGE stream - for lazy loading / infinite scroll
     * In dual-stream architecture, only messageStream has storage
     * @param {string} messageStreamId - Message Stream ID (channel key)
     * @returns {Promise<{loaded: number, hasMore: boolean}>} - Number of messages loaded and if more exist
     */
    async loadMoreHistory(messageStreamId) {
        const channel = this.manager.channels.get(messageStreamId);
        if (!channel) {
            Logger.warn('Channel not found for loadMoreHistory:', messageStreamId);
            return { loaded: 0, hasMore: false };
        }

        // Write-only channels have no network history access
        if (channel.writeOnly) {
            return { loaded: 0, hasMore: false };
        }

        // DM channels: paginate from inbox stream via dmManager
        if (channel.type === 'dm') {
            if (channel.loadingHistory) {
                return { loaded: 0, hasMore: channel.hasMoreHistory };
            }
            if (!channel.hasMoreHistory) {
                return { loaded: 0, hasMore: false };
            }
            channel.loadingHistory = true;
            // Abort any still-running fetch before replacing the controller —
            // otherwise the orphaned fetch keeps consuming its iterator.
            this.manager.historyAbortController?.abort();
            this.manager.historyAbortController = new AbortController();
            const signal = this.manager.historyAbortController.signal;
            const generationAtStart = this.manager.switchGeneration;
            try {
                const result = await dmManager.fetchOlderDMMessages(channel.peerAddress, signal);
                if (this.manager.switchGeneration !== generationAtStart) {
                    channel.loadingHistory = false;
                    return { loaded: 0, hasMore: channel.hasMoreHistory };
                }
                channel.loadingHistory = false;
                return result;
            } catch (error) {
                Logger.error('DM: loadMoreHistory failed:', error);
                channel.loadingHistory = false;
                return { loaded: 0, hasMore: channel.hasMoreHistory };
            }
        }
        
        // Prevent concurrent loads
        if (channel.loadingHistory) {
            Logger.debug('Already loading history, skipping');
            return { loaded: 0, hasMore: channel.hasMoreHistory };
        }
        
        // Check if there's more to load
        if (!channel.hasMoreHistory) {
            Logger.debug('No more history to load');
            return { loaded: 0, hasMore: false };
        }
        
        // Use oldest message timestamp, or Date.now() if history was only reactions
        const beforeTimestamp = channel.oldestTimestamp || Date.now();
        
        channel.loadingHistory = true;
        this.manager.notifyHandlers('history_loading', { streamId: messageStreamId, loading: true });
        
        const generationAtStart = this.manager.switchGeneration;
        
        // Create AbortController for this fetch - will be aborted on channel switch.
        // Abort any previous in-flight fetch first so it doesn't keep running orphaned.
        this.manager.historyAbortController?.abort();
        this.manager.historyAbortController = new AbortController();
        const signal = this.manager.historyAbortController.signal;
        
        try {
            Logger.debug('Loading more history before:', new Date(beforeTimestamp).toISOString());
            const supportsControlPartition = channel?._controlPartitionSupported !== false;

            // Fetch from MESSAGE stream partition 0 (content) and partition 1 (overrides)
            const fetchContent = () => streamrController.fetchOlderHistory(
                messageStreamId,
                STREAM_CONFIG.MESSAGE_STREAM.MESSAGES,
                beforeTimestamp,
                STREAM_CONFIG.LOAD_MORE_COUNT,
                channel.password,
                signal,
                !supportsControlPartition
            );
            const fetchOverrides = () => (
                supportsControlPartition
                    ? streamrController.fetchOlderHistory(
                        messageStreamId,
                        STREAM_CONFIG.MESSAGE_STREAM.CONTROL,
                        beforeTimestamp,
                        STREAM_CONFIG.LOAD_MORE_COUNT,
                        channel.password,
                        signal,
                        false
                    )
                    : Promise.resolve({ messages: [], hasMore: false })
            );

            // Reactions moved to the -5, so paging only the -1 brings back
            // older messages with their reactions missing. Same window, same
            // handler: they arrive as control messages either way. A channel
            // whose -5 was never created reads as empty and costs one call.
            const interactionsId = channel?.interactionsStreamId;
            const fetchReactions = () => (
                interactionsId
                    ? streamrController.fetchOlderHistory(
                        interactionsId,
                        STREAM_CONFIG.INTERACTIONS_STREAM.REACTIONS,
                        beforeTimestamp,
                        STREAM_CONFIG.LOAD_MORE_COUNT,
                        channel.password,
                        signal,
                        false
                    ).catch(e => {
                        Logger.debug('loadMoreHistory: interactions page failed:', e?.message || e);
                        return { messages: [], hasMore: false };
                    })
                    : Promise.resolve({ messages: [], hasMore: false })
            );

            let [contentResult, overrideResult, reactionResult] = await Promise.all([
                fetchContent(), fetchOverrides(), fetchReactions()
            ]);

            // Older reactions never gate "is there more history": that is the
            // -1's question, and a reaction page that runs dry says nothing
            // about the conversation behind it.
            for (const msg of reactionResult.messages || []) {
                if (msg?.type !== 'reaction') continue;
                const reactionUser = msg.account || msg.user;
                if (reactionUser && msg.messageId && msg.emoji) {
                    this.manager.storeReaction(
                        channel, msg.messageId, msg.emoji, reactionUser, msg.action || 'add');
                }
            }

            // Storage race mitigation: a {from:0, to:before} resend that returns
            // zero messages can mean either (a) true exhaustion, or (b) the
            // storage node closed the iterator early (observed with custom
            // storage and large temporal gaps where the iterator must traverse
            // many empty buckets before reaching real data).
            //
            // Without retries, case (b) permanently flags `hasMoreHistory=false`
            // and orphans any older messages. A single 1s retry covered most
            // cases but failed for the worst gaps. Use progressive backoff
            // (1s, 2s, 3s — total worst-case +6s in the truly-exhausted path)
            // to give the storage node enough time to walk the gap. Any
            // attempt that returns data wins immediately; we don't keep
            // retrying after success.
            const isEmpty = (c, o) => (c?.messages?.length || 0) === 0
                && (o?.messages?.length || 0) === 0;
            if (isEmpty(contentResult, overrideResult)
                && beforeTimestamp > 1
                && !signal?.aborted
                && this.manager.switchGeneration === generationAtStart) {
                const backoffMs = [1000, 2000, 3000];
                for (let attempt = 0; attempt < backoffMs.length; attempt++) {
                    await new Promise(r => setTimeout(r, backoffMs[attempt]));
                    if (signal?.aborted || this.manager.switchGeneration !== generationAtStart) break;
                    const [retryContent, retryOverride] = await Promise.all([fetchContent(), fetchOverrides()]);
                    if (!isEmpty(retryContent, retryOverride)) {
                        Logger.info(
                            `loadMoreHistory: retry #${attempt + 1} recovered messages after empty first response`
                        );
                        contentResult = retryContent;
                        overrideResult = retryOverride;
                        break;
                    }
                }
            }
            
            // Discard results if user switched channels during fetch
            if (this.manager.switchGeneration !== generationAtStart) {
                Logger.debug('Channel switched during history fetch, discarding results for', messageStreamId.slice(-20));
                channel.loadingHistory = false;
                return { loaded: 0, hasMore: channel.hasMoreHistory };
            }
            
            // Separate reactions and overrides from content messages
            let addedCount = 0;
            
            const contentMessagesRaw = contentResult.messages || [];
            const overridesRaw = overrideResult.messages || [];

            if (contentMessagesRaw.length > 0 || overridesRaw.length > 0) {
                const contentMessages = [];
                const overrides = [...overridesRaw];
                
                for (const msg of contentMessagesRaw) {
                    // Stored chunked-image chunks have `timestamp` but no
                    // `id`/`sender`, so the generic "incomplete message"
                    // filter below would drop them. Route to the assembler
                    // first — without this, paginating older history can
                    // never recover chunks whose manifest sits inside the
                    // initial resend window but whose chunks fall outside.
                    if (typeof mediaController?.isStoredImageChunkMessage === 'function'
                        && mediaController.isStoredImageChunkMessage(msg)) {
                        if (messageTime(msg) && (!channel.oldestTimestamp || messageTime(msg) < channel.oldestTimestamp)) {
                            channel.oldestTimestamp = messageTime(msg);
                        }
                        try {
                            await mediaController.registerStoredImageChunk(messageStreamId, msg);
                        } catch (err) {
                            Logger.debug('loadMoreHistory: chunk register failed:', err?.message || err);
                        }
                        continue;
                    }

                    // Route reactions to storeReaction (NOT channel.messages)
                    if (msg?.type === 'reaction') {
                        const reactionUser = msg.account || msg.user;
                        if (reactionUser && msg.messageId && msg.emoji) {
                            this.manager.storeReaction(channel, msg.messageId, msg.emoji, reactionUser, msg.action || 'add');
                        }
                        // Track oldest timestamp from reactions too (for pagination progress)
                        if (messageTime(msg) && (!channel.oldestTimestamp || messageTime(msg) < channel.oldestTimestamp)) {
                            channel.oldestTimestamp = messageTime(msg);
                        }
                        continue;
                    }

                    // Legacy fallback path: stream has no control partition, overrides come from P0
                    if (!supportsControlPartition && (msg?.type === 'edit' || msg?.type === 'delete')) {
                        if (messageTime(msg) && (!channel.oldestTimestamp || messageTime(msg) < channel.oldestTimestamp)) {
                            channel.oldestTimestamp = messageTime(msg);
                        }
                        overrides.push(msg);
                        continue;
                    }
                    
                    // Skip non-content or incomplete messages
                    if (!msg?.id || !msg?.sender || !msg?.timestamp) continue;
                    // Deduplicate
                    if (channel.messages.some(m => m.id === msg.id)) continue;
                    
                    contentMessages.push(msg);
                }
                
                if (contentMessages.length > 0) {
                    // OPTIMIZATION: Verify all messages in parallel using worker pool
                    const verificationPromises = contentMessages.map(async (msg) => {
                        try {
                            if (!msg.channelId) msg.channelId = messageStreamId;
                            const verification = await identityManager.verifyMessage(msg, messageStreamId, {
                                skipTimestampCheck: true
                            });
                            msg.verified = verification;
                        } catch (error) {
                            msg.verified = { valid: false, error: error.message, trustLevel: -1 };
                        }
                        return msg;
                    });
                    
                    // Wait for all verifications to complete in parallel
                    const verifiedMessages = await Promise.all(verificationPromises);
                    
                    // Discard results if user switched channels during verification
                    if (this.manager.switchGeneration !== generationAtStart) {
                        Logger.debug('Channel switched during history verification, discarding results for', messageStreamId.slice(-20));
                        channel.loadingHistory = false;
                        return { loaded: 0, hasMore: channel.hasMoreHistory };
                    }
                    
                    // Add all verified messages to channel (with dedup re-check for race conditions)
                    for (const msg of verifiedMessages) {
                        // Re-check dedup: real-time messages may have arrived during verification
                        if (channel.messages.some(m => m.id === msg.id)) {
                            continue;
                        }

                        // Register chunked-image manifests with the assembler
                        // so any chunks already buffered (or arriving in
                        // this same paginate window above) can complete.
                        if (
                            typeof mediaController?.isStoredChunkedImageManifest === 'function'
                            && mediaController.isStoredChunkedImageManifest(msg)
                            && msg.verified?.valid !== false
                            && typeof mediaController.registerStoredImageManifest === 'function'
                        ) {
                            try {
                                await mediaController.registerStoredImageManifest(messageStreamId, msg);
                            } catch (err) {
                                Logger.debug('loadMoreHistory: manifest register failed:', err?.message || err);
                            }
                        }

                        channel.messages.push(msg);
                        addedCount++;
                        
                        // Update oldest timestamp
                        if (!channel.oldestTimestamp || messageTime(msg) < channel.oldestTimestamp) {
                            channel.oldestTimestamp = messageTime(msg);
                        }
                    }
                    
                    // Sort messages
                    this.manager.sortMessagesByTimestamp(channel);
                }
                
                // Apply edit/delete overrides after content messages are added
                for (const override of overrides) {
                    this.manager.handleOverrideMessage(messageStreamId, override, true);
                }
                // Apply any previously pending overrides that now have matching messages
                this.manager.applyPendingOverrides(channel);
                // Remove deleted messages from array
                channel.messages = channel.messages.filter(m => !m._deleted);
            }
            
            // Pagination is driven by content partition
            channel.hasMoreHistory = contentResult.hasMore;
            channel.loadingHistory = false;
            
            this.manager.notifyHandlers('history_loaded', { 
                streamId: messageStreamId, 
                loaded: addedCount, 
                hasMore: contentResult.hasMore 
            });
            
            Logger.info(`Loaded ${addedCount} older messages (P0: ${contentMessagesRaw.length}, P1: ${overridesRaw.length}), hasMore: ${contentResult.hasMore}`);
            
            // Pagination may have delivered image manifests whose chunks are
            // missing (or chunks without their manifest). Re-run image
            // recovery unless we're already inside a recovery pass — without
            // this, images arriving via scroll pagination with incomplete
            // chunks stay on "Loading Image" forever: the initial-history
            // recovery trigger has long passed and no gave-up event (hence
            // no Retry button) is ever emitted. Fire-and-forget so scroll
            // latency is unaffected.
            if (!this.manager._imageRecoveryInFlight.has(messageStreamId)) {
                this.manager.recoverIncompleteImages(messageStreamId).catch(err => {
                    Logger.debug('post-pagination image recovery failed:', err?.message || err);
                });
            }
            
            return { loaded: addedCount, hasMore: contentResult.hasMore };
        } catch (error) {
            Logger.error('Failed to load more history:', error);
            channel.loadingHistory = false;
            this.manager.notifyHandlers('history_loading', { streamId: messageStreamId, loading: false });
            return { loaded: 0, hasMore: channel.hasMoreHistory };
        }
    }

    /**
     * Send wake signals to other members in the channel.
     * This notifies them via push notification that there's a new message.
     * 
     * HYBRID ARCHITECTURE:
     * - Gated channels: Send to the per-channel tag
     * - Public/Password channels: Send to channelTag (opt-in subscribers)
     * 
     * @param {string} messageStreamId - Message Stream ID (channel key)
     */
    async sendWakeSignals(messageStreamId) {
        try {
            const channel = this.manager.channels.get(messageStreamId);
            if (!channel) return;
            
            const channelType = channel.type || 'unknown';
            
            // DM channels: Send wake signal using the peer's inbox stream ID
            // The tag is based on the peer's inbox, so the peer gets notified
            if (channelType === 'dm') {
                Logger.debug('Sending DM wake signal for:', messageStreamId.slice(0, 20) + '...');
                await relayManager.sendChannelWakeSignal(messageStreamId);
                Logger.debug('DM wake signal sent');
                
            // Gated channels: Send to channel tag (per-channel notifications)
            } else if (channelType === 'gated') {
                Logger.debug('Sending gated channel wake signal for:', messageStreamId.slice(0, 20) + '...');
                await relayManager.sendNativeChannelWakeSignal(messageStreamId);
                Logger.debug('Gated channel wake signal sent');
                
            } else {
                // Public/Password channels: Send to channel tag
                // Anyone who opted into notifications for this channel will receive
                Logger.debug('Sending channel wake signal for:', channelType, 'channel');
                await relayManager.sendChannelWakeSignal(messageStreamId);
                Logger.debug('Channel wake signal sent');
            }
            
        } catch (error) {
            // Non-critical - log but don't throw
            Logger.debug('Failed to send wake signals:', error.message);
        }
    }

    /**
     * Cancel pending batch verifications for a stream
     * Called on channel switch to discard queued work for the previous channel
     * @param {string} streamId - Stream ID to cancel
     */
    cancelPendingVerifications(streamId) {
        const batch = this.pendingVerifications.get(streamId);
        if (batch) {
            if (batch.timer) {
                clearTimeout(batch.timer);
            }
            const discarded = batch.messages.length;
            this.pendingVerifications.delete(streamId);
            if (discarded > 0) {
                Logger.debug(`Cancelled ${discarded} pending batch verifications for`, streamId.slice(-20));
            }
        }
    }
}
