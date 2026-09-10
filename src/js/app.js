/**
 * Main Application Entry Point
 * Thin orchestrator â€” delegates wallet flows, invite handling, and messaging
 * to dedicated modules. Owns only lifecycle (init/teardown) and cross-module wiring.
 */

import { authManager } from './auth.js';
import { streamrController } from './streamr.js';
import { channelManager } from './channels.js';
import { uiController } from './ui.js';
import { notificationManager } from './notifications.js';
import { identityManager } from './identity.js';
import { secureStorage } from './secureStorage.js';
import { mediaController } from './media.js';
import { subscriptionManager } from './subscriptionManager.js';
import { relayManager } from './relayManager.js';
import { dmManager } from './dm.js';
import { syncManager } from './syncManager.js';
import { epochKeyManager } from './epochKeyManager.js';
import { storageFetch } from './storageFetch.js';
import { storageEndpoints } from './storageEndpoints.js';
import { Logger } from './logger.js';
import { CONFIG } from './config.js';
import { headerUI } from './ui/HeaderUI.js';
import { settingsUI } from './ui/SettingsUI.js';
import { contactsUI } from './ui/ContactsUI.js';
import { chatAreaUI } from './ui/ChatAreaUI.js';
import { reactionManager } from './ui/ReactionManager.js';
import { mediaHandler } from './ui/MediaHandler.js';
import { walletFlows } from './walletFlows.js';import { inviteHandler } from './inviteHandler.js';
import { channelModalsUI } from './ui/ChannelModalsUI.js';

class App {
    constructor() {
        this.initialized = false;
    }

    /**
     * Initialize the application
     */
    async init() {
        Logger.info('Pombo - Initializing...');

        // Web Share Target intake: if user shared an image into Pombo from
        // another Android app (Tenor, Gallery, Samsung Keyboard long-press),
        // the service worker stashed the files at /__shared/<i> and
        // redirected here with ?share=1. Pull them now so the chat input
        // path can pick them up once the channel is loaded.
        await this._consumeSharedFiles().catch(err =>
            Logger.debug('Share intake skipped:', err?.message));

        try {
            // Storage reads gain signatures and storedAt on Pombo nodes. Before
            // anything can fetch history, and once per page: the wrapper reads
            // the identity at request time, so a wallet switch needs nothing.
            storageFetch.install({
                endpoints: storageEndpoints,
                signer: () => {
                    const address = authManager.getAddress();
                    if (!address || authManager.isGuestMode() || !authManager.getSigner()) return null;
                    return { address, sign: (message) => authManager.signMessage(message) };
                },
                isGated: async (streamId) => !!(await streamrController._gatedChannelFor(streamId))
            });

            // Initialize media controller
            await mediaController.init();
            
            // Initialize UI
            uiController.init();
            
            // Wire cross-module callbacks (avoids circular dependencies and window globals)
            channelManager.onChannelsSaved = () => syncManager.scheduleAutoPush();
            identityManager.onTrustedContactsChanged = () => syncManager.scheduleAutoPush();
            epochKeyManager.setGateWarningHandler((_streamId, warning) =>
                uiController.showNotification(warning, 'error', 8000));
            // ENS is no longer resolved during message verification (that leaked
            // the contact list to public RPCs, one lookup per message seen), so
            // names arrive after render and the chat is patched in place.
            identityManager.onENSResolved = (address, name) => {
                try {
                    chatAreaUI.patchSenderNames(address, name);
                } catch (error) {
                    Logger.debug('ENS patch failed (non-critical):', error.message);
                }
            };
            secureStorage.onBlockedPeersChanged = () => syncManager.scheduleAutoPush();
            // Sent DMs/messages/reactions and DM soft-leaves must sync promptly —
            // they have no other push trigger (short debounce)
            secureStorage.onSentDataChanged = () => syncManager.scheduleAutoPush(5000);

            settingsUI.setDependencies({
                connectWallet: () => walletFlows.connectWallet(),
                onSyncTransportReconnected: () => this.pullSyncedStateAndBlobs().catch((error) => {
                    Logger.debug('Sync: Auto-pull after reconnect failed (non-critical):', error.message);
                })
            });

            // Wire wallet flows with app-level callbacks
            walletFlows.init({
                disconnectWallet: (opts) => this.disconnectWallet(opts),
                onWalletConnected: (addr, signer) => this.onWalletConnected(addr, signer),
                fallbackToGuest: (msg) => this.fallbackToGuest(msg)
            });

            // Set up message handlers
            this.setupMessageHandlers();

            syncManager.on('sync_activity', ({ active, label }) => {
                headerUI.setGlobalSyncState(active, label);
            });
            syncManager.on('sync_activity_success', ({ label }) => {
                headerUI.flashGlobalSyncSuccess(label);
            });
            syncManager.on('sync_pulled', ({ changes }) => {
                if (!changes) return;
                this.applyPulledSyncChanges(changes).catch((error) => {
                    Logger.error('Failed to reconcile UI after sync:', error);
                });
            });

            // Set up wallet connection handlers
            this.setupWalletHandlers();

            // Initialize mobile pill nav
            headerUI.initPillNav({
                onConnect: () => walletFlows.connectWallet(),
                onDisconnect: () => this.disconnectWallet(),
                onSwitchWallet: () => walletFlows.switchWallet(),
                onChatsTab: () => {
                    settingsUI.hide({ skipHistory: true });
                    contactsUI.hide({ skipHistory: true });
                    uiController.closeChatView();
                    // Clean orphaned modal history entry
                    if (window.history.state?.modal) {
                        window.history.replaceState(null, '');
                    }
                },
                onExploreTab: () => {
                    settingsUI.hide({ skipHistory: true });
                    contactsUI.hide({ skipHistory: true });
                    uiController.openExploreView();
                },
                onJoinWithId: () => {
                    uiController.showQuickJoinModal();
                },
                onCreateChannel: () => {
                    channelModalsUI.show();
                }
            });

            // Check for invite link in URL
            await inviteHandler.checkInviteLink();

            headerUI.updateNetworkStatus('Ready to connect', false);

            this.initialized = true;
            Logger.info('Pombo - Ready!');
            
            // Auto-connect: if saved wallets exist show unlock, otherwise connect as Guest
            if (authManager.hasSavedWallet()) {
                setTimeout(() => walletFlows.connectWallet(), 300);
            } else {
                setTimeout(() => this.connectAsGuest(), 300);
            }
        } catch (error) {
            Logger.error('Initialization failed:', error);
            uiController.showNotification('Failed to initialize app: ' + error.message, 'error');
        }
    }

    /**
     * Set up wallet connection handlers
     */
    setupWalletHandlers() {
        const connectBtn = document.getElementById('connect-wallet');
        const disconnectBtn = document.getElementById('disconnect-wallet');
        const switchBtn = document.getElementById('switch-wallet');
        const desktopJoinIdBtn = document.getElementById('desktop-join-id-btn');
        const syncBtn = document.getElementById('sync-devices-btn');
        const pillSyncBtn = document.getElementById('pill-sync-devices-btn');

        connectBtn.addEventListener('click', () => walletFlows.connectWallet());

        disconnectBtn?.addEventListener('click', async () => {
            headerUI._closeDesktopDropdown();
            await this.disconnectWallet();
        });

        switchBtn?.addEventListener('click', async () => {
            headerUI._closeDesktopDropdown();
            await walletFlows.switchWallet();
        });

        desktopJoinIdBtn?.addEventListener('click', () => {
            headerUI._closeDesktopDropdown();
            uiController.showQuickJoinModal();
        });

        // Sync buttons (desktop + mobile)
        const handleSync = async (btn) => {
            if (authManager.isGuestMode()) {
                uiController.showNotification('Sync not available in guest mode', 'warning');
                return;
            }

            const textEl = btn.querySelector('.sync-btn-text');
            const iconEl = btn.querySelector('.sync-icon');
            const originalText = textEl?.textContent;

            try {
                btn.disabled = true;
                if (textEl) textEl.textContent = 'Syncing...';
                if (iconEl) iconEl.classList.add('animate-spin');

                const result = await syncManager.runForegroundSync(
                    'Syncing devices',
                    () => syncManager.smartSync()
                );

                if (result.noInbox) {
                    uiController.showNotification('Create DM inbox first to enable sync', 'warning');
                }
            } catch (err) {
                Logger.error('Sync failed:', err);
                uiController.showNotification('Sync failed: ' + err.message, 'error');
            } finally {
                btn.disabled = false;
                if (textEl) textEl.textContent = originalText;
                if (iconEl) iconEl.classList.remove('animate-spin');
            }
        };

        syncBtn?.addEventListener('click', async () => {
            headerUI._closeDesktopDropdown();
            await handleSync(syncBtn);
        });

        pillSyncBtn?.addEventListener('click', async () => {
            await handleSync(pillSyncBtn);
        });

        // Best-effort push when the page is being hidden/unloaded.
        // Only fires when there are unsynced local changes (dirty flag).
        // Note: an async publish may not complete during unload — the dirty
        // flag survives and startup runs a push-first smart sync to recover.
        const pushOnHide = () => {
            if (syncManager.isDirty()) {
                syncManager.forcePushNow();
            }
        };

        window.addEventListener('beforeunload', pushOnHide);
        // pagehide is the reliable unload signal on mobile (beforeunload rarely fires)
        window.addEventListener('pagehide', pushOnHide);

        // Push immediately when app goes to background — a delayed timer may
        // never fire on mobile (page freeze); pull on return to foreground
        document.addEventListener('visibilitychange', () => {
            if (document.visibilityState === 'hidden') {
                pushOnHide();
            } else if (document.visibilityState === 'visible') {
                if (!syncManager.isAutoSyncAllowed('foreground')) return;
                this.pullSyncedStateAndBlobs().catch((error) => {
                    Logger.debug('Sync: Auto-pull on foreground failed (non-critical):', error.message);
                });
            }
        });
    }

    /**
     * Pull the latest sync snapshot and any pending image blobs.
     * @returns {Promise<Object|null>}
     */
    async pullSyncedStateAndBlobs() {
        const pullResult = await syncManager.pullSync();
        if (pullResult !== null) {
            try {
                await syncManager.pullImageBlobs();
            } catch (error) {
                Logger.debug('Sync: Image blob pull failed (non-critical):', error.message);
            }
        }
        return pullResult;
    }

    /**
     * Apply UI changes after a sync pull has already updated runtime state.
     * @param {Object} changes - Sync change summary
     */
    async applyPulledSyncChanges(changes) {
        if (!changes) return;

        if (changes.epochKeysUpdated) {
            epochKeyManager.refreshPersisted();
        }
        if (changes.channelsUpdated || changes.contactsUpdated) {
            uiController.renderChannelList();
        }
        if (changes.contactsUpdated) {
            contactsUI.renderList();
        }
        if (changes.blockedPeersUpdated) {
            settingsUI.renderBlockedPeersList();
        }
        if (changes.channelsUpdated) {
            await uiController.reconcileConnectedStateAfterSync({
                currentChannelRemoved: !!changes.currentChannelRemoved
            });
        }
        // Refresh the open DM / write-only timeline when synced sent messages
        // arrived — without this, messages sent on another device only appear
        // after re-opening the channel (or restarting the app).
        if (changes.sentMessagesUpdated) {
            const channel = channelManager.getCurrentChannel();
            if (channel?.type === 'dm' && channel.peerAddress) {
                await dmManager.loadDMTimeline(channel.peerAddress);
                chatAreaUI.renderMessages(channel.messages, () => {
                    uiController.attachReactionListeners();
                    mediaHandler.attachLightboxListeners();
                });
            } else if (channel?.writeOnly) {
                const sentMessages = secureStorage.getSentMessages(channel.messageStreamId);
                const existingIds = new Set(channel.messages.map(m => m.id));
                const newMessages = sentMessages.filter(m => m.id && !existingIds.has(m.id));
                if (newMessages.length > 0) {
                    for (const msg of newMessages) {
                        msg.verified = { valid: true, trustLevel: 2 };
                        channel.messages.push(msg);
                    }
                    channelManager.sortMessagesByTimestamp(channel);
                    chatAreaUI.renderMessages(channel.messages, () => {
                        uiController.attachReactionListeners();
                        mediaHandler.attachLightboxListeners();
                    });
                }
            }
        }
    }

    /**
     * Disconnect wallet - COMPLETE CLEANUP
     * @param {Object} options - Options
     * @param {boolean} options.skipFallback - If true, don't fallback to guest (used during account switch)
     */
    async disconnectWallet(options = {}) {
        const { skipFallback = false } = options;
        const wasGuest = authManager.isGuestMode();
        
        try {
            channelManager.stopPresenceTracking();
            // Stop background timers that survive disconnect otherwise:
            // sync auto-push and relay token re-registration (6h interval)
            syncManager.cancelAutoPush();
            relayManager.stopReRegistrationTimer();
            // Drop invites of the disconnecting account so they can't be
            // re-saved under the next account's storage
            notificationManager.pendingInvites.clear();
            await subscriptionManager.cleanup();
            await channelManager.leaveAllChannels();
            await dmManager.destroy();
            // Epoch-key runtime state (keys in memory, rotation timers)
            // belongs to the disconnecting account — the next account must
            // start from its own persisted slice, never inherit this one's.
            epochKeyManager.clear();
            await streamrController.disconnect();
            mediaController.reset();
            secureStorage.lock();
            authManager.disconnect();
            
            headerUI.updateWalletInfo(null);
            headerUI.updateNetworkStatus('Disconnected', false);
            uiController.renderChannelList();
            uiController.resetToDisconnectedState();
            
            if (wasGuest) {
                uiController.showNotification('Guest session ended - all data has been cleared', 'info');
            } else if (!skipFallback) {
                await this.fallbackToGuest('Account disconnected - continuing as Guest');
            }
            
            Logger.info('Account disconnected - full cleanup complete');
        } catch (error) {
            Logger.error('Error disconnecting:', error);
            headerUI.updateWalletInfo(null);
            headerUI.updateNetworkStatus('Disconnected', false);
            uiController.resetToDisconnectedState();
            uiController.showNotification('Error disconnecting: ' + error.message, 'error');
        }
    }

    /**
     * Connect as Guest with ephemeral wallet
     */
    async connectAsGuest() {
        try {
            headerUI.updateNetworkStatus('Connecting as Guest...', false);
            const { address, signer } = authManager.connectAsGuest();
            Logger.info('Guest account created:', address);
            await this.onWalletConnected(address, signer);
            Logger.info('Connected as Guest - ready to explore!');
        } catch (error) {
            Logger.error('Failed to connect as Guest:', error);
            headerUI.updateNetworkStatus('Failed to connect', false);
            uiController.showNotification('Failed to connect: ' + error.message, 'error');
        }
    }

    /**
     * Fallback to Guest mode when no account is connected
     */
    async fallbackToGuest(message = 'Continuing as Guest') {
        await this.connectAsGuest();
        uiController.showNotification(message, 'info');
    }

    /**
     * Handle wallet connected event â€” initializes all subsystems for the active wallet.
     * @param {string} address - Wallet address
     * @param {Object} signer - Ethers signer
     */
    async onWalletConnected(address, signer) {
        try {
            const isGuest = authManager.isGuestMode();

            headerUI.updateWalletInfo(address, isGuest);
            headerUI.updateNetworkStatus('Connecting to Streamr...', false);

            // Bell menu (invites + active transfers): shown the moment the
            // connected UI paints. It used to init at the END of this flow,
            // after Streamr/DM/sync setup — on a slow connect the bell only
            // materialised once all of that finished, which read as "appears
            // when I leave Chats and come back". It only READS from its
            // managers on open, so wiring it before they finish is safe
            // (pending invites are already loaded from storage).
            try {
                const { notificationBellUI } = await import('./ui/NotificationBellUI.js');
                const { storageMediaController } = await import('./storageMedia.js');
                notificationBellUI.init({
                    notificationManager,
                    mediaController,
                    storageMediaController,
                    // Reseed availability check for inactive rows: no channel
                    // (left it) = no password for the announce, delete only.
                    getChannel: (streamId) => channelManager.getChannel(streamId),
                    openChannel: (streamId) => uiController.selectChannel(streamId),
                    resumeStorageDownload: (transferId) => storageMediaController.resumeDownload(transferId),
                    // Deep P3 replay backing the invites "All" view — once per
                    // session, classified silently (see dm.replayInvites)
                    fetchAllInvites: () => dmManager.replayInvites().catch(() => {})
                });
            } catch (bellError) {
                Logger.warn('Failed to init notification bell (non-critical):', bellError);
            }

            const savedWallets = authManager.listSavedWallets();
            headerUI.updateSwitchWalletButton(savedWallets.length > 1);

            if (isGuest) {
                secureStorage.initAsGuest(address);
            } else {
                await secureStorage.init(signer, address);
            }

            channelManager.clearChannels();
            channelManager.loadChannels();
            Logger.info('Loaded channels for wallet:', address);

            await streamrController.init(signer);

            const deepLinkStreamId = this._getDeepLinkStreamId();
            streamrController.warmupNetwork(deepLinkStreamId);

            await mediaController.setOwner(address);

            const streamrAddress = await streamrController.getAddress();
            Logger.info('Streamr connected with address:', streamrAddress);
            headerUI.updateNetworkStatus('Connected to Streamr', true);

            try {
                await identityManager.init();
                Logger.info('Identity manager initialized');
                const username = identityManager.getUsername();
                if (username) {
                    headerUI.updateDisplayName(username);
                }
                // Always resolve own ENS — overrides local username if available
                identityManager.resolveENS(address).then(ensName => {
                    if (ensName) {
                        headerUI.updateDisplayName(ensName);
                        // ENS takes priority — clear local username so sync propagates deletion
                        if (identityManager.getUsername()) {
                            identityManager.setUsername(null);
                            Logger.info('ENS active — cleared local username');
                        }
                        // Store ENS in plain localStorage for unlock modal display
                        localStorage.setItem(CONFIG.storageKeys.ens(address), ensName);
                    }
                    // Resolve ENS avatar (needs ENS name first, so chain after name resolution)
                    identityManager.resolveENSAvatar(address).then(avatarUrl => {
                        if (avatarUrl) {
                            // Re-render header avatars with ENS image
                            headerUI.updateWalletInfo(address);
                        }
                    }).catch(() => {});
                }).catch(() => {});
            } catch (idError) {
                Logger.warn('Identity manager init failed (non-critical):', idError);
            }

            try {
                await dmManager.init();
                Logger.info('DM manager initialized');
                if (!authManager.isGuestMode()) {
                    // Wire blob_pulled events to update image placeholders in real-time.
                    // Register once per app lifetime — re-registering on every
                    // reconnect accumulated duplicate handlers.
                    if (!this._blobPulledHandler) {
                        this._blobPulledHandler = ({ imageId, data }) => {
                            mediaController.handleImageData({ type: 'image_data', imageId, data });
                        };
                        syncManager.on('blob_pulled', this._blobPulledHandler);
                    }

                    // Note: not gated on dmManager.inboxReady — sync operations
                    // re-check hasInbox() themselves, so a transient failure during
                    // dmManager.init doesn't disable sync for the whole session.
                    // Retries with escalating delay: transient RPC failures during
                    // the publish/resend path (see chainErrors) must not leave the
                    // session unsynced until the next foreground event.
                    const runInitialSync = (attempt = 1) => {
                        syncManager.runForegroundSync('Syncing your data', async () => {
                            // Always push-first (smartSync): local state that never
                            // reached the storage node — including state stuck from
                            // builds without mutation-triggered pushes — is flushed
                            // before the pull, so the merge can't clobber it and
                            // other devices receive it. One extra publish per
                            // startup is negligible.
                            const result = await syncManager.smartSync();
                            const pulled = result.pulled ? result : null;
                            Logger.info('Sync: Initial smart sync complete');

                            if (pulled !== null) {
                                // Update header with synced username or ENS
                                const syncedUsername = identityManager.getUsername();
                                if (syncedUsername) {
                                    headerUI.updateDisplayName(syncedUsername);
                                }
                                // Always resolve own ENS after sync — overrides local username
                                identityManager.resolveENS(address).then(ensName => {
                                    if (ensName) {
                                        headerUI.updateDisplayName(ensName);
                                        if (identityManager.getUsername()) {
                                            identityManager.setUsername(null);
                                            Logger.info('ENS active — cleared local username (post-sync)');
                                        }
                                        localStorage.setItem(CONFIG.storageKeys.ens(address), ensName);
                                    }
                                }).catch(() => {});
                            }
                        }).catch(e => {
                            Logger.debug(`Sync: Initial sync failed (attempt ${attempt}, non-critical):`, e.message);
                            if (attempt < 3) {
                                const delay = attempt * 30000;
                                Logger.info(`Sync: Retrying initial sync in ${delay / 1000}s`);
                                setTimeout(() => {
                                    // Skip if the account changed meanwhile (disconnect/switch)
                                    if (authManager.getAddress() === address) {
                                        runInitialSync(attempt + 1);
                                    }
                                }, delay);
                            }
                        });
                    };
                    if (syncManager.isAutoSyncAllowed('start')) {
                        runInitialSync();
                    }
                }
            } catch (dmError) {
                Logger.warn('Failed to init DM manager (non-critical):', dmError);
            }

            uiController.renderChannelList();
            await uiController.processInitialUrl();

            // Background: refresh channel names/descriptions from on-chain metadata
            // (picks up admin renames for channels the user already joined)
            channelManager.refreshChannelMetadataFromGraph()
                .then(changed => {
                    if (changed) {
                        uiController.renderChannelList();
                        Logger.info('Channel metadata refreshed from The Graph (changes applied)');
                    }
                })
                .catch(e => Logger.debug('Channel metadata refresh failed (non-critical):', e.message));

            subscriptionManager.startBackgroundPoller();
            Logger.info('Dynamic subscription management active (background poller started)');

            // Owner key-responder: answer retained key requests on the
            // channels this device is marked for (no-op when none are).
            import('./keyResponder.js')
                .then(({ keyResponder }) => keyResponder.start())
                .catch(e => Logger.debug('Key responder unavailable:', e.message));

            try {
                await notificationManager.init();
                Logger.info('Notification system ready');
            } catch (notifError) {
                Logger.warn('Failed to init notifications (non-critical):', notifError);
            }


            try {
                await relayManager.init(address);
                Logger.info('Relay manager initialized');
            } catch (relayError) {
                Logger.warn('Failed to init relay manager (non-critical):', relayError);
            }

            // Process pending invite if any
            if (inviteHandler.pendingInvite) {
                Logger.info('Processing pending invite:', inviteHandler.pendingInvite.name);
                const inviteData = inviteHandler.pendingInvite;
                inviteHandler.pendingInvite = null;
                setTimeout(() => inviteHandler.showInviteDialog(inviteData), 500);
            }

            Logger.info('Wallet connected and Streamr initialized');
        } catch (error) {
            Logger.error('Failed to initialize after wallet connection:', error);
            headerUI.updateNetworkStatus('Failed to connect to Streamr', false);
            throw error;
        }
    }

    /**
     * Set up message handlers
     */
    setupMessageHandlers() {
        const typingUsers = new Map();
        
        channelManager.onMessage((event, data) => {
            if (!authManager.isConnected()) {
                Logger.debug('Message ignored - user disconnected');
                return;
            }
            
            const currentChannel = channelManager.getCurrentChannel();
            // Reactions and the rest key off the current channel, which a
            // preview does not set.
            const currentStreamId = currentChannel?.streamId
                ?? channelManager.previewChannel?.messageStreamId;
            
            if (event === 'message') {
                chatAreaUI.updateUnreadCount(data.streamId);
                if (data.streamId === currentStreamId) {
                    // Append immediately even during initial history load.
                    // ChatAreaUI.addMessage appends to existing DOM; the
                    // subsequent full render on history_batch_loaded /
                    // initial_history_complete will reconcile any ordering.
                    chatAreaUI.addMessage(data.message, data.streamId, () => {
                        uiController.attachReactionListeners();
                        mediaHandler.attachLightboxListeners();
                    });
                }
            } else if (event === 'typing') {
                if (data.streamId !== currentStreamId) return;
                
                const user = data.user;
                const nickname = data.nickname || null;
                const myAddress = authManager.getAddress();
                if (user?.toLowerCase() === myAddress?.toLowerCase()) return;
                
                if (!typingUsers.has(data.streamId)) {
                    typingUsers.set(data.streamId, new Map());
                }
                const channelTyping = typingUsers.get(data.streamId);
                channelTyping.set(user, { time: Date.now(), nickname });
                
                const now = Date.now();
                for (const [u, info] of channelTyping) {
                    if (now - info.time > 3000) channelTyping.delete(u);
                }
                
                const typingList = Array.from(channelTyping.entries()).map(([addr, info]) => ({ address: addr, nickname: info.nickname }));
                chatAreaUI.showTypingIndicator(typingList);
                
                setTimeout(() => {
                    channelTyping.delete(user);
                    const stillCurrentChannel = channelManager.getCurrentChannel();
                    if (stillCurrentChannel?.streamId === data.streamId) {
                        const remaining = Array.from(channelTyping.entries()).map(([addr, info]) => ({ address: addr, nickname: info.nickname }));
                        chatAreaUI.showTypingIndicator(remaining);
                    }
                }, 3000);
                
            } else if (event === 'reaction') {
                if (data.streamId === currentStreamId) {
                    reactionManager.handleIncomingReaction(data.messageId, data.emoji, data.user, data.action || 'add');
                }
            } else if (event === 'message_edited') {
                if (data.streamId === currentStreamId) {
                    const channel = channelManager.getCurrentChannel();
                    // Note: handle even during initialLoadInProgress so that
                    // an edit override delivered in the history resend (after
                    // its target was already rendered by `history_batch_loaded`)
                    // updates the visible DOM immediately, instead of waiting
                    // for the final `initial_history_complete` render that may
                    // be up to 30s away on streams whose iterator never signals done.
                    if (channel) {
                        // Granular DOM update: find the edited message and replace
                        // only that node instead of rebuilding the entire conversation.
                        const edited = channel.messages.find(
                            m => (m.id || m.timestamp) === data.targetId
                        );
                        const didUpdate = edited
                            ? chatAreaUI.updateMessage(edited)
                            : false;
                        if (didUpdate === false) {
                            // Fallback: message not in DOM (e.g. not yet rendered) — full render
                            chatAreaUI.renderMessages(channel.messages, () => {
                                uiController.attachReactionListeners();
                                mediaHandler.attachLightboxListeners();
                            });
                        }
                    }
                }
            } else if (event === 'message_deleted') {
                if (data.streamId === currentStreamId) {
                    const channel = channelManager.getCurrentChannel();
                    // Same rationale as message_edited: must drop the visible
                    // node even during initial history load so a delete that
                    // arrives just after `history_batch_loaded` rendered the
                    // target does not leave the message on screen until
                    // `initial_history_complete` finally fires.
                    if (channel) {
                        // Granular DOM removal: just drop the deleted node.
                        const didRemove = chatAreaUI.removeMessage(data.targetId);
                        if (!didRemove) {
                            chatAreaUI.renderMessages(channel.messages, () => {
                                uiController.attachReactionListeners();
                                mediaHandler.attachLightboxListeners();
                            });
                        }
                    }
                }
            } else if (event === 'media') {
                mediaController.handleMediaMessage(data.streamId, data.media);
            } else if (event === 'channelJoined') {
                mediaController.reannounceForChannel(data.streamId, data.password);
                if (data.permissions && !data.permissions.canPublish && data.permissions.canSubscribe) {
                    uiController.showNotification(
                        'You have read-only access to this channel. You cannot send messages.',
                        'warning',
                        5000
                    );
                }
                uiController.renderChannelList();
            } else if (event === 'history_loaded') {
                if (data.streamId === currentStreamId) {
                    Logger.debug(`History loaded: ${data.loaded} messages, hasMore: ${data.hasMore}`);
                }
            } else if (event === 'history_batch_loaded') {
                if (data.streamId === currentStreamId) {
                    const channel = channelManager.getCurrentChannel();
                    // Not while the initial load runs: a batch painted before
                    // its edits and deletes have been read shows text that is
                    // about to change and messages that are about to vanish.
                    // The load always ends — `initial_history_complete` fires
                    // on completion or on the safety timeout — and that is
                    // where the conversation is painted, once.
                    if (channel && !channel.initialLoadInProgress) {
                        chatAreaUI.renderMessages(channel.messages, () => {
                            uiController.attachReactionListeners();
                            mediaHandler.attachLightboxListeners();
                        });
                        Logger.debug(`History batch loaded: ${data.loaded}/${data.total} messages`);
                    }
                }
            } else if (event === 'initial_history_complete') {
                if (data.streamId === currentStreamId) {
                    const channel = channelManager.getCurrentChannel();
                    if (channel) {
                        chatAreaUI.renderMessages(channel.messages, () => {
                            uiController.attachReactionListeners();
                            mediaHandler.attachLightboxListeners();
                        });
                        Logger.info(`Initial history complete — rendered ${channel.messages.length} messages`);
                    }
                }
            }
        });

        // Entry flows into channels without an on-chain name (hidden gated,
        // invites, direct links) offer the local name + classification panel
        // right after the join, over the key-request wait.
        channelManager.onNeedsLocalIdentity = (channel) => {
            channelModalsUI.showLocalIdentityModal(channel);
        };

        channelManager.onOnlineUsersChange((streamId, users) => {
            uiController.updateOnlineUsers(streamId, users);
        });
    }

    /**
     * Read any files the service worker stashed via the Web Share Target
     * (manifest action /share). Stashed at /__shared/<i> in the
     * pombo-share-v1 cache. Buffers them in memory and arms a hashchange
     * listener so the modal opens as soon as the user is in a channel.
     * @private
     */
    async _consumeSharedFiles() {
        if (typeof caches === 'undefined') return;
        const params = new URLSearchParams(window.location.search);
        if (!params.has('share')) return;

        try {
            const cache = await caches.open('pombo-share-v1');
            const requests = await cache.keys();
            const files = [];
            for (const req of requests) {
                const res = await cache.match(req);
                if (!res) continue;
                const blob = await res.blob();
                const filename = decodeURIComponent(
                    res.headers.get('X-Pombo-Filename') || 'shared'
                );
                files.push(new File([blob], filename, { type: blob.type }));
                await cache.delete(req);
            }
            this._sharedFilesQueue = files;
            // Strip the marker from the URL so a refresh doesn't replay.
            const cleanUrl = window.location.pathname + window.location.hash;
            window.history.replaceState({}, '', cleanUrl);
            // Try to drain now (probably no channel yet) and on every navigation.
            this._drainSharedFiles();
            window.addEventListener('hashchange', () => this._drainSharedFiles());
        } catch (err) {
            Logger.warn('Failed to consume shared files:', err.message);
        }
    }

    /**
     * Open the file-confirm modal for the next queued shared file, but only
     * once the user has a channel (joined or preview) selected. The first
     * call from boot will typically no-op; the hashchange listener covers
     * the case where the user is mid-route.
     * @private
     */
    async _drainSharedFiles() {
        if (!this._sharedFilesQueue?.length) return;
        const { inputUI } = await import('./ui/InputUI.js');
        const hasChannel = !!channelManager.getCurrentChannel()
            || !!this._getDeepLinkStreamId();
        if (!hasChannel) return;
        const file = this._sharedFilesQueue.shift();
        if (file && typeof inputUI.showFileConfirmModal === 'function') {
            inputUI.showFileConfirmModal(file, 'image');
        }
    }

    /**
     * Extract stream ID from deep link URL if present
     * @returns {string|null}
     * @private
     */
    _getDeepLinkStreamId() {
        try {
            const hash = window.location.hash;
            if (!hash) return null;
            const match = hash.match(/#\/(channel|preview)\/((0x[a-fA-F0-9]+)\/[^\/]+)/);
            if (match && match[2]) return match[2];
        } catch (e) {
            // Ignore parsing errors
        }
        return null;
    }
}

// Streamr's validation pipeline rejects unauthorized messages (e.g. traffic
// from a publisher without a grant) in a promise nothing awaits — correct
// outcome, uncaught noise. Known live case: a broken build published to a
// gated channel with an ephemeral key; the storage node retained the message
// and every history replay re-rejects it for the full retention window.
// Downgrade exactly that error to a debug line; everything else stays loud.
window.addEventListener('unhandledrejection', (event) => {
    if (event.reason?.code === 'MISSING_PERMISSION') {
        event.preventDefault();
        Logger.debug('Network rejected unauthorized message (expected):',
            event.reason.message?.slice(0, 140));
    }
});

// Initialize app when DOM is ready
document.addEventListener('DOMContentLoaded', () => {
    const app = new App();
    app.init();
});
