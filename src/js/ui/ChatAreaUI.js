/**
 * ChatAreaUI
 * Manages the main chat area: message rendering, scrolling, loading history,
 * typing indicators, reply state, and unread counts.
 */

import { notificationUI } from './NotificationUI.js';
import { messageRenderer } from './MessageRenderer.js';
import { reactionManager } from './ReactionManager.js';
import { mediaHandler } from './MediaHandler.js';
import { previewModeUI } from './PreviewModeUI.js';
import { pinnedBannerUI } from './PinnedBannerUI.js';
import { messageTime } from '../utils/messageTime.js';
import { subscriptionBannerUI } from './SubscriptionBannerUI.js';
import { analyzeMessageGroups, getGroupPositionClass, analyzeSpacing, getSpacingClass, shouldGroup } from './MessageGrouper.js';
import { escapeHtml, formatAddress } from './utils.js';
import { getAvatarHtml } from './AvatarGenerator.js';
import { identityManager } from '../identity.js';
import { CONFIG } from '../config.js';
import { banHidesMessage } from '../channels/modComposition.js';
import { epochKeyManager } from '../epochKeyManager.js';

/**
 * Watchdog cap for a single pagination load. If `loadMoreHistory` (network +
 * verification) takes longer than this, we abandon the in-flight UI op so the
 * spinner cannot get permanently stuck. The data fetch itself may still
 * resolve later — only the *UI* state is released.
 */
const PAGINATION_WATCHDOG_MS = 15000;

class ChatAreaUI {
    constructor() {
        this.deps = {};
        
        // Elements
        this.messagesArea = null;
        this.replyBar = null;
        this.replyToName = null;
        this.replyToText = null;
        this.messageInput = null;
        
        /**
         * Active pagination load operation, or null when idle. Single source of
         * truth for the "loading older messages" state — replaces the previous
         * boolean `isLoadingMore`. Owning a token per op lets us:
         *   - reject UI mutations from a stale op after channel switch
         *   - tag the DOM indicator with the op token so a stale op can't hide
         *     a fresh op's spinner (and vice versa)
         *   - run a watchdog that releases UI even if the network call hangs
         *
         * Shape: { id, streamId, mode: 'channel'|'preview', watchdog, indicator }
         */
        this._loadOp = null;
        this._loadOpSeq = 0;
        this._channelSwitching = false; // guard against spurious events during channel transition
        this._pendingAutoLoadTimer = null;
        
        // Reply state
        this.replyingTo = null;
        
        // Edit state
        this.editingMessage = null;
    }

    /**
     * Backwards-compatible boolean view of pagination state. Reads return true
     * while a load op is active; writing `false` cancels the op (used by
     * `selectChannel`/`deselectChannel`/preview-exit cleanup paths). Writing
     * `true` is intentionally a no-op — ops are started by `_beginLoadOp`.
     */
    get isLoadingMore() {
        return this._loadOp !== null;
    }
    set isLoadingMore(value) {
        if (!value) this._cancelLoadOp('external-clear');
    }

    /**
     * Allocate a fresh load op token, install the watchdog, and (optionally)
     * show the loading indicator scoped to this token.
     * @private
     */
    _beginLoadOp({ streamId, mode, showIndicator }) {
        // Defensive: cancel any prior op (e.g. caller did not clean up).
        if (this._loadOp) this._cancelLoadOp('begin-overrides-stale');

        const op = {
            id: ++this._loadOpSeq,
            streamId: streamId || null,
            mode,
            watchdog: null,
            indicatorShown: false,
            timedOut: false,
            cancelled: false,
        };

        op.watchdog = setTimeout(() => {
            // Network/verification hung — release UI ownership so the user
            // is not stuck behind a frozen spinner. The data path may still
            // settle and trigger a future render.
            op.timedOut = true;
            this.deps.Logger?.warn?.(
                `Pagination watchdog fired for ${mode}:${streamId?.slice?.(-20) || '?'}`
            );
            this._cancelLoadOp('watchdog');
        }, PAGINATION_WATCHDOG_MS);

        this._loadOp = op;

        if (showIndicator) {
            notificationUI.showLoadingMoreIndicator(this.messagesArea, op.id);
            op.indicatorShown = true;
        }
        return op;
    }

    /**
     * @private
     * @returns {boolean} true if `op` is still the current load op
     */
    _isOpCurrent(op) {
        return !!op && this._loadOp === op && !op.cancelled && !op.timedOut;
    }

    /**
     * Tear down the active op (or a specific op if provided) — clears the
     * watchdog and removes the loading indicator iff the DOM token matches.
     * @private
     */
    _cancelLoadOp(_reason = 'cancel') {
        const op = this._loadOp;
        if (!op) return;
        op.cancelled = true;
        if (op.watchdog) {
            clearTimeout(op.watchdog);
            op.watchdog = null;
        }
        if (op.indicatorShown) {
            notificationUI.hideLoadingMoreIndicator(op.id);
        }
        this._loadOp = null;
    }

    /**
     * @private
     * Cleanly finish an op (success path). Like `_cancelLoadOp` but only acts
     * when `op` is still current — never touches a fresher op.
     */
    _endLoadOp(op) {
        if (!op || this._loadOp !== op) return;
        if (op.watchdog) {
            clearTimeout(op.watchdog);
            op.watchdog = null;
        }
        if (op.indicatorShown) {
            notificationUI.hideLoadingMoreIndicator(op.id);
        }
        this._loadOp = null;
    }

    /**
     * Inject dependencies (avoids circular imports)
     * @param {Object} deps - { 
     *   channelManager, authManager, secureStorage, Logger,
     *   getActiveChannel, mediaController 
     * }
     */
    setDependencies(deps) {
        this.deps = { ...this.deps, ...deps };
    }

    /**
     * Initialize with DOM elements
     * @param {Object} elements - { messagesArea, replyBar, replyToName, replyToText, messageInput }
     */
    init(elements) {
        this.messagesArea = elements.messagesArea;
        this.replyBar = elements.replyBar;
        this.replyToName = elements.replyToName;
        this.replyToText = elements.replyToText;
        this.messageInput = elements.messageInput;
        this._wireAdminStateHandler();
    }

    /**
     * Re-render the active channel whenever its admin state changes so
     * banned-member messages and hidden message IDs disappear immediately
     * (e.g. after the admin-stream bootstrap arrives post-render).
     * @private
     */
    _wireAdminStateHandler() {
        if (this._adminHandlerWired) return;
        const { channelManager } = this.deps;
        if (!channelManager?.onMessage) return;
        channelManager.onMessage((event, data) => {
            if (event !== 'admin_state_updated') return;
            const channel = channelManager.getCurrentChannel?.();
            if (!channel || channel.streamId !== data?.streamId) return;
            this.renderMessages(channel.messages, () => {
                this._attachMessageListeners?.();
            });
        });
        this._adminHandlerWired = true;
    }

    /**
     * Trigger a history load. Invoked by the IntersectionObserver on the
     * top sentinel (modern infinite-scroll pattern) — no per-frame scrollTop
     * reads. Kept as a named method so tests and programmatic callers
     * (e.g. _autoLoadIfContentShort) can still invoke it directly.
     */
    async handleMessagesScroll() {
        if (!this.messagesArea) return;
        
        // Suppress events during channel transitions (innerHTML='' can cause spurious events)
        if (this._channelSwitching) return;
        
        // Prevent concurrent loads
        if (this._loadOp) return;
        
        const { channelManager } = this.deps;
        const channel = channelManager?.getCurrentChannel();
        const previewChannel = previewModeUI.getPreviewChannel();
        
        // Don't trigger loadMore during initial history load — let it complete
        // first. Applies to both regular channels and preview mode (preview was
        // previously unguarded, causing redundant P0/P1 refetches and duplicate
        // message injections while the initial resend was still streaming).
        if (channel?.initialLoadInProgress) return;
        if (previewChannel?.initialLoadInProgress) return;
        
        // Must have either a regular channel or a preview channel with more history
        if (channel && channel.hasMoreHistory) {
            await this._loadMoreChannelHistory(channel, channelManager);
        } else if (previewChannel && previewChannel.hasMoreHistory !== false) {
            await this._loadMorePreviewHistory(previewChannel);
        }
    }

    /**
     * Load more history for a regular channel
     * @private
     */
    async _loadMoreChannelHistory(channel, channelManager) {
        const generationAtStart = channelManager.switchGeneration;
        const streamId = channel.streamId;

        // Only show "Loading More" indicator if there are existing messages
        // (otherwise the central spinner from renderMessages is already showing)
        const showIndicator = channel.messages.length > 0;
        const op = this._beginLoadOp({ streamId, mode: 'channel', showIndicator });

        // Remove any existing "search older" / "history end" banners before loading
        this._removeSearchOlderBanner();
        this._removeHistoryEndBanner();

        // When the area has no messages (e.g. user clicked the "Search older"
        // banner on an empty DM), force a re-render so the central spinner
        // appears for the duration of the fetch. With `_loadOp` active,
        // `renderMessages([])` deterministically takes the non-terminal-empty
        // branch and shows the spinner.
        if (!showIndicator) {
            this.renderMessages(channel.messages);
        }

        const previousScrollHeight = this.messagesArea.scrollHeight;
        const previousScrollTop = this.messagesArea.scrollTop;
        
        try {
            const result = await channelManager.loadMoreHistory(streamId);

            // Guard against channel-switch mid-load (results are stale).
            if (channelManager.switchGeneration !== generationAtStart) return;
            // Guard against explicit cancellation (user navigated away,
            // op was superseded). NOTE: we deliberately DO NOT bail on
            // `op.timedOut` — the watchdog only releases the visual loading
            // indicator after 15s; if the actual fetch resolves later (slow
            // DM inbox windows often take 20-40s), the result is still
            // valid and the user-visible UI (banner / inline marker /
            // rendered messages) MUST be applied. Otherwise the banner
            // never appears in this cycle and the user waits even longer
            // for an auto-load retry.
            if (op.cancelled) return;

            if (result.loaded > 0) {
                this.renderMessages(channel.messages, () => {
                    this._attachMessageListeners();
                });
                
                const newScrollHeight = this.messagesArea.scrollHeight;
                const heightDiff = newScrollHeight - previousScrollHeight;
                this.messagesArea.scrollTop = previousScrollTop + heightDiff;
            } else if (result.noResultsInWindow && result.hasMore) {
                // DM pagination: no messages from this peer in the current time window.
                // End the op BEFORE rendering the banner so `renderMessages`
                // (called transitively from `_showSearchOlderBanner` for empty
                // channels) can correctly evaluate `isTerminalEmpty` without
                // our own in-flight op blocking the check.
                this._endLoadOp(op);
                this._showSearchOlderBanner(channel, channelManager);
            } else {
                // Empty result. End the op BEFORE re-rendering so the
                // empty-state derivation in `renderMessages` (which requires
                // `_loadOp === null`) can resolve correctly — either to the
                // "— beginning of conversation —" marker (when `hasMore`
                // flipped to false) or to "No messages yet" for an empty
                // channel that has reached exhaustion.
                this._endLoadOp(op);
                if (!result.hasMore || channel.messages.length === 0) {
                    this.renderMessages(channel.messages, () => {
                        this._attachMessageListeners();
                    });
                }
            }
        } catch (error) {
            this.deps.Logger?.error('Failed to load more messages:', error);
        } finally {
            this._endLoadOp(op);
        }
    }

    /**
     * Empty-state copy for a history read the storage node refused.
     * @param {{status: number, signed: boolean}} error
     * @param {boolean} isPreview - browsing without having joined
     * @returns {{title: string, detail: string}}
     */
    _historyErrorText(error, isPreview) {
        switch (error?.status) {
            case 403:
                return isPreview
                    ? { title: 'History is available to members', detail: 'Join the channel to read past messages' }
                    : { title: 'Your access to this channel has ended', detail: 'The storage node no longer serves its history to you' };
            case 401:
                return error?.signed
                    ? { title: 'The storage node did not accept this read', detail: 'Check the device clock and try again' }
                    : { title: 'History is available to members', detail: 'Sign in with an account that has access to read past messages' };
            case 503:
                return { title: 'Channel history is temporarily unavailable', detail: 'The storage node cannot reach the chain right now. Reopen the channel to retry' };
            default:
                return { title: 'Channel history could not be loaded', detail: `The storage node answered HTTP ${error?.status ?? '?'}. Reopen the channel to retry` };
        }
    }

    /**
     * Show "No messages found — Search older" banner at top of messages area (DM pagination)
     * @private
     */
    _showSearchOlderBanner(channel, channelManager) {
        this._removeSearchOlderBanner();
        if (!this.messagesArea) return;

        // If the area is currently in the empty/spinner placeholder state
        // (no rendered messages — e.g. an empty DM that just finished its
        // first windowed scan), replace the placeholder so the banner becomes
        // the SOLE visible affordance. Also kill the 20s
        // `_loadingTimeoutId` so it can't later wipe the banner with
        // "No messages yet".
        const messageCount = (channel?.messages?.length ?? 0);
        if (messageCount === 0) {
            if (this._loadingTimeoutId) {
                clearTimeout(this._loadingTimeoutId);
                this._loadingTimeoutId = null;
            }
            this.messagesArea.innerHTML = '';
        }

        const banner = document.createElement('div');
        banner.id = 'dm-search-older-banner';
        banner.className = messageCount === 0
            ? 'flex h-full items-center justify-center cursor-pointer group'
            : 'flex justify-center py-3 cursor-pointer group';
        banner.innerHTML = `
            <div class="flex items-center gap-2 text-white/30 text-sm group-hover:text-white/60 transition-colors">
                <svg class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
                    <path stroke-linecap="round" stroke-linejoin="round" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
                </svg>
                <span>No messages found in this time range — Search older</span>
            </div>
        `;
        banner.addEventListener('click', async () => {
            banner.remove();
            await this._loadMoreChannelHistory(channel, channelManager);
        });
        this.messagesArea.prepend(banner);
    }

    /**
     * Remove the "search older" prompt (DM-specific paginated empty window).
     * @private
     */
    _removeSearchOlderBanner() {
        document.getElementById('dm-search-older-banner')?.remove();
    }

    /**
     * Defensive: remove any stale icon-banner end-of-history marker. The app
     * no longer creates this element (the inline marker rendered inside
     * `renderMessages` is the single source of truth), but a service-worker
     * cached page from a previous build could still inject one — best effort
     * cleanup keeps things consistent.
     * @private
     */
    _removeHistoryEndBanner() {
        document.getElementById('history-end-banner')?.remove();
    }

    /**
     * Load more history for a preview channel
     * @private
     * @param {Object} previewChannel
     * @param {number} [chainDepth=0] - Internal counter for empty-batch
     *   auto-chaining. When a load returns `loaded:0` but `hasMore:true`
     *   (e.g. the entire batch was chunked-image chunks that produce no
     *   visible messages), the IntersectionObserver sentinel stays in the
     *   same intersecting state and won't fire a new event, so the user
     *   would have to scroll out and back in to keep paginating. To avoid
     *   that dead-end, we transparently chain another load up to a small
     *   cap so subsequent batches that DO carry visible messages (or chunks
     *   that complete a stuck image manifest) reach the UI.
     */
    async _loadMorePreviewHistory(previewChannel, chainDepth = 0) {
        const streamId = previewChannel?.streamId || null;

        // Only show "Loading More" indicator if there are existing messages
        // (otherwise the central spinner from renderMessages is already showing)
        const showIndicator = previewChannel.messages.length > 0;
        const op = this._beginLoadOp({ streamId, mode: 'preview', showIndicator });

        this._removeHistoryEndBanner();

        // See `_loadMoreChannelHistory`: render the central spinner while
        // the fetch runs against an empty preview channel.
        if (!showIndicator) {
            this.renderMessages(previewChannel.messages);
        }

        const previousScrollHeight = this.messagesArea.scrollHeight;
        const previousScrollTop = this.messagesArea.scrollTop;
        
        try {
            const result = await previewModeUI.loadMorePreviewHistory();

            if (!previewModeUI.isInPreviewMode()) return;
            if (!this._isOpCurrent(op)) return;

            if (result.loaded > 0) {
                this.renderMessages(previewChannel.messages, () => {
                    this._attachMessageListeners();
                });
                
                const newScrollHeight = this.messagesArea.scrollHeight;
                const heightDiff = newScrollHeight - previousScrollHeight;
                this.messagesArea.scrollTop = previousScrollTop + heightDiff;
            } else {
                // Empty result. End the op BEFORE re-rendering so the
                // empty-state derivation in `renderMessages` (which requires
                // `_loadOp === null`) can resolve to either the
                // "— beginning of conversation —" marker or "No messages yet".
                this._endLoadOp(op);
                if (!result.hasMore || previewChannel.messages.length === 0) {
                    this.renderMessages(previewChannel.messages, () => {
                        this._attachMessageListeners();
                    });
                }
                // IntersectionObserver auto-chain: this batch yielded no
                // visible messages but more history exists. The sentinel
                // is still intersecting, so the IO will not fire again
                // until the user scrolls out and back in. Continue the
                // chain ourselves up to a small cap to fetch the next
                // window. Common when a batch is entirely image chunks.
                if (result.hasMore
                    && previewChannel.hasMoreHistory !== false
                    && chainDepth < CONFIG.media.recoveryScrollChainCap
                    && previewModeUI.isInPreviewMode()
                    && previewModeUI.getPreviewChannel() === previewChannel) {
                    // Yield to the event loop so React/DOM updates settle
                    // and the user can interrupt with a channel switch.
                    await new Promise(r => setTimeout(r, 0));
                    if (previewModeUI.getPreviewChannel() !== previewChannel) return;
                    await this._loadMorePreviewHistory(previewChannel, chainDepth + 1);
                }
            }
        } catch (error) {
            this.deps.Logger?.error('Failed to load more preview messages:', error);
        } finally {
            this._endLoadOp(op);
        }
    }

    /**
     * Re-attach the spinner after a `renderMessages` `innerHTML=` wipe.
     * Marking `op.indicatorShown` is required so `_endLoadOp` /
     * `_cancelLoadOp` will remove the spinner — otherwise an op that
     * began with `showIndicator:false` and had the spinner re-attached
     * here would leak it on completion.
     */
    showLoadingMoreIndicator() {
        const op = this._loadOp;
        if (!op) return;
        notificationUI.showLoadingMoreIndicator(this.messagesArea, op.id);
        op.indicatorShown = true;
    }

    /**
     * Hide loading indicator only when the DOM-token matches the active op
     * (or unconditionally if no op is active — used by external cleanup paths).
     */
    hideLoadingMoreIndicator() {
        notificationUI.hideLoadingMoreIndicator(this._loadOp?.id ?? null);
    }

    /**
     * Attach reaction/reply/download listeners to message buttons.
     * Used as callback after renderMessages completes.
     * @private
     */
    _attachMessageListeners() {
        const { mediaController, storageMediaController, showNotification } = this.deps;
        const channel = this.deps.channelManager?.getCurrentChannel() || previewModeUI.getPreviewChannel();

        reactionManager.attachReactionListeners(
            (msgId) => this.startReply(msgId),
            async (fileId) => {
                if (channel && mediaController) {
                    await mediaHandler.handleFileDownload(fileId, channel, mediaController);
                }
            },
            (msgId) => this.scrollToMessage(msgId),
            async (transferId, msgId) => {
                if (!channel || !storageMediaController) return;
                const msg = channel.messages.find(m =>
                    (msgId && m.id === msgId) || m.metadata?.transferId === transferId);
                if (!msg?.metadata) return;
                try {
                    await storageMediaController.downloadFile(channel.streamId, msg, channel.password);
                } catch (error) {
                    showNotification?.('Download failed: ' + error.message, 'error');
                }
            }
        );
        mediaHandler.attachLightboxListeners();
    }

    /**
     * Render messages in the chat area
     * @param {Array} messages - Array of message objects
     * @param {Function} onRenderComplete - Callback after render (for attaching listeners)
     */
    renderMessages(messages, onRenderComplete = null) {
        const { channelManager, authManager, getActiveChannel } = this.deps;
        
        const channel = getActiveChannel ? getActiveChannel() : channelManager?.getCurrentChannel?.();
        const previewChannel = previewModeUI.getPreviewChannel?.();
        const effectiveChannel = previewChannel || channel;
        const hasMoreHistory = effectiveChannel?.hasMoreHistory !== false;
        
        if (!this.messagesArea) return;

        // Refresh pinned-message banner whenever we re-render (channel switch,
        // admin update, history complete, etc.).
        pinnedBannerUI.update();
        subscriptionBannerUI.update();

        // While initial history reconciliation is in progress, render cached
        // messages if any exist (avoids hiding persisted state behind a spinner
        // while the storage-node resend iterator completes). Only gate to
        // empty when there is nothing cached to show. A second render fires on
        // `initial_history_complete` to reconcile with any newly fetched
        // content/overrides.
        const sourceMessages = Array.isArray(messages) ? messages : [];
        const adminState = effectiveChannel?.adminState;
        const hiddenIds = adminState && Array.isArray(adminState.hiddenMessageIds)
            ? new Set(adminState.hiddenMessageIds)
            : null;
        // A ban hides from its epoch onward, so the lookup keeps the entry and
        // the filter compares it against the epoch the message was written in.
        const bannedBy = new Map();
        for (const entry of (adminState?.bannedMembers || [])) {
            const address = String(entry?.address ?? entry).toLowerCase();
            bannedBy.set(address, typeof entry === 'string'
                ? { address, sinceEpoch: null } : entry);
        }
        const filteredSource = sourceMessages.filter((m) => {
            if (!m || m._deleted || ['edit', 'delete'].includes(m.type)) return false;
            if (hiddenIds && m.id && hiddenIds.has(m.id)) return false;
            if (m.sender) {
                const ban = bannedBy.get(String(m.sender).toLowerCase());
                if (ban && banHidesMessage(ban, m._epoch)) return false;
            }
            return true;
        });
        const messagesForRender = effectiveChannel?.initialLoadInProgress && filteredSource.length === 0
            ? []
            : filteredSource;
        
        // Clear any existing loading timeout
        if (this._loadingTimeoutId) {
            clearTimeout(this._loadingTimeoutId);
            this._loadingTimeoutId = null;
        }
        
        if (messagesForRender.length === 0) {
            // "No messages yet" requires every loading signal to be quiescent;
            // otherwise we keep the spinner. Avoids the prior timer-based
            // fallback that raced slow resend iterators.
            const isTerminalEmpty =
                effectiveChannel?.initialLoadInProgress !== true &&
                hasMoreHistory === false &&
                this._loadOp == null &&
                !effectiveChannel?.loadingHistory &&
                !document.getElementById('dm-search-older-banner');

            if (isTerminalEmpty) {
                // Epoch channels: an empty render while keys are missing means
                // "cannot decrypt yet", not "nothing was said" — the refresh
                // fired on key adoption re-renders and clears this state.
                const waitingForKeys =
                    effectiveChannel?.type === 'gated' &&
                    this.deps.epochKeyManager?.getWaitingInfo?.(effectiveChannel.messageStreamId)?.waiting;
                // On a paid gate an expired subscription is indistinguishable
                // from "admin offline" at the key layer (refusals are silent),
                // so the chain-read status decides which state to show.
                const paidStatus = waitingForKeys && effectiveChannel?.gate?.address
                    ? subscriptionBannerUI.getStatus(effectiveChannel.streamId)
                    : null;
                const subscriptionExpired = paidStatus?.paid
                    && paidStatus.until * 1000 <= Date.now() && !paidStatus.accessNow;
                const historyError = effectiveChannel?.historyError;
                if (historyError) {
                    const { title, detail } = this._historyErrorText(historyError, !!previewChannel);
                    this.messagesArea.innerHTML = `
                    <div class="flex flex-col items-center justify-center h-full text-white/40 gap-3">
                        <span class="text-sm">${title}</span>
                        <span class="text-xs text-white/25">${detail}</span>
                    </div>
                `;
                } else if (subscriptionExpired) {
                    this.messagesArea.innerHTML = `
                    <div class="flex flex-col items-center justify-center h-full text-white/40 gap-3">
                        <span class="text-sm">Your subscription has expired</span>
                        <span class="text-xs text-white/25">Messages stay locked until you renew — renewing extends from the current end</span>
                        <button id="empty-state-renew-btn" class="subscription-banner-renew">Renew subscription</button>
                    </div>
                `;
                    this.messagesArea.querySelector('#empty-state-renew-btn')
                        ?.addEventListener('click', () => subscriptionBannerUI.renewCurrent());
                } else {
                    this.messagesArea.innerHTML = waitingForKeys
                        ? `
                    <div class="flex flex-col items-center justify-center h-full text-white/40 gap-3">
                        <div class="spinner" style="width: 24px; height: 24px;"></div>
                        <span class="text-sm">Waiting for channel keys…</span>
                        <span class="text-xs text-white/25">Another member needs to be online to share them</span>
                    </div>
                `
                        : `
                    <div class="flex items-center justify-center h-full text-white/40">
                        No messages yet. Start the conversation!
                    </div>
                `;
                }
            } else {
                this.messagesArea.innerHTML = `
                    <div class="flex flex-col items-center justify-center h-full text-white/40 gap-3">
                        <div class="spinner" style="width: 24px; height: 24px;"></div>
                        <span class="text-sm">Loading messages...</span>
                    </div>
                `;
            }
            // Still trigger auto-load — initial history may have been all reactions
            if (!this.isLoadingMore) {
                requestAnimationFrame(() => this._autoLoadIfContentShort());
            }
            return;
        }

        const currentAddress = authManager?.getAddress();

        let historyStartIndicator = '';
        if (!hasMoreHistory) {
            historyStartIndicator = `
                <div class="flex justify-center py-4">
                    <div class="text-white/[0.12] text-xs">
                        — beginning of conversation —
                    </div>
                </div>
            `;
        }

        // Analyze message groups for Stack Effect
        const groupPositions = analyzeMessageGroups(messagesForRender);
        // Analyze spacing for 3-level margin system
        const spacingTypes = analyzeSpacing(messagesForRender, currentAddress);

        // Build all HTML in a single pass, wrapping consecutive grouped messages
        // (same sender, same day, within 2-min window) in a .message-group with
        // a single sticky avatar rail. Group boundaries always coincide with
        // shouldGroup() boundaries — date separators sit between groups.
        let messagesHtml = '';
        let inGroup = false;
        let lastDateStr = null;

        for (let index = 0; index < messagesForRender.length; index++) {
            const msg = messagesForRender[index];
            const prev = index > 0 ? messagesForRender[index - 1] : null;
            const isOwn = msg.sender?.toLowerCase() === currentAddress?.toLowerCase();
            const msgDate = new Date(messageTime(msg));
            const time = msgDate.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

            const dateStr = msgDate.toDateString();
            let dateSeparator = '';
            if (dateStr !== lastDateStr) {
                lastDateStr = dateStr;
                dateSeparator = messageRenderer.renderDateSeparator(msgDate);
            }

            const badge = this.getVerificationBadge(msg, isOwn);
            // Read ENS from cache at render time, exactly like the avatar just
            // below. `msg.verified.ensName` is filled once, at verification —
            // if the cache was cold then, it stays null on the object forever,
            // so relying on it alone loses the name on every re-render.
            let displayName = this._displayNameFor(msg, effectiveChannel);

            const groupClass = getGroupPositionClass(groupPositions[index]);
            const spacingClass = getSpacingClass(spacingTypes[index]);
            const ensAvatarUrl = identityManager.getCachedENSAvatar(msg.sender);

            // Decide whether this msg starts a new group
            const startNewGroup = !shouldGroup(prev, msg);
            if (startNewGroup) {
                if (inGroup) {
                    messagesHtml += messageRenderer.buildMessageGroupCloseHTML();
                    inGroup = false;
                }
                if (dateSeparator) {
                    messagesHtml += dateSeparator;
                }
                // The first message of a group carries the spacing relative to
                // the previous group/message — apply that on the group wrapper
                // (not the entry) so the first bubble is flush with the group's
                // top edge. This ensures the sticky avatar's upper bound aligns
                // with the top of the first bubble, never above it.
                messagesHtml += messageRenderer.buildMessageGroupOpenHTML({
                    sender: msg.sender,
                    isOwn,
                    ensAvatarUrl,
                    spacingClass,
                });
                inGroup = true;
            }

            // Spacing class only applies to non-first entries within a group;
            // for the first entry it lives on the group wrapper.
            const entrySpacingClass = startNewGroup ? '' : spacingClass;
            messagesHtml += messageRenderer.buildMessageHTML(
                msg, isOwn, time, badge, displayName,
                groupClass, groupPositions[index], entrySpacingClass, ensAvatarUrl
            );
        }
        if (inGroup) {
            messagesHtml += messageRenderer.buildMessageGroupCloseHTML();
        }

        this.messagesArea.innerHTML = historyStartIndicator + messagesHtml;

        if (!this.isLoadingMore) {
            this.messagesArea.scrollTop = this.messagesArea.scrollHeight;
        } else {
            // Re-insert loading indicator destroyed by innerHTML replacement
            this.showLoadingMoreIndicator();
        }

        // Install IntersectionObserver sentinel for infinite scroll (replaces scroll-event polling)
        this._setupHistorySentinel();
        
        // Call render complete callback for attaching listeners
        if (onRenderComplete) {
            onRenderComplete();
        }
        
        // Auto-load more if content doesn't fill viewport (e.g. only 1 message visible)
        if (!this.isLoadingMore) {
            requestAnimationFrame(() => this._autoLoadIfContentShort());
        }

        // Kick off ENS avatar resolution for senders not yet cached — until
        // now only the user's own avatar was ever resolved (app.js startup),
        // so other users' ENS avatars never appeared in the chat.
        this._resolveMessageAvatars(messagesForRender);

        // And ENS names. Message verification no longer resolves ENS (it would
        // leak the whole contact list to public RPCs, one lookup per message
        // seen), so the only lookups that happen are for senders actually
        // painted on screen.
        this._resolveMessageNames(messagesForRender);
    }

    /**
     * Queue background ENS name resolution for the senders just rendered.
     *
     * `renderMessages` reads the name synchronously from `msg.verified.ensName`,
     * which identityManager now fills from cache only. Anything not yet cached
     * renders as the payload `senderName` or a short address, and gets patched
     * in place when the lookup lands.
     *
     * @private
     * @param {Array} messages - Messages that were just rendered
     */
    _resolveMessageNames(messages) {
        if (!Array.isArray(messages)) return;
        const seen = new Set();
        for (const msg of messages) {
            const sender = msg?.sender;
            if (typeof sender !== 'string' || !sender) continue;
            const normalized = sender.toLowerCase();
            if (seen.has(normalized)) continue;
            seen.add(normalized);
            try {
                identityManager.queueENSResolution?.(sender);
            } catch { /* non-critical */ }
        }
    }

    /**
     * Replace the display name of every rendered message from `normalizedSender`
     * with a freshly resolved ENS name. Mirrors _patchSenderAvatars — patching
     * in place avoids a full re-render just because a name arrived.
     *
     * ENS wins over the payload's self-reported `senderName`, matching the
     * precedence in renderMessages.
     *
     * @private
     * @param {string} normalizedSender - Lowercased sender address
     * @param {string} name - Resolved ENS name
     */
    patchSenderNames(normalizedSender, name) {
        if (!this.messagesArea || !name) return;
        // Same truncation as MessageRenderer.buildMessageHTML — a patched name
        // must not render longer than one that was there from the start.
        const truncated = name.length > 18 ? name.substring(0, 18) + '...' : name;
        const entries = this.messagesArea.querySelectorAll('.message-entry[data-sender]');
        for (const entry of entries) {
            const sender = entry.getAttribute('data-sender');
            if (!sender || sender.toLowerCase() !== normalizedSender) continue;
            const nameEl = entry.querySelector('.message-sender-name');
            if (nameEl) nameEl.textContent = truncated;
        }
    }

    /**
     * Fire-and-forget ENS avatar resolution for the senders of the rendered
     * messages. `renderMessages` reads avatars synchronously via
     * `getCachedENSAvatar`, so an avatar only shows if something resolved it
     * first. identityManager dedups in-flight lookups and caches results
     * (positive 24h, null 1h), so calling this on every render is cheap.
     * When a lookup lands with a URL, the existing avatar rails are patched
     * in place — no full re-render needed.
     * @private
     * @param {Array} messages - Messages that were just rendered
     */
    _resolveMessageAvatars(messages) {
        if (!Array.isArray(messages)) return;
        const seen = new Set();
        for (const msg of messages) {
            const sender = msg?.sender;
            if (typeof sender !== 'string' || !sender) continue;
            const normalized = sender.toLowerCase();
            if (seen.has(normalized)) continue;
            seen.add(normalized);
            if (identityManager.getCachedENSAvatar(sender)) continue;
            try {
                identityManager.resolveENSAvatar?.(sender)
                    ?.then(url => {
                        if (url) this._patchSenderAvatars(normalized, url);
                    })
                    ?.catch(() => {});
            } catch { /* non-critical */ }
        }
    }

    /**
     * Replace the avatar content of every rendered message group belonging
     * to `normalizedSender` with the freshly resolved ENS avatar.
     * @private
     * @param {string} normalizedSender - Lowercased sender address
     * @param {string} url - Resolved ENS avatar URL
     */
    _patchSenderAvatars(normalizedSender, url) {
        if (!this.messagesArea) return;
        const groups = this.messagesArea.querySelectorAll('.message-group[data-group-sender]');
        for (const group of groups) {
            const sender = group.getAttribute('data-group-sender');
            if (!sender || sender.toLowerCase() !== normalizedSender) continue;
            const avatarEl = group.querySelector('.message-avatar');
            if (avatarEl) {
                avatarEl.innerHTML = getAvatarHtml(sender, 46, 0.5, url);
            }
        }
    }

    /**
     * Install a sentinel element at the top of the messages area and observe it
     * with IntersectionObserver. When the sentinel enters the root viewport,
     * more history is loaded. Replaces the old scroll-event + scrollTop threshold
     * approach (which forces a layout read on every scroll frame).
     * @private
     */
    _setupHistorySentinel() {
        if (!this.messagesArea) return;

        // Feature detect — older browsers / test environments without IO
        if (typeof IntersectionObserver === 'undefined') return;

        // Lazily create the observer (reused across renders)
        if (!this._historyObserver) {
            this._historyObserver = new IntersectionObserver((entries) => {
                for (const entry of entries) {
                    if (entry.isIntersecting) {
                        this.handleMessagesScroll();
                    }
                }
            }, {
                root: this.messagesArea,
                rootMargin: '200px 0px 0px 0px',
                threshold: 0
            });
        } else {
            this._historyObserver.disconnect();
        }

        // Only install sentinel when there's more history to load
        const { channelManager } = this.deps;
        const channel = channelManager?.getCurrentChannel();
        const previewChannel = previewModeUI.getPreviewChannel?.();
        const hasMore = (channel && channel.hasMoreHistory) ||
                        (previewChannel && previewChannel.hasMoreHistory !== false);
        if (!hasMore) return;

        const sentinel = document.createElement('div');
        sentinel.id = 'history-sentinel';
        sentinel.setAttribute('aria-hidden', 'true');
        sentinel.style.cssText = 'height:1px;width:100%;pointer-events:none;';
        this.messagesArea.prepend(sentinel);
        this._historyObserver.observe(sentinel);
    }

    /**
     * The name on a bubble:
     *
     *   ENS  >  contact nickname  >  roster name  >  senderName  >  address
     *
     * ENS is read from the cache at render time, not from `msg.verified`: that
     * field is filled once, at verification, so a cold cache back then would
     * lose the name on every later render.
     *
     * The roster name and `senderName` are the same kind of claim — a display
     * name the account chose — so between those two the most RECENT wins,
     * which is deterministic and avoids an arbitrary order. A gated channel's
     * roster is what gives a name to a member who never wrote.
     */
    _displayNameFor(msg, channel) {
        const sender = msg?.sender || '';
        const ens = identityManager.getCachedENS?.(sender) || msg?.verified?.ensName;
        if (ens) return ens;
        const nickname = identityManager.getTrustedContact?.(sender.toLowerCase())?.nickname;
        if (nickname) return nickname;

        const roster = channel?.gate?.address
            ? epochKeyManager.getRosterName?.(channel.messageStreamId, sender)
            : null;
        if (roster && msg?.senderName) {
            return roster.ts >= (msg.timestamp || 0) ? roster.name : msg.senderName;
        }
        return roster?.name || msg?.senderName || formatAddress(sender);
    }

    /**
     * Rebuild only a single message entry in the DOM (used when a message is edited).
     * Avoids the cost of re-rendering the entire conversation.
     * Falls back to a full render if the target node cannot be found.
     * @param {Object} msg - Updated message object
     */
    updateMessage(msg) {
        if (!this.messagesArea || !msg) return;
        const msgId = msg.id || msg.timestamp;
        if (msgId == null) return;

        const selector = `.message-entry[data-msg-id="${CSS.escape(String(msgId))}"]`;
        const existing = this.messagesArea.querySelector(selector);
        if (!existing) {
            // Not in DOM yet — fall back to full render via caller
            return false;
        }

        const { authManager } = this.deps;
        const currentAddress = authManager?.getAddress();
        const isOwn = msg.sender?.toLowerCase() === currentAddress?.toLowerCase();
        const msgDate = new Date(messageTime(msg));
        const time = msgDate.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        const badge = this.getVerificationBadge(msg, isOwn);
        const displayName = this._displayNameFor(
            msg, this.deps.getActiveChannel?.() || null);

        // Preserve existing grouping/spacing classes from the DOM so we don't
        // need to re-analyze the whole conversation for a single edit.
        const classes = Array.from(existing.classList);
        const groupClass = classes.find(c => c.startsWith('msg-group-')) || 'msg-group-single';
        const spacingClass = classes.find(c => c.startsWith('msg-space-') || c.startsWith('spacing-')) || '';
        // Map class back to GroupPosition enum (buildMessageHTML uses it for avatar/name logic)
        const groupPosition = groupClass === 'msg-group-first' ? 'first'
            : groupClass === 'msg-group-middle' ? 'middle'
            : groupClass === 'msg-group-last' ? 'last'
            : 'single';
        const ensAvatarUrl = identityManager.getCachedENSAvatar(msg.sender);

        const html = messageRenderer.buildMessageHTML(
            msg, isOwn, time, badge, displayName,
            groupClass, groupPosition, spacingClass, ensAvatarUrl
        );

        const template = document.createElement('template');
        template.innerHTML = html.trim();
        const newEl = template.content.firstElementChild;
        if (newEl) {
            existing.replaceWith(newEl);
            // The replaced node carries no listeners: react, reply and the
            // reaction badges are wired per element, not delegated.
            this._attachMessageListeners();
            return true;
        }
        return false;
    }

    /**
     * Remove a single message entry from the DOM (used when a message is deleted).
     * Avoids the cost of re-rendering the entire conversation.
     *
     * Maintains the .message-group wrapper invariants: when a message is removed
     * from a group, the remaining entries' msg-group-{first|middle|last|single}
     * classes are recomputed (sender-row visibility flips automatically via CSS).
     * If the removed entry was alone in its group, the entire group wrapper is
     * dropped (which also removes the sticky avatar).
     *
     * @param {string} msgId - Message ID to remove
     * @returns {boolean} - true if the node was found and removed
     */
    removeMessage(msgId) {
        if (!this.messagesArea || msgId == null) return false;
        const selector = `.message-entry[data-msg-id="${CSS.escape(String(msgId))}"]`;
        const existing = this.messagesArea.querySelector(selector);
        if (!existing) return false;

        const groupWrapper = existing.closest('.message-group');
        existing.remove();

        if (groupWrapper) {
            const remaining = groupWrapper.querySelectorAll(':scope > .message-group-stack > .message-entry');
            if (remaining.length === 0) {
                groupWrapper.remove();
            } else {
                this._recomputeGroupPositions(remaining);
            }
        }
        return true;
    }

    /**
     * Recompute msg-group-{first|middle|last|single} classes on a NodeList of
     * .message-entry siblings within a single group. Used after removeMessage.
     * Bubble corner radius and sender-row visibility update reactively via CSS.
     * @private
     * @param {NodeListOf<Element>|Element[]} entries
     */
    _recomputeGroupPositions(entries) {
        const total = entries.length;
        const groupClasses = ['msg-group-single', 'msg-group-first', 'msg-group-middle', 'msg-group-last'];
        for (let i = 0; i < total; i++) {
            const el = entries[i];
            el.classList.remove(...groupClasses);
            let cls;
            if (total === 1) cls = 'msg-group-single';
            else if (i === 0) cls = 'msg-group-first';
            else if (i === total - 1) cls = 'msg-group-last';
            else cls = 'msg-group-middle';
            el.classList.add(cls);
        }
    }

    /**
     * Auto-load more history if content doesn't fill the viewport.
     * Retries up to MAX_AUTO_LOAD_RETRIES times when fetched history is all reactions.
     *
     * Tracks the channelManager `switchGeneration` (and preview mode flag) at
     * scheduling time. Any pending retry whose generation/mode no longer
     * matches is dropped — fixes the race where a `setTimeout` retry survived
     * a channel switch and triggered a premature load on the new channel.
     * @private
     * @param {number} retriesLeft - Remaining retries (default: 5)
     * @param {number} startGeneration - Switch generation when this run started
     * @param {boolean} startInPreview - Whether preview mode was active at start
     */
    async _autoLoadIfContentShort(retriesLeft = 5, startGeneration = null, startInPreview = null) {
        if (!this.messagesArea) return;
        if (this._channelSwitching) return;
        if (this.isLoadingMore) return;
        if (this.messagesArea.scrollHeight > this.messagesArea.clientHeight) return;
        if (retriesLeft <= 0) return;

        const { channelManager } = this.deps;
        const inPreview = previewModeUI.isInPreviewMode?.() === true;
        const generation = channelManager?.switchGeneration ?? 0;

        // Capture context on first invocation; subsequent retries inherit it
        // and bail if the current state diverged (channel switch, preview
        // exit/enter, etc.).
        if (startGeneration === null) {
            startGeneration = generation;
            startInPreview = inPreview;
        } else {
            if (generation !== startGeneration) return;
            if (inPreview !== startInPreview) return;
        }

        const channel = channelManager?.getCurrentChannel();
        const previewChannel = previewModeUI.getPreviewChannel();
        const hasMore = (channel && channel.hasMoreHistory) ||
                        (previewChannel && previewChannel.hasMoreHistory !== false);
        if (!hasMore) return;
        
        // Content fits without scrolling - try to load more
        await this.handleMessagesScroll();
        
        // If a "Search older messages" banner is now visible, the previous
        // fetch hit an empty time window. Stop auto-retrying — silently
        // scanning further empty windows backward would (a) hide the banner
        // affordance from the user and (b) generate a chain of slow resend
        // calls they did not request. The banner click handler is the
        // explicit user opt-in to keep searching older.
        if (document.getElementById('dm-search-older-banner')) return;

        // After loading, if content still doesn't fill viewport, retry
        // (handles case where fetched history was all reactions)
        if (this.messagesArea.scrollHeight <= this.messagesArea.clientHeight) {
            this._cancelPendingAutoLoad();
            this._pendingAutoLoadTimer = setTimeout(() => {
                this._pendingAutoLoadTimer = null;
                this._autoLoadIfContentShort(retriesLeft - 1, startGeneration, startInPreview);
            }, 300);
        }
    }

    /**
     * Cancel any scheduled auto-load retry. Called by the channel switch path
     * so retries cannot fire against the wrong channel.
     * @private
     */
    _cancelPendingAutoLoad() {
        if (this._pendingAutoLoadTimer) {
            clearTimeout(this._pendingAutoLoadTimer);
            this._pendingAutoLoadTimer = null;
        }
    }

    /**
     * Scroll to a specific message with highlight
     * @param {string} msgId - Message ID to scroll to
     */
    scrollToMessage(msgId) {
        const msgElement = document.querySelector(`[data-msg-id="${CSS.escape(msgId)}"]`);
        if (msgElement) {
            msgElement.scrollIntoView({ behavior: 'smooth', block: 'center' });
            msgElement.classList.add('message-highlight');
            setTimeout(() => {
                msgElement.classList.remove('message-highlight');
            }, 1500);
        }
    }

    /**
     * Scroll to bottom of messages
     */
    scrollToBottom() {
        if (this.messagesArea) {
            this.messagesArea.scrollTop = this.messagesArea.scrollHeight;
        }
    }

    /**
     * Start replying to a message
     * @param {string} msgId - Message ID
     */
    startReply(msgId) {
        const { getActiveChannel } = this.deps;
        const channel = getActiveChannel ? getActiveChannel() : null;
        if (!channel) return;
        
        const msg = channel.messages.find(m => (m.id || m.timestamp) === msgId);
        if (!msg) return;
        
        const displayName = identityManager.getCachedENS?.(msg.sender)
            || msg.verified?.ensName || msg.senderName || formatAddress(msg.sender);
        
        this.replyingTo = {
            id: msgId,
            text: msg.text ? msg.text.substring(0, 100) : '',
            sender: msg.sender,
            senderName: displayName
        };
        
        // Update reply bar UI
        if (this.replyToName) {
            this.replyToName.textContent = displayName;
        }
        if (this.replyToText) {
            this.replyToText.textContent = msg.text ? msg.text.substring(0, 100) + (msg.text.length > 100 ? '...' : '') : '[Media]';
        }
        if (this.replyBar) {
            this.replyBar.classList.add('active');
        }
        
        // Focus input
        this.messageInput?.focus();
    }

    /**
     * Cancel reply mode
     */
    cancelReply() {
        this.replyingTo = null;
        if (this.replyBar) {
            this.replyBar.classList.remove('active');
        }
    }

    /**
     * Get current reply state
     * @returns {Object|null} - Reply state or null
     */
    getReplyingTo() {
        return this.replyingTo;
    }

    /**
     * Clear reply state (after message sent)
     */
    clearReply() {
        this.cancelReply();
    }

    // ==================== Edit Mode ====================

    /**
     * Enter edit mode for a message
     * @param {string} msgId - Message ID to edit
     */
    startEdit(msgId) {
        const { getActiveChannel } = this.deps;
        const channel = getActiveChannel ? getActiveChannel() : null;
        if (!channel) return;

        const msg = channel.messages.find(m => (m.id || m.timestamp) === msgId);
        if (!msg || !msg.text) return;

        // Cancel reply if active
        this.cancelReply();

        this.editingMessage = {
            id: msgId,
            originalText: msg.text,
            streamId: channel.streamId
        };

        // Show edit bar
        const editBar = document.getElementById('edit-bar');
        const editBarText = document.getElementById('edit-bar-text');
        if (editBarText) {
            editBarText.textContent = msg.text.substring(0, 100) + (msg.text.length > 100 ? '...' : '');
        }
        if (editBar) {
            editBar.classList.add('active');
        }

        // Pre-fill input with current text
        if (this.messageInput) {
            this.messageInput.textContent = msg.text;
            this.messageInput.dispatchEvent(new Event('input', { bubbles: true }));
            this.messageInput.focus();
            // Move caret to end of contenteditable input
            const range = document.createRange();
            range.selectNodeContents(this.messageInput);
            range.collapse(false);
            const sel = window.getSelection();
            sel?.removeAllRanges();
            sel?.addRange(range);
        }
    }

    /**
     * Cancel edit mode
     */
    cancelEdit() {
        this.editingMessage = null;
        const editBar = document.getElementById('edit-bar');
        if (editBar) {
            editBar.classList.remove('active');
        }
        // Clear input
        if (this.messageInput) {
            this.messageInput.textContent = '';
            this.messageInput.dispatchEvent(new Event('input', { bubbles: true }));
        }
    }

    /**
     * Get current edit state
     * @returns {Object|null} - { id, originalText, streamId } or null
     */
    getEditingMessage() {
        return this.editingMessage || null;
    }

    /**
     * Show typing indicator
     * @param {Array} users - Array of user addresses currently typing
     */
    showTypingIndicator(users) {
        const indicator = document.getElementById('typing-indicator');
        const usersSpan = document.getElementById('typing-users');
        
        if (!indicator || !usersSpan) return;
        
        if (users.length === 0) {
            indicator.classList.add('hidden');
            return;
        }
        
        const { channelManager } = this.deps;
        const channel = channelManager?.getCurrentChannel() || previewModeUI.getPreviewChannel();
        const names = users.map(u => {
            const addr = u.address || u;
            // Timestamped now: the name riding with a keystroke is a live
            // claim, so it outranks an older roster entry.
            return this._displayNameFor(
                { sender: addr, senderName: u.nickname || null, timestamp: Date.now() }, channel);
        }).join(', ');
        usersSpan.textContent = names + (users.length === 1 ? ' is' : ' are');
        indicator.classList.remove('hidden');
    }

    /**
     * Hide typing indicator
     */
    hideTypingIndicator() {
        const indicator = document.getElementById('typing-indicator');
        if (indicator) {
            indicator.classList.add('hidden');
        }
    }

    /**
     * Add a new message to the UI
     * @param {Object} message - Message object
     * @param {string} streamId - Stream ID the message belongs to
     * @param {Function} onRenderComplete - Callback after render
     */
    addMessage(message, streamId, onRenderComplete = null) {
        const { channelManager } = this.deps;
        const channel = channelManager?.getCurrentChannel();
        if (channel && channel.streamId === streamId) {
            this.renderMessages(channel.messages, onRenderComplete);
            this.updateUnreadCount(channel.streamId);
        }
    }

    /**
     * Update unread count badge for a channel in the sidebar
     * @param {string} streamId - Channel stream ID
     */
    updateUnreadCount(streamId) {
        const { channelManager, secureStorage } = this.deps;
        
        const countEl = document.querySelector(`[data-channel-count="${CSS.escape(streamId)}"]`);
        if (!countEl) return;
        
        const channel = channelManager?.getChannel(streamId);
        if (!channel) return;
        
        // Get last access timestamp
        const lastAccess = secureStorage?.getChannelLastAccess(streamId) || 0;
        
        // If user is currently viewing this channel, update access timestamp
        const currentChannel = channelManager?.getCurrentChannel();
        const isCurrentChannel = currentChannel?.streamId === streamId;
        
        if (isCurrentChannel) {
            // User is viewing this channel - mark as read
            secureStorage?.setChannelLastAccess(streamId, Date.now());
            countEl.classList.add('hidden');
            return;
        }
        
        // Calculate unread count (messages newer than last access)
        // Exclude deleted messages and control messages (reactions, edits, deletes)
        const unreadCount = channel.messages.filter(m => 
            m.timestamp > lastAccess && 
            !m._deleted && 
            !['reaction', 'edit', 'delete'].includes(m.type)
        ).length;
        const hasUnread = unreadCount > 0;
        
        if (hasUnread) {
            countEl.textContent = unreadCount >= 30 ? '+30' : unreadCount;
            countEl.classList.remove('hidden', 'text-white/30', 'bg-white/[0.04]');
            countEl.classList.add('text-white', 'bg-[#F6851B]/20');
        } else {
            countEl.classList.add('hidden');
            countEl.classList.remove('text-white', 'bg-[#F6851B]/20');
            countEl.classList.add('text-white/30', 'bg-white/[0.04]');
        }
    }

    /**
     * Get verification badge HTML for a message
     * @param {Object} msg - Message object
     * @param {boolean} isOwn - Whether this is the user's own message
     * @returns {Object} - { html, textColor, bgColor, border }
     */
    getVerificationBadge(msg, isOwn = false) {
        const trustLevel = msg.verified?.trustLevel ?? 0;
        // Cache-first so the badge upgrades once ENS lands, instead of being
        // frozen at whatever the cache held when the message was verified.
        const ensName = identityManager.getCachedENS?.(msg.sender) || msg.verified?.ensName;
        // A known ENS name alone is enough (parity with Android's
        // `trustLevel == 1 || ensName != null`). Gating on trustLevel >= 1
        // meant a received message whose sender's ENS resolved only AFTER
        // verification (the usual order) kept a plain ✓ forever, because
        // trustLevel was snapshotted at 0 — the name showed but the badge
        // never upgraded.
        const hasENS = trustLevel === 1 || !!ensName;

        // ENS verified badge — green checkmark inside organic circle
        const ensBadgeSvg = `<svg class="inline-block" style="vertical-align: -1px" width="14" height="14" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><circle cx="12" cy="12" r="10" stroke="#4ade80" stroke-width="2" fill="none"/><path d="M7.5 12.5l3 3 6-6.5" stroke="#4ade80" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" fill="none"/></svg>`;

        // Own messages
        if (isOwn) {
            if (hasENS) {
                return {
                    html: `<span title="ENS verified">${ensBadgeSvg}</span>`,
                    textColor: 'text-green-400',
                    bgColor: '',
                    border: ''
                };
            }
            return {
                html: '<span class="text-green-400" title="Your message">✓</span>',
                textColor: 'text-green-400',
                bgColor: '',
                border: ''
            };
        }

        // Signed but verification FAILED → red impersonation flag.
        if (msg.signature && msg.verified && !msg.verified.valid) {
            return {
                html: '<span class="text-red-500" title="⚠️ Invalid signature - may be impersonation!">❌</span>',
                textColor: 'text-red-400',
                bgColor: 'bg-red-900/20',
                border: 'border border-red-500/50'
            };
        }

        // Unsigned = the CURRENT format (D6). Identity is established by the
        // proof at INGEST (attachAccount → msg.account), NOT by the async
        // verifyMessage — so show the badge optimistically, exactly as a
        // signed message showed ✓ before its async check returned. Waiting on
        // `verified.valid` left every received (unsigned) message with NO
        // badge until batch verification happened to re-render, which is why
        // only own messages (rendered via the isOwn branch) ever showed one.
        // The only unsigned case that gets no badge is an EXPLICIT failure
        // (replay guard / no account) — and never a red ❌, matching the old
        // "unsigned = no flag, not a failure" rule.
        if (!msg.signature && msg.verified && msg.verified.valid === false) {
            return {
                html: '',
                textColor: 'text-white/30',
                bgColor: 'bg-white/10',
                border: ''
            };
        }

        // Valid signature - ENS badge overrides all other badges
        if (hasENS) {
            return {
                html: `<span title="ENS verified">${ensBadgeSvg}</span>`,
                textColor: 'text-green-400',
                bgColor: '',
                border: ''
            };
        }

        const trustedStarSvg = `<svg class="inline-block" style="vertical-align: -1px" width="14" height="14" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M12 2.5l2.9 5.8 6.4.9-4.6 4.5 1.1 6.4L12 17.3l-5.8 3.8 1.1-6.4-4.6-4.5 6.4-.9z" fill="#d4a544" opacity="0.85" stroke="#d4a544" stroke-width="0.5" stroke-linejoin="round"/></svg>`;

        const badges = {
            0: { icon: '✓', color: 'text-green-400', label: 'Valid signature' },
            2: { icon: trustedStarSvg, color: 'text-amber-400/70', label: 'Trusted contact' }
        };
        
        const badge = badges[trustLevel] || badges[0];

        return {
            html: trustLevel === 2 ? `<span title="${badge.label}">${badge.icon}</span>` : `<span class="${badge.color}" title="${badge.label}">${badge.icon}</span>`,
            textColor: badge.color,
            bgColor: '',
            border: ''
        };
    }

    /**
     * Clear all messages from the chat area
     */
    clearMessages() {
        if (this.messagesArea) {
            this.messagesArea.innerHTML = '';
        }
    }

    /**
     * Show empty state when no channel is selected
     * @param {string} message - Custom message to display
     */
    showEmptyState(message = 'Select a channel to start chatting') {
        if (this.messagesArea) {
            this.messagesArea.innerHTML = `
                <div class="flex items-center justify-center h-full text-white/40">
                    ${escapeHtml(message)}
                </div>
            `;
        }
    }
}

// Export singleton
export const chatAreaUI = new ChatAreaUI();
