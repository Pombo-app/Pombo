import { beforeEach, describe, expect, it } from 'vitest';
import { accountsUI } from '../../src/js/ui/AccountsUI.js';

const ROWS = ['accounts-add-btn', 'accounts-guest-btn'];

describe('AccountsUI', () => {
    beforeEach(() => {
        document.body.innerHTML = `
            <div id="accounts-avatar"></div><div id="accounts-name"></div>
            <div id="accounts-username" class="hidden"></div><div id="accounts-address"></div>
            <div id="accounts-list-section"><div id="accounts-list"></div></div>
            ${ROWS.map(id => `<button id="${id}"></button>`).join('')}
            <div id="accounts-lock-section"></div>`;
    });

    const render = (isGuest) => {
        accountsUI.deps = {
            authManager: { getAddress: () => '0x1234567890abcdef1234567890abcdef12345678', isGuestMode: () => isGuest, listSavedWallets: () => [] },
            identityManager: { getUsername: () => null }
        };
        accountsUI.render();
        return ROWS.filter(id => !document.getElementById(id).classList.contains('hidden'));
    };

    it('names a guest Guest and only offers Add account, with nothing to lock', () => {
        expect(render(true)).toEqual(['accounts-add-btn']);
        expect(document.getElementById('accounts-name').textContent).toBe('Guest');
        expect(document.getElementById('accounts-name').classList.contains('accounts-name-guest')).toBe(true);
        expect(document.getElementById('accounts-lock-section').classList.contains('hidden')).toBe(true);
    });

    it('keeps Add account and Browse as guest for an account', () => {
        expect(render(false)).toEqual(['accounts-add-btn', 'accounts-guest-btn']);
        expect(document.getElementById('accounts-name').textContent).toBe('0x1234…5678');
        expect(document.getElementById('accounts-name').classList.contains('accounts-name-guest')).toBe(false);
    });
});
