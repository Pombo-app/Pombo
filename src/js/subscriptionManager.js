/**
 * Subscription Manager
 * Handles dynamic subscription lifecycle for performance optimization
 * 
 * DUAL-STREAM ARCHITECTURE:
 * - Active channel: Full subscription to BOTH streams (message + ephemeral)
 * - Background channels: Lightweight polling for activity detection (message stream only)
 * 
 * This reduces network traffic significantly when users have many channels
 * but only actively use one at a time.
 */

import { streamrController, STREAM_CONFIG, deriveEphemeralId, deriveAdminId, deriveInteractionsId } from './streamr.js';
import { channelManager } from './channels.js';
import { channelLatestMessageManager } from './channelLatestMessageManager.js';
import { adminStatePoller } from './adminStatePoller.js';
import { memberCatchUp } from './memberCatchUp.js';
import { secureStorage } from './secureStorage.js';
import { authManager } from './auth.js';
import { identityManager } from './identity.js';
import { mediaController } from './media.js';
import { Logger } from './logger.js';
import { CONFIG } from './config.js';

class SubscriptionManager {
    constructor() {
        // Active channel state (keyed by messageStreamId)
        this.activeChannelId = null;  // messageStreamId of active channel
        
        // Preview channel state (temporary subscription, not persisted)
        this.previewChannelId = null;  // messageStreamId of channel being previewed
        this.previewPresenceInterval = null;  // Interval for presence broadcasting in preview

        // Switch fence for preview subscription work. Bumped on every
        // setPreviewChannel and clearPreviewChannel call so async work
        // captured during a previous preview (admin resend,
        // subscribeToDualStream) can detect it has been superseded after
        // its awaits and either bail out or undo (unsubscribe) without
        // leaking an orphan subscription/presence interval. Mirrors
        // channelManager.switchGeneration for joined channels.
        this.previewSwitchGeneration = 0;

        // Tracks preview message-stream ids whose subscribeToDualStream
        // has been started but is no longer the active preview. Two
        // sources: (a) the user clicked a different Explore item before
        // the prior subscribe await returned, (b) handlers fired for a
        // streamId that mismatches `previewChannelId`. We fire a single
        // unsubscribe per orphan and rely on the streamId-bound handler
        // closures to drop messages until the unsubscribe takes effect.
        this._orphanPreviewSubs = new Set();
        
        // Background activity tracking (keyed by messageStreamId)
        this.backgroundPoller = null;
        this.channelActivity = new Map(); // messageStreamId -> { lastMessageTime, unreadCount, lastChecked }
        
        // Activity change handlers
        this.activityHandlers = [];
        
        // Preview message callback (set by ui.js to avoid circular dependency)
        this.onPreviewMessage = null;

        // Preview override callback — invoked for -1/P1 edit/delete
        // messages so PreviewModeUI can apply or queue them. Distinct from
        // onPreviewMessage so previews mirror the channel-mode dual-handler
        // pipeline (text vs override) and overrides cannot be lost when the
        // preview is later promoted to active. Set by ui.js to avoid a
        // circular dependency.
        this.onPreviewOverride = null;

        // Preview admin-state callback — invoked once after an on-open
        // resend of -3/P0 (and on each subsequent poll/invalidate refresh)
        // so PreviewModeUI can apply moderation (banned, hidden, pins) and
        // re-render. Set by ui.js to avoid circular dependency.
        this.onPreviewAdmin = null;
        
        // Configuration
        this.config = {
            POLL_INTERVAL: CONFIG.subscriptions.pollIntervalMs,
            POLL_BATCH_SIZE: CONFIG.subscriptions.pollBatchSize,
            POLL_STAGGER_DELAY: CONFIG.subscriptions.pollStaggerDelayMs,
            MIN_POLL_INTERVAL: CONFIG.subscriptions.minPollIntervalMs,
            MAX_CONCURRENT_SUBS: CONFIG.subscriptions.maxConcurrentSubs,
            ACTIVITY_CHECK_MESSAGES: CONFIG.subscriptions.activityCheckMessages,
        };
        
        // Polling state
        this.pollIndex = 0;
        this.isPolling = false;
    }

    /**
     * Set the active channel - full subscription with history
     * Downgrades previous active channel to background mode
     * In dual-stream architecture, subscribes to BOTH message and ephemeral streams
     * @param {string} messageStreamId - Message Stream ID to activate (channel key)
     * @param {string} password - Optional password for encrypted channels
     */
    async setActiveChannel(messageStreamId, password = null) {
        if (!messageStreamId) {
            Logger.warn('setActiveChannel called with null streamId');
            return;
        }

        // If same channel, just ensure subscription is active
        if (this.activeChannelId === messageStreamId) {
            Logger.debug('Channel already active:', messageStreamId);
            return;
        }

        Logger.info('Setting active channel:', messageStreamId);

        // Downgrade previous active channel (unsubscribe BOTH streams to save resources)
        if (this.activeChannelId) {
            await this.downgradeToBackground(this.activeChannelId);
        }

        this.activeChannelId = messageStreamId;

        // Full subscription with history for active channel (BOTH streams)
        try {
            await channelManager.subscribeToChannel(messageStreamId, password);
            Logger.info('Active channel subscription complete:', messageStreamId);
        } catch (error) {
            Logger.error('Failed to subscribe to active channel:', error);
            throw error;
        }

        // Start admin-state polling for the active channel. Resend-only model:
        // no live -3 subscription, periodic refresh + invalidation signal.
        try {
            adminStatePoller.start(messageStreamId, () => channelManager.refreshAdminState(messageStreamId));
        } catch (e) {
            Logger.debug('Admin poller start failed (non-fatal):', e?.message || e);
        }

        // A member's keys and messages need a raw sweep the owner does not.
        try {
            const channel = channelManager.getChannel(messageStreamId);
            if (channel) {
                memberCatchUp.start(channel,
                    (data) => channelManager.handleTextMessage(messageStreamId, data));
            }
        } catch (e) {
            Logger.debug('Member catch-up start failed (non-fatal):', e?.message || e);
        }
    }

    /**
     * Downgrade channel to background mode (unsubscribe BOTH streams to free resources)
     * @param {string} messageStreamId - Message Stream ID to downgrade
     */
    async downgradeToBackground(messageStreamId) {
        if (!messageStreamId) return;

        // Stop admin polling for this channel — no -3 traffic in background.
        try {
            if (adminStatePoller.getStreamId() === messageStreamId) {
                adminStatePoller.stop();
            }
            memberCatchUp.stop(messageStreamId);
        } catch (e) { /* ignore */ }

        try {
            // Store current activity state before unsubscribing
            const channel = channelManager.getChannel(messageStreamId);
            if (channel && channel.messages?.length > 0) {
                const latestMsg = channel.messages[channel.messages.length - 1];
                this.channelActivity.set(messageStreamId, {
                    lastMessageTime: latestMsg.timestamp || Date.now(),
                    unreadCount: 0,
                    lastChecked: Date.now()
                });
            }

            // Get ephemeral stream ID
            const ephemeralStreamId = channel?.ephemeralStreamId || deriveEphemeralId(messageStreamId);

            // If active media transfers exist (downloads/seeds), keep P1/P2 alive
            // Only unsubscribe message stream + ephemeral P0 (control)
            if (mediaController.hasActiveMediaTransfers(messageStreamId)) {
                Logger.info('Active media transfers — keeping P1/P2 alive for:', messageStreamId);
                await streamrController.unsubscribe(messageStreamId);
                await streamrController.unsubscribeFromPartition(ephemeralStreamId, STREAM_CONFIG.EPHEMERAL_STREAM.CONTROL);
            } else {
                // No active transfers — full unsubscribe (both streams, all partitions)
                await streamrController.unsubscribeFromDualStream(messageStreamId, ephemeralStreamId);
            }
            Logger.debug('Downgraded to background:', messageStreamId);
        } catch (error) {
            Logger.warn('Failed to downgrade channel:', messageStreamId, error.message);
        }
    }

    /**
     * Clear active channel (when deselecting/closing)
     */
    async clearActiveChannel() {
        if (this.activeChannelId) {
            await this.downgradeToBackground(this.activeChannelId);
            this.activeChannelId = null;
        }
    }

    /**
     * Set a preview channel - temporary subscription without persistence
     * Used for browsing/exploring channels before committing to join
     * @param {string} messageStreamId - Message Stream ID to preview
     * @param {Function} [onHistoryComplete] - Callback when initial history is fully loaded
     */
    async setPreviewChannel(messageStreamId, onHistoryComplete = null) {
        if (!messageStreamId) {
            Logger.warn('setPreviewChannel called with null streamId');
            return;
        }

        // If same channel, already previewing
        if (this.previewChannelId === messageStreamId) {
            Logger.debug('Already previewing this channel:', messageStreamId);
            return;
        }

        Logger.info('Setting preview channel:', messageStreamId);

        // Claim this preview switch. Any older in-flight setPreviewChannel
        // call (rapid clicks in Explore) will see gen !== previewSwitchGeneration
        // after its awaits and either return without subscribing or undo a
        // subscription that completed too late.
        const gen = ++this.previewSwitchGeneration;

        // Clear any existing preview first. clearPreviewChannel intentionally
        // does NOT bump the generation, so our claimed `gen` survives the
        // await — see clearPreviewChannel for rationale.
        if (this.previewChannelId) {
            await this.clearPreviewChannel();
        }

        // Also clear active channel if any (preview takes precedence in UI)
        if (this.activeChannelId) {
            await this.downgradeToBackground(this.activeChannelId);
            this.activeChannelId = null;
            if (gen !== this.previewSwitchGeneration) {
                Logger.debug('setPreviewChannel: superseded during active downgrade:', messageStreamId);
                return;
            }
        }

        this.previewChannelId = messageStreamId;

        // Safety net: wrap onHistoryComplete so it fires at most once and
        // is forced after 30s if the SDK resend iterator never signals
        // `done` (custom storage / legacy single-partition streams).
        // Without this, `previewChannel.initialLoadInProgress` stays true
        // and the empty-state render keeps the spinner indefinitely.
        let historyCompleteFired = false;
        let previewHistorySafetyTimer = null;
        let historyStats = null;
        // Nothing is painted until every source that can change what a message
        // looks like has been read: content, the control overrides, and the
        // reactions on the -5.
        let pendingHistoryGates = 2;
        const fireHistoryComplete = () => {
            if (historyCompleteFired || !onHistoryComplete) return;
            historyCompleteFired = true;
            if (previewHistorySafetyTimer) {
                clearTimeout(previewHistorySafetyTimer);
                previewHistorySafetyTimer = null;
            }
            try { onHistoryComplete(historyStats); }
            catch (e) { Logger.warn('preview onHistoryComplete error:', e?.message || e); }
        };
        const releaseHistoryGate = (stats) => {
            if (stats) historyStats = stats;
            if (--pendingHistoryGates > 0) return;
            fireHistoryComplete();
        };
        const wrappedOnHistoryComplete = onHistoryComplete ? releaseHistoryGate : null;
        this._previewOnHistoryComplete = onHistoryComplete;
        if (wrappedOnHistoryComplete) {
            previewHistorySafetyTimer = setTimeout(() => {
                if (historyCompleteFired) return;
                Logger.warn(`Preview history safety timeout for ${messageStreamId.slice(-20)}`);
                fireHistoryComplete();
            }, 30000);
        }

        // Subscribe to both streams with proper handler object format
        // Using streamrController directly since channel is not in channelManager yet
        let ephemeralStreamId = null;
        try {
            ephemeralStreamId = deriveEphemeralId(messageStreamId);
            const adminStreamId = deriveAdminId(messageStreamId);

            // Step 1: Bootstrap admin state via a one-shot resend of -3/P0
            // BEFORE subscribing to content, mirroring the flow used for
            // active channels. The resend-based model removes the live
            // websocket on -3 entirely — subsequent updates arrive via the
            // AdminStatePoller (started below) and via ADMIN_INVALIDATE
            // signals received on the ephemeral -2/P0 control partition.
            if (adminStreamId) {
                try {
                    const latest = await streamrController.resendAdminState(adminStreamId, {
                        historyCount: STREAM_CONFIG.ADMIN_HISTORY_COUNT,
                        password: null
                    });
                    // Drop the snapshot if a newer preview has taken over.
                    if (gen !== this.previewSwitchGeneration) {
                        Logger.debug('setPreviewChannel: superseded after admin resend:', messageStreamId);
                        return;
                    }
                    if (latest && this.onPreviewAdmin) {
                        try { this.onPreviewAdmin(messageStreamId, latest); }
                        catch (e) { Logger.warn('onPreviewAdmin error (initial):', e.message); }
                    }
                } catch (e) {
                    Logger.warn('Preview admin bootstrap resend failed (continuing without moderation):', e.message);
                    if (gen !== this.previewSwitchGeneration) return;
                }
            }

            // Start the admin-state poller for the preview channel. The
            // refresh function calls back into ui.js (via onPreviewAdmin)
            // after each resend so PreviewModeUI can apply the snapshot
            // through channelManager.applyAdminState and re-render.
            try {
                adminStatePoller.start(messageStreamId, async () => {
                    if (this.previewChannelId !== messageStreamId) return;
                    if (!adminStreamId) return;
                    const latest = await streamrController.resendAdminState(adminStreamId, {
                        historyCount: 5,
                        password: null
                    });
                    if (latest && this.onPreviewAdmin) {
                        try { this.onPreviewAdmin(messageStreamId, latest); }
                        catch (e) { Logger.warn('onPreviewAdmin error (poll):', e.message); }
                    }
                });
            } catch (e) {
                Logger.debug('Preview admin poller start failed (non-fatal):', e?.message || e);
            }

            await streamrController.subscribeToDualStream(
                messageStreamId,
                ephemeralStreamId,
                {
                    // Bind messageStreamId to each handler closure so
                    // history messages delivered while a newer preview has
                    // already taken over `previewChannelId` are routed by
                    // the stream that actually produced them — not by
                    // whatever preview happens to be active right now.
                    // Mismatch ⇒ drop and schedule orphan cleanup.
                    onMessage: (msg) => this._handlePreviewMessage(messageStreamId, msg),
                    onOverride: (msg) => this._handlePreviewOverride(messageStreamId, msg),
                    onControl: (ephMsg) => this._handlePreviewEphemeral(messageStreamId, ephMsg),
                    onMedia: (mediaMsg, account) => this._handlePreviewMedia(messageStreamId, mediaMsg, account)
                },
                null, // password
                STREAM_CONFIG.INITIAL_MESSAGES, // historyCount - load recent messages
                wrappedOnHistoryComplete // safety-wrapped callback (forces fire after 30s)
            );

            // Reactions live on the -5, which the dual stream does not cover.
            // The join reuses this subscription rather than making its own.
            const interactionsStreamId = deriveInteractionsId(messageStreamId);
            try {
                await streamrController.subscribeToPartition(
                    interactionsStreamId,
                    STREAM_CONFIG.INTERACTIONS_STREAM.REACTIONS,
                    (data) => channelManager.handleControlMessage(messageStreamId, data),
                    null
                );
                await streamrController.fetchHistoryAsync(
                    interactionsStreamId,
                    STREAM_CONFIG.INTERACTIONS_STREAM.REACTIONS,
                    STREAM_CONFIG.INITIAL_MESSAGES,
                    (data) => channelManager.handleControlMessage(messageStreamId, data),
                    null, null, false, { quiet: true }
                );
            } catch (e) {
                Logger.warn('Preview interactions subscription failed:', e.message);
            } finally {
                releaseHistoryGate();
            }

            // If a newer preview has claimed the slot while we were
            // subscribing, undo this subscription so it doesn't leak
            // (handlers would still fire and route into the wrong
            // previewChannelId, plus presence/poller would never stop).
            if (gen !== this.previewSwitchGeneration) {
                Logger.warn('setPreviewChannel: superseded after subscribe, unsubscribing orphan:', messageStreamId);
                if (previewHistorySafetyTimer) {
                    clearTimeout(previewHistorySafetyTimer);
                    previewHistorySafetyTimer = null;
                }
                try {
                    await streamrController.unsubscribeFromDualStream(messageStreamId, ephemeralStreamId);
                } catch (e) {
                    Logger.warn('Failed to unsubscribe orphan preview:', e.message);
                }
                try {
                    if (adminStatePoller.getStreamId() === messageStreamId) {
                        adminStatePoller.stop();
                    }
                    memberCatchUp.stop(messageStreamId);
                } catch (e) { /* ignore */ }
                return;
            }
            Logger.info('Preview subscription active:', messageStreamId);
            
            // Start presence broadcasting for preview channel
            this._startPreviewPresence(messageStreamId, ephemeralStreamId);
        } catch (error) {
            Logger.error('Failed to subscribe to preview channel:', error);
            if (previewHistorySafetyTimer) {
                clearTimeout(previewHistorySafetyTimer);
                previewHistorySafetyTimer = null;
            }
            // Fire the wrapped callback so PreviewModeUI releases
            // `initialLoadInProgress` and the spinner is dismissed.
            if (wrappedOnHistoryComplete) wrappedOnHistoryComplete(null);
            // Only clear our claim if still current — a newer setPreviewChannel
            // may have already taken ownership of previewChannelId.
            if (gen === this.previewSwitchGeneration && this.previewChannelId === messageStreamId) {
                this.previewChannelId = null;
            }
            throw error;
        }
    }

    /**
     * Handle message received on preview channel (-1/P0 content).
     * After promote, forwards to channelManager if channel exists there.
     * @param {string} sourceStreamId - Stream id whose subscription produced
     *   this message (captured in closure when subscribing). Must match
     *   `previewChannelId` for the message to be considered current; any
     *   mismatch indicates a stale/orphan subscription created by a rapid
     *   Explore switch and the message is dropped.
     * @private
     */
    _handlePreviewMessage(sourceStreamId, msg) {
        // Drop messages from stale subscriptions (rapid Explore switch).
        // Without this, the SDK keeps delivering A's history after the
        // user moved on to B, and `this.previewChannelId === B` would
        // misroute A's messages into B's preview state — exactly the
        // cross-channel leak this guard prevents. Once promoted to a
        // joined channel, channelManager owns routing by streamId so we
        // still allow forwarding below.
        if (sourceStreamId !== this.previewChannelId
            && sourceStreamId !== this.activeChannelId
            && !channelManager.getChannel(sourceStreamId)) {
            this._scheduleOrphanPreviewUnsub(sourceStreamId);
            return;
        }

        // If channel was promoted to channelManager, forward there instead
        if (channelManager.getChannel(sourceStreamId)) {
            channelManager.handleTextMessage(sourceStreamId, msg);
            return;
        }

        // Stored chunked-image protocol: chunks carry no id and must be fed
        // to the assembler — never propagate them to UI. Mirrors the
        // interception channels.js does for joined channels.
        if (typeof mediaController?.isStoredImageChunkMessage === 'function'
            && mediaController.isStoredImageChunkMessage(msg)) {
            mediaController.registerStoredImageChunk(sourceStreamId, msg).catch(err => {
                Logger.debug('Preview: stored image chunk register failed:', err?.message);
            });
            return;
        }

        // Stored chunked-image manifest is the actual image message (has id +
        // type='image'); register it with the assembler so any already-
        // buffered chunks can complete, then continue normal preview flow.
        if (typeof mediaController?.isStoredChunkedImageManifest === 'function'
            && mediaController.isStoredChunkedImageManifest(msg)) {
            mediaController.registerStoredImageManifest(sourceStreamId, msg).catch(err => {
                Logger.debug('Preview: stored image manifest register failed:', err?.message);
            });
        }

        // Still in preview mode - forward to UI via callback
        Logger.debug('Preview message callback:', msg?.id, msg?.type || 'text');
        if (this.onPreviewMessage) {
            this.onPreviewMessage(msg);
        } else {
            Logger.warn('subscriptionManager.onPreviewMessage not configured');
        }
    }

    /**
     * Handle override (edit/delete) on preview channel (-1/P1 control).
     * Routed through a dedicated callback so overrides bypass the text
     * validation path — mirroring the channel-mode dual-handler design
     * (handleTextMessage vs handleOverrideMessage). Without this, after
     * `promotePreviewToActive` the single text-path callback would treat
     * deletes/edits as malformed text messages and drop them silently.
     *
     * Pre-promote: forwarded to ui.js via `onPreviewOverride` so
     * PreviewModeUI applies the override (or queues it if the target
     * hasn't been ingested yet).
     * Post-promote: routed to channelManager.handleOverrideMessage so the
     * canonical `_pendingOverrides` map is used and `notifyHandlers`
     * fires the granular `message_edited` / `message_deleted` events.
     * @private
     */
    _handlePreviewOverride(sourceStreamId, msg) {
        // Same orphan-detection rationale as _handlePreviewMessage.
        if (sourceStreamId !== this.previewChannelId
            && sourceStreamId !== this.activeChannelId
            && !channelManager.getChannel(sourceStreamId)) {
            this._scheduleOrphanPreviewUnsub(sourceStreamId);
            return;
        }
        if (channelManager.getChannel(sourceStreamId)) {
            channelManager.handleOverrideMessage(sourceStreamId, msg);
            return;
        }
        Logger.debug('Preview override callback:', msg?.type, '→', msg?.targetId);
        if (this.onPreviewOverride) {
            this.onPreviewOverride(msg);
        } else if (this.onPreviewMessage) {
            // Backwards fallback: route through message handler so existing
            // type-based branch in PreviewModeUI.handlePreviewMessage still
            // applies the override.
            this.onPreviewMessage(msg);
        }
    }

    /**
     * Handle ephemeral message on preview channel (typing, presence)
     * After promote, continues to work because channelManager handles these
     * @private
     */
    _handlePreviewEphemeral(sourceStreamId, msg) {
        // Drop ephemerals (typing/presence/admin_invalidate) from stale
        // preview subscriptions; otherwise an orphan sub from channel A
        // could pollute channel B's online users list and admin state.
        if (sourceStreamId !== this.previewChannelId
            && sourceStreamId !== this.activeChannelId
            && !channelManager.getChannel(sourceStreamId)) {
            this._scheduleOrphanPreviewUnsub(sourceStreamId);
            return;
        }
        const streamId = sourceStreamId;
        
        Logger.debug('Preview ephemeral:', msg.type);
        
        // Process presence messages so online users work in preview mode
        if (msg.type === 'presence') {
            channelManager.handlePresenceMessage(streamId, msg);
        } else if (msg.type === 'typing') {
            // Use account from Streamr SDK (cryptographically guaranteed)
            channelManager.notifyHandlers('typing', {
                streamId: streamId,
                user: msg.account || msg.user,
                nickname: msg.nickname || null
            });
        } else if (msg.type === 'admin_invalidate') {
            // Apply the canonical ADMIN_STATE snapshot embedded in the
            // ephemeral signal. Sender authenticity is enforced at network
            // level by the -3/P0 publish permission (only the channel admin
            // can publish moderation), and the matching -2/P0 signal is
            // published by the same admin. We additionally inject createdBy
            // from the account so applyAdminState's owner check passes.
            if (!msg.snapshot || typeof msg.snapshot !== 'object') return;
            const sender = (msg.account || msg.user || '').toLowerCase();
            if (!msg.snapshot.createdBy && sender) {
                msg.snapshot.createdBy = sender;
            }
            if (this.onPreviewAdmin) {
                try { this.onPreviewAdmin(streamId, msg.snapshot); }
                catch (e) { Logger.warn('onPreviewAdmin error (signal):', e.message); }
            }
            if (adminStatePoller.getStreamId() === streamId) {
                adminStatePoller.markFresh();
            }
        }
    }

    /**
     * Handle media message on preview channel (piece requests, file chunks, etc.)
     * Essential for P2P file transfers to work in preview mode
     * @private
     */
    _handlePreviewMedia(messageStreamId, msg, account) {
        if (!msg?.type && !(msg instanceof Uint8Array)) return;

        // Drop media from stale preview subscriptions.
        if (messageStreamId !== this.previewChannelId
            && messageStreamId !== this.activeChannelId
            && !channelManager.getChannel(messageStreamId)) {
            this._scheduleOrphanPreviewUnsub(messageStreamId);
            return;
        }

        Logger.debug('Preview media:', msg instanceof Uint8Array ? 'binary' : msg.type);
        
        // Forward to mediaController for processing
        // This enables piece_request handling, file_piece reception, etc.
        mediaController.handleMediaMessage(messageStreamId, msg, account);
    }

    /**
     * Schedule an unsubscribe for an orphan preview subscription detected
     * inside one of the streamId-bound handler closures. Deduped via
     * `_orphanPreviewSubs` so we issue at most one unsubscribe per
     * orphan even if it keeps producing history messages between
     * detection and the unsubscribe taking effect. Fire-and-forget —
     * errors are logged at debug since the sub is already orphan.
     * @param {string} messageStreamId
     * @private
     */
    _scheduleOrphanPreviewUnsub(messageStreamId) {
        if (!messageStreamId) return;
        if (this._orphanPreviewSubs.has(messageStreamId)) return;
        this._orphanPreviewSubs.add(messageStreamId);
        const ephemeralStreamId = (() => {
            try { return deriveEphemeralId(messageStreamId); } catch (_) { return null; }
        })();
        Logger.warn('Detected orphan preview subscription, unsubscribing:', messageStreamId);
        Promise.resolve().then(async () => {
            try {
                if (ephemeralStreamId) {
                    await streamrController.unsubscribeFromDualStream(messageStreamId, ephemeralStreamId);
                } else {
                    await streamrController.unsubscribe(messageStreamId);
                }
            } catch (e) {
                Logger.debug('Orphan preview unsubscribe failed:', e?.message || e);
            } finally {
                this._orphanPreviewSubs.delete(messageStreamId);
            }
        });
    }

    /**
     * Start presence broadcasting for preview channel
     * @private
     */
    _startPreviewPresence(messageStreamId, ephemeralStreamId) {
        // Stop any existing preview presence interval
        this._stopPreviewPresence();
        
        // Track consecutive failures to avoid spamming logs
        let consecutiveFailures = 0;
        const MAX_CONSECUTIVE_FAILURES = CONFIG.subscriptions.maxPresenceFailures;
        
        const publishPresence = async () => {
            if (this.previewChannelId !== messageStreamId) return;
            
            // If we've failed too many times, stop trying
            if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
                Logger.debug('Preview presence disabled after repeated failures');
                return;
            }
            
            const myAddress = authManager.getAddress();
            const myNickname = identityManager?.getUsername?.() || null;
            
            const presenceData = {
                type: 'presence',
                userId: myAddress,
                address: myAddress,
                nickname: myNickname,
                lastActive: Date.now()
            };
            
            try {
                await streamrController.publishControl(ephemeralStreamId, presenceData);
                consecutiveFailures = 0; // Reset on success
            } catch (e) {
                consecutiveFailures++;
                if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
                    Logger.warn('Stopping preview presence: too many failures');
                    this._stopPreviewPresence();
                } else {
                    Logger.debug(`Preview presence error (${consecutiveFailures}/${MAX_CONSECUTIVE_FAILURES}):`, e.message);
                }
            }
        };
        
        // Publish immediately
        publishPresence();
        
        // Then periodically (every 20 seconds)
        this.previewPresenceInterval = setInterval(publishPresence, CONFIG.subscriptions.previewPresenceIntervalMs);
    }

    /**
     * Stop presence broadcasting for preview channel
     * @private
     */
    _stopPreviewPresence() {
        if (this.previewPresenceInterval) {
            clearInterval(this.previewPresenceInterval);
            this.previewPresenceInterval = null;
        }
    }

    /**
     * Clear preview channel (unsubscribe without saving)
     */
    async clearPreviewChannel() {
        if (!this.previewChannelId) return;

        const streamId = this.previewChannelId;
        Logger.info('Clearing preview channel:', streamId);

        // NOTE: do NOT bump previewSwitchGeneration here. setPreviewChannel
        // calls clearPreviewChannel() before its awaits and would otherwise
        // self-invalidate (its own gen would mismatch after the clear).
        // Concurrent in-flight setPreviewChannel calls are handled by:
        //   1. The streamId-bound handler closures (drop stale messages).
        //   2. The post-subscribe gen check (orphan unsubscribe).
        //   3. setPreviewChannel claiming a new gen at entry.

        // Stop presence broadcasting
        this._stopPreviewPresence();

        // Stop admin-state polling for the preview channel — no live -3
        // subscription to drop in the resend-only model.
        try {
            if (adminStatePoller.getStreamId() === streamId) {
                adminStatePoller.stop();
            }
            memberCatchUp.stop(streamId);
        } catch (e) { /* ignore */ }

        try {
            const ephemeralStreamId = deriveEphemeralId(streamId);
            await streamrController.unsubscribeFromDualStream(streamId, ephemeralStreamId);
        } catch (error) {
            Logger.warn('Error unsubscribing from preview:', error.message);
        }

        // The -5 was subscribed beside the pair; a channel the user joins from
        // here re-subscribes it, so leaving it open would double-deliver.
        if (!channelManager.getChannel(streamId)) {
            try {
                await streamrController.unsubscribe(deriveInteractionsId(streamId));
            } catch (error) {
                Logger.debug('Preview interactions unsubscribe failed:', error.message);
            }
        }

        this.previewChannelId = null;
    }

    /**
     * Promote preview channel to active (after user joins)
     * OPTIMIZED: Keeps the existing subscription, handlers auto-forward to channelManager
     * @param {string} messageStreamId - The preview channel to promote
     */
    async promotePreviewToActive(messageStreamId) {
        if (this.previewChannelId !== messageStreamId) {
            Logger.warn('Cannot promote - not the current preview channel');
            return;
        }

        Logger.info('Promoting preview to active (keeping subscription):', messageStreamId);

        // Stop preview presence broadcasting
        this._stopPreviewPresence();

        // Stop the preview's admin-state poller — caller (PreviewModeUI)
        // re-bootstraps admin state through channelManager and the active
        // poller is started by setActiveChannel on the next selection. In
        // the resend-only model there is no live -3 subscription to drop.
        try {
            if (adminStatePoller.getStreamId() === messageStreamId) {
                adminStatePoller.stop();
            }
            memberCatchUp.stop(messageStreamId);
        } catch (e) { /* ignore */ }

        // Transfer state - keep MESSAGE subscription alive!
        // The preview handlers (_handlePreviewMessage, _handlePreviewEphemeral) 
        // automatically forward to channelManager when channel exists there
        this.activeChannelId = messageStreamId;
        this.previewChannelId = null;

        // Start the active-channel admin-state poller. The on-open snapshot
        // is fetched by the caller (PreviewModeUI.addPreviewToList) via
        // channelManager.bootstrapAdminState; the poller takes over for
        // periodic refresh and reacts to ADMIN_INVALIDATE signals.
        try {
            adminStatePoller.start(messageStreamId, () => channelManager.refreshAdminState(messageStreamId));
        } catch (e) {
            Logger.debug('Active admin poller start (after promote) failed (non-fatal):', e?.message || e);
        }

        Logger.debug('Preview promoted - subscription reused, handlers auto-forward');
    }

    /**
     * Re-read the preview's history over the subscriptions it already holds.
     *
     * Keys land after the first resend on a cold gated open, so what could not
     * be opened then has to be read again — over the subscriptions already
     * held, rendering once at the end.
     *
     * @param {string} messageStreamId - The preview to refresh
     */
    async refreshPreviewHistory(messageStreamId) {
        if (this.previewChannelId !== messageStreamId) return;
        const count = STREAM_CONFIG.INITIAL_MESSAGES;
        const reads = [
            [messageStreamId, STREAM_CONFIG.MESSAGE_STREAM.MESSAGES,
                (data) => this._handlePreviewMessage(messageStreamId, data)],
            [messageStreamId, STREAM_CONFIG.MESSAGE_STREAM.CONTROL,
                (data) => this._handlePreviewOverride(messageStreamId, data)],
            [deriveInteractionsId(messageStreamId), STREAM_CONFIG.INTERACTIONS_STREAM.REACTIONS,
                (data) => channelManager.handleControlMessage(messageStreamId, data)]
        ];
        for (const [streamId, partition, handler] of reads) {
            try {
                await streamrController.fetchHistoryAsync(
                    streamId, partition, count, handler, null, null, false, { quiet: true });
            } catch (e) {
                Logger.debug('preview refresh failed on', streamId.slice(-24), e?.message || e);
            }
            if (this.previewChannelId !== messageStreamId) return;
        }
        try { this._previewOnHistoryComplete?.(null); }
        catch (e) { Logger.warn('preview refresh render failed:', e?.message || e); }
    }

    /**
     * Check if currently in preview mode
     * @returns {boolean}
     */
    isInPreviewMode() {
        return this.previewChannelId !== null;
    }

    /**
     * Get the preview channel ID
     * @returns {string|null}
     */
    getPreviewChannelId() {
        return this.previewChannelId;
    }

    /**
     * Start background activity polling for all channels
     * Polls channels in batches to detect new messages without full subscriptions
     */
    startBackgroundPoller() {
        if (this.backgroundPoller) {
            Logger.debug('Background poller already running');
            return;
        }

        Logger.info('Starting background activity poller');
        
        // Initialize activity state for all channels
        this.initializeActivityState();

        // Start polling
        this.backgroundPoller = setInterval(async () => {
            await this.pollBackgroundChannels();
        }, this.config.POLL_INTERVAL);

        // Run first poll immediately (after short delay)
        setTimeout(() => this.pollBackgroundChannels(), CONFIG.subscriptions.initialPollDelayMs);
    }

    /**
     * Initialize activity tracking state from stored data
     * Uses messageStreamId as key (dual-stream architecture)
     */
    initializeActivityState() {
        const channels = channelManager.getAllChannels();
        const lastAccessMap = secureStorage.getAllChannelLastAccess();
        const now = Date.now();

        for (const channel of channels) {
            // Use messageStreamId as key (dual-stream)
            const messageStreamId = channel.messageStreamId || channel.streamId;
            
            if (!this.channelActivity.has(messageStreamId)) {
                // Get last access time for this channel
                const lastAccess = lastAccessMap[messageStreamId] || lastAccessMap[channel.streamId];
                
                // If user never accessed this channel, use current time as baseline
                // This prevents historical messages from being counted as "new"
                const lastMessageTime = lastAccess || now;
                
                this.channelActivity.set(messageStreamId, {
                    lastMessageTime,
                    unreadCount: 0,
                    lastChecked: 0
                });
            }
        }
    }

    /**
     * Poll background channels for new activity
     * Uses lightweight history fetch to check for new messages
     */
    async pollBackgroundChannels() {
        if (this.isPolling) {
            Logger.debug('Poll already in progress, skipping');
            return;
        }

        this.isPolling = true;

        try {
            const channels = channelManager.getAllChannels();
            // Filter out the active channel and DM channels
            // DM channels use E2E encryption and real-time inbox subscription,
            // not Streamr-level storage polling
            const backgroundChannels = channels.filter(c => {
                if (c.type === 'dm') return false;
                const channelMsgId = c.messageStreamId || c.streamId;
                return channelMsgId !== this.activeChannelId;
            });

            if (backgroundChannels.length === 0) {
                Logger.debug('No background channels to poll');
                return;
            }

            // Get batch of channels to poll this cycle (round-robin)
            const batchSize = Math.min(this.config.POLL_BATCH_SIZE, backgroundChannels.length);
            const channelsToPoll = [];

            for (let i = 0; i < batchSize; i++) {
                const idx = (this.pollIndex + i) % backgroundChannels.length;
                channelsToPoll.push(backgroundChannels[idx]);
            }

            this.pollIndex = (this.pollIndex + batchSize) % backgroundChannels.length;

            // Poll each channel in batch with stagger delay
            for (let i = 0; i < channelsToPoll.length; i++) {
                const channel = channelsToPoll[i];
                
                // Use messageStreamId as key (dual-stream architecture)
                const messageStreamId = channel.messageStreamId || channel.streamId;
                
                // Check if enough time has passed since last check
                const activity = this.channelActivity.get(messageStreamId);
                const timeSinceLastCheck = Date.now() - (activity?.lastChecked || 0);
                
                if (timeSinceLastCheck < this.config.MIN_POLL_INTERVAL) {
                    continue;
                }

                try {
                    await this.checkChannelActivity(channel);
                } catch (error) {
                    Logger.debug('Activity check failed for:', messageStreamId, error.message);
                }

                // Stagger delay between checks
                if (i < channelsToPoll.length - 1) {
                    await new Promise(r => setTimeout(r, this.config.POLL_STAGGER_DELAY));
                }
            }
        } finally {
            this.isPolling = false;
        }
    }

    /**
     * Check activity for a single channel without full subscription
     * In multiple-stream architecture, only queries MESSAGE stream (the one with storage)
     * @param {Object} channel - Channel object
     */
    async checkChannelActivity(channel) {
        // Use messageStreamId as the identifier (multiple-stream)
        const messageStreamId = channel.messageStreamId || channel.streamId;
        const password = channel.password || null;

        // Get current activity state
        // If no state exists, use current time as baseline to avoid false positives
        const currentActivity = this.channelActivity.get(messageStreamId) || {
            lastMessageTime: Date.now(),
            unreadCount: 0,
            lastChecked: 0
        };

        try {
            // Fetch only the N most recent stored messages via a `{ last: N }`
            // resend (fetchHistoryAsync). The previous implementation called
            // fetchOlderHistory(..., Date.now(), ...) which resends from
            // timestamp 0 — iterating and decrypting the ENTIRE stored history
            // of every background channel on every poll tick (O(history)).
            // Note: only messageStream has storage, so we can only query it.
            const messages = [];
            await streamrController.fetchHistoryAsync(
                messageStreamId,
                STREAM_CONFIG.MESSAGE_STREAM.MESSAGES, // partition 0
                this.config.ACTIVITY_CHECK_MESSAGES,
                (msg) => { messages.push(msg); },
                password,
                null,   // onHistoryComplete
                false,  // allowOverridesInContentPartition
                { quiet: true }
            );

            // Count only content messages for unread/background activity.
            // P0 may include reactions, so filter them out explicitly.
            const isContentMessage = (msg) => {
                if (!msg) return false;
                if (msg._deleted) return false;
                const type = msg.type;
                if (type === 'reaction' || type === 'edit' || type === 'delete') return false;
                if (type === 'image' && msg.imageId) return true;
                if (type === 'file_announce' && msg.metadata) return true;
                if (type === 'storage_file_announce' && msg.metadata) return true;
                if (type === 'text' || type === 'message') return true;
                if (!type && msg.id && msg.text && msg.sender && msg.timestamp) return true;
                return false;
            };

            let newCount = 0;
            let latestTime = currentActivity.lastMessageTime;
            let latestPreviewCandidate = null;

            for (const msg of messages) {
                const msgTimestamp = Number(msg?.timestamp || msg?._timestamp || 0) || 0;
                if (!msgTimestamp || msgTimestamp <= currentActivity.lastMessageTime) {
                    continue;
                }

                // Advance watermark for any newer observed item to avoid reprocessing loops.
                if (msgTimestamp > latestTime) {
                    latestTime = msgTimestamp;
                }

                if (isContentMessage(msg)) {
                    newCount++;
                    if (!latestPreviewCandidate || msgTimestamp > (Number(latestPreviewCandidate.timestamp || latestPreviewCandidate._timestamp || 0) || 0)) {
                        latestPreviewCandidate = msg;
                    }
                }
            }

            // Update activity state
            const newActivity = {
                lastMessageTime: latestTime,
                unreadCount: currentActivity.unreadCount + newCount,
                lastChecked: Date.now()
            };
            this.channelActivity.set(messageStreamId, newActivity);

            // Notify handlers if new messages detected
            if (newCount > 0) {
                if (latestPreviewCandidate) {
                    channelLatestMessageManager.setFromLocal(messageStreamId, {
                        ...latestPreviewCandidate,
                        sender: latestPreviewCandidate.sender
                            || latestPreviewCandidate.account
                            || latestPreviewCandidate._publisherId
                            || null,
                        timestamp: latestPreviewCandidate.timestamp
                            || latestPreviewCandidate._timestamp
                            || latestTime
                    });
                }
                Logger.debug('New activity detected:', messageStreamId, newCount, 'messages');
                this.notifyActivityHandlers(messageStreamId, newActivity);
            }

        } catch (error) {
            // Update lastChecked even on error to prevent rapid retries
            currentActivity.lastChecked = Date.now();
            this.channelActivity.set(messageStreamId, currentActivity);
            throw error;
        }
    }

    /**
     * Register handler for activity changes
     * @param {Function} handler - Callback (streamId, activity) => void
     */
    onActivity(handler) {
        if (typeof handler === 'function') {
            this.activityHandlers.push(handler);
        }
    }

    /**
     * Remove activity handler
     * @param {Function} handler - Handler to remove
     */
    offActivity(handler) {
        this.activityHandlers = this.activityHandlers.filter(h => h !== handler);
    }

    /**
     * Notify all activity handlers
     * @param {string} streamId - Channel stream ID
     * @param {Object} activity - Activity data
     */
    notifyActivityHandlers(streamId, activity) {
        for (const handler of this.activityHandlers) {
            try {
                handler(streamId, activity);
            } catch (error) {
                Logger.warn('Activity handler error:', error);
            }
        }
    }

    /**
     * Get activity state for a channel
     * @param {string} streamId - Stream ID
     * @returns {Object|null} - Activity data or null
     */
    getChannelActivity(streamId) {
        return this.channelActivity.get(streamId) || null;
    }

    /**
     * Get unread count for a channel
     * @param {string} streamId - Stream ID
     * @returns {number} - Unread message count
     */
    getUnreadCount(streamId) {
        const activity = this.channelActivity.get(streamId);
        return activity?.unreadCount || 0;
    }

    /**
     * Clear unread count for a channel (when user opens it)
     * @param {string} streamId - Stream ID
     */
    clearUnreadCount(streamId) {
        const activity = this.channelActivity.get(streamId);
        if (activity) {
            activity.unreadCount = 0;
            this.channelActivity.set(streamId, activity);
        }
    }

    /**
     * Remove a channel from tracking (when leaving or deleting)
     * @param {string} messageStreamId - Message Stream ID (channel key)
     */
    async removeChannel(messageStreamId) {
        Logger.debug('Removing channel from subscription manager:', messageStreamId);
        
        // Clear from activity tracking (keyed by messageStreamId)
        this.channelActivity.delete(messageStreamId);
        
        // If this was the active channel, clear it
        if (this.activeChannelId === messageStreamId) {
            this.activeChannelId = null;
        }
        
        // Clear lastOpenedChannel if it points to this channel
        const lastOpened = secureStorage.getLastOpenedChannel();
        if (lastOpened === messageStreamId) {
            await secureStorage.setLastOpenedChannel(null);
        }
    }

    /**
     * Stop background polling
     */
    stopBackgroundPoller() {
        if (this.backgroundPoller) {
            clearInterval(this.backgroundPoller);
            this.backgroundPoller = null;
            Logger.debug('Background poller stopped');
        }
    }

    /**
     * Full cleanup - stop polling and clear all state
     */
    async cleanup() {
        Logger.info('Subscription manager cleanup');
        
        // Stop background polling
        this.stopBackgroundPoller();
        
        // Clear preview channel
        if (this.previewChannelId) {
            await this.clearPreviewChannel();
        }
        
        // Clear active channel
        this.activeChannelId = null;
        
        // Clear activity state
        this.channelActivity.clear();
        this.pollIndex = 0;
        this.isPolling = false;
        
        // Clear handlers
        this.activityHandlers = [];
    }

    /**
     * Check if a channel is currently the active channel
     * @param {string} streamId - Stream ID to check (messageStreamId)
     * @returns {boolean}
     */
    isActiveChannel(streamId) {
        return this.activeChannelId === streamId;
    }

    /**
     * Get the active channel ID (messageStreamId)
     * @returns {string|null}
     */
    getActiveChannelId() {
        return this.activeChannelId;
    }

    /**
     * Force poll a specific channel immediately
     * Useful when user hovers over channel in sidebar
     * @param {string} messageStreamId - Message Stream ID to poll
     */
    async forcePollChannel(messageStreamId) {
        const channel = channelManager.getChannel(messageStreamId);
        if (!channel || messageStreamId === this.activeChannelId) {
            return;
        }

        try {
            await this.checkChannelActivity(channel);
        } catch (error) {
            Logger.debug('Force poll failed:', messageStreamId, error.message);
        }
    }

    /**
     * Update configuration
     * @param {Object} newConfig - New configuration values
     */
    updateConfig(newConfig) {
        this.config = { ...this.config, ...newConfig };
        Logger.debug('Subscription manager config updated:', this.config);
    }
}

// Export singleton instance
export const subscriptionManager = new SubscriptionManager();
