/**
 * Channel creation form: tabs, visibility, password and gate fields.
 */

import { channelModalsUI } from '../ChannelModalsUI.js';

/**
 * @param {Object} ui - the UI controller singleton
 */
export function attachChannelForm(ui) {
    // New channel button
    ui.elements.newChannelBtn.addEventListener('click', () => {
        channelModalsUI.show();
    });

    // Channel type tabs - switch between tab content
    document.querySelectorAll('.channel-tab').forEach(tab => {
        tab.addEventListener('click', () => {
            const tabType = tab.dataset.tab;
            channelModalsUI.switchChannelTab(tabType);
        });
    });

    // On mobile the tabs are a horizontal scroller: fade the edge that has more past it
    const typeNav = document.querySelector('#new-channel-modal nav');
    if (typeNav) {
        const updateFade = () => {
            typeNav.classList.toggle('fade-start', typeNav.scrollLeft > 1);
            typeNav.classList.toggle('fade-end', typeNav.scrollLeft + typeNav.clientWidth < typeNav.scrollWidth - 1);
        };
        typeNav.addEventListener('scroll', updateFade, { passive: true });
        if (typeof ResizeObserver === 'function') new ResizeObserver(updateFade).observe(typeNav);
    }

    // Visibility toggle - switch between hidden/visible
    document.getElementById('visibility-toggle')?.addEventListener('click', () => {
        channelModalsUI.toggleVisibility();
    });

    // Channel password visibility toggle (eye icon)
    document.getElementById('channel-password-toggle')?.addEventListener('click', () => {
        const input = document.getElementById('channel-password-input');
        const eyeOpen = document.getElementById('channel-pw-eye-open');
        const eyeOff = document.getElementById('channel-pw-eye-off');
        if (!input) return;
        const isPassword = input.type === 'password';
        input.type = isPassword ? 'text' : 'password';
        input.style.webkitTextSecurity = isPassword ? 'none' : 'disc';
        eyeOpen?.classList.toggle('hidden', isPassword);
        eyeOff?.classList.toggle('hidden', !isPassword);
    });

    // Password confirm step: reopens whenever the password field gets
    // focus, closes again once the two fields match.
    const channelPasswordInput = document.getElementById('channel-password-input');
    const channelPasswordConfirmInput = document.getElementById('channel-password-confirm-input');
    channelPasswordInput?.addEventListener('focus', () => {
        channelModalsUI.expandPasswordConfirm();
    });
    channelPasswordInput?.addEventListener('input', () => {
        channelModalsUI.checkPasswordMatch();
    });
    channelPasswordConfirmInput?.addEventListener('input', () => {
        channelModalsUI.checkPasswordMatch();
    });

    // Gate asset tabs (for Gated channels) - switch between token/nft
    document.querySelectorAll('.gate-asset-tab').forEach(tab => {
        tab.addEventListener('click', () => {
            channelModalsUI.switchGateAssetTab(tab.dataset.gateAsset);
        });
    });

    // Quick-pick token presets (Gated/Paid tabs)
    document.querySelectorAll('.gate-token-preset-tab').forEach(tab => {
        tab.addEventListener('click', () => {
            channelModalsUI.switchTokenPresetTab('gate', tab.dataset.tokenPreset);
        });
    });
    document.querySelectorAll('.paid-token-preset-tab').forEach(tab => {
        tab.addEventListener('click', () => {
            channelModalsUI.switchTokenPresetTab('paid', tab.dataset.tokenPreset);
        });
    });
}
