/**
 * @fileoverview Invite UI Manager
 * Handles channel invite functionality including invite links,
 * direct invites, and QR code generation.
 */
import { Logger } from '../logger.js';
import { identityManager } from '../identity.js';

// Forward declarations - dependencies injected via setDependencies()
let channelManager = null;
let modalManager = null;

/**
 * Manages invite modal UI and workflows
 */
class InviteUI {
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
        modalManager = deps.modalManager;
    }

    /**
     * Set element references
     * @param {Object} elements - DOM element references
     */
    setElements(elements) {
        this.elements = elements;
    }

    /**
     * Show invite modal
     */
    async show() {
        const currentChannel = channelManager.getCurrentChannel();
        if (!currentChannel) {
            this.deps.showNotification('Please select a channel first', 'warning');
            return;
        }

        try {
            // Generate encrypted invite link
            const inviteLink = await channelManager.generateInviteLink(currentChannel.streamId);
            if (this.elements.inviteLinkDisplay) {
                this.elements.inviteLinkDisplay.value = inviteLink;
            }
        } catch (error) {
            Logger.error('Failed to generate invite link:', error);
            this.deps.showNotification('Failed to generate invite link', 'error');
            return;
        }

        // Clear address input
        if (this.elements.inviteAddressInput) {
            this.elements.inviteAddressInput.value = '';
        }

        // Reset to link tab
        this.switchTab('link');

        // Show modal
        modalManager.show('invite-users-modal');
    }

    /**
     * Hide invite modal
     */
    hide() {
        modalManager.hide('invite-users-modal');
    }

    /**
     * Switch invite modal tab
     * @param {string} tabType - Tab type ('link' or 'address')
     */
    switchTab(tabType) {
        // Update tab buttons
        document.querySelectorAll('.invite-tab').forEach(tab => {
            if (tab.dataset.inviteTab === tabType) {
                tab.classList.add('bg-white', 'text-black', 'font-medium');
                tab.classList.remove('text-overlay-50', 'hover:text-primary', 'hover:bg-overlay-6');
            } else {
                tab.classList.remove('bg-white', 'text-black', 'font-medium');
                tab.classList.add('text-overlay-50', 'hover:text-primary', 'hover:bg-overlay-6');
            }
        });

        // Show/hide content panels
        document.querySelectorAll('.invite-tab-content').forEach(panel => {
            panel.classList.add('hidden');
        });

        const targetPanel = document.getElementById(`invite-tab-${tabType}`);
        if (targetPanel) {
            targetPanel.classList.remove('hidden');
        }
    }

    /**
     * Handle send invite to address
     */
    async handleSendInvite() {
        const input = this.elements.inviteAddressInput?.value.trim();
        if (!input) {
            this.deps.showNotification('Enter an address or ENS name', 'warning');
            return;
        }

        const currentChannel = channelManager.getCurrentChannel();
        if (!currentChannel) {
            this.deps.showNotification('No channel selected', 'error');
            return;
        }

        let address = input;
        if (!input.startsWith('0x') && input.includes('.')) {
            this.deps.showLoading('Resolving name…');
            try {
                address = await identityManager.resolveAddress(input);
            } finally {
                this.deps.hideLoading();
            }
            if (!address) {
                this.deps.showNotification(`Could not resolve ENS name: ${input}`, 'error');
                return;
            }
        }

        if (!/^0x[a-fA-F0-9]{40}$/.test(address)) {
            this.deps.showNotification('Invalid address or ENS name', 'error');
            return;
        }

        try {
            // Import notificationManager dynamically
            const { notificationManager } = await import('../notifications.js');

            this.deps.showLoading('Sending invite…');
            await notificationManager.sendChannelInvite(address, currentChannel);
            this.hide();
            this.deps.showNotification('Invite sent', 'success');
        } catch (error) {
            Logger.error('Failed to send invite:', error);
            // Check for STREAM_NOT_FOUND error - user doesn't have notifications enabled
            if (error.message?.includes('STREAM_NOT_FOUND') || error.message?.includes('Stream not found')) {
                this.deps.showNotification('User does not have notifications enabled', 'error', 5000);
            } else {
                this.deps.showNotification('Failed to send invite', 'error');
            }
        } finally {
            this.deps.hideLoading();
        }
    }

    /**
     * Copy invite link to clipboard
     */
    copyInviteLink() {
        if (this.elements.inviteLinkDisplay) {
            this.elements.inviteLinkDisplay.select();
            document.execCommand('copy');
            this.deps.showNotification('Link copied to clipboard', 'success');
        }
    }

    /**
     * Show invite QR code
     */
    showQR() {
        const inviteLink = this.elements.inviteLinkDisplay?.value;
        if (inviteLink && this.deps.generateQRCode) {
            this.deps.generateQRCode(inviteLink);
        }
    }
}

// Singleton instance
export const inviteUI = new InviteUI();
