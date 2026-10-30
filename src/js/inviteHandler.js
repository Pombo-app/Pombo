/**
 * Invite Handler Module
 * Handles invite link detection, dialog display, and channel joining from invites.
 * Extracted from app.js to decompose the God Object.
 */

import { authManager } from './auth.js';
import { channelManager } from './channels.js';
import { uiController } from './ui.js';
import { notificationManager } from './notifications.js';
import { Logger } from './logger.js';
import { escapeHtml } from './ui/utils.js';
import { sanitizeText } from './ui/sanitizer.js';
import { 
    createModalFromTemplate, 
    bindData, 
    closeModal, 
    setupModalCloseHandlers,
    $
} from './ui/modalUtils.js';

class InviteHandler {
    constructor() {
        this.pendingInvite = null;
    }

    /**
     * Check for invite link in URL
     */
    async checkInviteLink() {
        const hash = window.location.hash || '';
        const match = hash.match(/^#\/invite\/([^?#]+)/);
        const inviteCode = match?.[1] || null;

        if (inviteCode) {
            const inviteData = await channelManager.parseInviteLink(inviteCode);

            if (inviteData) {
                Logger.info('Invite detected:', inviteData);

                // Clear URL immediately to avoid re-processing on refresh
                window.history.replaceState({}, document.title, window.location.pathname);

                // If wallet already connected, process immediately
                // Otherwise store for processing after auto-connect (Guest or saved account)
                if (authManager.isConnected()) {
                    this.showInviteDialog(inviteData);
                } else {
                    // Store for later - will be processed in onWalletConnected()
                    this.pendingInvite = inviteData;
                }
            }
        }
    }

    /**
     * Show invite dialog and process
     */
    showInviteDialog(inviteData) {
        const modal = createModalFromTemplate('modal-invite');
        if (!modal) return;

        // Bind channel data (safely escaped via textContent)
        bindData(modal, {
            channelName: sanitizeText(inviteData.name),
            channelType: this.getChannelTypeLabel(inviteData.type),
            streamId: sanitizeText(inviteData.streamId)
        });

        const cleanup = () => closeModal(modal);

        // Close and decline handlers
        setupModalCloseHandlers(modal, cleanup);
        $(modal, '[data-action="decline"]').addEventListener('click', cleanup);

        // Accept handler
        $(modal, '[data-action="accept"]').addEventListener('click', () => {
            cleanup();
            this.joinChannelFromInvite(inviteData);
        });
    }

    /**
     * Get channel type label for display
     */
    getChannelTypeLabel(type) {
        const labels = {
            'public': 'Public Channel',
            'password': 'Password Protected',
            'gated': 'Gated Channel (on-chain)'
        };
        // Security: escape unknown types to prevent XSS
        return labels[type] || escapeHtml(String(type || 'Unknown'));
    }

    /**
     * Join channel from invite
     * @param {Object} inviteData - Invite data
     */
    async joinChannelFromInvite(inviteData) {
        try {
            uiController.showLoading('Joining channel…');
            await channelManager.joinChannel(inviteData.streamId, inviteData.password, {
                name: inviteData.name,
                type: inviteData.type,
                gateAddress: inviteData.gateAddress
            });

            uiController.renderChannelList();
            uiController.showNotification('Joined channel', 'success');
        } catch (error) {
            if (error.code === 'GATE_ACCESS_DENIED') {
                const { channelModalsUI } = await import('./ui/ChannelModalsUI.js');
                channelModalsUI.showGateEntryModal({
                    streamId: inviteData.streamId,
                    gateAddress: error.gateAddress,
                    name: inviteData.name,
                    retry: () => this.joinChannelFromInvite(inviteData)
                });
            } else {
                uiController.showNotification('Failed to join channel: ' + error.message, 'error');
            }
        } finally {
            uiController.hideLoading();
        }
    }

    /**
     * Accept invite (called from notification banner)
     * @param {string} inviteId - Invite ID
     */
    async acceptInvite(inviteId) {
        await notificationManager.acceptInvite(inviteId);
        uiController.renderChannelList();
    }

    /**
     * Dismiss invite (called from notification banner)
     * @param {string} inviteId - Invite ID
     */
    dismissInvite(inviteId) {
        notificationManager.dismissInvite(inviteId);
    }
}

export const inviteHandler = new InviteHandler();
