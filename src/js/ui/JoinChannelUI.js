/**
 * @fileoverview Join Channel UI Manager
 * Handles all join channel related functionality including quick join,
 * password-protected channels, and public channel joining.
 */
import { Logger } from '../logger.js';

// Forward declarations - dependencies injected via init()
let channelManager = null;
let modalManager = null;
let notificationUI = null;
let graphAPI = null;
let exploreUI = null;
let channelModalsUI = null;

/**
 * Manages join channel UI and workflows
 */
class JoinChannelUI {
    /**
     * @param {Object} elements - DOM element references from UIController
     */
    constructor(elements) {
        this.elements = elements;
    }

    /**
     * Show join channel modal
     */
    showJoinChannelModal() {
        modalManager.showJoinChannelModal(
            this.elements.joinChannelModal,
            this.elements.joinStreamIdInput,
            this.elements.joinPasswordInput,
            this.elements.joinPasswordField
        );
    }

    /**
     * Hide join channel modal
     */
    hideJoinChannelModal() {
        modalManager.hide('join-channel-modal');
    }

    /**
     * Handle quick join
     * @param {Function} showNotification - Notification callback
     * @param {Function} renderChannelList - Channel list render callback
     * @param {string} streamId - Channel stream ID to join
     */
    async handleQuickJoin(showNotification, renderChannelList, streamId) {
        
        if (!streamId) {
            showNotification('Please enter a channel ID', 'error');
            return;
        }

        // First check cache (from ExploreUI), then query The Graph for channel info
        let channelInfo = exploreUI.cachedPublicChannels?.find(ch => ch.streamId === streamId);
        
        if (!channelInfo) {
            // Not in cache - query The Graph
            notificationUI.showLoading('Checking channel...');
            try {
                channelInfo = await graphAPI.getChannelInfo(streamId);
            } catch (error) {
                Logger.warn('Failed to query channel info:', error);
            } finally {
                notificationUI.hideLoading();
            }
        }
        
        // If we know it's a password-protected channel, show password modal
        if (channelInfo?.type === 'password') {
            const displayName = channelInfo.name || channelInfo.displayName || 'this channel';
            const password = await this.showPasswordInputModal('Join Password Channel', 
                `Enter password for "${displayName}":`);
            
            if (!password) {
                return; // User cancelled
            }
            
            try {
                notificationUI.showLoadingToast('Joining channel...', 'This may take a moment');
                await channelManager.joinChannel(streamId, password, {
                    name: channelInfo.name,
                    type: 'password'
                });
                
                renderChannelList();
                showNotification('Joined channel successfully!', 'success');
            } catch (error) {
                showNotification('Failed to join: ' + error.message, 'error');
            } finally {
                notificationUI.hideLoadingToast();
            }
            return;
        }
        
        // Closed-style channels without an on-chain name need a local name +
        // classification. A gated channel WITH an on-chain name (visible
        // token/paid) joins like a public channel — the owner named it.
        if (channelInfo?.type === 'gated' && !channelInfo?.name) {
            channelModalsUI.showJoinClosedModal(streamId, channelInfo);
            return;
        }
        
        // For hidden channels without a name, ask user for a local name
        // This applies to any channel type with exposure: hidden and name: null
        if (channelInfo && !channelInfo.name) {
            channelModalsUI.showJoinHiddenModal(streamId, channelInfo);
            return;
        }

        // For unknown channels (no channelInfo), show modal to get name
        if (!channelInfo) {
            channelModalsUI.showJoinHiddenModal(streamId, null);
            return;
        }

        // For channels with on-chain name, join directly - name is immutable
        try {
            notificationUI.showLoadingToast('Joining channel...', 'This may take a moment');
            await channelManager.joinChannel(streamId, null, {
                name: channelInfo.name,
                type: channelInfo.type,
                readOnly: channelInfo.readOnly || false,
                createdBy: channelInfo.createdBy
            });

            renderChannelList();
            showNotification('Joined channel successfully!', 'success');
        } catch (error) {
            if (error.code === 'GATE_ACCESS_DENIED') {
                channelModalsUI.showGateEntryModal({
                    streamId,
                    gateAddress: error.gateAddress,
                    name: channelInfo.name,
                    retry: () => this.handleQuickJoin(showNotification, renderChannelList, streamId)
                });
            } else {
                showNotification('Failed to join: ' + error.message, 'error');
            }
        } finally {
            notificationUI.hideLoadingToast();
        }
    }

    /**
     * Handle join channel from modal
     * @param {Function} showNotification - Notification callback
     * @param {Function} renderChannelList - Channel list render callback
     */
    async handleJoinChannel(showNotification, renderChannelList) {
        const streamId = this.elements.joinStreamIdInput?.value.trim();
        const password = this.elements.joinPasswordInput?.value || null;

        if (!streamId) {
            showNotification('Please enter a Stream ID', 'error');
            return;
        }

        try {
            notificationUI.showLoadingToast('Joining channel...', 'This may take a moment');
            await channelManager.joinChannel(streamId, password);
            this.hideJoinChannelModal();
            renderChannelList();
            showNotification('Joined channel successfully!', 'success');
        } catch (error) {
            if (error.code === 'GATE_ACCESS_DENIED') {
                this.hideJoinChannelModal();
                channelModalsUI.showGateEntryModal({
                    streamId,
                    gateAddress: error.gateAddress,
                    retry: async () => {
                        try {
                            notificationUI.showLoadingToast('Joining channel...', 'This may take a moment');
                            await channelManager.joinChannel(streamId, password);
                            renderChannelList();
                            showNotification('Joined channel successfully!', 'success');
                        } finally {
                            notificationUI.hideLoadingToast();
                        }
                    }
                });
            } else {
                showNotification('Failed to join: ' + error.message, 'error');
            }
        } finally {
            notificationUI.hideLoadingToast();
        }
    }

    /**
     * Join a public channel from browse/explore
     * @param {string} streamId - Channel stream ID
     * @param {Object} channelInfo - Channel metadata (optional)
     * @param {Function} showNotification - Notification callback
     * @param {Function} renderChannelList - Channel list render callback
     * @param {Function} selectChannel - Channel selection callback
     */
    async joinPublicChannel(streamId, channelInfo, showNotification, renderChannelList, selectChannel) {
        try {
            // Channels without an on-chain name (hidden gated included) join
            // directly: the post-join local identity panel asks for the name
            // and classification AFTER the entry — for a gated channel that
            // means after the gate entry screen and the payment, over the
            // key-request wait, never before the user has seen the price.

            // If password-protected, ask for password
            if (channelInfo?.type === 'password') {
                const displayName = channelInfo.name || channelInfo.displayName || 'this channel';
                const password = await this.showPasswordInputModal('Join Password Channel', 
                    `Enter password for "${displayName}":`);
                
                if (!password) {
                    return; // User cancelled
                }
                
                notificationUI.showLoadingToast('Joining channel...', 'This may take a moment');
                await channelManager.joinChannel(streamId, password, {
                    name: channelInfo?.name,
                    type: 'password',
                    readOnly: channelInfo?.readOnly || false,
                    createdBy: channelInfo?.createdBy
                });
            } else {
                notificationUI.showLoadingToast('Joining channel...', 'This may take a moment');
                await channelManager.joinChannel(streamId, null, {
                    name: channelInfo?.name,
                    type: channelInfo?.type || 'public',
                    readOnly: channelInfo?.readOnly || false,
                    createdBy: channelInfo?.createdBy,
                    // Author-visibility hint from the Explore card; the join
                    // re-reads the -1 metadata when absent
                    wireIdentity: channelInfo?.wireIdentity || undefined
                });
            }
            
            renderChannelList();

            // Automatically enter the channel after joining
            await selectChannel(streamId);

            showNotification('Joined channel successfully!', 'success');
        } catch (error) {
            if (error.code === 'GATE_ACCESS_DENIED') {
                channelModalsUI.showGateEntryModal({
                    streamId,
                    gateAddress: error.gateAddress,
                    name: channelInfo?.name,
                    retry: () => this.joinPublicChannel(streamId, channelInfo, showNotification, renderChannelList, selectChannel)
                });
            } else {
                showNotification('Failed to join: ' + error.message, 'error');
            }
        } finally {
            notificationUI.hideLoadingToast();
        }
    }

    /**
     * Show password input modal for joining password-protected channels
     * @param {string} title - Modal title
     * @param {string} message - Modal message
     * @returns {Promise<string|null>} Password or null if cancelled
     */
    showPasswordInputModal(title, message) {
        return new Promise((resolve) => {
            const modal = document.createElement('div');
            modal.className = 'fixed inset-0 bg-black/80 flex items-center justify-center z-[60]';
            // Security: escape user-provided content to prevent XSS
            const safeTitle = this._escapeHtml(title);
            const safeMessage = this._escapeHtml(message);
            modal.innerHTML = `
                <div class="bg-[#111113] rounded-2xl p-5 w-[340px] max-w-full mx-4 border border-white/[0.06]">
                    <h3 class="text-[15px] font-medium mb-2 text-white">${safeTitle}</h3>
                    <p class="text-[12px] text-white/50 mb-4">${safeMessage}</p>
                    <div class="relative mb-4">
                        <input type="password" id="browse-password-input" placeholder="Enter password..." 
                            class="w-full bg-white/[0.05] border border-white/[0.08] text-white px-3 py-2.5 pr-10 rounded-xl text-[13px] focus:outline-none focus:border-white/[0.15] transition"
                            autocomplete="off" data-lpignore="true" data-1p-ignore="true" data-form-type="other" spellcheck="false"
                            style="-webkit-text-security: disc; text-security: disc;">
                        <button type="button" id="browse-pw-toggle" class="absolute right-2.5 top-1/2 -translate-y-1/2 text-white/25 hover:text-white transition">
                            <svg class="w-4 h-4" id="browse-pw-eye-open" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M2.036 12.322a1.012 1.012 0 010-.639C3.423 7.51 7.36 4.5 12 4.5c4.638 0 8.573 3.007 9.963 7.178.07.207.07.431 0 .639C20.577 16.49 16.64 19.5 12 19.5c-4.638 0-8.573-3.007-9.963-7.178z"/>
                                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"/>
                            </svg>
                            <svg class="w-4 h-4 hidden" id="browse-pw-eye-off" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M3.98 8.223A10.477 10.477 0 001.934 12C3.226 16.338 7.244 19.5 12 19.5c.993 0 1.953-.138 2.863-.395M6.228 6.228A10.45 10.45 0 0112 4.5c4.756 0 8.773 3.162 10.065 7.498a10.523 10.523 0 01-4.293 5.774M6.228 6.228L3 3m3.228 3.228l3.65 3.65m7.894 7.894L21 21m-3.228-3.228l-3.65-3.65m0 0a3 3 0 10-4.243-4.243m4.242 4.242L9.88 9.88"/>
                            </svg>
                        </button>
                    </div>
                    <div class="flex gap-2">
                        <button id="cancel-pw-btn" class="flex-1 bg-white/[0.05] hover:bg-white/[0.08] border border-white/[0.08] text-white/50 text-[13px] font-medium py-2.5 rounded-xl transition">
                            Cancel
                        </button>
                        <button id="confirm-pw-btn" class="flex-1 bg-white hover:bg-[#f0f0f0] text-black text-[13px] font-medium py-2.5 rounded-lg transition">
                            Join
                        </button>
                    </div>
                </div>
            `;
            
            document.body.appendChild(modal);
            
            const input = modal.querySelector('#browse-password-input');
            const cancelBtn = modal.querySelector('#cancel-pw-btn');
            const confirmBtn = modal.querySelector('#confirm-pw-btn');
            
            // Eye toggle for password visibility
            const toggleBtn = modal.querySelector('#browse-pw-toggle');
            if (toggleBtn) {
                toggleBtn.addEventListener('click', () => {
                    const eyeOpen = modal.querySelector('#browse-pw-eye-open');
                    const eyeOff = modal.querySelector('#browse-pw-eye-off');
                    const isPassword = input.type === 'password';
                    input.type = isPassword ? 'text' : 'password';
                    input.style.webkitTextSecurity = isPassword ? 'none' : 'disc';
                    input.style.textSecurity = isPassword ? 'none' : 'disc';
                    eyeOpen?.classList.toggle('hidden', isPassword);
                    eyeOff?.classList.toggle('hidden', !isPassword);
                });
            }

            setTimeout(() => input.focus(), 100);
            
            const cleanup = (value) => {
                document.body.removeChild(modal);
                resolve(value);
            };
            
            cancelBtn.addEventListener('click', () => cleanup(null));
            confirmBtn.addEventListener('click', () => cleanup(input.value));
            input.addEventListener('keypress', (e) => {
                if (e.key === 'Enter') cleanup(input.value);
            });
            modal.addEventListener('click', (e) => {
                if (e.target === modal) cleanup(null);
            });
        });
    }

    /**
     * Generate and display QR code for invite
     * @param {string} inviteLink - Invite link
     * @param {Function} showNotification - Notification callback
     */
    async generateQRCode(inviteLink, showNotification) {
        try {
            // QRCode is bundled in vendor.bundle.js
            if (!window.QRCode) {
                throw new Error('QRCode library not loaded');
            }

            // Show in modal
            const modal = document.createElement('div');
            modal.className = 'fixed inset-0 bg-black/80 flex items-center justify-center z-50';
            modal.innerHTML = `
                <div class="bg-[#111113] rounded-2xl p-5 border border-white/[0.06]">
                    <h3 class="text-[15px] font-medium mb-4 text-white">Invite QR Code</h3>
                    <div id="qr-container" class="bg-white p-3 rounded-lg flex items-center justify-center"></div>
                    <button class="mt-4 w-full bg-white/[0.05] hover:bg-white/[0.08] border border-white/[0.08] text-white/50 text-[13px] font-medium px-4 py-2.5 rounded-xl transition">Close</button>
                </div>
            `;
            
            document.body.appendChild(modal);
            
            // Generate QR code using qrcode npm package
            // Use lowest error correction level (L) to allow more data capacity
            const container = modal.querySelector('#qr-container');
            const canvas = document.createElement('canvas');
            await window.QRCode.toCanvas(canvas, inviteLink, {
                width: 200,
                margin: 1,
                errorCorrectionLevel: 'L',
                color: {
                    dark: '#000000',
                    light: '#ffffff'
                }
            });
            container.appendChild(canvas);
            
            modal.querySelector('button').addEventListener('click', () => {
                document.body.removeChild(modal);
            });
            
            // Click outside to close
            modal.addEventListener('click', (e) => {
                if (e.target === modal) {
                    document.body.removeChild(modal);
                }
            });
        } catch (error) {
            Logger.error('Failed to generate QR code:', error);
            showNotification('Failed to generate QR code', 'error');
        }
    }

    /**
     * Escape HTML characters to prevent XSS
     * @param {string} unsafe - Unsafe string
     * @returns {string} Safe escaped string
     * @private
     */
    _escapeHtml(unsafe) {
        return unsafe
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;")
            .replace(/"/g, "&quot;")
            .replace(/'/g, "&#039;");
    }
}

// Singleton instance
let instance = null;

/**
 * Initialize JoinChannelUI with dependencies
 * @param {Object} deps - Dependencies
 * @returns {JoinChannelUI} Singleton instance
 */
export function init(deps) {
    channelManager = deps.channelManager;
    modalManager = deps.modalManager;
    notificationUI = deps.notificationUI;
    graphAPI = deps.graphAPI;
    exploreUI = deps.exploreUI;
    channelModalsUI = deps.channelModalsUI;
    
    instance = new JoinChannelUI(deps.elements);
    return instance;
}

/**
 * Get the singleton instance
 * @returns {JoinChannelUI|null}
 */
export function getInstance() {
    return instance;
}

export { JoinChannelUI };
