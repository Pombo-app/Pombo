/**
 * HeaderUI
 * Manages the header/toolbar area: wallet info, network status,
 * channel title/info, and connection indicators.
 */

import { escapeHtml } from './utils.js';
import { generateAvatar, getAvatarHtml } from './AvatarGenerator.js';
import { identityManager } from '../identity.js';
import { channelImageManager } from '../channelImageManager.js';
import { deriveAdminId } from '../streamConstants.js';
import { escapeAttr } from './utils.js';

class HeaderUI {
    constructor() {
        this.deps = {};
        this._desktopDropdownOpen = false;
        this._boundCloseDesktopDropdown = null;
        this._currentAddress = null;
        this._currentDisplayName = null;
        this._isGuest = false;
        this._globalSyncSuccessTimeout = null;
        this._isGlobalSyncActive = false;
        
        // DOM elements
        this.elements = {
            switchWalletBtn: null,
            contactsBtn: null,
            settingsBtn: null,
            globalSyncIndicator: null,
            globalSyncText: null,
            currentChannelName: null,
            currentChannelInfo: null,
            currentChannelThumb: null,
            chatHeaderRight: null,
            // Desktop dropdown
            desktopAccountWrapper: null,
            desktopAccountBtn: null,
            desktopAccountAvatar: null,
            desktopAccountName: null,
            desktopAccountDropdown: null,
            desktopDropdownAddress: null
        };

        // Mobile pill elements (cached on first access)
        this._pillElements = null;
    }

    /**
     * Inject dependencies
     * @param {Object} deps - { }
     */
    setDependencies(deps) {
        this.deps = { ...this.deps, ...deps };
    }

    /**
     * Initialize with DOM elements
     * @param {Object} elements - Header-related DOM elements
     */
    init(elements) {
        this.elements = {
            switchWalletBtn: elements.switchWalletBtn,
            contactsBtn: elements.contactsBtn,
            settingsBtn: elements.settingsBtn,
            globalSyncIndicator: elements.globalSyncIndicator,
            globalSyncText: elements.globalSyncText,
            currentChannelName: elements.currentChannelName,
            currentChannelInfo: elements.currentChannelInfo,
            currentChannelThumb: elements.currentChannelThumb,
            chatHeaderRight: elements.chatHeaderRight,
            // Desktop dropdown
            desktopAccountWrapper: elements.desktopAccountWrapper,
            desktopAccountBtn: elements.desktopAccountBtn,
            desktopAccountAvatar: elements.desktopAccountAvatar,
            desktopAccountName: elements.desktopAccountName,
            desktopAccountDropdown: elements.desktopAccountDropdown,
            desktopDropdownAddress: elements.desktopDropdownAddress
        };

        // Desktop dropdown toggle
        this.elements.desktopAccountBtn?.addEventListener('click', (e) => {
            e.stopPropagation();
            this._toggleDesktopDropdown();
        });
        this._boundCloseDesktopDropdown = (e) => {
            if (this._desktopDropdownOpen && !this.elements.desktopAccountWrapper?.contains(e.target)) {
                this._closeDesktopDropdown();
            }
        };
        document.addEventListener('click', this._boundCloseDesktopDropdown);
    }

    /**
     * Update wallet info display
     * @param {string} address - Wallet address
     * @param {boolean} isGuest - Whether connected as Guest
     */
    updateWalletInfo(address, isGuest = false) {
        const { contactsBtn, settingsBtn,
                desktopAccountWrapper, desktopAccountAvatar, desktopAccountName, desktopDropdownAddress } = this.elements;
        
        // Mobile pill elements
        const pill = this._getPillElements();
        this._isGuest = !!address && isGuest;

        if (address) {
            if (isGuest) {
                desktopAccountWrapper?.classList.remove('hidden');
                desktopAccountWrapper?.classList.add('md:relative');
                if (desktopAccountAvatar) desktopAccountAvatar.innerHTML = generateAvatar(address, 38, 0.5);
                if (desktopAccountName) {
                    desktopAccountName.innerHTML = '<span class="text-[#F6851B]">Guest</span>';
                    desktopAccountName.classList.remove('font-mono');
                }
                this._setGuestMenu(true);
                contactsBtn?.classList.remove('hidden');

                // Mobile: show pill nav (same as authenticated), hide floating connect
                document.body.classList.add('guest-mode');
                pill.connectFloat?.classList.add('hidden');
                pill.pillNav?.classList.remove('hidden');
                // Update profile avatar in pill (guest address)
                if (pill.profileBtn) {
                    pill.profileBtn.innerHTML = generateAvatar(address, 32, 0.5);
                }
            } else {
                this._currentAddress = address;
                const short = `${address.slice(0, 6)}...${address.slice(-4)}`;
                const displayText = this._currentDisplayName || short;
                
                desktopAccountWrapper?.classList.remove('hidden');
                desktopAccountWrapper?.classList.add('md:relative');
                
                // Update desktop dropdown button
                if (desktopAccountAvatar) {
                    const ensAvatar = identityManager.getCachedENSAvatar(address);
                    desktopAccountAvatar.innerHTML = getAvatarHtml(address, 38, 0.5, ensAvatar);
                }
                if (desktopAccountName) {
                    desktopAccountName.textContent = displayText;
                    desktopAccountName.classList.toggle('font-mono', !this._currentDisplayName);
                }
                if (desktopDropdownAddress) {
                    desktopDropdownAddress.textContent = short;
                }
                this._setGuestMenu(false);

                // Show contacts button
                contactsBtn?.classList.remove('hidden');
                
                // Mobile: hide floating connect, show pill nav
                document.body.classList.remove('guest-mode');
                pill.connectFloat?.classList.add('hidden');
                pill.pillNav?.classList.remove('hidden');
                // Update profile avatar in pill
                if (pill.profileBtn) {
                    const ensAvatar = identityManager.getCachedENSAvatar(address);
                    pill.profileBtn.innerHTML = getAvatarHtml(address, 38, 0.5, ensAvatar);
                }
            }
            // Show settings button
            settingsBtn?.classList.remove('hidden');
        } else {
            this._currentAddress = null;
            this._currentDisplayName = null;
            this.setGlobalSyncState(false);
            // Hide desktop dropdown
            desktopAccountWrapper?.classList.add('hidden');
            desktopAccountWrapper?.classList.remove('md:relative');
            // Hide contacts button
            contactsBtn?.classList.add('hidden');
            // Hide settings button
            settingsBtn?.classList.add('hidden');
            
            // Mobile: hide both pill and float
            document.body.classList.remove('guest-mode');
            pill.connectFloat?.classList.add('hidden');
            pill.pillNav?.classList.add('hidden');
        }
    }

    /**
     * Account menu items: a guest gets Create and Import instead of the
     * address line and Disconnect.
     * @param {boolean} isGuest
     */
    _setGuestMenu(isGuest) {
        document.getElementById('guest-create-account-btn')?.classList.toggle('hidden', !isGuest);
        document.getElementById('guest-import-account-btn')?.classList.toggle('hidden', !isGuest);
        document.getElementById('guest-restore-account-btn')?.classList.toggle('hidden', !isGuest);
        this.elements.desktopDropdownAddress?.classList.toggle('hidden', isGuest);
        document.getElementById('disconnect-wallet')?.classList.toggle('hidden', isGuest);
    }

    /**
     * Update display name shown in header and pill nav
     * @param {string|null} username - Username to show, or null to revert to address
     */
    updateDisplayName(username) {
        this._currentDisplayName = username || null;
        const displayText = this._currentDisplayName || (this._currentAddress ? `${this._currentAddress.slice(0, 6)}...${this._currentAddress.slice(-4)}` : null);
        if (!displayText || this._isGuest) return;

        // Update desktop dropdown button name
        const { desktopAccountName } = this.elements;
        if (desktopAccountName) {
            desktopAccountName.textContent = displayText;
            desktopAccountName.classList.toggle('font-mono', !this._currentDisplayName);
        }
    }

    /**
     * Update switch wallet button visibility
     * @param {boolean} show - Whether to show the switch button
     */
    updateSwitchWalletButton(show) {
        if (show) {
            this.elements.switchWalletBtn?.classList.remove('hidden');
        } else {
            this.elements.switchWalletBtn?.classList.add('hidden');
        }
    }

    /**
     * Update network status indicator (no-op, status dot removed)
     */
    updateNetworkStatus() {}

    /** The dot on the logo and "Connecting…" in place of the online count. */
    setNetworkDown(down) {
        document.body.classList.toggle('network-down', !!down);
    }

    /** The offline banner and "Offline" in place of the online count. */
    setOffline(offline) {
        document.body.classList.toggle('network-offline', !!offline);
        document.getElementById('offline-banner')?.classList.toggle('hidden', !offline);
    }

    /**
     * Update the persistent global sync indicator in the header.
     * @param {boolean} active - Whether foreground sync is active
     * @param {string} label - Indicator label
     */
    setGlobalSyncState(active, label = 'Syncing your data') {
        const { globalSyncIndicator, globalSyncText } = this.elements;
        if (!globalSyncIndicator) return;

        this._isGlobalSyncActive = active;

        if (globalSyncText && label) {
            globalSyncText.textContent = label;
        }

        if (active) {
            if (this._globalSyncSuccessTimeout) {
                clearTimeout(this._globalSyncSuccessTimeout);
                this._globalSyncSuccessTimeout = null;
            }

            globalSyncIndicator.classList.remove('is-success', 'hidden');
            globalSyncIndicator.setAttribute('aria-hidden', 'false');
            return;
        }

        if (globalSyncIndicator.classList.contains('is-success')) {
            globalSyncIndicator.classList.remove('hidden');
            globalSyncIndicator.setAttribute('aria-hidden', 'false');
            return;
        }

        globalSyncIndicator.classList.add('hidden');
        globalSyncIndicator.setAttribute('aria-hidden', 'true');
    }

    /**
     * Briefly swap the spinner for a success check mark after a completed sync.
     * @param {string} label - Accessible status text
     */
    flashGlobalSyncSuccess(label = 'Sync complete') {
        const { globalSyncIndicator, globalSyncText } = this.elements;
        if (!globalSyncIndicator) return;

        if (this._globalSyncSuccessTimeout) {
            clearTimeout(this._globalSyncSuccessTimeout);
        }

        if (globalSyncText && label) {
            globalSyncText.textContent = label;
        }

        globalSyncIndicator.classList.remove('hidden');
        globalSyncIndicator.classList.add('is-success');
        globalSyncIndicator.setAttribute('aria-hidden', 'false');

        this._globalSyncSuccessTimeout = setTimeout(() => {
            this._globalSyncSuccessTimeout = null;
            globalSyncIndicator.classList.remove('is-success');

            if (!this._isGlobalSyncActive) {
                globalSyncIndicator.classList.add('hidden');
                globalSyncIndicator.setAttribute('aria-hidden', 'true');
            }
        }, 1100);
    }

    /**
     * Update channel title in header
     * @param {string} name - Channel name
     */
    updateChannelTitle(name) {
        if (this.elements.currentChannelName) {
            this.elements.currentChannelName.textContent = name;
        }
    }

    /**
     * Update channel info (type label) in header
     * @param {string} type - Channel type
     * @param {boolean} readOnly - Whether channel is read-only
     */
    updateChannelInfo(type, readOnly = false) {
        if (this.elements.currentChannelInfo) {
            this.elements.currentChannelInfo.innerHTML = this.getChannelTypeLabel(type, readOnly);
            this.elements.currentChannelInfo.parentElement?.classList.remove('hidden');
        }
    }

    /**
     * Hide channel info section
     */
    hideChannelInfo() {
        if (this.elements.currentChannelInfo) {
            this.elements.currentChannelInfo.textContent = '';
            this.elements.currentChannelInfo.parentElement?.classList.add('hidden');
        }
    }

    /**
     * Render the chat-header thumbnail for the active channel.
     * For DMs uses the peer's ENS avatar (or deterministic avatar).
     * For other channels uses the cached channel image (or fallback avatar).
     * Subscribes to channelImageManager so a freshly-published image
     * appears without a manual refresh.
     * @param {Object} channel - Active channel object
     */
    updateChannelThumb(channel) {
        const slot = this.elements.currentChannelThumb;
        if (!slot) return;
        // Tear down any prior subscription
        if (this._thumbUnsub) { try { this._thumbUnsub(); } catch {} this._thumbUnsub = null; }
        if (!channel || !channel.streamId) {
            slot.classList.add('hidden');
            slot.innerHTML = '';
            return;
        }

        const sizePx = 38;
        const sizeStyle = 'width:38px;height:38px';
        const radiusCls = 'rounded-full';
        const spinnerHtml = `<div class="${radiusCls} flex items-center justify-center bg-overlay-4" style="${sizeStyle}"><div class="thumb-spinner" style="width:18px;height:18px"></div></div>`;
        const avatarHtml = (seed, ensUrl) => `<div class="${radiusCls} overflow-hidden" style="${sizeStyle}">${getAvatarHtml(seed, sizePx, 0.5, ensUrl)}</div>`;
        const fallbackHtml = (seed) => avatarHtml(seed, null);
        const imgHtml = (url) => `<img class="${radiusCls} object-cover" alt="" src="${escapeAttr(url)}" style="${sizeStyle}" />`;

        const renderDM = () => {
            const peer = channel.peerAddress;
            const seed = peer || channel.streamId;
            const ens = peer ? (identityManager.getCachedENSAvatar?.(peer) || null) : null;
            if (ens) { slot.innerHTML = avatarHtml(seed, ens); return; }
            // No cached ENS — show spinner while resolving
            if (peer && identityManager.resolveENSAvatar) {
                slot.innerHTML = spinnerHtml;
                identityManager.resolveENSAvatar(peer)
                    .then(url => {
                        if (this.elements.currentChannelThumb !== slot) return;
                        slot.innerHTML = avatarHtml(seed, url);
                    })
                    .catch(() => {
                        if (this.elements.currentChannelThumb !== slot) return;
                        slot.innerHTML = fallbackHtml(seed);
                    });
            } else {
                slot.innerHTML = fallbackHtml(seed);
            }
        };

        const renderChannel = () => {
            const adminStreamId = channel.adminStreamId || deriveAdminId(channel.streamId);
            const setImg = (url) => {
                if (this.elements.currentChannelThumb !== slot) return;
                slot.innerHTML = imgHtml(url);
            };
            const cached = channelImageManager.getCached(adminStreamId);
            if (cached?.dataUrl) {
                slot.innerHTML = imgHtml(cached.dataUrl);
            } else {
                // Unknown — show spinner until resolution
                slot.innerHTML = spinnerHtml;
            }
            // Subscribe so newly-published image lands here too
            this._thumbUnsub = channelImageManager.subscribe(adminStreamId, (entry) => {
                if (entry?.dataUrl) setImg(entry.dataUrl);
            });
            // Trigger fetch and resolve directly too — covers cases where
            // the entry was already in flight before we subscribed.
            channelImageManager
                .get(adminStreamId, { password: channel.password || null })
                .then(entry => {
                    if (this.elements.currentChannelThumb !== slot) return;
                    if (entry?.dataUrl) setImg(entry.dataUrl);
                    // Only swap to deterministic fallback if still showing spinner
                    else if (!cached?.dataUrl) slot.innerHTML = fallbackHtml(channel.streamId);
                })
                .catch(() => {
                    if (this.elements.currentChannelThumb === slot && !cached?.dataUrl) {
                        slot.innerHTML = fallbackHtml(channel.streamId);
                    }
                });
        };

        slot.classList.remove('hidden');
        if (channel.type === 'dm') renderDM();
        else renderChannel();
    }

    /**
     * Hide channel thumbnail (e.g. on Explore mode)
     */
    clearChannelThumb() {
        if (this._thumbUnsub) { try { this._thumbUnsub(); } catch {} this._thumbUnsub = null; }
        const slot = this.elements.currentChannelThumb;
        if (slot) {
            slot.classList.add('hidden');
            slot.innerHTML = '';
        }
    }

    /**
     * Show/hide header right section (menu buttons)
     * @param {boolean} show - Whether to show
     */
    showHeaderRight(show) {
        if (show) {
            this.elements.chatHeaderRight?.classList.remove('hidden');
        } else {
            this.elements.chatHeaderRight?.classList.add('hidden');
        }
    }

    /**
     * Get channel type label HTML
     * @param {string} type - Channel type
     * @param {boolean} readOnly - Whether channel is read-only
     * @returns {string} - HTML with icon and label
     */
    getChannelTypeLabel(type, readOnly = false, showLabel = false) {
        // Megaphone icon for read-only/announcements indicator (header only)
        const roIcon = readOnly && !showLabel ? '<svg class="w-3 h-3 md:w-4 md:h-4 ml-1 text-overlay-40" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M11 5.882V19.24a1.76 1.76 0 01-3.417.592l-2.147-6.15M18 13a3 3 0 100-6M5.436 13.683A4.001 4.001 0 017 6h1.832c4.1 0 7.625-1.234 9.168-3v14c-1.543-1.766-5.067-3-9.168-3H7a3.988 3.988 0 01-1.564-.317z"/></svg>' : '';

        if (showLabel) {
            // Vertical layout for Channel Details modal: [icon][label] per line
            const roLine = readOnly ? '<span class="inline-flex items-center gap-1.5"><svg class="w-3 h-3 md:w-4 md:h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M11 5.882V19.24a1.76 1.76 0 01-3.417.592l-2.147-6.15M18 13a3 3 0 100-6M5.436 13.683A4.001 4.001 0 017 6h1.832c4.1 0 7.625-1.234 9.168-3v14c-1.543-1.766-5.067-3-9.168-3H7a3.988 3.988 0 01-1.564-.317z"/></svg>Announcements</span>' : '';
            const typeLines = {
                'public': `<span class="inline-flex items-center gap-1.5"><svg class="w-3 h-3 md:w-4 md:h-4" fill="currentColor" viewBox="0 0 24 24"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-1 17.93c-3.95-.49-7-3.85-7-7.93 0-.62.08-1.21.21-1.79L9 15v1c0 1.1.9 2 2 2v1.93zm6.9-2.54c-.26-.81-1-1.39-1.9-1.39h-1v-3c0-.55-.45-1-1-1H8v-2h2c.55 0 1-.45 1-1V7h2c1.1 0 2-.9 2-2v-.41c2.93 1.19 5 4.06 5 7.41 0 2.08-.8 3.97-2.1 5.39z"/></svg>Open</span>`,
                'password': `<span class="inline-flex items-center gap-1.5"><svg class="w-3 h-3 md:w-4 md:h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z"/></svg>Password Protected</span>`,
                // "Gated" until the gate itself is read — see
                // ChannelSettingsUI._applyGateAccessLabel. Naming a mode here
                // would state one of the four as fact whenever the read fails.
                'gated': `<span class="inline-flex items-center gap-1.5"><svg class="w-3 h-3 md:w-4 md:h-4" viewBox="0 0 24 24" fill="currentColor"><path d="M12 1.5l-8 13.5 8 4.5 8-4.5-8-13.5zm0 18l-8-4.5 8 9 8-9-8 4.5z"/></svg>Gated</span>`,
                'dm': `<span class="inline-flex items-center gap-1.5"><svg class="w-3 h-3 md:w-4 md:h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M3 8l7.89 5.26a2 2 0 002.22 0L21 8M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z"/></svg>Direct Message</span>`
            };
            const typeLine = typeLines[type] || escapeHtml(String(type || 'Unknown'));
            return `<div class="flex flex-col gap-1.5">${typeLine}${roLine}</div>`;
        }

        const labels = {
            'public': `<span class="inline-flex items-center gap-1"><svg class="w-3 h-3 md:w-4 md:h-4" fill="currentColor" viewBox="0 0 24 24"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-1 17.93c-3.95-.49-7-3.85-7-7.93 0-.62.08-1.21.21-1.79L9 15v1c0 1.1.9 2 2 2v1.93zm6.9-2.54c-.26-.81-1-1.39-1.9-1.39h-1v-3c0-.55-.45-1-1-1H8v-2h2c.55 0 1-.45 1-1V7h2c1.1 0 2-.9 2-2v-.41c2.93 1.19 5 4.06 5 7.41 0 2.08-.8 3.97-2.1 5.39z"/></svg>${roIcon}</span>`,
            'password': `<span class="inline-flex items-center gap-1"><svg class="w-3 h-3 md:w-4 md:h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z"/></svg>${roIcon}</span>`,
            'gated': `<span class="inline-flex items-center gap-1"><svg class="w-3 h-3 md:w-4 md:h-4" viewBox="0 0 24 24" fill="currentColor"><path d="M12 1.5l-8 13.5 8 4.5 8-4.5-8-13.5zm0 18l-8-4.5 8 9 8-9-8 4.5z"/></svg>${roIcon}</span>`,
            'dm': `<span class="inline-flex items-center gap-1"><svg class="w-3 h-3 md:w-4 md:h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M3 8l7.89 5.26a2 2 0 002.22 0L21 8M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z"/></svg></span>`
        };
        // Security: escape unknown types to prevent XSS
        return labels[type] || escapeHtml(String(type || 'Unknown'));
    }

    /**
     * Set header to "Explore" mode
     */
    setExploreMode() {
        this.updateChannelTitle('Explore Channels');
        this.hideChannelInfo();
        this.clearChannelThumb();
        this.showHeaderRight(false);
    }

    /**
     * Set header to channel mode
     * @param {Object} channel - Channel object with name, type, readOnly
     */
    setChannelMode(channel) {
        this.updateChannelTitle(channel.name);
        this.updateChannelInfo(channel.type, channel.readOnly);
        this.updateChannelThumb(channel);
        this.showHeaderRight(true);
    }

    /**
     * Get mobile pill nav elements (cached)
     */
    _getPillElements() {
        if (!this._pillElements) {
            this._pillElements = {
                connectFloat: document.getElementById('sidebar-connect-float'),
                sidebarConnectBtn: document.getElementById('sidebar-connect-btn'),
                pillNav: document.getElementById('mobile-pill-nav'),
                pillChatsBtn: document.getElementById('pill-chats-btn'),
                pillExploreBtn: document.getElementById('pill-explore-btn'),
                profileBtn: document.getElementById('pill-profile-btn')
            };
        }
        return this._pillElements;
    }

    /**
     * Initialize mobile pill nav event handlers
     * Called from app.js after DOM is ready
     */
    initPillNav({ onConnect, onChatsTab, onExploreTab, onProfileTab, onCreateChannel }) {
        const pill = this._getPillElements();

        // Floating connect button triggers same action as header connect
        pill.sidebarConnectBtn?.addEventListener('click', () => {
            onConnect?.();
        });

        pill.pillExploreBtn?.addEventListener('click', () => {
            this._setActivePillTab('explore');
            onExploreTab?.();
        });

        // Create Channel from header button (explore view)
        const headerCreateBtn = document.getElementById('header-create-channel-btn');
        headerCreateBtn?.addEventListener('click', () => {
            onCreateChannel?.();
        });

        pill.profileBtn?.addEventListener('click', () => {
            onProfileTab?.();
        });

        // Pill tabs: chats tab closes any open modal and returns to channel list
        pill.pillChatsBtn?.addEventListener('click', () => {
            this._setActivePillTab('chats');
            onChatsTab?.();
        });

        // Desktop sidebar footer buttons
        const contactsBtnDesktop = document.getElementById('contacts-btn-desktop');
        const settingsBtnDesktop = document.getElementById('settings-btn-desktop');
        if (contactsBtnDesktop) {
            contactsBtnDesktop.addEventListener('click', () => {
                document.getElementById('contacts-btn')?.click();
            });
        }
        if (settingsBtnDesktop) {
            settingsBtnDesktop.addEventListener('click', () => {
                // Import avoided: fire custom event; SettingsUI listens
                document.dispatchEvent(new CustomEvent('pombo:open-settings'));
            });
        }
    }

    /**
     * Toggle desktop account dropdown
     */
    _toggleDesktopDropdown() {
        const { desktopAccountDropdown } = this.elements;
        if (!desktopAccountDropdown) return;

        if (this._desktopDropdownOpen) {
            this._closeDesktopDropdown();
        } else {
            desktopAccountDropdown.classList.remove('hidden');
            desktopAccountDropdown.classList.add('dropdown-animate-open');
            this._desktopDropdownOpen = true;
        }
    }

    /**
     * Close desktop account dropdown
     */
    _closeDesktopDropdown() {
        const { desktopAccountDropdown } = this.elements;
        if (!desktopAccountDropdown) return;
        desktopAccountDropdown.classList.add('hidden');
        desktopAccountDropdown.classList.remove('dropdown-animate-open');
        this._desktopDropdownOpen = false;
    }

    /**
     * Set active pill tab visually
     */
    _setActivePillTab(tab) {
        const items = document.querySelectorAll('.pill-nav-item[data-pill-tab]');
        items.forEach(item => {
            if (item.dataset.pillTab === tab) {
                item.classList.add('active');
            } else {
                item.classList.remove('active');
            }
        });
    }

    /**
     * Public accessor for setting active pill tab
     */
    setActivePillTab(tab) {
        this._setActivePillTab(tab);
    }
}

// Export singleton
export const headerUI = new HeaderUI();
