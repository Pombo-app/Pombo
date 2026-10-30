/**
 * Join channel flows: join by ID and closed channels.
 */

import { channelModalsUI } from '../ChannelModalsUI.js';

/**
 * @param {Object} ui - the UI controller singleton
 */
export function attachJoinFlows(ui) {
    // Join by ID from the Explore header (mobile and desktop)
    for (const id of ['header-join-id-btn', 'explore-join-id-btn']) {
        document.getElementById(id)?.addEventListener('click', () => {
            ui.showJoinChannelModal();
        });
    }

    const joinModal = ui.elements.joinChannelModal;
    const joinBtn = ui.elements.joinBtn;
    const join = () => {
        if (!joinBtn?.disabled) ui.handleJoinChannel();
    };
    joinBtn?.addEventListener('click', join);
    ui.elements.joinStreamIdInput?.addEventListener('input', (e) => {
        joinBtn?.toggleAttribute('disabled', !e.target.value.trim());
    });
    joinModal?.querySelectorAll('input').forEach(input => {
        input.addEventListener('keypress', (e) => {
            if (e.key === 'Enter') join();
        });
    });
    joinModal?.querySelectorAll('.join-id-classification-tab').forEach(tab => {
        tab.addEventListener('click', () => {
            ui.joinChannelUI.setJoinClassification(tab.dataset.joinIdClassification);
        });
    });

    ui.elements.cancelJoinBtn?.addEventListener('click', () => {
        ui.hideJoinChannelModal();
    });
    joinModal?.addEventListener('click', (e) => {
        if (e.target === joinModal) ui.hideJoinChannelModal();
    });

    // Join Closed Channel modal buttons
    document.getElementById('join-closed-btn')?.addEventListener('click', () => {
        channelModalsUI.saveLocalIdentity();
    });
    document.getElementById('cancel-join-closed-btn')?.addEventListener('click', () => {
        channelModalsUI.hideJoinClosedModal();
    });

    // Join password visibility toggle (eye icon)
    document.getElementById('join-password-toggle')?.addEventListener('click', () => {
        const input = document.getElementById('join-password-input');
        const eyeOpen = document.getElementById('join-pw-eye-open');
        const eyeOff = document.getElementById('join-pw-eye-off');
        if (!input) return;
        const isPassword = input.type === 'password';
        input.type = isPassword ? 'text' : 'password';
        input.style.webkitTextSecurity = isPassword ? 'none' : 'disc';
        eyeOpen?.classList.toggle('hidden', isPassword);
        eyeOff?.classList.toggle('hidden', !isPassword);
    });
}
