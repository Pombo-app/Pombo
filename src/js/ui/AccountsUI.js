/**
 * Accounts screen (mobile, opened from the pill avatar): who is signed in,
 * the saved accounts to switch to, adding one, browsing as guest, About, and
 * locking the session. Mirrors the Android Profile screen.
 */

import { CONFIG } from '../config.js';
import { getAvatarHtml } from './AvatarGenerator.js';
import { escapeHtml } from './utils.js';
import { modalManager } from './ModalManager.js';
import { confirmDialog } from './ConfirmDialogUI.js';

const shortAddress = (a) => `${a.slice(0, 6)}…${a.slice(-4)}`;

/**
 * Names readable without unlocking: secureStorage mirrors the username to
 * plain localStorage on unlock, on change and on sync, and the ENS name is
 * mirrored when it resolves.
 */
const storedEns = (address) => localStorage.getItem(CONFIG.storageKeys.ens(address));
const storedUsername = (address) => localStorage.getItem(CONFIG.storageKeys.username(address));

class AccountsUI {
    constructor() {
        this.deps = {};
        this._wired = false;
        this._aboutOpen = false;
    }

    /**
     * @param {Object} deps
     * @param {Object} deps.authManager
     * @param {Object} deps.identityManager
     * @param {Function} deps.switchTo - (address) => switch to a saved account
     * @param {Function} deps.addAccount - create / import / restore another account
     * @param {Function} deps.browseAsGuest - leave the account for a guest session
     * @param {Function} deps.lock - disconnect and ask for an unlock
     * @param {Function} deps.hideOtherScreens - close Settings / Contacts without history
     */
    init(deps) {
        this.deps = { ...this.deps, ...deps };
        if (this._wired) return;
        this._wired = true;

        modalManager.registerOnHide('accounts-modal', () => this._cleanupOnHide());

        document.getElementById('accounts-add-btn')?.addEventListener('click', () => {
            this.hide();
            this.deps.addAccount?.();
        });
        document.getElementById('accounts-guest-btn')?.addEventListener('click', () => {
            this.hide();
            this.deps.browseAsGuest?.();
        });
        document.getElementById('accounts-about-btn')?.addEventListener('click', () => this._openAbout());
        document.getElementById('accounts-about-close')?.addEventListener('click', () => this._closeAbout());
        document.getElementById('accounts-about-dialog')?.addEventListener('click', (e) => {
            if (e.target.id === 'accounts-about-dialog') this._closeAbout();
        });
        document.getElementById('accounts-lock-btn')?.addEventListener('click', () => this._confirmLock());
        document.getElementById('accounts-list')?.addEventListener('click', (e) => {
            const row = e.target.closest('[data-account]');
            if (!row || row.dataset.current === '1') return;
            this.hide();
            this.deps.switchTo?.(row.dataset.account);
        });
    }

    show() {
        this.deps.hideOtherScreens?.();
        this.render();
        document.body.classList.add('accounts-open');
        document.querySelectorAll('.pill-nav-item[data-pill-tab]').forEach(item => {
            item.classList.toggle('active', item.dataset.pillTab === 'profile');
        });
        modalManager.show('accounts-modal');
    }

    hide(options = {}) {
        modalManager.hide('accounts-modal', options);
    }

    _cleanupOnHide() {
        this._setAboutVisible(false);
        document.body.classList.remove('accounts-open');
        const active = document.querySelector('.pill-nav-item[data-pill-tab].active');
        if (!active || active.dataset.pillTab === 'profile') {
            document.querySelectorAll('.pill-nav-item[data-pill-tab]').forEach(item => {
                item.classList.toggle('active', item.dataset.pillTab === 'chats');
            });
        }
    }

    /** About is a dialog over this screen; Back closes it before the screen. */
    _openAbout() {
        if (this._aboutOpen) return;
        this._setAboutVisible(true);
        modalManager.pushSubState('accounts-modal', () => this._setAboutVisible(false));
    }

    _closeAbout() {
        if (!this._aboutOpen) return;
        this._setAboutVisible(false);
        modalManager.dropSubState('accounts-modal');
    }

    _setAboutVisible(visible) {
        this._aboutOpen = visible;
        document.getElementById('accounts-about-dialog')?.classList.toggle('hidden', !visible);
    }

    render() {
        const { authManager, identityManager } = this.deps;
        const address = authManager?.getAddress() || '';
        const isGuest = !!authManager?.isGuestMode();
        const saved = authManager?.listSavedWallets() || [];
        const current = address.toLowerCase();

        // Display precedence, as on Android: ENS → username → short address.
        const ens = address && !isGuest ? storedEns(address) : null;
        const username = isGuest ? null : (identityManager?.getUsername() || (address && storedUsername(address)));

        const avatar = document.getElementById('accounts-avatar');
        if (avatar) avatar.innerHTML = address ? getAvatarHtml(address, 88, 0.3) : '';
        const name = document.getElementById('accounts-name');
        if (name) name.textContent = ens || username || (address ? shortAddress(address) : 'No name');
        const second = document.getElementById('accounts-username');
        if (second) {
            second.textContent = ens && username ? username : '';
            second.classList.toggle('hidden', !(ens && username));
        }
        const addr = document.getElementById('accounts-address');
        if (addr) addr.textContent = address || '—';

        // Also shown to a guest with one saved account, so "Browse as guest"
        // is never a one-way door.
        const showList = saved.length > 1 || (isGuest && saved.length > 0);
        document.getElementById('accounts-list-section')?.classList.toggle('hidden', !showList);
        const list = document.getElementById('accounts-list');
        if (list) {
            list.innerHTML = saved.map(w => {
                const isCurrent = !isGuest && w.address.toLowerCase() === current;
                const label = storedEns(w.address) || storedUsername(w.address) || shortAddress(w.address);
                return `<button class="accounts-row accounts-account-row" data-account="${escapeHtml(w.address)}" data-current="${isCurrent ? '1' : '0'}">
                    <span class="accounts-row-avatar">${getAvatarHtml(w.address, 34, 0.5)}</span>
                    <span class="accounts-row-label">${escapeHtml(label)}</span>
                    ${isCurrent ? '<span class="accounts-current">current</span>' : ''}
                </button>`;
            }).join('');
        }

        // Guest is already the guest session and has nothing to lock.
        document.getElementById('accounts-guest-btn')?.classList.toggle('hidden', isGuest);
        document.getElementById('accounts-lock-section')?.classList.toggle('hidden', isGuest);
    }

    async _confirmLock() {
        const ok = await confirmDialog({
            title: 'Lock & disconnect',
            message: 'This account is locked on this device until you unlock it again with its password.',
            confirmLabel: 'Lock'
        });
        if (!ok) return;
        this.hide();
        this.deps.lock?.();
    }
}

export const accountsUI = new AccountsUI();
