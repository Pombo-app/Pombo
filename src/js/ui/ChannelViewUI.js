/**
 * @fileoverview Channel View UI Manager
 * Handles channel selection, deselection, and view state transitions.
 * Consolidates logic previously split across selectChannel and _selectChannelWithoutHistory.
 */
import { Logger } from '../logger.js';
import { pinnedBannerUI } from './PinnedBannerUI.js';
import { subscriptionBannerUI } from './SubscriptionBannerUI.js';

// Forward declarations - dependencies injected via setDependencies()
let channelManager = null;
let subscriptionManager = null;
let secureStorage = null;
let historyManager = null;
let previewModeUI = null;
let chatAreaUI = null;
let headerUI = null;
let reactionManager = null;
let mediaHandler = null;
let onlineUsersUI = null;
let exploreUI = null;

/**
 * Manages channel view transitions and UI state
 */
class ChannelViewUI {
    constructor() {
        this.elements = null;
        this.deps = null;
    }

    /**
     * Set dependencies
     * @param {Object} deps - Dependencies
     */
    setDependencies(deps) {
        this.deps = deps;
        channelManager = deps.channelManager;
        subscriptionManager = deps.subscriptionManager;
        secureStorage = deps.secureStorage;
        historyManager = deps.historyManager;
        previewModeUI = deps.previewModeUI;
        chatAreaUI = deps.chatAreaUI;
        headerUI = deps.headerUI;
        reactionManager = deps.reactionManager;
        mediaHandler = deps.mediaHandler;
        onlineUsersUI = deps.onlineUsersUI;
        exploreUI = deps.exploreUI;
    }

    /**
     * Set element references
     * @param {Object} elements - DOM element references
     */
    setElements(elements) {
        this.elements = elements;
    }

    /**
     * Select and display a channel
     * @param {string} streamId - Stream ID
     * @param {Object} options - Selection options
     * @param {boolean} options.pushHistory - Whether to push to browser history (default: true)
     */
    async selectChannel(streamId, options = { pushHistory: true }) {
        // Stop heartbeat for previous channel
        this.deps.stopAccessHeartbeat();
        
        // Clear typing indicator, reply state, and any stuck loading indicator
        chatAreaUI.hideTypingIndicator();
        chatAreaUI.cancelReply();
        // Cancels any in-flight pagination op (clears watchdog + indicator).
        // Setting `isLoadingMore = false` invokes the cancellation path on
        // ChatAreaUI.
        chatAreaUI.isLoadingMore = false;
        chatAreaUI._cancelPendingAutoLoad?.();
        chatAreaUI.hideLoadingMoreIndicator();
        this.deps.setReplyingTo(null);
        
        // Exit preview mode if active
        if (previewModeUI.isInPreviewMode()) {
            await previewModeUI.exitPreviewMode(false);
        }
        
        channelManager.setCurrentChannel(streamId);
        const channel = channelManager.getCurrentChannel();

        if (!channel) return;
        
        // Start heartbeat
        this.deps.startAccessHeartbeat(streamId);
        
        // Hide Join button (this is a joined channel)
        this.elements.joinChannelBtn?.classList.add('hidden');
        
        // Subscribe to channel
        try {
            await subscriptionManager.setActiveChannel(streamId, channel.password);
        } catch (e) {
            Logger.warn('Subscribe error (may already be subscribed):', e.message);
        }
        
        // Save as last opened channel
        await secureStorage.setLastOpenedChannel(streamId);
        subscriptionManager.clearUnreadCount(streamId);
        
        // Update header. Leaving Explore belongs here, with the caption and
        // thumb that replace it — the subscribe above can take a while, and
        // dropping the class at tap time stranded the Explore list without
        // its layout rules while the header still read Explore.
        document.body.classList.remove('explore-open', 'explore-header-retracted');
        this.elements.currentChannelName.textContent = channel.name;
        this.elements.currentChannelInfo.innerHTML = headerUI.getChannelTypeLabel(channel.type, channel.readOnly);
        this.elements.currentChannelInfo.parentElement.classList.remove('hidden');
        headerUI.updateChannelThumb(channel);
        this.elements.messageInputContainer.classList.remove('hidden');
        
        // Restore padding and clear content
        this.elements.messagesArea?.classList.add('p-4');
        chatAreaUI._channelSwitching = true;
        this.elements.messagesArea.innerHTML = '';
        
        // Show header controls
        this.elements.chatHeaderRight?.classList.remove('hidden');
        
        // Handle read-only UI
        await this.deps.updateReadOnlyUI(channel);
        
        // Show channel buttons (hide invite for DM channels)
        if (channel.type === 'dm') {
            this.elements.inviteUsersBtn?.classList.add('hidden');
        } else {
            this.elements.inviteUsersBtn?.classList.remove('hidden');
        }
        this.elements.channelMenuBtn?.classList.remove('hidden');
        this.elements.channelMenuBtnMobile?.classList.remove('hidden');
        this.elements.closeChannelBtn?.classList.remove('hidden');
        this.elements.closeChannelBtnDesktop?.classList.remove('hidden');
        
        // Show online users
        this.elements.onlineHeader?.classList.remove('hidden');
        this.elements.onlineHeader?.classList.add('flex');
        this.elements.onlineSeparator?.classList.remove('hidden');
        
        // Push to browser history
        if (options.pushHistory) {
            const currentState = window.history.state;
            if (currentState?.view === 'channel') {
                historyManager.replaceState({ view: 'channel', streamId });
            } else {
                historyManager.pushState({ view: 'channel', streamId });
            }
        }
        
        // Load and render messages
        const reactions = channelManager.getChannelReactions(streamId);
        reactionManager.loadFromChannelState(reactions);
        
        chatAreaUI._channelSwitching = false;
        // Always pass cached channel.messages — ChatAreaUI.renderMessages gates
        // to an empty/spinner state only when nothing is cached. A second
        // render fires on `initial_history_complete` once P0+P1 reconciliation
        // is done.
        chatAreaUI.renderMessages(channel.messages, () => {
            this.deps.attachReactionListeners();
            mediaHandler.attachLightboxListeners();
        });
        
        // Self-heal image placeholders after render. Crucial for re-selecting
        // the ALREADY-active channel: setActiveChannel early-returns (no
        // resubscribe, no initial_history_complete), so without this trigger
        // a cache-missed image has no recovery path — guests (no IDB ledger)
        // would stay on "Loading image" until they switch away and back.
        // Cheap when everything is cached (recoverImage re-fires from cache).
        channelManager.recoverIncompleteImages?.(streamId)?.catch?.((err) => {
            Logger.debug('selectChannel image recovery failed:', err?.message || err);
        });
        // Mark channel as read
        await secureStorage.setChannelLastAccess(streamId, Date.now());
        
        // Update sidebar
        this.deps.renderChannelList();
        
        // Start presence tracking
        channelManager.startPresenceTracking(streamId);
        
        // Update online users
        this._updateOnlineUsers(streamId);
        
        // Pre-load DELETE permission
        channelManager.preloadDeletePermission(streamId);
        channelManager.preloadModeratorPermission(streamId);
        
        // Mobile: navigate to chat view
        this.deps.openChatView();
    }

    /**
     * Deselect current channel (close it)
     */
    async deselectChannel() {
        // Stop heartbeat
        this.deps.stopAccessHeartbeat();
        
        // Clear UI state
        chatAreaUI.hideTypingIndicator();
        chatAreaUI.cancelReply();
        chatAreaUI.isLoadingMore = false;
        chatAreaUI._cancelPendingAutoLoad?.();
        chatAreaUI.hideLoadingMoreIndicator();
        this.deps.setReplyingTo(null);
        
        // Stop presence tracking
        channelManager.stopPresenceTracking();
        
        // If in preview mode, exit preview
        if (previewModeUI.isInPreviewMode()) {
            await previewModeUI.exitPreviewMode(true);
            return;
        }
        
        // Clear active channel
        await subscriptionManager.clearActiveChannel();
        channelManager.setCurrentChannel(null);
        
        // Hide UI elements
        this.elements.messageInputContainer?.classList.add('hidden');
        this.elements.inviteUsersBtn?.classList.add('hidden');
        this.elements.joinChannelBtn?.classList.add('hidden');
        this.elements.channelMenuBtn?.classList.add('hidden');
        this.elements.channelMenuBtnMobile?.classList.add('hidden');
        this.elements.closeChannelBtn?.classList.add('hidden');
        this.elements.closeChannelBtnDesktop?.classList.add('hidden');
        this.elements.onlineHeader?.classList.add('hidden');
        this.elements.onlineHeader?.classList.remove('flex');
        this.elements.onlineSeparator?.classList.add('hidden');
        
        // Hide pinned banner (no active channel)
        pinnedBannerUI.update();
        subscriptionBannerUI.update();
        
        // Reset online users
        this._resetOnlineUsers();
        
        // Show Explore view
        await this.deps.showExploreView();
        
        // Remove selection highlight
        document.querySelectorAll('.channel-item').forEach(item => {
            item.classList.remove('bg-white/[0.06]');
        });
    }

    /**
     * Show Explore view inline in messages area
     */
    async showExploreView() {
        // Clear preview state
        if (previewModeUI.isInPreviewMode()) {
            await previewModeUI.exitPreviewMode(false);
        }
        
        // Hide message input
        this.elements.messageInputContainer?.classList.add('hidden');
        
        // Remove padding for edge-to-edge explore
        this.elements.messagesArea?.classList.remove('p-4');
        
        // Update header. Entering Explore is applied here, alongside the
        // caption, so the class and the content it styles change together.
        document.body.classList.add('explore-open');
        const isMobile = this.deps.isMobileView();
        if (!isMobile) {
            this.elements.currentChannelName.textContent = 'Explore Channels';
        }
        this.elements.currentChannelInfo.textContent = '';
        this.elements.currentChannelInfo.parentElement?.classList.add('hidden');
        headerUI.clearChannelThumb();
        
        // Hide channel buttons
        this.elements.inviteUsersBtn?.classList.add('hidden');
        this.elements.joinChannelBtn?.classList.add('hidden');
        this.elements.channelMenuBtn?.classList.add('hidden');
        this.elements.channelMenuBtnMobile?.classList.add('hidden');
        this.elements.onlineHeader?.classList.add('hidden');
        this.elements.onlineSeparator?.classList.add('hidden');
        
        // Hide pinned banner in Explore view
        pinnedBannerUI.update();
        subscriptionBannerUI.update();
        
        // Close button: hide on mobile (pill nav handles navigation), show close on desktop
        if (isMobile) {
            this.elements.closeChannelBtn?.classList.add('hidden');
            this.elements.chatHeaderRight?.classList.add('hidden');
        } else {
            this.elements.closeChannelBtn?.classList.add('hidden');
            this.elements.chatHeaderRight?.classList.remove('hidden');
        }
        this.elements.closeChannelBtnDesktop?.classList.add('hidden');
        
        // Render Explore view
        const nsfwEnabled = secureStorage.getNsfwEnabled();
        this.elements.messagesArea.innerHTML = exploreUI.getTemplate(nsfwEnabled);
        
        // Setup and load
        exploreUI.setupListeners();
        exploreUI.resetFilters();
        await exploreUI.loadChannels();
    }

    /**
     * Reset to disconnected state
     */
    resetToDisconnectedState() {
        chatAreaUI.hideTypingIndicator();
        this.deps.inputUI?.setIsSending(false);
        
        // Reset header
        this.elements.currentChannelName.textContent = 'Explore Channels';
        this.elements.currentChannelInfo.textContent = '';
        this.elements.currentChannelInfo.parentElement?.classList.add('hidden');
        headerUI.clearChannelThumb();
        this.elements.messageInputContainer?.classList.add('hidden');
        
        // Hide all channel buttons
        this.elements.inviteUsersBtn?.classList.add('hidden');
        this.elements.channelMenuBtn?.classList.add('hidden');
        this.elements.channelMenuBtnMobile?.classList.add('hidden');
        this.elements.closeChannelBtn?.classList.add('hidden');
        this.elements.closeChannelBtnDesktop?.classList.add('hidden');
        this.elements.onlineHeader?.classList.add('hidden');
        this.elements.onlineHeader?.classList.remove('flex');
        this.elements.onlineSeparator?.classList.add('hidden');
        
        // Hide pinned banner (disconnected)
        pinnedBannerUI.update();
        subscriptionBannerUI.update();
        
        // Reset online users
        this._resetOnlineUsers();
        
        // Clear messages
        if (this.elements.messagesArea) {
            this.elements.messagesArea.innerHTML = '';
        }
    }

    /**
     * Update online users display for current channel
     * @param {string} streamId - Stream ID
     * @private
     */
    _updateOnlineUsers(streamId) {
        const users = channelManager.getOnlineUsers(streamId);
        onlineUsersUI.updateOnlineUsers(
            this.elements.onlineUsersCount,
            this.elements.onlineUsersList,
            users
        );
    }

    /**
     * Reset online users display
     * @private
     */
    _resetOnlineUsers() {
        if (this.elements.onlineUsersList) {
            this.elements.onlineUsersList.innerHTML = '<div class="text-white/30 text-sm text-center">No one online</div>';
        }
        if (this.elements.onlineUsersCount) {
            this.elements.onlineUsersCount.textContent = '0';
        }
    }
}

// Singleton instance
export const channelViewUI = new ChannelViewUI();
