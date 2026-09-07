/**
 * PreviewModeUI - Handles channel preview mode functionality
 * Allows users to view channels before joining them
 */

import { Logger } from '../logger.js';
import { authManager } from '../auth.js';
import { STREAM_CONFIG } from '../streamr.js';
import { deriveKeysId, deriveInteractionsId } from '../streamConstants.js';
import { mediaController } from '../media.js';
import { secureStorage } from '../secureStorage.js';
import { CONFIG } from '../config.js';
import { escapeAttr } from './utils.js';

class PreviewModeUI {
    constructor() {
        // Preview channel state
        this.previewChannel = null;

        // Switch fence — incremented on every preview enter/exit so async
        // work captured during a previous preview can detect that it has
        // been superseded and bail before mutating state, mirroring
        // channelManager.switchGeneration for joined channels. Prevents
        // cross-channel message leaks when the user clicks rapidly through
        // multiple Explore items.
        this.previewGeneration = 0;

        // Re-entrancy guard for the chunked-image recovery loop.
        // _recoverIncompletePreviewImages itself calls loadMorePreviewHistory,
        // and loadMorePreviewHistory now re-triggers recovery when scroll
        // pagination uncovers new manifests. Without this flag we would
        // recurse infinitely.
        this._recoveryInFlight = false;

        // Per-imageId set of image ids already marked as "unavailable" so
        // we don't repeatedly rewrite their DOM placeholders.
        this._expiredImageIds = new Set();
        
        // Dependencies (set via setDependencies)
        this.deps = null;
        
        // UI Controller callbacks (set via setUIController)
        this.ui = null;
    }

    /**
     * Set module dependencies
     * @param {Object} deps - Dependencies object
     */
    setDependencies(deps) {
        this.deps = deps;
    }

    /**
     * Set UI Controller references
     * @param {Object} ui - UI Controller callbacks and references
     */
    setUIController(ui) {
        this.ui = ui;
    }

    /**
     * Check if currently in preview mode
     * @returns {boolean}
     */
    isInPreviewMode() {
        return this.previewChannel !== null;
    }

    /**
     * Get current preview channel
     * @returns {Object|null}
     */
    getPreviewChannel() {
        return this.previewChannel;
    }

    /**
     * Enter preview mode for a channel (view without adding to list)
     * For public/open channels - allows users to try before committing
     * @param {string} streamId - Channel stream ID
     * @param {Object} channelInfo - Channel metadata
     */
    async enterPreviewMode(streamId, channelInfo = null) {
        // Check if channel is already in user's list
        if (this.deps.channelManager.getChannel(streamId)) {
            // Already joined - just select it normally
            await this.ui.selectChannel(streamId);
            return;
        }
        await this._enterPreviewCore(streamId, channelInfo, true);
    }

    /**
     * Enter preview mode without pushing to history (for popstate handling)
     * @param {string} streamId - Channel stream ID
     * @param {Object} channelInfo - Channel metadata
     */
    async enterPreviewWithoutHistory(streamId, channelInfo) {
        if (this.deps.channelManager.getChannel(streamId)) {
            await this.ui.selectChannelWithoutHistory(streamId);
            return;
        }
        await this._enterPreviewCore(streamId, channelInfo, false);
    }

    /**
     * Core preview mode logic
     * @param {string} streamId - Channel stream ID  
     * @param {Object} channelInfo - Channel metadata (optional)
     * @param {boolean} pushHistory - Whether to push to browser history
     * @private
     */
    async _enterPreviewCore(streamId, channelInfo, pushHistory) {
        const { channelManager, subscriptionManager, graphAPI, notificationUI, historyManager, headerUI, reactionManager } = this.deps;
        const elements = this.ui.elements;

        // Claim this switch. Any previous preview's in-flight async work
        // (verify, admin resend, subscribe) will see gen !== previewGeneration
        // after their awaits and bail out without touching UI/state.
        const gen = ++this.previewGeneration;

        try {
            // Exit any existing preview first (only one preview at a time).
            // Use the internal teardown so it does NOT bump generation again
            // — we already claimed `gen` for this enter call.
            if (this.previewChannel) {
                this.cancelPendingPreviewVerifications(this.previewChannel);
                await this._teardownPreview(false);
                if (gen !== this.previewGeneration) return;
            }

            // Clear current channel selection (preview is not a "real" selection)
            channelManager.setCurrentChannel(null);

            // Clear stale reactions from any previously viewed channel
            reactionManager.loadFromChannelState({});

            notificationUI.showLoadingToast('Loading channel...', 'Connecting to stream');

            // If no channelInfo, try to fetch from The Graph
            if (!channelInfo) {
                try {
                    channelInfo = await graphAPI.getChannelInfo(streamId);
                } catch (e) {
                    Logger.warn('Could not get channel info from Graph:', e.message);
                }
                if (gen !== this.previewGeneration) return;
            }

            // Gated preview (N-D): a TOKEN/NFT holder browsing before
            // committing needs the FULL gated context — the gate drives the
            // erc1271 subscribe/transport and the -4 is where epoch keys
            // come from. Without it the open dies on the SDK's subscribe guard.
            const gatedPreview = channelInfo?.type === 'gated' && channelInfo?.gateAddress
                ? {
                    gate: { address: channelInfo.gateAddress },
                    keysStreamId: deriveKeysId(streamId),
                    members: []
                } : null;

            // Store preview state
            this.previewChannel = {
                streamId,
                // Mirror messageStreamId so channelManager.applyAdminState() can be reused
                messageStreamId: streamId,
                preview: true,
                channelInfo,
                name: this._getChannelDisplayName(streamId, channelInfo),
                type: channelInfo?.type || 'public',
                readOnly: channelInfo?.readOnly || false,
                // Without the mode a Sealed channel is previewed as Visible, and
                // what is published from here goes out unreadable.
                wireIdentity: channelInfo?.wireIdentity || null,
                // Reactions ride the -5, in a preview as anywhere else.
                interactionsStreamId: deriveInteractionsId(streamId),
                ...(gatedPreview || {}),
                password: null, // Preview mode doesn't have password (public channels only)
                // Admin/moderation layer (rebuilt on subscribe to -3/P0)
                createdBy: channelInfo?.createdBy || streamId.split('/')[0] || null,
                adminState: { bannedMembers: [], hiddenMessageIds: [], pins: [] },
                adminRev: 0,
                adminTs: 0,
                adminLoaded: false,
                messages: [],
                _pendingOverrides: new Map(),
                // In-flight dedup: ids currently being verified/pushed.
                // Prevents races when the same message arrives via both the
                // real-time websocket subscription and the HTTP resend, or via
                // concurrent resend + loadMore fetches.
                _processingIds: new Set(),
                initialLoadInProgress: true
            };

            // Capture the just-created preview as the "owner" closure for
            // the onHistoryComplete callback so a stale callback fired by
            // an old subscription cannot mutate a newer preview's state.
            const ownerChannel = this.previewChannel;

            if (gatedPreview) {
                // Shadow registration: _gatedChannelFor and the epoch refresh
                // resolve channels through channelManager, and a preview lives
                // outside the map — this is what lights the gated paths up.
                channelManager.previewChannel = ownerChannel;

                // Explore does not always carry the mode, so the gate settles it
                // before anything is published or read here. Awaited: the same
                // read carries the read-only flag the reader cut needs.
                ownerChannel._wireIdentityGuessed = true;
                try {
                    await channelManager.ensureGateAuthority(ownerChannel);
                } catch (e) {
                    Logger.debug('preview: gate authority unresolved:', e?.message || e);
                }
                if (gen !== this.previewGeneration) return;
                const { streamrController } = await import('../streamr.js');
                const { epochKeyManager } = await import('../epochKeyManager.js');
                await streamrController.subscribeToKeysStream(
                    ownerChannel.keysStreamId,
                    (data, publisherId, timestamp) =>
                        epochKeyManager.handleKeysMessage(ownerChannel, data, publisherId, timestamp));
                await epochKeyManager.ensureChannelKeys(ownerChannel);
                if (gen !== this.previewGeneration) return;
                // First visit: the wraps land AFTER the resend below (N-B rank
                // delay), so what could not be opened then is read again once
                // the key is in — over the same subscriptions.
                epochKeyManager.onKeyAdopted(streamId, () => {
                    if (this.previewChannel !== ownerChannel) return;
                    clearTimeout(this._previewKeyRefreshTimer);
                    this._previewKeyRefreshTimer = setTimeout(() => {
                        if (this.previewChannel !== ownerChannel) return;
                        subscriptionManager.refreshPreviewHistory(streamId).catch(() => {});
                    }, 1500);
                });
            }

            // Subscribe to channel stream temporarily (without persisting)
            await subscriptionManager.setPreviewChannel(streamId, () => {
                // ownerChannel identity check is sufficient: every code path
                // that replaces `previewChannel` also bumps previewGeneration.
                if (this.previewChannel !== ownerChannel) return;
                this._applyPreviewOverrides();
                ownerChannel.messages = ownerChannel.messages.filter(m => !m._deleted);
                ownerChannel.initialLoadInProgress = false;
                const { chatAreaUI, mediaHandler } = this.deps;
                chatAreaUI.renderMessages(ownerChannel.messages, () => {
                    this.ui.attachReactionListeners();
                    mediaHandler.attachLightboxListeners();
                });
                // Auto-paginate older history if any chunked-image manifest is
                // still missing chunks (each image upload publishes N chunks
                // + 1 manifest, so older images can leave the initial resend
                // window with their chunks truncated). Without this, multiple
                // GIFs/images stay stuck on "Loading…" until the user scrolls.
                this._recoverIncompletePreviewImages(ownerChannel).catch(err => {
                    Logger.debug('preview: recoverIncompleteImages failed:', err?.message || err);
                });
            });
            if (this.previewChannel !== ownerChannel) return;

            // Update UI for preview mode
            this._showPreviewUI(ownerChannel);
            
            // Check actual publish permission via SDK and update header accordingly
            this._checkAndUpdateReadOnlyState();

            // Mobile: navigate to chat view
            this.ui.openChatView();
            
            // Push to browser history if requested
            if (pushHistory) {
                const currentState = window.history.state;
                if (currentState?.view === 'preview' || currentState?.view === 'channel') {
                    historyManager.replaceState({ view: 'preview', streamId });
                } else {
                    historyManager.pushState({ view: 'preview', streamId });
                }
            }

            Logger.info('Entered preview mode for:', streamId);
        } catch (error) {
            // Only clear state if we are still the active switch — otherwise
            // a newer enter call already owns `previewChannel` and we must
            // not touch it.
            if (gen === this.previewGeneration) {
                this.previewChannel = null;
            }
            Logger.error('Failed to enter preview mode:', error);
            this.ui.showNotification('Failed to load channel: ' + error.message, 'error');
        } finally {
            notificationUI.hideLoadingToast();
        }
    }

    /**
     * Get display name for a channel, with fallbacks
     * @param {string} streamId - Channel stream ID
     * @param {Object} channelInfo - Channel metadata (optional)
     * @returns {string} - Display name
     * @private
     */
    _getChannelDisplayName(streamId, channelInfo) {
        // Use explicit name if set, or displayName from Graph, or extract from streamId
        if (channelInfo?.name) return channelInfo.name;
        if (channelInfo?.displayName) return channelInfo.displayName;
        // Extract name from streamId (format: address/name-N)
        const namePart = streamId.split('/')[1];
        if (namePart) {
            return namePart.replace(/-\d$/, '');
        }
        return streamId;
    }

    /**
     * Update UI to show preview mode state
     * @param {Object} [ownerChannel] - Preview channel snapshot owning this UI update.
     *   Used by the deferred empty-state setTimeout to detect rapid switches
     *   and skip the DOM mutation if a different preview now owns the area.
     * @private
     */
    _showPreviewUI(ownerChannel = this.previewChannel) {
        if (!this.previewChannel) return;

        const elements = this.ui.elements;
        const { headerUI } = this.deps;

        // Leave Explore here rather than when the tap arrives: entering a
        // preview subscribes and fetches first, and dropping the class up
        // there left the Explore list on screen without the layout rules it
        // is built on, under a header still captioned Explore.
        document.body.classList.remove('explore-open', 'explore-header-retracted');

        // The spinner belongs to the load, not over a conversation that is
        // already in: this runs after the subscribe whose callback renders.
        if (!ownerChannel.initialLoadInProgress && ownerChannel.messages?.length) {
            const { chatAreaUI, mediaHandler } = this.deps;
            chatAreaUI.renderMessages(ownerChannel.messages, () => {
                this.ui.attachReactionListeners();
                mediaHandler.attachLightboxListeners();
            });
        } else {
            elements.messagesArea.innerHTML = `
                <div class="flex flex-col items-center justify-center h-full text-white/40">
                    <div class="spinner mb-3" style="width: 24px; height: 24px;"></div>
                    <span class="text-sm">Loading messages...</span>
                </div>
            `;
        }
        elements.messagesArea?.classList.add('p-4');
        
        // Set a flag to track if we're still loading
        this.previewChannel.isLoading = true;
        
        // After a short delay, if still no messages, show empty state
        setTimeout(() => {
            // Bail if a different preview now owns the UI (rapid switch
            // between Explore items would otherwise stomp the new
            // channel's messages area with the previous channel's empty
            // state placeholder).
            if (this.previewChannel !== ownerChannel) return;
            if (ownerChannel.isLoading && ownerChannel.messages.length === 0) {
                ownerChannel.isLoading = false;
                elements.messagesArea.innerHTML = `
                    <div class="flex items-center justify-center h-full text-white/40">
                        No messages yet. Start the conversation!
                    </div>
                `;
            }
        }, 20000); // 20 seconds timeout

        // Update header
        elements.currentChannelName.textContent = this.previewChannel.name;
        elements.currentChannelInfo.innerHTML = headerUI.getChannelTypeLabel(this.previewChannel.type, this.previewChannel.readOnly);
        elements.currentChannelInfo.parentElement.classList.remove('hidden');
        headerUI.updateChannelThumb(this.previewChannel);

        // Show message input (full functionality in preview) — except on an
        // announcements channel, where the network refuses a reader's publish
        // and the send would fail where nobody sees it.
        const previewOwner = (this.previewChannel.createdBy
            || this.previewChannel.streamId?.split('/')[0] || '').toLowerCase();
        const mayWriteHere = !this.previewChannel.readOnly
            || (authManager.getAddress() || '').toLowerCase() === previewOwner;
        elements.messageInputContainer.classList.toggle('hidden', !mayWriteHere);

        // Hide explore type tabs
        elements.exploreTypeTabs?.classList.add('hidden');

        // Restore right header buttons
        elements.chatHeaderRight?.classList.remove('hidden');

        // Show JOIN button, hide INVITE button
        elements.joinChannelBtn?.classList.remove('hidden');
        elements.inviteUsersBtn?.classList.add('hidden');

        // Show channel menu button
        if (elements.channelMenuBtn) {
            elements.channelMenuBtn.classList.remove('hidden');
        }
        if (elements.channelMenuBtnMobile) {
            elements.channelMenuBtnMobile.classList.remove('hidden');
        }

        // Show close channel buttons
        if (elements.closeChannelBtn) {
            elements.closeChannelBtn.classList.remove('hidden');
        }
        if (elements.closeChannelBtnDesktop) {
            elements.closeChannelBtnDesktop.classList.remove('hidden');
        }

        // Show online users container
        elements.onlineHeader?.classList.remove('hidden');
        elements.onlineHeader?.classList.add('flex');
        elements.onlineSeparator?.classList.remove('hidden');
    }

    /**
     * Check publish permission via SDK and update header read-only indicator
     * Called after preview UI is shown to provide accurate permission state
     * @private
     */
    async _checkAndUpdateReadOnlyState() {
        if (!this.previewChannel) return;
        
        const { streamrController, headerUI } = this.deps;
        const elements = this.ui.elements;
        // Capture the owner snapshot up-front so a switch during the
        // permission RPC cannot apply state to a different channel.
        const ownerChannel = this.previewChannel;
        
        try {
            const result = await streamrController.hasPublishPermission(ownerChannel.streamId, true);
            
            // Bail if a rapid switch invalidated this preview while the
            // permission check was in flight.
            if (this.previewChannel !== ownerChannel) return;

            // Handle RPC error - don't mark as read-only when we can't verify
            if (result.rpcError) {
                Logger.warn('RPC error checking permissions, keeping optimistic state');
                // For public channels, assume user can publish (optimistic)
                // Server will reject if actually not allowed
                return;
            }
            
            const canPublish = result.hasPermission;
            
            // Update effective read-only: either channel is marked read-only OR user cannot publish
            const effectiveReadOnly = !canPublish || this.previewChannel.readOnly;
            this.previewChannel.effectiveReadOnly = effectiveReadOnly;
            
            // Update header label
            if (elements.currentChannelInfo) {
                elements.currentChannelInfo.innerHTML = headerUI.getChannelTypeLabel(
                    this.previewChannel.type, 
                    effectiveReadOnly
                );
            }
            
            // Update input state
            if (!canPublish) {
                const messageInput = elements.messageInput;
                const sendBtn = document.querySelector('#send-btn');
                elements.messageInputContainer?.classList.add('hidden');
                if (messageInput) {
                    messageInput.disabled = true;
                    messageInput.placeholder = 'This channel is read-only';
                    messageInput.classList.add('cursor-not-allowed', 'opacity-50');
                }
                if (sendBtn) {
                    sendBtn.disabled = true;
                    sendBtn.classList.add('opacity-50', 'cursor-not-allowed');
                }
            }
            
            Logger.debug('Preview permission check:', {
                streamId: this.previewChannel.streamId,
                canPublish,
                effectiveReadOnly
            });
        } catch (error) {
            Logger.warn('Failed to check preview permissions:', error.message);
        }
    }

    /**
     * Add preview channel to user's list (convert preview to joined)
     */
    async addPreviewToList() {
        if (!this.previewChannel) {
            Logger.warn('No preview channel to add');
            return;
        }

        const { channelManager, subscriptionManager, reactionManager, notificationUI } = this.deps;

        try {
            const { streamId, channelInfo, name, type, readOnly, messages, adminState, adminRev, adminTs, adminLoaded } = this.previewChannel;
            // Capture pending overrides so any P1 edit/delete that arrived
            // in preview but whose target P0 message hasn't been ingested
            // yet (slow network: verify in flight or message still pending)
            // is preserved across the promote. Without this transfer, late
            // P0 messages routed via the reused subscription would land in
            // channelManager without their override and reappear on screen.
            const pendingOverrides = this.previewChannel._pendingOverrides instanceof Map
                ? this.previewChannel._pendingOverrides
                : null;

            notificationUI.showLoadingToast('Joining channel...', 'Saving channel...');

            // Use fast path - channel already subscribed via preview
            await channelManager.persistChannelFromPreview(streamId, {
                name: name,
                type: type,
                readOnly: readOnly,
                gateAddress: this.previewChannel.gate?.address
                    || channelInfo?.gateAddress || null,
                // The mode the preview settled against the gate: without it the
                // joined record would guess, and publishing cannot guess.
                wireIdentity: this.previewChannel.wireIdentity || null,
                createdBy: channelInfo?.createdBy,
                messages: messages || [],
                reactions: reactionManager.exportAsObject(),
                oldestTimestamp: this.previewChannel.oldestTimestamp || null,
                // Carry over moderation layer so pins / bans / hidden ids
                // stay visible across the preview→joined transition.
                adminState,
                adminRev,
                adminTs,
                adminLoaded,
                pendingOverrides
            });

            // Clear preview state. The gated shadow goes with it — the
            // channel now lives in the real map, which every lookup prefers.
            // The -4 subscription deliberately survives the promote.
            const previewStreamId = streamId;
            if (channelManager.previewChannel === this.previewChannel) {
                channelManager.previewChannel = null;
            }
            clearTimeout(this._previewKeyRefreshTimer);
            this.previewChannel = null;

            // Transfer subscription handlers from preview to channelManager
            // (also unsubscribes the admin stream so we can rewire it below).
            await subscriptionManager.promotePreviewToActive(previewStreamId);

            // Re-bootstrap admin stream against channelManager so live
            // ADMIN_STATE updates after Join keep flowing into the joined
            // channel. Best-effort — pin/ban state already carried over via
            // persistChannelFromPreview, so failure here doesn't lose UI.
            try {
                const joined = channelManager.getChannel(previewStreamId);
                if (joined?.adminStreamId) {
                    await channelManager.bootstrapAdminState(
                        previewStreamId,
                        joined.adminStreamId,
                        joined.password || null
                    );
                }
            } catch (e) {
                Logger.warn('Post-join admin bootstrap failed:', e.message);
            }

            // Update UI - hide Join, show Invite
            this.ui.elements.joinChannelBtn?.classList.add('hidden');
            this.ui.elements.inviteUsersBtn?.classList.remove('hidden');

            // Update channel list in sidebar
            this.ui.renderChannelList();

            // Select the now-joined channel
            await this.ui.selectChannel(previewStreamId);

            this.ui.showNotification('Joined channel successfully!', 'success');
            Logger.info('Preview channel added to list:', previewStreamId);
        } catch (error) {
            Logger.error('Failed to add preview to list:', error);
            this.ui.showNotification('Failed to add channel: ' + error.message, 'error');
        } finally {
            notificationUI.hideLoadingToast();
        }
    }

    /**
     * Exit preview mode and return to Explore
     * @param {boolean} navigateToExplore - Whether to navigate back to Explore view (default: true)
     */
    async exitPreviewMode(navigateToExplore = true) {
        if (!this.previewChannel) return;
        // Bump generation so any in-flight async work for this preview
        // (verifyMessage, _checkAndUpdateReadOnlyState, deferred timeouts)
        // detects it has been superseded after their awaits and bails.
        this.previewGeneration++;
        this.cancelPendingPreviewVerifications(this.previewChannel);
        return this._teardownPreview(navigateToExplore);
    }

    /**
     * Cancel pending in-flight verifications for a preview channel.
     * Mirrors channelManager.cancelPendingVerifications: the actual async
     * verifyMessage promises remain in flight (we cannot abort them) but
     * downstream consumers gate on `_processingIds` and the previewGeneration
     * fence, so clearing the set + bumping the generation invalidates them.
     * Logs the discarded count for parity with the joined-channel path.
     * @param {Object} channel - Preview channel to cancel verifications for
     */
    cancelPendingPreviewVerifications(channel) {
        if (!channel?._processingIds) return;
        const discarded = channel._processingIds.size;
        channel._processingIds.clear();
        if (discarded > 0) {
            Logger.debug(`Cancelled ${discarded} pending preview verifications for`,
                String(channel.streamId || '').slice(-20));
        }
    }

    /**
     * Internal teardown of preview state without bumping the generation.
     * Used both by `exitPreviewMode` (which bumps externally) and by
     * `_enterPreviewCore` when transitioning from one preview to another
     * (the enter call has already claimed the new generation; teardown
     * must not invalidate the new switch).
     * @param {boolean} navigateToExplore
     * @private
     */
    async _teardownPreview(navigateToExplore = true) {
        if (!this.previewChannel) return;

        const { subscriptionManager, reactionManager } = this.deps;

        try {
            const streamId = this.previewChannel.streamId;

            // Unsubscribe from preview channel
            await subscriptionManager.clearPreviewChannel();

            // Gated preview: drop the -4 subscription and the shadow
            // registration. The epoch keys themselves persist — they are
            // the member's, and joining later reuses them.
            if (this.previewChannel.keysStreamId) {
                clearTimeout(this._previewKeyRefreshTimer);
                const { streamrController } = await import('../streamr.js');
                try { await streamrController.unsubscribe(this.previewChannel.keysStreamId); }
                catch { /* not subscribed */ }
            }
            if (this.deps.channelManager.previewChannel === this.previewChannel) {
                this.deps.channelManager.previewChannel = null;
            }

            // Clear preview state
            this.previewChannel = null;

            // Reset any stuck loading indicator from preview history loading
            const { chatAreaUI } = this.deps;
            if (chatAreaUI) {
                // Setter cancels active op (clears watchdog + token-tagged spinner)
                chatAreaUI.isLoadingMore = false;
                chatAreaUI._cancelPendingAutoLoad?.();
                chatAreaUI.hideLoadingMoreIndicator();
            }

            // Clear stale reactions from the previewed channel
            reactionManager.loadFromChannelState({});

            // Hide Join button
            this.ui.elements.joinChannelBtn?.classList.add('hidden');

            Logger.info('Exited preview mode for:', streamId);

            // Navigate back to Explore if requested
            if (navigateToExplore) {
                await this.ui.openExploreView();
            }
        } catch (error) {
            Logger.error('Error exiting preview mode:', error);
            this.previewChannel = null;
        }
    }

    /**
     * Handle ADMIN_STATE message received on the preview channel's -3/P0 stream.
     * Reuses channelManager.applyAdminState() so the latest-wins logic
     * (rev + ts tiebreaker) and validation remain in one place.
     * Triggers a re-render so banned/hidden messages disappear immediately.
     * @param {string} streamId - Preview channel streamId
     * @param {Object} adminMsg - Decoded ADMIN_STATE payload
     */
    handlePreviewAdmin(streamId, adminMsg) {
        if (!this.previewChannel || this.previewChannel.streamId !== streamId) return;
        const { channelManager, chatAreaUI } = this.deps;
        if (!channelManager?.applyAdminState) return;
        const applied = channelManager.applyAdminState(this.previewChannel, adminMsg);
        if (!applied) return;
        // Re-render preview timeline to drop banned/hidden messages, unless
        // the initial load is still running: the conversation is painted once,
        // at the end, with every override already applied.
        if (chatAreaUI?.renderMessages && !this.previewChannel.initialLoadInProgress) {
            chatAreaUI.renderMessages(this.previewChannel.messages, () => {
                this.ui?.attachReactionListeners?.();
                this.deps.mediaHandler?.attachLightboxListeners?.();
            });
        }
    }

    /**
     * Handle message received in preview mode
     * @param {Object} message - Message object
     */
    /**
     * The reader cut a joined channel applies (MessageFlow: read-only drops
     * member-authored messages), for the preview's two ingest paths — the
     * subscription and the older-history pagination. What a preview lets in is
     * copied into the channel record at join, where nothing judges it again.
     *
     * @param {Object} channel - The preview channel
     * @param {string} sender - The message's author
     * @returns {Promise<boolean>} false when the reader must drop it
     */
    async _readOnlyAllows(channel, sender) {
        if (!channel?.gate?.address || !channel.readOnly) return true;
        const author = String(sender || '').toLowerCase();
        if (!author) return true;
        const ownerAddr = (channel.createdBy
            || channel.messageStreamId?.split('/')[0] || '').toLowerCase();
        if (author === ownerAddr) return true;
        const { gateManager } = await import('../gate.js');
        return gateManager._isModerator(channel.gate.address, author).catch(() => false);
    }

    async handlePreviewMessage(message) {
        if (!this.previewChannel) return;

        const { reactionManager, identityManager, chatAreaUI, mediaHandler } = this.deps;

        // Filter out non-content messages (presence, typing)
        if (message?.type === 'presence' || message?.type === 'typing') {
            return;
        }

        // Handle reactions in preview mode
        if (message?.type === 'reaction') {
            const reactionUser = message.user || message.account;
            if (!reactionUser) return;
            reactionManager.handleIncomingReaction(
                message.messageId,
                message.emoji,
                reactionUser,
                message.action || 'add'
            );
            return;
        }

        // Validate message has required properties
        const isTextMessage = message?.text;
        const isImageMessage = message?.type === 'image' && message?.imageId;
        const isVideoMessage = (message?.type === 'file_announce' || message?.type === 'storage_file_announce') && message?.metadata;

        if (!message?.id || !message?.sender || !message?.timestamp) {
            return;
        }

        const previewOwner = this.previewChannel;
        if (!await this._readOnlyAllows(previewOwner, message.sender)) return;
        if (this.previewChannel !== previewOwner) return;

        if (!isTextMessage && !isImageMessage && !isVideoMessage) {
            Logger.debug('Preview: Unknown message type, skipping:', message?.type);
            return;
        }

        // Deduplication: skip if message already exists OR is currently being
        // processed by a concurrent handler invocation (prevents races between
        // realtime websocket delivery and HTTP resend iterator, which can both
        // call this handler for the same message id).
        if (this.previewChannel._processingIds.has(message.id)) {
            Logger.debug('Preview: Message already being processed, skipping:', message.id);
            return;
        }
        const exists = this.previewChannel.messages.some(m => m.id === message.id);
        if (exists) {
            Logger.debug('Preview: Message already exists, skipping:', message.id);
            return;
        }

        // Snapshot owner channel: rapid-switch protection. Without this,
        // a stale message from a previous Explore preview could be pushed
        // into the new preview's array after the async verify completes —
        // exactly the cross-channel leak that
        // channelManager.cancelPendingVerifications guards against for
        // joined channels. Identity check is sufficient because every
        // path that replaces `previewChannel` also bumps generation.
        const ownerChannel = this.previewChannel;
        ownerChannel._processingIds.add(message.id);

        try {
            Logger.debug('Preview message received:', message.id, message.text?.slice(0, 30));

            // Verify message signature (same as channel mode)
            const streamId = ownerChannel.streamId;
            const isRecentMessage = Date.now() - message.timestamp < 30000;
            
            try {
                // Add channelId if missing
                if (!message.channelId) {
                    message.channelId = streamId;
                }
                
                const verification = await identityManager.verifyMessage(message, streamId, {
                    skipTimestampCheck: !isRecentMessage
                });
                message.verified = verification;
            } catch (error) {
                Logger.error('Preview verification error:', error);
                message.verified = { valid: false, error: error.message, trustLevel: -1 };
            }

            // Bail if a rapid switch invalidated this preview while the
            // signature verification was in flight. Identity check covers
            // both "channel cleared" and "channel replaced" cases.
            if (this.previewChannel !== ownerChannel) {
                Logger.debug('Preview: Channel changed during verification, skipping message');
                return;
            }

            // Re-check dedup after async verify: defence-in-depth in case the
            // _processingIds set was somehow bypassed (e.g. preview channel
            // recreated mid-flight).
            if (ownerChannel.messages.some(m => m.id === message.id)) {
                Logger.debug('Preview: Message raced in during verify, skipping:', message.id);
                return;
            }

            // Mark as no longer loading (we got at least one message)
            ownerChannel.isLoading = false;

            // Track oldest timestamp for pagination (scroll-to-top load-more)
            if (!ownerChannel.oldestTimestamp || message.timestamp < ownerChannel.oldestTimestamp) {
                ownerChannel.oldestTimestamp = message.timestamp;
            }

            // Add message to preview channel
            ownerChannel.messages.push(message);

            // Sort by timestamp to ensure correct order
            ownerChannel.messages.sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));

            // Apply any override (edit/delete) that arrived BEFORE this
            // message and was queued in `_pendingOverrides`. Race-safe by
            // design: the SDK delivers P0 (content) and P1 (overrides)
            // independently and async verification means a delete can be
            // queued before its target lands here. Without this, the
            // override would only be flushed in `onHistoryComplete` —
            // which is unreliable for streams whose resend iterator never
            // signals `done`. ChatAreaUI.renderMessages already filters
            // `_deleted` and `type:'edit'|'delete'`, so flagging is enough.
            this._applyPreviewOverrides();

            // Nothing is painted while the initial load runs. It always ends:
            // when the three sources are in, or when the safety timer fires.
            if (!ownerChannel.initialLoadInProgress) {
                chatAreaUI.renderMessages(ownerChannel.messages, () => {
                    this.ui.attachReactionListeners();
                    mediaHandler.attachLightboxListeners();
                });
            }

            // Scroll to bottom
            if (this.ui.elements.messagesArea) {
                this.ui.elements.messagesArea.scrollTop = this.ui.elements.messagesArea.scrollHeight;
            }
        } finally {
            // Always release the in-flight id, whether the message was added,
            // rejected, or an error was thrown during verification. Use the
            // captured ownerChannel so we never delete from a newer preview.
            ownerChannel?._processingIds?.delete(message.id);
        }
    }

    /**
     * Handle a -1/P1 override (edit/delete) received in preview mode.
     * Applies immediately when the target is already loaded, otherwise
     * queues the override in `_pendingOverrides` so it is applied as
     * soon as the target arrives via `handlePreviewMessage`. Re-renders
     * the timeline so the message disappears (delete) or updates (edit)
     * without waiting for `onHistoryComplete` — the SDK resend iterator
     * is unreliable on some streams and may never signal `done`.
     * @param {Object} override - { type:'edit'|'delete', targetId, account, text?, timestamp }
     */
    handlePreviewOverride(override) {
        if (!this.previewChannel) return;
        if (!override || (override.type !== 'edit' && override.type !== 'delete')) return;
        const { chatAreaUI, mediaHandler } = this.deps;

        this._applyOrQueuePreviewOverride(override);

        // Same rule: while the initial load runs, an override changes the
        // model and nothing else.
        if (chatAreaUI?.renderMessages && !this.previewChannel.initialLoadInProgress) {
            chatAreaUI.renderMessages(this.previewChannel.messages, () => {
                this.ui?.attachReactionListeners?.();
                mediaHandler?.attachLightboxListeners?.();
            });
        }
    }

    /**
     * Apply pending edit/delete overrides to preview channel messages
     * @private
     */
    _applyPreviewOverrides() {
        if (!this.previewChannel?._pendingOverrides?.size) return;
        // Only delete entries that were actually applied. Targets whose
        // P0 content message hasn't landed yet (e.g. its async signature
        // verification is still in flight when onHistoryComplete fires)
        // must remain queued so the override applies as soon as the
        // message is pushed via handlePreviewMessage.
        const applied = [];
        for (const [targetId, override] of this.previewChannel._pendingOverrides) {
            const msg = this.previewChannel.messages.find(m => m.id === targetId);
            if (!msg) continue;
            if (msg.sender?.toLowerCase() !== override.account?.toLowerCase()) continue;
            if (override.type === 'edit' && override.text) {
                msg.text = override.text;
                msg._edited = true;
            } else if (override.type === 'delete') {
                msg._deleted = true;
            }
            applied.push(targetId);
        }
        for (const id of applied) {
            this.previewChannel._pendingOverrides.delete(id);
        }
    }

    /**
     * Apply a preview override immediately when possible, otherwise queue it.
     * @param {Object} override - Override message
     * @private
     */
    _applyOrQueuePreviewOverride(override) {
        if (!this.previewChannel || !override?.account || !override?.targetId) return;

        const original = this.previewChannel.messages.find(m => m.id === override.targetId);
        if (!original) {
            const pending = this.previewChannel._pendingOverrides;
            if (pending) {
                const existing = pending.get(override.targetId);
                if (!existing || override.timestamp > existing.timestamp) {
                    pending.set(override.targetId, override);
                }
            }
            return;
        }

        if (original.sender?.toLowerCase() !== override.account.toLowerCase()) return;

        if (override.type === 'edit' && override.text) {
            original.text = override.text;
            original._edited = true;
        } else if (override.type === 'delete') {
            original._deleted = true;
        }
    }

    /**
     * Send a message in preview mode (directly to stream without channelManager)
     * @param {string} text - Message text
     * @param {Object} replyTo - Reply to message (optional)
     */
    async sendPreviewMessage(text, replyTo = null) {
        if (!this.previewChannel) return;

        const { identityManager, streamrController, chatAreaUI, mediaHandler } = this.deps;
        
        const streamId = this.previewChannel.streamId;
        
        // Create signed message using identity manager (same as channelManager)
        const message = await identityManager.createSignedMessage(text, streamId, replyTo);
        
        // Add verification info for local display
        message.verified = {
            valid: true,
            trustLevel: await identityManager.getTrustLevel(message.sender)
        };
        
        // Add to local preview messages immediately
        this.previewChannel.messages.push(message);
        this.previewChannel.messages.sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));
        chatAreaUI.renderMessages(this.previewChannel.messages, () => {
            this.ui.attachReactionListeners();
            mediaHandler.attachLightboxListeners();
        });
        
        // Scroll to bottom
        if (this.ui.elements.messagesArea) {
            this.ui.elements.messagesArea.scrollTop = this.ui.elements.messagesArea.scrollHeight;
        }
        
        // Publish to the message stream
        await streamrController.publishMessage(streamId, message);
        
        Logger.debug('Preview message sent:', message.id);
    }

    /**
     * Send a reaction in preview mode (directly to stream without channelManager)
     * @param {string} msgId - Message ID to react to
     * @param {string} emoji - Emoji reaction
     * @param {boolean} isRemoving - True if removing reaction
     */
    async sendPreviewReaction(msgId, emoji, isRemoving) {
        if (!this.previewChannel) return;

        const { authManager, streamrController } = this.deps;
        
        const streamId = this.previewChannel.streamId;
        const action = isRemoving ? 'remove' : 'add';
        
        try {
            const reaction = {
                type: 'reaction',
                action: action,
                messageId: msgId,
                emoji: emoji,
                user: authManager.getAddress(),
                timestamp: Date.now()
            };

            // Publish to message stream (reactions are stored with messages)
            await streamrController.publishReaction(streamId, reaction, this.previewChannel.password);
            
            Logger.debug('Preview reaction sent:', action, emoji, 'to', msgId);
        } catch (error) {
            Logger.error('Failed to send preview reaction:', error);
            this.ui.showNotification('Failed to send reaction', 'error');
        }
    }
    /**
     * Load older history for preview channel (scroll-to-top load-more)
     * @returns {Promise<{loaded: number, hasMore: boolean}>}
     */
    async loadMorePreviewHistory() {
        if (!this.previewChannel) return { loaded: 0, hasMore: false };
        if (this.previewChannel.loadingHistory) return { loaded: 0, hasMore: true };

        const { streamrController, identityManager, chatAreaUI, mediaHandler } = this.deps;
        const channel = this.previewChannel;
        const streamId = channel.streamId;

        // Use oldest message timestamp, or compute from existing messages, or Date.now()
        let beforeTimestamp = channel.oldestTimestamp;
        if (!beforeTimestamp && channel.messages.length > 0) {
            beforeTimestamp = Math.min(...channel.messages.map(m => m.timestamp || Infinity));
            channel.oldestTimestamp = beforeTimestamp;
        }
        if (!beforeTimestamp) beforeTimestamp = Date.now();

        channel.loadingHistory = true;

        try {
            const fetchContent = () => streamrController.fetchOlderHistory(
                streamId,
                STREAM_CONFIG.MESSAGE_STREAM.MESSAGES,
                beforeTimestamp,
                30,
                channel.password
            );
            const fetchOverrides = () => streamrController.fetchOlderHistory(
                streamId,
                STREAM_CONFIG.MESSAGE_STREAM.CONTROL,
                beforeTimestamp,
                30,
                channel.password
            );

            let [contentResult, overrideResult] = await Promise.all([fetchContent(), fetchOverrides()]);

            // Storage race mitigation (symmetric with `channels.loadMoreHistory`):
            // when both partitions return zero across a non-trivial range, the
            // storage iterator may have closed early. Progressive backoff
            // (1s, 2s, 3s) disambiguates flakiness from true exhaustion.
            const isEmpty = (c, o) => (c?.messages?.length || 0) === 0
                && (o?.messages?.length || 0) === 0;
            if (isEmpty(contentResult, overrideResult) && beforeTimestamp > 1 && this.previewChannel === channel) {
                const backoffMs = [1000, 2000, 3000];
                for (let attempt = 0; attempt < backoffMs.length; attempt++) {
                    await new Promise(r => setTimeout(r, backoffMs[attempt]));
                    if (this.previewChannel !== channel) break;
                    const [retryContent, retryOverride] = await Promise.all([fetchContent(), fetchOverrides()]);
                    if (!isEmpty(retryContent, retryOverride)) {
                        Logger.info?.(
                            `loadMorePreviewHistory: retry #${attempt + 1} recovered messages after empty first response`
                        );
                        contentResult = retryContent;
                        overrideResult = retryOverride;
                        break;
                    }
                }
            }

            if (!this.previewChannel) return { loaded: 0, hasMore: false };

            // Separate reactions from content messages
            let addedCount = 0;
            const { reactionManager } = this.deps;

            for (const msg of contentResult.messages || []) {
                // Stored image chunks (no id/sender) — feed the assembler
                // before the generic incomplete-message filter drops them.
                if (typeof mediaController?.isStoredImageChunkMessage === 'function'
                    && mediaController.isStoredImageChunkMessage(msg)) {
                    if (msg.timestamp && (!channel.oldestTimestamp || msg.timestamp < channel.oldestTimestamp)) {
                        channel.oldestTimestamp = msg.timestamp;
                    }
                    try {
                        await mediaController.registerStoredImageChunk(streamId, msg);
                    } catch (err) {
                        Logger.debug?.('Preview loadMore: chunk register failed:', err?.message || err);
                    }
                    continue;
                }

                if (msg?.type === 'reaction') {
                    const reactionUser = msg.user || msg.account;
                    if (reactionUser) {
                        reactionManager.handleIncomingReaction(
                            msg.messageId, msg.emoji, reactionUser, msg.action || 'add'
                        );
                    }
                    // Track oldest timestamp from reactions too (for pagination progress)
                    if (msg.timestamp && (!channel.oldestTimestamp || msg.timestamp < channel.oldestTimestamp)) {
                        channel.oldestTimestamp = msg.timestamp;
                    }
                    continue;
                }

                if (!msg?.id || !msg?.sender || !msg?.timestamp) continue;
                if (channel.messages.some(m => m.id === msg.id)) continue;
                if (channel._processingIds?.has(msg.id)) continue;
                // Older history is ingested here rather than through the
                // subscription handler, so the cut applies again.
                if (!await this._readOnlyAllows(channel, msg.sender)) continue;
                channel._processingIds?.add(msg.id);

                try {
                    // Verify signature
                    try {
                        if (!msg.channelId) msg.channelId = streamId;
                        msg.verified = await identityManager.verifyMessage(msg, streamId, { skipTimestampCheck: true });
                    } catch (e) {
                        msg.verified = { valid: false, error: e.message, trustLevel: -1 };
                    }

                    // Re-check after await (race with concurrent handler)
                    if (channel.messages.some(m => m.id === msg.id)) continue;

                    // Register chunked-image manifests so already-buffered
                    // chunks (or chunks paginated in this same window) can
                    // complete assembly.
                    if (
                        typeof mediaController?.isStoredChunkedImageManifest === 'function'
                        && mediaController.isStoredChunkedImageManifest(msg)
                        && msg.verified?.valid !== false
                        && typeof mediaController.registerStoredImageManifest === 'function'
                    ) {
                        try {
                            await mediaController.registerStoredImageManifest(streamId, msg);
                        } catch (err) {
                            Logger.debug?.('Preview loadMore: manifest register failed:', err?.message || err);
                        }
                    }

                    channel.messages.push(msg);
                    addedCount++;

                    if (!channel.oldestTimestamp || msg.timestamp < channel.oldestTimestamp) {
                        channel.oldestTimestamp = msg.timestamp;
                    }
                } finally {
                    channel._processingIds?.delete(msg.id);
                }
            }

            for (const override of overrideResult.messages || []) {
                if (override?.timestamp && (!channel.oldestTimestamp || override.timestamp < channel.oldestTimestamp)) {
                    channel.oldestTimestamp = override.timestamp;
                }
                this._applyOrQueuePreviewOverride(override);
            }

            this._applyPreviewOverrides();
            channel.messages = channel.messages.filter(m => !m._deleted);

            if (addedCount > 0) {
                channel.messages.sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));
            }

            channel.hasMoreHistory = !!(contentResult.hasMore || overrideResult.hasMore);
            Logger.debug(`Preview: Loaded ${addedCount} older messages, hasMore: ${channel.hasMoreHistory}`);

            return { loaded: addedCount, hasMore: channel.hasMoreHistory };
        } catch (error) {
            Logger.error('Preview: Failed to load more history:', error);
            return { loaded: 0, hasMore: true };
        } finally {
            if (this.previewChannel) {
                this.previewChannel.loadingHistory = false;
            }
        }
    }

    /**
     * Recover chunked-image manifests in preview mode whose chunks fell
     * outside the initial resend window. Mirrors `channelManager.recoverIncompleteImages`
     * but operates on `this.previewChannel` and uses `loadMorePreviewHistory`.
     *
     * Each chunked image publishes N chunks + 1 manifest. With the initial
     * `last:N` resend bounded, older manifests can land without their
     * chunks (manifest is the last message of the upload run). Without
     * recovery, the affected placeholders stay on "Loading…" forever
     * because the assembled image is never persisted to the ledger
     * (assembly never completes) and merely scrolling enough to repaginate
     * is not always done by the user.
     *
     * @param {Object} ownerChannel - Captured preview channel reference
     * @param {number} [maxRounds]
     * @private
     */
    async _recoverIncompletePreviewImages(ownerChannel, maxRounds = CONFIG.media.recoveryMaxRounds) {
        if (!ownerChannel) return;
        if (typeof mediaController?.isStoredChunkedImageManifest !== 'function') return;
        if (this._recoveryInFlight) return;
        this._recoveryInFlight = true;
        try {
            await this._recoverIncompletePreviewImagesInner(ownerChannel, maxRounds);
        } finally {
            this._recoveryInFlight = false;
        }
    }

    /** @private */
    async _recoverIncompletePreviewImagesInner(ownerChannel, maxRounds) {
        // Wait briefly for any in-flight async signature verification to push
        // verified manifest messages into `ownerChannel.messages`. Without this
        // the first scan often races and reports "0 msgs in initial window".
        // TODO: replace with a deterministic signal (e.g.
        // `identityManager.pendingVerifications` empty promise) instead of
        // a fixed timeout — see CONFIG.media.recoverySignatureRaceWaitMs.
        await new Promise(r => setTimeout(r, CONFIG.media.recoverySignatureRaceWaitMs));
        if (this.previewChannel !== ownerChannel) return;

        Logger.debug(
            `preview recover: starting scan for ${ownerChannel.streamId.slice(-20)} ` +
            `(${ownerChannel.messages.length} msgs in window, ` +
            `${mediaController.pendingImageAssemblies?.size || 0} pending assemblies)`
        );

        const streamId = ownerChannel.streamId;
        let prevIncompleteCount = -1;
        let stagnantRounds = 0;

        // Collect candidate imageIds from BOTH sources:
        //   1. ownerChannel.messages — manifests already verified by the
        //      preview message handler.
        //   2. mediaController.pendingImageAssemblies — manifests/chunks
        //      already received by the assembler but whose verified message
        //      may not yet be in `messages` (signature verification races
        //      with onHistoryComplete fired by the resend iterator).
        // The second source is critical for guest mode where the resend
        // iterator delivers chunks/manifests synchronously while the
        // verified message is still being signed-checked.
        const collectIncomplete = () => {
            const seen = new Set();
            const out = [];

            for (const msg of ownerChannel.messages) {
                if (!mediaController.isStoredChunkedImageManifest(msg)) continue;
                if (msg.verified?.valid === false) continue;
                if (!msg.imageId) continue;
                if (seen.has(msg.imageId)) continue;
                seen.add(msg.imageId);
                if (mediaController.deletedImageIds?.has?.(msg.imageId)) continue;
                if (mediaController.getImage?.(msg.imageId)) continue;
                out.push(msg.imageId);
            }

            for (const [id, pending] of (mediaController.pendingImageAssemblies || new Map())) {
                if (seen.has(id)) continue;
                if (mediaController.deletedImageIds?.has?.(id)) continue;
                if (mediaController.getImage?.(id)) continue;
                // Only consider pendings tied to this preview's stream
                if (pending?.streamId && pending.streamId !== streamId) continue;
                seen.add(id);
                out.push(id);
            }

            return out;
        };

        for (let round = 0; round < maxRounds; round++) {
            if (this.previewChannel !== ownerChannel) return;

            // Resolve quick wins (cache hit, ledger hit, complete pending).
            // Then collect what is still genuinely incomplete.
            const candidates = collectIncomplete();
            const incompleteIds = [];

            for (const imageId of candidates) {
                if (mediaController.getImage?.(imageId)) {
                    mediaController.recoverImage?.(imageId);
                    continue;
                }

                // Try ledger (no-op for guest mode but cheap)
                try {
                    const fromLedger = await secureStorage.getImageBlob?.(imageId);
                    if (fromLedger) {
                        mediaController.handleImageData?.({
                            type: 'image_data',
                            imageId,
                            data: fromLedger
                        });
                        continue;
                    }
                } catch (err) {
                    Logger.debug('preview recover: ledger lookup failed:', err?.message || err);
                }

                // Re-register the manifest if we have it on the message side —
                // useful when chunks arrived out of order.
                const msg = ownerChannel.messages.find(m =>
                    m.imageId === imageId
                    && mediaController.isStoredChunkedImageManifest(m)
                    && m.verified?.valid !== false
                );
                if (msg) {
                    try {
                        await mediaController.registerStoredImageManifest(streamId, msg);
                    } catch (err) {
                        Logger.debug('preview recover: manifest re-register failed:', err?.message || err);
                    }
                    if (mediaController.getImage?.(imageId)) {
                        mediaController.recoverImage?.(imageId);
                        continue;
                    }
                }

                const pending = mediaController.pendingImageAssemblies?.get?.(imageId);
                if (pending?.manifest && pending.chunks.size >= pending.manifest.chunkCount) {
                    // All chunks present, just nudge assembly
                    mediaController.recoverImage?.(imageId);
                    continue;
                }

                incompleteIds.push(imageId);
            }

            if (incompleteIds.length === 0) {
                if (round > 0) {
                    Logger.debug(
                        `preview recover: all manifests resolved for ${streamId.slice(-20)} after ${round} round(s)`
                    );
                }
                return;
            }

            if (ownerChannel.hasMoreHistory === false) {
                const detail = this._describePendingChunks(incompleteIds);
                Logger.warn(
                    `preview recover: ${incompleteIds.length} manifest(s) still incomplete (chunks not in stored history) for ${streamId.slice(-20)} — ${detail}`
                );
                for (const id of incompleteIds) this._markImageUnavailable(id);
                return;
            }

            Logger.debug(
                `preview recover: paginating to recover ${incompleteIds.length} image manifest(s) ` +
                `for ${streamId.slice(-20)} (round ${round + 1}/${maxRounds})`
            );

            const chunksBefore = this._sumPendingPreviewChunks(incompleteIds);
            const globalChunksBefore = this._sumAllPreviewChunks(streamId);
            const globalAssembliesBefore = mediaController.pendingImageAssemblies?.size || 0;

            const result = await this.loadMorePreviewHistory();
            if (this.previewChannel !== ownerChannel) return;
            // Note: loadMorePreviewHistory's finally-block also tries to
            // re-trigger recovery, but our `_recoveryInFlight` guard
            // suppresses that re-entry while we are still iterating here.

            const chunksAfter = this._sumPendingPreviewChunks(incompleteIds);
            const globalChunksAfter = this._sumAllPreviewChunks(streamId);
            const globalAssembliesAfter = mediaController.pendingImageAssemblies?.size || 0;

            // Progress is ANY of: new visible messages, new chunks for our
            // tracked manifests, any new chunks anywhere in this stream's
            // assembly buffer (older manifests are still being discovered),
            // or a change in the count of pending assemblies (one resolved
            // or a new one appeared). Without the global signal we'd bail
            // early when a stuck manifest's own chunks haven't yet arrived
            // but other images are still streaming chunks behind them.
            const madeProgress = result.loaded > 0
                || chunksAfter > chunksBefore
                || globalChunksAfter > globalChunksBefore
                || globalAssembliesAfter !== globalAssembliesBefore
                || incompleteIds.length !== prevIncompleteCount;

            if (madeProgress) {
                stagnantRounds = 0;
                prevIncompleteCount = incompleteIds.length;
            } else {
                stagnantRounds++;
                if (stagnantRounds >= CONFIG.media.recoveryStagnantRoundsLimit) {
                    const detail = this._describePendingChunks(incompleteIds);
                    Logger.warn(
                        `preview recover: ${incompleteIds.length} manifest(s) stagnant after ${stagnantRounds} rounds — giving up for ${streamId.slice(-20)} — ${detail}`
                    );
                    for (const id of incompleteIds) this._markImageUnavailable(id);
                    return;
                }
            }

            if (result.loaded === 0 && !result.hasMore && chunksAfter === chunksBefore) continue;
        }

        Logger.debug(
            `preview recover: hit max rounds (${maxRounds}) for ${streamId.slice(-20)}`
        );
    }

    /**
     * Sum buffered chunk counts across imageIds so the recovery loop can
     * distinguish "pagination brought new chunks but no manifest completed
     * yet" (real progress on a multi-round assembly) from "pagination
     * found nothing" (true stagnation).
     * @private
     */
    _sumPendingPreviewChunks(ids) {
        let total = 0;
        for (const id of ids) {
            const pending = mediaController.pendingImageAssemblies?.get?.(id);
            if (pending) total += pending.chunks.size;
        }
        return total;
    }

    /**
     * Sum buffered chunks across ALL pending image assemblies tied to
     * this preview's stream. Used as a coarse "any image activity?"
     * signal so the stagnation guard does not give up on a stuck
     * manifest while other images on the same channel are still pulling
     * chunks through pagination.
     * @private
     */
    _sumAllPreviewChunks(streamId) {
        const map = mediaController.pendingImageAssemblies;
        if (!map) return 0;
        let total = 0;
        for (const pending of map.values()) {
            if (!pending) continue;
            if (pending.streamId && streamId && pending.streamId !== streamId) continue;
            total += pending.chunks.size;
        }
        return total;
    }

    /**
     * Replace the spinner placeholder in the DOM with an "unavailable"
     * notice + Retry button for an image whose chunks could not be
     * recovered (storage truncation or never stored). Called after
     * pagination is exhausted or the recovery loop stagnates. Idempotent:
     * tracks ids already marked so repeated calls are no-ops.
     *
     * The Retry button clears the expired flag and re-runs the recovery
     * loop, in case the channel has since gained more history (e.g. a
     * relay caught up, or the user has reconnected).
     * @private
     */
    _markImageUnavailable(imageId) {
        if (!imageId || this._expiredImageIds.has(imageId)) return;
        this._expiredImageIds.add(imageId);
        try {
            const placeholders = document.querySelectorAll(
                `[data-image-id="${CSS.escape(imageId)}"]`
            );
            for (const el of placeholders) {
                el.innerHTML = `
                    <div class="flex flex-col items-center gap-2 text-white/40 text-sm p-3">
                        <div class="flex items-center gap-2">
                            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                                <rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect>
                                <line x1="3" y1="3" x2="21" y2="21"></line>
                            </svg>
                            <span>Image unavailable</span>
                        </div>
                        <button type="button" class="px-2 py-1 rounded bg-white/10 hover:bg-white/20 text-white/80 text-xs" data-retry-image-id="${escapeAttr(imageId)}">Retry</button>
                    </div>
                `;
                const btn = el.querySelector(`[data-retry-image-id="${CSS.escape(imageId)}"]`);
                if (btn) {
                    btn.addEventListener('click', (ev) => {
                        ev.preventDefault();
                        ev.stopPropagation();
                        this._retryImageRecovery(imageId, el);
                    }, { once: true });
                }
            }
        } catch (err) {
            Logger.debug?.('preview: _markImageUnavailable failed:', err?.message || err);
        }
    }

    /**
     * Reset an image placeholder to its loading state and re-run the
     * preview recovery loop. Used by the Retry button on unavailable
     * placeholders. No-op if the preview channel has changed since the
     * placeholder was rendered.
     * @private
     */
    _retryImageRecovery(imageId, placeholderEl) {
        if (!imageId) return;
        this._expiredImageIds.delete(imageId);
        try {
            if (placeholderEl) {
                placeholderEl.innerHTML = `
                    <div class="flex items-center gap-2 text-white/40 text-sm">
                        <div class="w-4 h-4 border-2 border-white/30 border-t-white/80 rounded-full animate-spin" aria-hidden="true"></div>
                        <span>Loading\u2026</span>
                    </div>
                `;
            }
        } catch (err) {
            Logger.debug?.('preview: _retryImageRecovery DOM reset failed:', err?.message || err);
        }
        const owner = this.previewChannel;
        if (!owner) return;
        this._recoverIncompletePreviewImages(owner).catch(err => {
            Logger.debug?.('preview: _retryImageRecovery loop failed:', err?.message || err);
        });
    }

    /**
     * Build a short diagnostic string of `imageId(have/need)` pairs so a
     * single warn line tells us whether pagination genuinely never brought
     * the chunks (have=0) or only brought a partial run (have<need).
     * @private
     */
    _describePendingChunks(ids) {
        const parts = [];
        for (const id of ids) {
            const pending = mediaController.pendingImageAssemblies?.get?.(id);
            const have = pending?.chunks?.size || 0;
            const need = pending?.manifest?.chunkCount ?? '?';
            parts.push(`${id.slice(0, 8)}(${have}/${need})`);
            if (parts.length >= 6) {
                parts.push(`+${ids.length - parts.length}`);
                break;
            }
        }
        return parts.join(', ');
    }
}

// Export singleton
export const previewModeUI = new PreviewModeUI();
