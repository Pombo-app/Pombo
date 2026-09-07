/**
 * UI Controller
 * Manages DOM manipulation, rendering, and QR code generation
 */

import { channelManager } from './channels.js';
import { epochKeyManager } from './epochKeyManager.js';
import { authManager } from './auth.js';
import { identityManager } from './identity.js';
import { notificationManager } from './notifications.js';
import { graphAPI } from './graph.js';
import { secureStorage } from './secureStorage.js';
import { Logger } from './logger.js';
import { mediaController } from './media.js';
import { storageMediaController } from './storageMedia.js';
import { streamrController } from './streamr.js';
import { subscriptionManager } from './subscriptionManager.js';
import { historyManager } from './historyManager.js';
import { relayManager } from './relayManager.js';
import { dmManager } from './dm.js';
import { syncManager } from './syncManager.js';
import { openUnjoinedChannel } from './channelEntry.js';
import { CONFIG } from './config.js';

// UI Modules
import { notificationUI } from './ui/NotificationUI.js';
import { sanitizeText } from './ui/sanitizer.js';
import { escapeHtml as _escapeHtml, escapeAttr as _escapeAttr, formatAddress as _formatAddress, isValidMediaUrl as _isValidMediaUrl } from './ui/utils.js';
import { reactionManager } from './ui/ReactionManager.js';
import { onlineUsersUI } from './ui/OnlineUsersUI.js';
import { dropdownManager } from './ui/DropdownManager.js';
import { mediaHandler } from './ui/MediaHandler.js';
import { messageRenderer } from './ui/MessageRenderer.js';
import { analyzeMessageGroups, getGroupPositionClass, analyzeSpacing, getSpacingClass } from './ui/MessageGrouper.js';
import { modalManager } from './ui/ModalManager.js';
import { settingsUI } from './ui/SettingsUI.js';
import { exploreUI } from './ui/ExploreUI.js';
import { channelSettingsUI } from './ui/ChannelSettingsUI.js';
import { contactsUI } from './ui/ContactsUI.js';
import { messageContextMenuUI } from './ui/MessageContextMenuUI.js';
import { pinnedBannerUI } from './ui/PinnedBannerUI.js';
import { subscriptionBannerUI } from './ui/SubscriptionBannerUI.js';
import { channelListUI } from './ui/ChannelListUI.js';
import { chatAreaUI } from './ui/ChatAreaUI.js';
import { inputUI } from './ui/InputUI.js';
import { headerUI } from './ui/HeaderUI.js';
import { previewModeUI } from './ui/PreviewModeUI.js';
import { channelModalsUI } from './ui/ChannelModalsUI.js';
import { dmModalsUI } from './ui/DMModalsUI.js';
import { init as initJoinChannelUI, getInstance as getJoinChannelUI } from './ui/JoinChannelUI.js';
import { inviteUI } from './ui/InviteUI.js';
import { channelViewUI } from './ui/ChannelViewUI.js';

// Event wiring
import { attachChannelForm } from './ui/wiring/channelForm.js';
import { attachChannelFilters } from './ui/wiring/channelFilters.js';
import { attachChannelStorage } from './ui/wiring/channelStorage.js';
import { attachOnlineUsers } from './ui/wiring/onlineUsers.js';
import { attachChannelActions } from './ui/wiring/channelActions.js';
import { attachJoinFlows } from './ui/wiring/joinFlows.js';
import { attachComposer } from './ui/wiring/composer.js';
import { attachInvites } from './ui/wiring/invites.js';
import { attachChannelHeader } from './ui/wiring/channelHeader.js';
import { attachChannelSettings } from './ui/wiring/channelSettings.js';
import { attachContactModals } from './ui/wiring/contactModals.js';
import { attachMeshImages } from './ui/wiring/meshImages.js';
import { attachMeshProgress } from './ui/wiring/meshProgress.js';
import { attachMeshComplete } from './ui/wiring/meshComplete.js';
import { attachMeshServing } from './ui/wiring/meshServing.js';
import { attachStorageTransfers } from './ui/wiring/storageTransfers.js';

class UIController {
    constructor() {
        this.elements = {};
        
        // Reply state (kept for backward compatibility, synced with ChatAreaUI)
        this.replyingTo = null; // { id, text, sender, senderName }
        
        // Channel filter state (sidebar tabs: all/personal/community)
        this.currentChannelFilter = 'all';
        this.isFilterAnimating = false; // Prevent rapid swipes
        
        // Preview mode state - handled by previewModeUI module
        
        // Setup callbacks for UI modules
        this._setupModuleCallbacks();
    }

    /**
     * Get the currently active channel (preview or joined)
     * @returns {Object|null} Channel object or null
     */
    getActiveChannel() {
        return previewModeUI.getPreviewChannel() || channelManager.getCurrentChannel();
    }
    
    /**
     * Setup dependencies for UI modules
     */
    _setupModuleCallbacks() {
        // ReactionManager
        reactionManager.setDependencies({
            getCurrentAddress: () => authManager.getAddress(),
            onSendReaction: (msgId, emoji, isRemoving) => {
                const channel = channelManager.getCurrentChannel();
                if (channel) {
                    channelManager.sendReaction(channel.streamId, msgId, emoji, isRemoving);
                } else if (previewModeUI.isInPreviewMode()) {
                    // Preview mode: send reaction directly via streamrController
                    previewModeUI.sendPreviewReaction(msgId, emoji, isRemoving);
                }
            }
        });
        
        // OnlineUsersUI
        onlineUsersUI.setDependencies({
            getCurrentAddress: () => authManager.getAddress(),
            onUserMenuAction: (action, address) => this.handleUserMenuAction(action, address)
        });
        
        // DropdownManager
        dropdownManager.setDependencies({
            onChannelMenuAction: (action) => this.handleChannelMenuAction(action)
        });
        
        // MediaHandler
        mediaHandler.setDependencies({
            showNotification: (msg, type) => this.showNotification(msg, type)
        });
        mediaHandler.initLightboxModal();
        
        // MessageRenderer
        messageRenderer.setDependencies({
            getCurrentAddress: () => authManager.getAddress(),
            getMessageReactions: (msgId) => reactionManager.getReactions(msgId),
            registerMedia: (url, type) => mediaHandler.registerMedia(url, type),
            getImage: (imageId) => mediaController.getImage(imageId),
            cacheImage: (imageId, data) => mediaController.cacheImage(imageId, data),
            loadImageFromLedger: (imageId) => {
                secureStorage.getImageBlob(imageId).then(data => {
                    if (data) {
                        mediaController.handleImageData({ type: 'image_data', imageId, data });
                    }
                }).catch(() => {});
            },
            recoverImage: (imageId) => mediaController.recoverImage(imageId),
            getCurrentChannel: () => this.getActiveChannel(),
            getFileUrl: (fileId) => mediaController.getFileUrl(fileId),
            isSeeding: (fileId) => mediaController.isSeeding(fileId),
            isSaved: (fileId) => mediaHandler.isSaved(fileId),
            isDownloading: (fileId) => mediaController.isDownloading(fileId),
            getDownloadProgress: (fileId) => mediaController.getDownloadProgress(fileId),
            isVideoPlayable: (fileType) => mediaController.isVideoPlayable(fileType),
            getYouTubeEmbedsEnabled: () => secureStorage.getYouTubeEmbedsEnabled(),
            // Persistent (storage-node) transfers
            getStorageFileUrl: (tid) => storageMediaController.getFileUrl(tid),
            isStorageDownloading: (tid) => storageMediaController.isDownloading(tid),
            getStorageDownloadProgress: (tid) => storageMediaController.getDownloadProgress(tid),
            getStorageUploadState: (tid) => storageMediaController.getUploadState(tid),
            getStorageResumePercent: (tid) => storageMediaController.getResumePercent(tid),
            isStorageSaved: (tid) => mediaHandler.isStorageSaved(tid)
        });
        
        // SettingsUI - All settings functionality
        settingsUI.setDependencies({
            authManager,
            secureStorage,
            channelManager,
            streamrController,
            mediaController,
            identityManager,
            graphAPI,
            Logger,
            modalManager,
            notificationManager,
            relayManager,
            notificationUI,
            contactsUI,
            dmManager,
            syncManager,
            showCreateDMInboxModal: () => dmModalsUI.showCreateInboxModal(),
            showNotification: (msg, type) => this.showNotification(msg, type),
            updateWalletInfo: (address, isGuest) => headerUI.updateWalletInfo(address, isGuest),
            updateDisplayName: (username) => headerUI.updateDisplayName(username),
            updateNetworkStatus: () => {},
            renderChannelList: () => this.renderChannelList(),
            resetToDisconnectedState: () => this.resetToDisconnectedState(),
            isMobileView: () => this.isMobileView(),
            showExploreView: () => this.showExploreView()
        });
        
        // ExploreUI
        exploreUI.setDependencies({
            getPublicChannels: () => channelManager.getPublicChannels(),
            joinPublicChannel: (streamId, channelInfo) => this.joinPublicChannel(streamId, channelInfo),
            enterPreviewMode: (streamId, channelInfo) => previewModeUI.enterPreviewMode(streamId, channelInfo),
            getNsfwEnabled: () => secureStorage.getNsfwEnabled()
        });
        
        // ChannelSettingsUI
        channelSettingsUI.setDependencies({
            channelManager,
            streamrController,
            authManager,
            subscriptionManager,
            showNotification: (msg, type) => this.showNotification(msg, type),
            showLoading: (msg) => this.showLoading(msg),
            hideLoading: () => this.hideLoading(),
            getChannelTypeLabel: (type, readOnly, showLabel) => headerUI.getChannelTypeLabel(type, readOnly, showLabel),
            renderChannelList: () => this.renderChannelList(),
            selectChannel: (streamId) => this.selectChannel(streamId),
            showConnectedNoChannelState: () => this.showConnectedNoChannelState(),
            getActiveChannel: () => this.getActiveChannel(),
            isInPreviewMode: () => previewModeUI.isInPreviewMode()
        });
        
        // ContactsUI
        contactsUI.setDependencies({
            identityManager,
            settingsUI,
            showNotification: (msg, type) => this.showNotification(msg, type),
            showLoading: (msg) => this.showLoading(msg),
            hideLoading: () => this.hideLoading(),
            renderChannelList: () => this.renderChannelList()
        });

        // MessageContextMenuUI — owns the right-click menu on messages
        messageContextMenuUI.setDependencies({
            Logger,
            channelManager,
            identityManager,
            dmManager,
            chatAreaUI,
            contactsUI,
            showNotification: (msg, type) => this.showNotification(msg, type),
            renderChannelList: () => this.renderChannelList(),
            selectChannel: (streamId) => this.selectChannel(streamId),
            showConnectedNoChannelState: () => this.showConnectedNoChannelState()
        });

        // PinnedBannerUI — top-of-chat banner showing the latest pinned message
        pinnedBannerUI.setDependencies({
            Logger,
            channelManager,
            chatAreaUI,
            getActiveChannel: () => this.getActiveChannel()
        });

        // SubscriptionBannerUI — paid-gate expiry warning + renew flow (N-F)
        subscriptionBannerUI.setDependencies({
            Logger,
            channelManager,
            authManager,
            onRenew: (channel) => {
                channelModalsUI.showGateEntryModal({
                    streamId: channel.streamId,
                    gateAddress: channel.gate.address,
                    name: channel.name,
                    renewal: true,
                    retry: async () => {
                        subscriptionBannerUI.noteRenewed(channel.streamId);
                        // Key requests sent while expired were refused
                        // silently — ask again now that the chain grants us
                        try { await epochKeyManager.retryRequestIfWaiting(channel); }
                        catch (e) { Logger.debug('post-renewal key request failed:', e.message); }
                        chatAreaUI.renderMessages(channel.messages || [],
                            () => this.attachReactionListeners());
                    }
                });
            },
            onStatusResolved: (streamId) => {
                // Swap the empty-state ("waiting for keys" ↔ "expired") once
                // the chain read lands; cheap, only fires on an empty timeline
                const ch = channelManager.getCurrentChannel?.();
                if (ch?.streamId === streamId && !(ch.messages?.length > 0)) {
                    chatAreaUI.renderMessages(ch.messages || []);
                }
            }
        });

        // ChannelListUI
        channelListUI.setDependencies({
            channelManager,
            secureStorage,
            onChannelSelect: (streamId) => this.selectChannel(streamId)
        });

        // ChannelModalsUI
        channelModalsUI.setDependencies({
            channelManager,
            modalManager,
            notificationUI,
            Logger,
            showNotification: (msg, type) => this.showNotification(msg, type),
            renderChannelList: () => this.renderChannelList(),
            selectChannel: (streamId) => this.selectChannel(streamId)
        });

        // DMModalsUI
        dmModalsUI.setDependencies({
            dmManager,
            modalManager,
            authManager,
            notificationUI,
            Logger,
            showNotification: (msg, type) => this.showNotification(msg, type),
            renderChannelList: () => this.renderChannelList()
        });
    }
    
    /**
     * Initialize UI elements and event listeners
     */
    init() {
        // Cache DOM elements
        this.elements = {
            // Header
            walletInfo: document.getElementById('wallet-info'),
            connectWalletBtn: document.getElementById('connect-wallet'),
            disconnectWalletBtn: document.getElementById('disconnect-wallet'),
            switchWalletBtn: document.getElementById('switch-wallet'),
            contactsBtn: document.getElementById('contacts-btn'),
            globalSyncIndicator: document.getElementById('global-sync-indicator'),
            globalSyncText: document.getElementById('global-sync-text'),
            // Desktop account dropdown
            desktopAccountWrapper: document.getElementById('desktop-account-wrapper'),
            desktopAccountBtn: document.getElementById('desktop-account-btn'),
            desktopAccountAvatar: document.getElementById('desktop-account-avatar'),
            desktopAccountName: document.getElementById('desktop-account-name'),
            desktopAccountDropdown: document.getElementById('desktop-account-dropdown'),
            desktopDropdownAddress: document.getElementById('desktop-dropdown-address'),

            // Sidebar
            channelList: document.getElementById('channel-list'),
            newChannelBtn: document.getElementById('new-channel-btn'),

            // Chat area
            chatHeader: document.getElementById('chat-header'),
            currentChannelName: document.getElementById('current-channel-name'),
            currentChannelInfo: document.getElementById('current-channel-info'),
            currentChannelThumb: document.getElementById('current-channel-thumb'),
            channelMenuBtn: document.getElementById('channel-menu-btn'),
            channelMenuBtnMobile: document.getElementById('channel-menu-btn-mobile'),
            closeChannelBtn: document.getElementById('close-channel-btn'),
            messagesArea: document.getElementById('messages-area'),
            pinnedBanner: document.getElementById('pinned-banner'),
            pinnedBannerName: document.getElementById('pinned-banner-name'),
            pinnedBannerText: document.getElementById('pinned-banner-text'),
            pinnedBannerCount: document.getElementById('pinned-banner-count'),
            pinnedBannerClose: document.getElementById('pinned-banner-close'),
            subscriptionBanner: document.getElementById('subscription-banner'),
            subscriptionBannerText: document.getElementById('subscription-banner-text'),
            subscriptionBannerRenew: document.getElementById('subscription-banner-renew'),
            subscriptionBannerDismiss: document.getElementById('subscription-banner-dismiss'),
            messageInput: document.getElementById('message-input'),
            messageInputContainer: document.getElementById('message-input-container'),
            sendMessageBtn: document.getElementById('send-message-btn'),

            // Modals
            newChannelModal: document.getElementById('new-channel-modal'),
            channelNameInput: document.getElementById('channel-name-input'),
            channelPasswordInput: document.getElementById('channel-password-input'),
            channelPasswordConfirmInput: document.getElementById('channel-password-confirm-input'),
            passwordConfirmSection: document.getElementById('password-confirm-section'),
            channelMembersInput: document.getElementById('channel-members-input'),
            // Exposure/visibility fields
            exposureSection: document.getElementById('exposure-section'),
            visibleFields: document.getElementById('visible-fields'),
            channelDescriptionInput: document.getElementById('channel-description-input'),
            channelLanguageInput: document.getElementById('channel-language-input'),
            channelCategoryInput: document.getElementById('channel-category-input'),
            createChannelBtn: document.getElementById('create-channel-btn'),
            cancelChannelBtn: document.getElementById('cancel-channel-btn'),

            // Online users
            onlineHeader: document.getElementById('online-header'),
            onlineSeparator: document.getElementById('online-separator'),
            onlineUsersCount: document.getElementById('online-users-count'),
            onlineUsersList: document.getElementById('online-users-list'),

            joinChannelModal: document.getElementById('join-channel-modal'),
            joinStreamIdInput: document.getElementById('join-stream-id-input'),
            joinPasswordInput: document.getElementById('join-password-input'),
            joinPasswordField: document.getElementById('join-password-field'),
            joinBtn: document.getElementById('join-btn'),
            cancelJoinBtn: document.getElementById('cancel-join-btn'),

            // Join button (preview mode)
            joinChannelBtn: document.getElementById('join-channel-btn'),
            
            // Invite modal
            inviteUsersBtn: document.getElementById('invite-users-btn'),
            inviteUsersModal: document.getElementById('invite-users-modal'),
            inviteAddressInput: document.getElementById('invite-address-input'),
            inviteLinkDisplay: document.getElementById('invite-link-display'),
            copyInviteLinkBtn: document.getElementById('copy-invite-link-btn'),
            showQrBtn: document.getElementById('show-qr-btn'),
            sendInviteBtn: document.getElementById('send-invite-btn'),
            cancelInviteBtn: document.getElementById('cancel-invite-btn'),

            // Channel settings modal
            channelInfoBtn: document.getElementById('channel-info-btn'),
            channelSettingsModal: document.getElementById('channel-settings-modal'),
            channelSettingsType: document.getElementById('channel-settings-type'),
            channelSettingsId: document.getElementById('channel-settings-id'),
            channelSettingsName: document.getElementById('channel-settings-name'),
            channelNameSection: document.getElementById('channel-name-section'),
            editChannelNameBtn: document.getElementById('edit-channel-name-btn'),
            channelNameEditContainer: document.getElementById('channel-name-edit-container'),
            channelSettingsNameInput: document.getElementById('channel-settings-name-input'),
            saveChannelNameBtn: document.getElementById('save-channel-name-btn'),
            cancelChannelNameBtn: document.getElementById('cancel-channel-name-btn'),
            channelSettingsDescriptionInput: document.getElementById('channel-settings-description-input'),
            channelEditActions: document.getElementById('channel-edit-actions'),
            membersSection: document.getElementById('members-section'),
            descriptionSection: document.getElementById('channel-description-section'),
            channelDescriptionDisplay: document.getElementById('channel-description-display'),
            channelStorageRetentionReadonly: document.getElementById('channel-storage-retention-readonly'),
            channelStorageRetentionEditor: document.getElementById('channel-storage-retention-editor'),
            channelStorageRetentionMixed: document.getElementById('channel-storage-retention-mixed'),
            channelStorageRetentionMixedText: document.getElementById('channel-storage-retention-mixed-text'),
            channelStorageRetentionInput: document.getElementById('channel-storage-retention-input'),
            channelStorageRetentionSave: document.getElementById('channel-storage-retention-save'),
            channelStorageNodesList: document.getElementById('channel-storage-nodes-list'),
            channelStorageAddSection: document.getElementById('channel-storage-add-section'),
            channelStorageAddToggleBtn: document.getElementById('channel-storage-add-toggle-btn'),
            channelStorageAddForm: document.getElementById('channel-storage-add-form'),
            channelStorageCustomAddress: document.getElementById('channel-storage-custom-address'),
            channelStorageAddCancel: document.getElementById('channel-storage-add-cancel'),
            channelStorageAddConfirm: document.getElementById('channel-storage-add-confirm'),
            channelStorageGasWarning: document.getElementById('channel-storage-gas-warning'),
            channelStorageNoStorage: document.getElementById('channel-storage-no-storage'),
            refreshMembersBtn: document.getElementById('refresh-members-btn'),
            addMemberForm: document.getElementById('add-member-form'),
            addMemberInput: document.getElementById('add-member-input'),
            addMemberBtn: document.getElementById('add-member-btn'),
            batchMembersInput: document.getElementById('batch-members-input'),
            batchAddMembersBtn: document.getElementById('batch-add-members-btn'),
            membersList: document.getElementById('members-list'),
            permissionsSection: document.getElementById('permissions-section'),
            permissionsList: document.getElementById('permissions-list'),
            refreshPermissionsBtn: document.getElementById('refresh-permissions-btn'),
            closeChannelSettingsBtn: document.getElementById('close-channel-settings-btn'),
            dangerTabDivider: document.getElementById('danger-tab-divider'),
            dangerTabBtn: document.getElementById('danger-tab-btn'),
            deleteChannelSection: document.getElementById('delete-channel-section'),
            deleteChannelBtn: document.getElementById('delete-channel-btn'),
            channelSettingsTabs: document.querySelectorAll('.channel-settings-tab'),
            channelSettingsPanels: document.querySelectorAll('.channel-settings-panel'),

            // Delete channel confirmation modal
            deleteChannelModal: document.getElementById('delete-channel-modal'),
            deleteChannelName: document.getElementById('delete-channel-name'),
            cancelDeleteBtn: document.getElementById('cancel-delete-btn'),
            confirmDeleteBtn: document.getElementById('confirm-delete-btn'),

            // Join/Browse channels
            browseChannelsBtn: document.getElementById('browse-channels-btn'),
            browseBtnIcon: document.getElementById('browse-btn-icon'),
            browseBtnText: document.getElementById('browse-btn-text'),
            
            // Reply UI
            replyBar: document.getElementById('reply-bar'),
            replyToName: document.getElementById('reply-to-name'),
            replyToText: document.getElementById('reply-to-text'),
            replyBarClose: document.getElementById('reply-bar-close'),

            // Mobile navigation
            sidebar: document.getElementById('sidebar'),
            chatArea: document.getElementById('chat-area'),
            closeChannelBtnDesktop: document.getElementById('close-channel-btn-desktop'),
            chatHeaderRight: document.getElementById('chat-header-right'),
            
            // Explore type tabs
            exploreTypeTabs: document.getElementById('explore-type-tabs')
        };

        // Set element references for UI modules
        channelSettingsUI.setElements(this.elements);
        contactsUI.setElements(this.elements);
        messageContextMenuUI.setElements(this.elements);
        channelListUI.setElements(this.elements);
        channelModalsUI.setElements(this.elements);
        
        // Initialize JoinChannelUI with dependencies
        this.joinChannelUI = initJoinChannelUI({
            channelManager,
            modalManager,
            notificationUI,
            graphAPI,
            exploreUI,
            channelModalsUI,
            elements: this.elements
        });

        // Initialize InviteUI with dependencies
        inviteUI.setDependencies({
            channelManager,
            modalManager,
            showNotification: (msg, type, duration) => this.showNotification(msg, type, duration),
            showLoading: (msg) => this.showLoading(msg),
            hideLoading: () => this.hideLoading(),
            generateQRCode: (link) => this.generateQRCode(link)
        });
        inviteUI.setElements(this.elements);

        // Initialize ChannelViewUI with dependencies
        channelViewUI.setDependencies({
            channelManager,
            subscriptionManager,
            secureStorage,
            historyManager,
            previewModeUI,
            chatAreaUI,
            headerUI,
            reactionManager,
            mediaHandler,
            onlineUsersUI,
            exploreUI,
            inputUI,
            // Callbacks to UIController
            stopAccessHeartbeat: () => this.stopAccessHeartbeat(),
            startAccessHeartbeat: (streamId) => this.startAccessHeartbeat(streamId),
            setReplyingTo: (val) => { this.replyingTo = val; },
            updateReadOnlyUI: (channel) => this.updateReadOnlyUI(channel),
            attachReactionListeners: () => this.attachReactionListeners(),
            renderChannelList: () => this.renderChannelList(),
            openChatView: () => this.openChatView(),
            showExploreView: () => this.showExploreView(),
            isMobileView: () => this.isMobileView()
        });
        channelViewUI.setElements(this.elements);
        
        // Initialize ChatAreaUI with dependencies and elements
        chatAreaUI.setDependencies({
            channelManager,
            authManager,
            epochKeyManager,
            secureStorage,
            Logger,
            mediaController,
            storageMediaController,
            showNotification: (msg, type) => this.showNotification(msg, type),
            getActiveChannel: () => this.getActiveChannel()
        });
        chatAreaUI.init({
            messagesArea: this.elements.messagesArea,
            replyBar: this.elements.replyBar,
            replyToName: this.elements.replyToName,
            replyToText: this.elements.replyToText,
            messageInput: this.elements.messageInput
        });

        // Initialize InputUI with dependencies and elements
        inputUI.setDependencies({
            channelManager,
            mediaController,
            storageMediaController,
            Logger,
            showNotification: (msg, type) => this.showNotification(msg, type),
            showLoading: (msg) => this.showLoading(msg),
            hideLoading: () => this.hideLoading()
        });
        inputUI.init({
            messageInput: this.elements.messageInput,
            sendMessageBtn: this.elements.sendMessageBtn
        });

        // Initialize HeaderUI with elements
        headerUI.init({
            walletInfo: this.elements.walletInfo,
            connectWalletBtn: this.elements.connectWalletBtn,
            switchWalletBtn: this.elements.switchWalletBtn,
            contactsBtn: this.elements.contactsBtn,
            settingsBtn: document.getElementById('settings-btn'),
            globalSyncIndicator: this.elements.globalSyncIndicator,
            globalSyncText: this.elements.globalSyncText,
            currentChannelName: this.elements.currentChannelName,
            currentChannelInfo: this.elements.currentChannelInfo,
            currentChannelThumb: this.elements.currentChannelThumb,
            chatHeaderRight: this.elements.chatHeaderRight,
            desktopAccountWrapper: this.elements.desktopAccountWrapper,
            desktopAccountBtn: this.elements.desktopAccountBtn,
            desktopAccountAvatar: this.elements.desktopAccountAvatar,
            desktopAccountName: this.elements.desktopAccountName,
            desktopAccountDropdown: this.elements.desktopAccountDropdown,
            desktopDropdownAddress: this.elements.desktopDropdownAddress
        });

        // Initialize PreviewModeUI with dependencies
        previewModeUI.setDependencies({
            channelManager,
            subscriptionManager,
            graphAPI,
            reactionManager,
            chatAreaUI,
            headerUI,
            mediaHandler,
            identityManager,
            authManager,
            streamrController,
            notificationUI,
            historyManager
        });
        previewModeUI.setUIController({
            elements: this.elements,
            selectChannel: (streamId) => this.selectChannel(streamId),
            selectChannelWithoutHistory: (streamId) => this._selectChannelWithoutHistory(streamId),
            openExploreView: () => this.openExploreView(),
            openChatView: () => this.openChatView(),
            showNotification: (msg, type) => this.showNotification(msg, type),
            attachReactionListeners: () => this.attachReactionListeners(),
            renderChannelList: () => this.renderChannelList()
        });

        // Set up event listeners
        this.setupEventListeners();
        
        // Register activity handler for background channel updates
        this.setupActivityHandler();
        
        // Setup heartbeat for tracking channel access (handles abrupt app closure)
        this.setupAccessHeartbeat();
        
        // Initialize history manager for browser back/forward navigation
        historyManager.init((state) => this.navigateToState(state));

        Logger.info('UI Controller initialized');
    }
    
    /**
     * Setup heartbeat system for tracking channel access
     * This ensures lastAccess is saved even if app closes abruptly
     */
    setupAccessHeartbeat() {
        // Heartbeat interval (from CONFIG.channels.accessHeartbeatMs)
        this.HEARTBEAT_INTERVAL = CONFIG.channels.accessHeartbeatMs;
        this.heartbeatTimer = null;
        
        // Save access on page unload (best effort)
        window.addEventListener('beforeunload', () => {
            this.saveCurrentChannelAccess();
        });
        
        // Save access when tab becomes hidden (user switches tabs)
        document.addEventListener('visibilitychange', () => {
            if (document.hidden) {
                this.saveCurrentChannelAccess();
            }
        });
        
        // Save access on page hide (mobile browsers)
        window.addEventListener('pagehide', () => {
            this.saveCurrentChannelAccess();
        });
    }
    
    /**
     * Start heartbeat for current channel
     * @param {string} streamId - Channel stream ID
     */
    startAccessHeartbeat(streamId) {
        this.stopAccessHeartbeat();
        this.heartbeatStreamId = streamId;
        
        // Save immediately when entering channel
        secureStorage.setChannelLastAccess(streamId, Date.now());
        
        // Then save periodically
        this.heartbeatTimer = setInterval(() => {
            if (this.heartbeatStreamId) {
                secureStorage.setChannelLastAccess(this.heartbeatStreamId, Date.now());
            }
        }, this.HEARTBEAT_INTERVAL);
    }
    
    /**
     * Stop heartbeat and save final access time
     */
    stopAccessHeartbeat() {
        if (this.heartbeatTimer) {
            clearInterval(this.heartbeatTimer);
            this.heartbeatTimer = null;
        }
        
        // Save final access time
        if (this.heartbeatStreamId) {
            secureStorage.setChannelLastAccess(this.heartbeatStreamId, Date.now());
            this.heartbeatStreamId = null;
        }
    }
    
    /**
     * Save current channel access (for emergency saves on unload/hide)
     */
    saveCurrentChannelAccess() {
        const currentChannel = channelManager.getCurrentChannel();
        if (currentChannel) {
            // Use synchronous localStorage directly for reliability during unload
            const key = CONFIG.storageKeys.channelAccess(currentChannel.streamId);
            localStorage.setItem(key, Date.now().toString());
        }
    }
    
    /**
     * Setup handler for background channel activity updates
     * Updates unread badges when new messages are detected in background channels
     */
    setupActivityHandler() {
        // Wire preview message callback (avoids circular dependency with subscriptionManager)
        subscriptionManager.onPreviewMessage = (msg) => this.handlePreviewMessage(msg);
        // Wire preview override callback so -1/P1 edits/deletes apply during preview.
        // Mirrors channel-mode where text and override are dispatched through
        // separate handlers; without this, overrides would only flow via the
        // text-message branch (which gates on `id`/`text`/`sender` and would
        // drop the delete payload).
        subscriptionManager.onPreviewOverride = (msg) => previewModeUI.handlePreviewOverride(msg);
        // Wire preview admin-state callback so moderation is applied during preview
        subscriptionManager.onPreviewAdmin = (streamId, adminMsg) => previewModeUI.handlePreviewAdmin(streamId, adminMsg);
        
        subscriptionManager.onActivity((streamId, activity) => {
            Logger.debug('Background activity update:', streamId, activity);
            
            // Update unread badge in sidebar
            const countEl = document.querySelector(`[data-channel-count="${CSS.escape(streamId)}"]`);
            if (countEl && activity.unreadCount > 0) {
                countEl.textContent = activity.unreadCount >= 30 ? '+30' : activity.unreadCount;
                countEl.classList.remove('hidden', 'text-white/30', 'bg-white/[0.04]');
                countEl.classList.add('text-white', 'bg-[#F6851B]/20');
            }
        });
    }

    /**
     * Set up event listeners
     */
    setupEventListeners() {
        attachChannelForm(this);
        attachChannelFilters(this);
        attachChannelStorage(this);
        attachOnlineUsers(this);
        attachChannelActions(this);
        attachJoinFlows(this);
        attachComposer(this);
        attachInvites(this);
        attachChannelHeader(this);
        attachChannelSettings(this);
        attachContactModals(this);

        // Initialize contacts UI
        contactsUI.init();

        // Initialize message context menu UI
        messageContextMenuUI.init();

        // Initialize pinned-message banner UI
        pinnedBannerUI.init({
            banner: this.elements.pinnedBanner,
            name: this.elements.pinnedBannerName,
            text: this.elements.pinnedBannerText,
            count: this.elements.pinnedBannerCount,
            closeBtn: this.elements.pinnedBannerClose
        });

        // Initialize paid-subscription banner UI
        subscriptionBannerUI.init({
            banner: this.elements.subscriptionBanner,
            text: this.elements.subscriptionBannerText,
            renewBtn: this.elements.subscriptionBannerRenew,
            dismissBtn: this.elements.subscriptionBannerDismiss
        });

        // Initialize DM modals UI
        dmModalsUI.init();
        
        // Initialize settings UI (delegates to SettingsUI)
        settingsUI.init();
        
        // Initialize emoji picker
        this.initEmojiPicker();
        
        // Initialize attach button (delegates to InputUI)
        inputUI.initAttachButton();
        
        // Setup media controller handlers
        this.setupMediaHandlers();
        
        // Initialize reactions
        reactionManager.init();
    }

    /**
     * Render channel list (delegates to ChannelListUI)
     */
    renderChannelList() {
        channelListUI.setFilter(this.currentChannelFilter);
        channelListUI.render();
        // Update DM sidebar buttons visibility
        dmModalsUI.updateVisibility();
    }

    /**
     * Select and open a channel (delegates to ChannelViewUI)
     * @param {string} streamId - Stream ID
     */
    async selectChannel(streamId) {
        return channelViewUI.selectChannel(streamId, { pushHistory: true });
    }

    /**
     * Deselect current channel (delegates to ChannelViewUI)
     */
    async deselectChannel() {
        return channelViewUI.deselectChannel();
    }

    /**
     * Reset UI to disconnected state
     */
    resetToDisconnectedState() {
        // Clear typing indicator
        chatAreaUI.hideTypingIndicator();
        
        // Reset sending state
        inputUI.setIsSending(false);
        
        // Close any open modals first (using ModalManager)
        modalManager.hide('channel-settings-modal');
        modalManager.hide('invite-users-modal');
        modalManager.hide('delete-channel-modal');
        this.hideLeaveChannelModal();
        
        // Reset channel name and info
        this.elements.currentChannelName.textContent = 'Explore Channels';
        this.elements.currentChannelInfo.textContent = '';
        this.elements.currentChannelInfo.parentElement.classList.add('hidden');
        headerUI.clearChannelThumb();
        this.elements.messageInputContainer.classList.add('hidden');
        
        this.elements.inviteUsersBtn?.classList.add('hidden');
        this.elements.channelMenuBtn?.classList.add('hidden');
        this.elements.channelMenuBtnMobile?.classList.add('hidden');
        this.elements.closeChannelBtn?.classList.add('hidden');
        this.elements.closeChannelBtnDesktop?.classList.add('hidden');
        this.elements.onlineHeader?.classList.add('hidden');
        this.elements.onlineHeader?.classList.remove('flex');
        this.elements.onlineSeparator?.classList.add('hidden');
        
        // Reset online users list
        if (this.elements.onlineUsersList) {
            this.elements.onlineUsersList.innerHTML = '<div class="text-white/30 text-sm text-center">No one online</div>';
        }
        if (this.elements.onlineUsersCount) {
            this.elements.onlineUsersCount.textContent = '0';
        }
        
        // Clear messages area (will show loading or empty state)
        this.elements.messagesArea.innerHTML = '';
    }

    /**
     * Show connected but no channel selected state
     * Now shows the Explore view as the front-page
     */
    showConnectedNoChannelState() {
        this.showExploreView();
    }

    /**
     * Show the default connected view for the current device/layout.
     * @param {Object} options
     * @param {boolean} options.forceSidebarOnMobile - Close back to the sidebar on mobile after preparing the default view
     * @private
     */
    async _showDefaultConnectedView({ forceSidebarOnMobile = false } = {}) {
        const hasChannels = channelManager.getAllChannels().length > 0;
        const hasDMs = (dmManager.getConversations?.() || []).length > 0;

        if (this.isMobileView() && !hasChannels && !hasDMs) {
            const sidebar = this.elements.sidebar;
            const chatArea = this.elements.chatArea;
            sidebar?.style.setProperty('transition', 'none');
            chatArea?.style.setProperty('transition', 'none');

            channelManager.setCurrentChannel(null);
            this.openChatView();
            await this.showExploreView();
            document.querySelectorAll('.channel-item').forEach(item => {
                item.classList.remove('bg-white/[0.06]');
            });
            headerUI.setActivePillTab?.('explore');

            chatArea?.offsetHeight;
            requestAnimationFrame(() => {
                sidebar?.style.removeProperty('transition');
                chatArea?.style.removeProperty('transition');
            });

            historyManager.replaceState({ view: 'explore' });
            return;
        }

        await this.showExploreView();
        headerUI.setActivePillTab?.(this.isMobileView() ? 'chats' : 'explore');

        if (this.isMobileView() && forceSidebarOnMobile) {
            this.closeChatView();
        }

        historyManager.replaceState({ view: 'explore' });
    }

    /**
     * Reconcile the visible connected-state UI after sync has changed local runtime state.
     * @param {Object} options
     * @param {boolean} options.currentChannelRemoved - Whether the sync snapshot removed the currently open channel
     */
    async reconcileConnectedStateAfterSync({ currentChannelRemoved = false } = {}) {
        const state = historyManager.getInitialState();

        if ((state?.view === 'channel' || state?.view === 'preview') && state.streamId) {
            const deepLinkedChannel = channelManager.getChannel(state.streamId);
            if (deepLinkedChannel) {
                if (previewModeUI.isInPreviewMode()) {
                    await previewModeUI.exitPreviewMode(false);
                }
                await this._selectChannelWithoutHistory(state.streamId);
                historyManager.replaceState({ view: 'channel', streamId: state.streamId });
                return;
            }
        }

        if (!currentChannelRemoved && previewModeUI.isInPreviewMode()) {
            return;
        }

        if (!currentChannelRemoved && channelManager.getCurrentChannel()) {
            return;
        }

        if (previewModeUI.isInPreviewMode()) {
            await previewModeUI.exitPreviewMode(false);
        }

        await this._showDefaultConnectedView({ forceSidebarOnMobile: true });
    }

    /**
     * Open Explore view (unified for mobile/desktop)
     * Mobile: navigates to chat-area with Explore
     * Desktop: shows Explore inline
     */
    async openExploreView() {
        // Deselect any current channel first
        channelManager.setCurrentChannel(null);
        
        // Mobile: open chat area to show Explore
        this.openChatView();
        
        // Show Explore view
        await this.showExploreView();
        
        // Remove selection highlight from channel list
        document.querySelectorAll('.channel-item').forEach(item => {
            item.classList.remove('bg-white/[0.06]');
        });
        
        // Push to browser history (replace if current entry is an orphaned modal state)
        const isOrphanedModal = window.history.state?.modal;
        historyManager.pushState({ view: 'explore' }, isOrphanedModal);
    }

    /**
     * Navigate to a state (called by historyManager on popstate)
     * Does not push to history - used for back/forward navigation
     * @param {Object} state - State object { view, streamId?, channelInfo? }
     */
    async navigateToState(state) {
        if (!state || !state.view) {
            // Clear any preview state first
            if (previewModeUI.isInPreviewMode()) {
                await previewModeUI.exitPreviewMode(false);
            }
            
            // On mobile, go back to sidebar; on desktop, show explore
            if (this.isMobileView()) {
                this.closeChatView();
            } else {
                await this.showExploreView();
            }
            return;
        }

        Logger.debug('Navigating to state:', state);

        switch (state.view) {
            case 'channel':
                if (state.streamId) {
                    // Check if channel is in user's list
                    const channel = channelManager.getChannel(state.streamId);
                    if (channel) {
                        await this._selectChannelWithoutHistory(state.streamId);
                    } else {
                        // Channel not in list - clear preview and go back
                        if (previewModeUI.isInPreviewMode()) {
                            await previewModeUI.exitPreviewMode(false);
                        }
                        
                        // Go back to explore/sidebar
                        if (this.isMobileView()) {
                            this.closeChatView();
                        } else {
                            await this.showExploreView();
                        }
                        this.showNotification('Channel not found in your list', 'warning');
                    }
                }
                break;

            case 'preview':
                if (state.streamId) {
                    await previewModeUI.enterPreviewWithoutHistory(state.streamId, state.channelInfo);
                }
                break;

            case 'explore':
            default:
                // Clear preview state if active
                if (previewModeUI.isInPreviewMode()) {
                    await previewModeUI.exitPreviewMode(false);
                }
                
                // On mobile, back to explore means close chat view (show sidebar)
                // User can then click Explore button if they want explore view
                if (this.isMobileView()) {
                    this.closeChatView();
                } else {
                    await this.showExploreView();
                }
                break;
        }
    }

    /**
     * Process initial URL on app load (deep link handling)
     * Called after wallet connection when channels are loaded
     */
    async processInitialUrl() {
        const state = historyManager.getInitialState();
        
        if (!state || state.view === 'explore') {
            await this._showDefaultConnectedView();
            return;
        }

        Logger.info('Processing deep link:', state);

        switch (state.view) {
            case 'channel':
                if (state.streamId) {
                    const channel = channelManager.getChannel(state.streamId);
                    if (channel) {
                        await this._selectChannelWithoutHistory(state.streamId);
                        historyManager.replaceState(state);
                    } else {
                        await this._openDeepLinkedChannel(state.streamId);
                    }
                }
                break;

            case 'preview':
                if (state.streamId) {
                    await previewModeUI.enterPreviewWithoutHistory(state.streamId, state.channelInfo);
                    historyManager.replaceState(state);
                }
                break;

            default:
                await this.showExploreView();
                historyManager.replaceState({ view: 'explore' });
                break;
        }
    }

    /**
     * Open a `#/channel/<streamId>` link for a channel the user has not
     * joined. A link carries nothing but the id, so the type, name and gate
     * come from the chain and the routing is the one Explore uses for a card
     * tap: password prompts, gated raises the gate screen, public previews.
     * @private
     */
    async _openDeepLinkedChannel(streamId) {
        let channelInfo = null;
        try {
            channelInfo = await graphAPI.getChannelInfo(streamId);
        } catch (e) {
            Logger.warn('Deep link: could not read channel metadata:', e.message);
        }

        await openUnjoinedChannel(streamId, channelInfo, {
            enterPreviewMode: async (id, info) => {
                await previewModeUI.enterPreviewWithoutHistory(id, info);
                historyManager.replaceState({ view: 'preview', streamId: id });
            },
            joinPublicChannel: (id, info) => this.joinPublicChannel(id, info)
        });

        // A join can end without a channel: the password prompt and the gate
        // screen both return before the user has answered them. The URL still
        // points at the channel, so without this the app boots into an empty
        // pane behind the modal. The history entry a modal pushed for its own
        // back-button dismissal must survive, hence the guard.
        if (!channelManager.getCurrentChannel() && !previewModeUI.isInPreviewMode()) {
            await this._showDefaultConnectedView();
            if (!modalManager.hasOpenHistoryModal()) {
                historyManager.replaceState({ view: 'explore' });
            }
        }
    }

    /**
     * Select channel without pushing to history (for popstate handling)
     * @private
     */
    async _selectChannelWithoutHistory(streamId) {
        return channelViewUI.selectChannel(streamId, { pushHistory: false });
    }

    /**
     * Show Explore view inline in messages area (delegates to ChannelViewUI)
     */
    async showExploreView() {
        return channelViewUI.showExploreView();
    }

    /**
     * Update online users display
     * @param {string} streamId - Stream ID
     * @param {Array} users - Array of online users
     */
    updateOnlineUsers(streamId, users) {
        // Check if this is for the current channel
        const currentChannel = channelManager.getCurrentChannel();
        const isCurrentChannel = currentChannel && currentChannel.streamId === streamId;
        
        // Also check if this is for the preview channel
        const previewChannel = previewModeUI.getPreviewChannel();
        const isPreviewChannel = previewChannel && previewChannel.streamId === streamId;
        
        if (!isCurrentChannel && !isPreviewChannel) return;
        
        onlineUsersUI.updateOnlineUsers(this.elements.onlineUsersCount, this.elements.onlineUsersList, users);
    }
    
    /**
     * Attach event listeners for user dropdown menus
     */
    attachUserMenuListeners() {
        onlineUsersUI.attachUserMenuListeners();
    }
    
    /**
     * Close user dropdown menu
     */
    closeUserDropdown() {
        onlineUsersUI.closeUserDropdown();
    }
    
    /**
     * Show channel dropdown menu
     * @param {Event} e - Click event (currentTarget is the button clicked)
     */
    showChannelDropdown(e) {
        const currentChannel = this.getActiveChannel();
        if (!currentChannel) return;
        const isPreviewMode = previewModeUI.isInPreviewMode();
        // Use the actual button that was clicked for positioning
        const menuBtn = e.currentTarget || this.elements.channelMenuBtn;
        dropdownManager.showChannelDropdown(e, menuBtn, currentChannel, isPreviewMode);
    }
    
    /**
     * Close channel dropdown menu
     */
    closeChannelDropdown() {
        dropdownManager.closeChannelDropdown();
    }
    
    /**
     * Handle channel menu action
     */
    async handleChannelMenuAction(action) {
        const currentChannel = this.getActiveChannel();
        if (!currentChannel) return;
        
        switch (action) {
            case 'copy-stream-id':
                try {
                    await navigator.clipboard.writeText(currentChannel.streamId);
                    this.showNotification('Channel ID copied!', 'success');
                } catch {
                    this.showNotification('Failed to copy', 'error');
                }
                break;
                
            case 'channel-settings':
                channelSettingsUI.show();
                break;
                
            case 'show-pinned':
                pinnedBannerUI.showAndScroll();
                break;
                
            case 'leave-channel':
                channelSettingsUI.showLeaveModal();
                break;
        }
    }
    
    /**
     * Handle user menu action
     */
    async handleUserMenuAction(action, address) {
        switch (action) {
            case 'copy-address':
                try {
                    await navigator.clipboard.writeText(address);
                    this.showNotification('Address copied!', 'success');
                } catch {
                    this.showNotification('Failed to copy', 'error');
                }
                break;
                
            case 'add-contact':
                this.showAddContactModal(address);
                break;
                
            case 'start-dm':
                dmModalsUI.showNewDMModalWithAddress(address);
                break;
        }
    }

    /**
     * Attach reaction button listeners
     */
    attachReactionListeners() {
        reactionManager.attachReactionListeners(
            (msgId) => {
                chatAreaUI.startReply(msgId);
                this.replyingTo = chatAreaUI.getReplyingTo();
            },
            (fileId) => this.handleFileDownload(fileId),
            (msgId) => chatAreaUI.scrollToMessage(msgId),
            (transferId, msgId) => this.handleStorageFileDownload(transferId, msgId)
        );
    }

    /**
     * Handle file download button click
     */
    async handleFileDownload(fileId) {
        const channel = this.getActiveChannel();
        if (!channel) {
            this.showNotification('No active channel', 'error');
            return;
        }
        await mediaHandler.handleFileDownload(fileId, channel, mediaController);
    }

    /**
     * Handle storage (persistent) file download button click.
     * The chunks come from the channel's storage nodes, not a live swarm.
     */
    async handleStorageFileDownload(transferId, msgId) {
        const channel = this.getActiveChannel();
        if (!channel) {
            this.showNotification('No active channel', 'error');
            return;
        }
        const msg = channel.messages.find(m =>
            (msgId && m.id === msgId) || m.metadata?.transferId === transferId);
        if (!msg || !msg.metadata) {
            this.showNotification('File announce not found', 'error');
            return;
        }
        // Spinner on the button while the transfer spins up
        const btn = document.querySelector(`.storage-download-btn[data-file-id="${CSS.escape(transferId)}"]`);
        if (btn) {
            btn.querySelector('.download-play-icon')?.classList.add('hidden');
            const loading = btn.querySelector('.download-loading-icon');
            if (loading) {
                loading.classList.remove('hidden');
                loading.innerHTML = '<div class="w-4 h-4 border-2 border-white/60 border-t-transparent rounded-full animate-spin"></div>';
            }
            btn.disabled = true;
        }
        try {
            await storageMediaController.downloadFile(channel.streamId, msg, channel.password);
        } catch (error) {
            this.showNotification('Download failed: ' + error.message, 'error');
        }
    }

    /**
     * Initialize emoji picker
     */
    initEmojiPicker() {
        reactionManager.initEmojiPicker(this.elements.messageInput);
    }
    
    /**
     * Setup media controller event handlers
     */
    setupMediaHandlers() {
        attachMeshImages(this);
        attachMeshProgress(this);
        attachMeshComplete(this);
        attachMeshServing(this);
        attachStorageTransfers(this);

        // Seeder update
        mediaController.onSeederUpdate((fileId, count) => {
            const seederEl = document.querySelector(`[data-seeder-count="${CSS.escape(fileId)}"]`);
            if (seederEl) {
                seederEl.textContent = `${count} seeder${count !== 1 ? 's' : ''}`;
            }
        });
    }

    /**
     * Handle preview message - delegates to PreviewModeUI
     * Required for subscriptionManager callback
     * @param {Object} message - Message object
     */
    handlePreviewMessage(message) {
        previewModeUI.handlePreviewMessage(message);
    }

    /**
     * Handle send message
     */
    async handleSendMessage() {
        // DEBOUNCE: Prevent rapid double-clicks from sending duplicates
        if (inputUI.getIsSending()) {
            return;
        }
        
        const text = inputUI.getValue();
        if (!text) return;

        // Check if in edit mode
        const editState = chatAreaUI.getEditingMessage();
        if (editState) {
            // Edit mode: send edit override instead of new message
            inputUI.setIsSending(true);
            try {
                inputUI.clear();
                chatAreaUI.cancelEdit();
                await channelManager.sendEdit(editState.streamId, editState.id, text);
            } catch (error) {
                this.showNotification('Failed to edit message: ' + error.message, 'error');
            } finally {
                inputUI.setIsSending(false);
            }
            return;
        }

        // Check if in preview mode or normal channel mode
        const currentChannel = channelManager.getCurrentChannel();
        const isPreviewMode = previewModeUI.isInPreviewMode();
        
        if (!currentChannel && !isPreviewMode) return;

        // Lock sending state
        inputUI.setIsSending(true);
        
        try {
            // Capture reply context before clearing
            const replyTo = this.replyingTo;
            
            // Clear input and reply bar
            inputUI.clear();
            chatAreaUI.cancelReply(); // Clear reply state
            this.replyingTo = null;
            
            if (isPreviewMode) {
                // Send message in preview mode via streamrController directly
                await previewModeUI.sendPreviewMessage(text, replyTo);
            } else {
                await channelManager.sendMessage(currentChannel.streamId, text, replyTo);
            }
            // UI update happens via notifyHandlers -> addMessage (or handlePreviewMessage)
        } catch (error) {
            this.showNotification('Failed to send message: ' + error.message, 'error');
        } finally {
            // Always unlock sending state
            inputUI.setIsSending(false);
        }
    }

    // =========================================
    // Mobile Navigation Methods
    // =========================================

    /**
     * Check if we're on mobile viewport
     * Also treats landscape with very short height as mobile (phones rotated, small tablets)
     */
    isMobileView() {
        if (window.innerWidth < 768) return true;
        // Landscape mobile: wide enough for desktop but too short vertically
        if (window.innerHeight <= 500 && window.matchMedia('(orientation: landscape)').matches) return true;
        return false;
    }

    /**
     * Open chat view (mobile: push navigation from sidebar)
     */
    openChatView() {
        if (this.isMobileView()) {
            this.elements.sidebar?.classList.add('chat-active');
            this.elements.chatArea?.classList.add('active');
            document.body.classList.add('chat-open');
        }
    }

    /**
     * Close chat view and return to sidebar (mobile back navigation)
     */
    closeChatView() {
        if (this.isMobileView()) {
            this.elements.sidebar?.classList.remove('chat-active');
            this.elements.chatArea?.classList.remove('active');
            document.body.classList.remove('chat-open', 'explore-open');
            // Clean up any dangling modal body classes
            document.body.classList.remove('settings-open', 'contacts-open', 'new-channel-open');
            // Reset pill tab to chats
            headerUI.setActivePillTab('chats');
        }
    }

    /**
     * Switch channel filter tab in sidebar (All/Personal/Communities)
     * @param {string} filter - Filter to apply ('all', 'personal', 'community')
     * @param {number} direction - Direction of swipe (-1 = right/prev, 1 = left/next, 0 = click)
     */
    switchChannelFilterTab(filter, direction = 0) {
        // Animation lock for swipes
        if (direction !== 0 && this.isFilterAnimating) return;
        if (direction !== 0) this.isFilterAnimating = true;
        
        document.querySelectorAll('.channel-filter-tab').forEach(tab => {
            const isActive = tab.dataset.channelFilter === filter;
            
            // Border bottom indicator for active state
            tab.classList.toggle('border-[#F6851B]', isActive);
            tab.classList.toggle('border-transparent', !isActive);
            tab.classList.toggle('text-[#F6851B]', isActive);
            tab.classList.toggle('text-white/40', !isActive);
            tab.classList.toggle('hover:text-white/60', !isActive);
        });
        
        this.currentChannelFilter = filter;
        
        // Animate channel list on mobile swipe
        const channelList = this.elements.channelList;
        if (this.isMobileView() && direction !== 0 && channelList) {
            // Fade out with slide
            channelList.style.transition = 'opacity 0.15s ease, transform 0.15s ease';
            channelList.style.opacity = '0';
            channelList.style.transform = direction > 0 ? 'translateX(-20px)' : 'translateX(20px)';
            
            setTimeout(() => {
                this.renderChannelList();
                
                // Slide in from opposite direction
                channelList.style.transition = 'none';
                channelList.style.transform = direction > 0 ? 'translateX(20px)' : 'translateX(-20px)';
                
                // Trigger reflow
                channelList.offsetHeight;
                
                channelList.style.transition = 'opacity 0.2s ease, transform 0.2s ease';
                channelList.style.opacity = '1';
                channelList.style.transform = 'translateX(0)';
                
                // Cleanup
                setTimeout(() => {
                    channelList.style.transition = '';
                    channelList.style.transform = '';
                    channelList.style.opacity = '';
                    this.isFilterAnimating = false;
                }, 200);
            }, 150);
        } else {
            this.renderChannelList();
            this.isFilterAnimating = false;
        }
    }

    /**
     * Initialize swipe gestures for channel filter tabs (mobile)
     * Allows swiping left/right on channel list to switch between All/Personal/Communities
     */
    initChannelFilterSwipe() {
        const channelList = this.elements.channelList;
        if (!channelList) return;

        const filterOrder = ['all', 'personal', 'community'];
        let touchStartX = 0;
        let touchStartY = 0;
        let isSwiping = false;

        channelList.addEventListener('touchstart', (e) => {
            touchStartX = e.touches[0].clientX;
            touchStartY = e.touches[0].clientY;
            isSwiping = true;
        }, { passive: true });

        channelList.addEventListener('touchend', (e) => {
            if (!isSwiping || !this.isMobileView()) return;

            const touchEndX = e.changedTouches[0].clientX;
            const touchEndY = e.changedTouches[0].clientY;
            const diffX = touchStartX - touchEndX;
            const diffY = touchStartY - touchEndY;

            // Require horizontal swipe > 50px and more horizontal than vertical (1.5x)
            if (Math.abs(diffX) > 50 && Math.abs(diffX) > Math.abs(diffY) * 1.5) {
                const currentIndex = filterOrder.indexOf(this.currentChannelFilter);
                let newIndex;

                if (diffX > 0) {
                    // Swipe left - go to next tab
                    newIndex = Math.min(currentIndex + 1, filterOrder.length - 1);
                } else {
                    // Swipe right - go to previous tab
                    newIndex = Math.max(currentIndex - 1, 0);
                }

                if (newIndex !== currentIndex) {
                    const direction = newIndex > currentIndex ? 1 : -1;
                    this.switchChannelFilterTab(filterOrder[newIndex], direction);
                }
            }

            isSwiping = false;
        }, { passive: true });
    }

    /**
     * Update UI for read-only channel state
     * Checks actual publish permission from blockchain via Streamr SDK
     * @param {Object} channel - Channel object
     */
    async updateReadOnlyUI(channel) {
        const messageInput = this.elements.messageInput;
        const sendBtn = document.querySelector('#send-btn');
        
        // Get current user address
        const currentAddress = authManager.getAddress();
        
        if (!currentAddress) {
            // No address - disable input
            this.setReadOnlyInputState(true);
            return;
        }

        // Check if we have cached permission for current user (valid for 1 min)
        const cacheValid = channel._publishPermCache?.address?.toLowerCase() === currentAddress.toLowerCase() &&
                          channel._publishPermCache?.timestamp && 
                          (Date.now() - channel._publishPermCache.timestamp) < 60000;
        
        if (cacheValid) {
            const canPublish = channel._publishPermCache.canPublish;
            this.setReadOnlyInputState(!canPublish, canPublish && channel.readOnly, !canPublish);
            
            // Update header label with cached permission result
            const effectiveReadOnly = !canPublish || channel.readOnly;
            if (this.elements.currentChannelInfo) {
                this.elements.currentChannelInfo.innerHTML = headerUI.getChannelTypeLabel(channel.type, effectiveReadOnly);
            }
            return;
        }

        // Default to enabled while checking (optimistic for public channels)
        // This prevents the annoying flash of "read-only" before verification completes
        if (channel.type === 'public' || channel.type === 'password') {
            this.setReadOnlyInputState(false);
        } else {
            this.setReadOnlyInputState(true);
        }

        // Check actual permission from blockchain via Streamr SDK
        try {
            const result = await streamrController.hasPublishPermission(channel.messageStreamId, true);
            
            // Handle RPC error - use optimistic approach for public channels
            if (result.rpcError) {
                Logger.warn('RPC error in updateReadOnlyUI, using optimistic state');
                
                // For public/password channels, assume user can publish
                // The server will reject if not allowed anyway
                if (channel.type === 'public' || channel.type === 'password') {
                    this.setReadOnlyInputState(false);
                    return;
                }
                
                // For gated/private channels, use cache or stay disabled for safety
                if (cacheValid) {
                    const cachedCanPublish = channel._publishPermCache.canPublish;
                    this.setReadOnlyInputState(!cachedCanPublish, cachedCanPublish && channel.readOnly, !cachedCanPublish);
                }
                return;
            }
            
            const canPublish = result.hasPermission;
            
            // Cache the result
            channel._publishPermCache = {
                address: currentAddress,
                canPublish: canPublish,
                timestamp: Date.now()
            };

            // Update UI based on actual permission
            // If channel is read-only and user can publish, show "broadcast" placeholder
            this.setReadOnlyInputState(!canPublish, canPublish && channel.readOnly, !canPublish);
            
            // Update header label to reflect actual read-only state (user cannot publish)
            const effectiveReadOnly = !canPublish || channel.readOnly;
            if (this.elements.currentChannelInfo) {
                this.elements.currentChannelInfo.innerHTML = headerUI.getChannelTypeLabel(channel.type, effectiveReadOnly);
            }
            
            Logger.debug('Permission check via SDK:', {
                channel: channel.name,
                canPublish: canPublish,
                readOnly: channel.readOnly,
                effectiveReadOnly: effectiveReadOnly
            });
        } catch (error) {
            Logger.warn('Failed to check publish permission:', error);
            // On error with public channel, stay optimistic
            if (channel.type === 'public' || channel.type === 'password') {
                this.setReadOnlyInputState(false);
            }
        }
    }

    /**
     * Helper to set input state for read-only channels
     * @param {boolean} disabled - Whether input should be disabled
     * @param {boolean} canBroadcast - Whether user can broadcast (has publish permission)
     */
    setReadOnlyInputState(disabled, canBroadcast = false, hide = false) {
        const messageInput = this.elements.messageInput;
        const sendBtn = document.querySelector('#send-btn');

        // Whoever the network would refuse gets no composer at all: a disabled
        // field is furniture that only says "not for you". The optimistic
        // states before an answer arrives keep their field.
        this.elements.messageInputContainer?.classList.toggle('hidden', hide);
        // Replying is writing: the reply affordances follow the composer.
        document.body.classList.toggle('cannot-write', hide);

        if (disabled) {
            if (messageInput) {
                messageInput.contentEditable = 'false';
                messageInput.dataset.placeholder = 'This channel is read-only';
                messageInput.classList.add('cursor-not-allowed', 'opacity-50');
            }
            if (sendBtn) {
                sendBtn.disabled = true;
                sendBtn.classList.add('opacity-50', 'cursor-not-allowed');
            }
        } else {
            if (messageInput) {
                messageInput.contentEditable = 'true';
                messageInput.dataset.placeholder = canBroadcast ? 'Type a message (broadcast)...' : 'Type a message...';
                messageInput.classList.remove('cursor-not-allowed', 'opacity-50');
            }
            if (sendBtn) {
                sendBtn.disabled = false;
                sendBtn.classList.remove('opacity-50', 'cursor-not-allowed');
            }
        }
    }

    // ========================================
    // Join Channel Methods (delegated to JoinChannelUI)
    // ========================================

    showJoinChannelModal() {
        this.joinChannelUI.showJoinChannelModal();
    }

    hideJoinChannelModal() {
        this.joinChannelUI.hideJoinChannelModal();
    }

    async handleQuickJoin(streamId) {
        return this.joinChannelUI.handleQuickJoin(
            (msg, type) => this.showNotification(msg, type),
            () => this.renderChannelList(),
            streamId
        );
    }

    /**
     * Show the quick join modal (mobile pill)
     */
    showQuickJoinModal() {
        const modal = document.getElementById('quick-join-modal');
        const input = document.getElementById('quick-join-modal-input');
        if (modal) {
            modal.classList.remove('hidden');
            setTimeout(() => input?.focus(), 100);
        }
    }

    /**
     * Handle join from the quick join modal
     * @private
     */
    async _handleQuickJoinModal() {
        const modal = document.getElementById('quick-join-modal');
        const input = document.getElementById('quick-join-modal-input');
        const streamId = input?.value.trim();

        if (!streamId) {
            this.showNotification('Please enter a channel ID', 'error');
            return;
        }

        // Hide modal
        modal?.classList.add('hidden');
        if (input) input.value = '';

        // Delegate to existing quick join logic with the streamId directly
        await this.handleQuickJoin(streamId);
    }

    async handleJoinChannel() {
        return this.joinChannelUI.handleJoinChannel(
            (msg, type) => this.showNotification(msg, type),
            () => this.renderChannelList()
        );
    }

    async joinPublicChannel(streamId, channelInfo = null) {
        return this.joinChannelUI.joinPublicChannel(
            streamId,
            channelInfo,
            (msg, type) => this.showNotification(msg, type),
            () => this.renderChannelList(),
            (sid) => this.selectChannel(sid)
        );
    }

    showPasswordInputModal(title, message) {
        return this.joinChannelUI.showPasswordInputModal(title, message);
    }

    async generateQRCode(inviteLink) {
        return this.joinChannelUI.generateQRCode(
            inviteLink,
            (msg, type) => this.showNotification(msg, type)
        );
    }

    /**
     * Show loading indicator with spinner overlay (delegates to NotificationUI)
     */
    showLoading(message) {
        notificationUI.showLoading(message);
    }

    /**
     * Hide loading indicator (delegates to NotificationUI)
     */
    hideLoading() {
        notificationUI.hideLoading();
    }

    // ========================================
    // Contact Modal Methods (delegated to ContactsUI)
    // ========================================

    showAddContactModal(address) {
        contactsUI.showAddModal(address);
    }

    hideAddContactModal() {
        contactsUI.hideAddModal();
    }

    async confirmAddContact() {
        return contactsUI.confirmAdd();
    }

    showEditContactModal(address) {
        contactsUI.showEditModal(address);
    }

    hideEditContactModal() {
        contactsUI.hideEditModal();
    }

    async confirmEditContact() {
        return contactsUI.confirmEdit();
    }

    showRemoveContactModal(address, onRemoveCallback = null) {
        contactsUI.showRemoveModal(address, onRemoveCallback);
    }

    hideRemoveContactModal() {
        contactsUI.hideRemoveModal();
    }

    async confirmRemoveContact() {
        return contactsUI.confirmRemove();
    }

    // ========================================
    // Channel Settings Methods (delegated to ChannelSettingsUI)
    // ========================================

    hideChannelSettingsModal() {
        channelSettingsUI.hide();
    }

    hideLeaveChannelModal() {
        channelSettingsUI.hideLeaveModal();
    }

    /**
     * Show toast notification (delegates to NotificationUI)
     */
    showNotification(message, type = 'info', duration = 3000) {
        notificationUI.showNotification(message, type, duration);
    }

    // ========================================
    // Invite Modal Methods (delegated to InviteUI)
    // ========================================

    showInviteModal() {
        inviteUI.show();
    }

    hideInviteModal() {
        inviteUI.hide();
    }

    switchInviteTab(tabType) {
        inviteUI.switchTab(tabType);
    }

    async handleSendInvite() {
        return inviteUI.handleSendInvite();
    }

    copyInviteLink() {
        inviteUI.copyInviteLink();
    }

    showInviteQR() {
        inviteUI.showQR();
    }
}

// Export singleton instance
export const uiController = new UIController();
