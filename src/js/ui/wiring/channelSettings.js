/**
 * Channel settings modal: members, permissions and deletion.
 */

import { channelSettingsUI } from '../ChannelSettingsUI.js';

/**
 * @param {Object} ui - the UI controller singleton
 */
export function attachChannelSettings(ui) {
    // Close channel settings modal
    if (ui.elements.closeChannelSettingsBtn) {
        ui.elements.closeChannelSettingsBtn.addEventListener('click', () => {
            // On mobile, if a sub-panel is open, go back to unified view first
            if (ui.isMobileView() && channelSettingsUI.closeMobileSubPanel()) {
                return;
            }
            ui.hideChannelSettingsModal();
        });
    }

    // Click outside channel settings modal to close (desktop only - on mobile it's a full-screen container)
    if (ui.elements.channelSettingsModal) {
        ui.elements.channelSettingsModal.addEventListener('click', (e) => {
            if (e.target === ui.elements.channelSettingsModal && !ui.isMobileView()) {
                ui.hideChannelSettingsModal();
            }
        });
    }

    // Refresh members button
    if (ui.elements.refreshMembersBtn) {
        ui.elements.refreshMembersBtn.addEventListener('click', () => {
            channelSettingsUI.loadMembers();
        });
    }

    // Refresh permissions button
    if (ui.elements.refreshPermissionsBtn) {
        ui.elements.refreshPermissionsBtn.addEventListener('click', () => {
            channelSettingsUI.loadPermissions();
        });
    }

    // Add member button
    if (ui.elements.addMemberBtn) {
        ui.elements.addMemberBtn.addEventListener('click', () => {
            channelSettingsUI.handleAddMember();
        });
    }

    // Batch add members button
    if (ui.elements.batchAddMembersBtn) {
        ui.elements.batchAddMembersBtn.addEventListener('click', () => {
            channelSettingsUI.handleBatchAddMembers();
        });
    }

    // Copy the identifier by clicking its row — a DM names an address there,
    // every other channel its stream id.
    const idRow = document.getElementById('channel-id-row') || ui.elements.channelSettingsId;
    if (idRow) {
        idRow.addEventListener('click', async () => {
            const code = ui.elements.channelSettingsId;
            const value = code?.dataset.copy || ui.getActiveChannel()?.streamId;
            if (!value) return;
            try {
                await navigator.clipboard.writeText(value);
                ui.showNotification(`${code?.dataset.copyLabel || 'Channel ID'} copied!`, 'success');
            } catch {
                ui.showNotification('Failed to copy', 'error');
            }
        });
    }


    // Delete channel button
    if (ui.elements.deleteChannelBtn) {
        ui.elements.deleteChannelBtn.addEventListener('click', () => {
            channelSettingsUI.showDeleteModal();
        });
    }

    // Cancel delete button
    if (ui.elements.cancelDeleteBtn) {
        ui.elements.cancelDeleteBtn.addEventListener('click', () => {
            channelSettingsUI.hideDeleteModal();
        });
    }

    // Confirm delete button
    if (ui.elements.confirmDeleteBtn) {
        ui.elements.confirmDeleteBtn.addEventListener('click', () => {
            channelSettingsUI.handleDelete();
        });
    }

    // Click outside delete modal to close
    if (ui.elements.deleteChannelModal) {
        ui.elements.deleteChannelModal.addEventListener('click', (e) => {
            if (e.target === ui.elements.deleteChannelModal) {
                channelSettingsUI.hideDeleteModal();
            }
        });
    }
}
