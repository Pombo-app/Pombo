/**
 * SettingsUI — Security cards in a guest session
 * A guest holds no stored key: Export and Delete stay visible but cannot be
 * used, and a real account gets them back.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../../src/js/ui/AvatarGenerator.js', () => ({
    getAvatarHtml: vi.fn(() => '<div></div>')
}));

vi.mock('../../src/js/ui/GasEstimator.js', () => ({
    GasEstimator: class {}
}));

vi.mock('../../src/js/backupImport.js', () => ({
    importBackupData: vi.fn()
}));

vi.mock('../../src/js/ui/pillDropdown.js', () => ({
    positionPillDropdown: vi.fn()
}));

const { settingsUI } = await import('../../src/js/ui/SettingsUI.js');

function renderPanel() {
    document.body.innerHTML = `
        <div id="export-key-step1">
            <input id="export-key-password" type="password" />
            <button id="unlock-private-key-btn">Unlock Key</button>
        </div>
        <div id="export-key-step2" class="hidden"></div>
        <div id="delete-account-step1">
            <input id="delete-account-password" type="password" />
            <button id="verify-delete-account-btn">Verify Password</button>
        </div>
        <div id="delete-account-step2" class="hidden"></div>
    `;
}

const controls = () => ['export-key-password', 'unlock-private-key-btn', 'delete-account-password', 'verify-delete-account-btn']
    .map(id => document.getElementById(id));
const steps = () => ['export-key-step1', 'delete-account-step1'].map(id => document.getElementById(id));

function openAs(guest) {
    settingsUI.setDependencies({ authManager: { isGuestMode: () => guest } });
    settingsUI.resetExportKeyUI();
    settingsUI.resetDeleteAccountUI();
}

describe('SettingsUI Security cards', () => {
    beforeEach(renderPanel);

    it('a guest can use neither Export nor Delete', () => {
        openAs(true);

        controls().forEach(el => expect(el.disabled, el.id).toBe(true));
        steps().forEach(el => expect(el.classList.contains('opacity-40'), el.id).toBe(true));
    });

    it('a real account can, including right after a guest session', () => {
        openAs(true);
        openAs(false);

        controls().forEach(el => expect(el.disabled, el.id).toBe(false));
        steps().forEach(el => expect(el.classList.contains('opacity-40'), el.id).toBe(false));
    });
});
