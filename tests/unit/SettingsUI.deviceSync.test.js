/**
 * SettingsUI — Device Sync panel
 * Covers: mode reflected in the radios, persistence on change, and the panel
 * going inert when sync cannot run (guest, or no DM inbox).
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

const { settingsUI } = await import('../../src/js/ui/SettingsUI.js');

const MODES = ['automatic', 'not_on_start', 'manual_only'];

function renderPanel() {
    document.body.innerHTML = `
        <div id="settings-panel-devicesync" class="settings-panel hidden">
            <div id="sync-mode-no-inbox" class="hidden">
                <p id="sync-mode-no-inbox-text"></p>
            </div>
            <div id="sync-mode-options">
                ${MODES.map(m => `<label><input type="radio" name="sync-mode-radio" value="${m}" /></label>`).join('')}
            </div>
        </div>
    `;
}

function radios() {
    return Array.from(document.querySelectorAll('input[name="sync-mode-radio"]'));
}

describe('SettingsUI Device Sync panel', () => {
    let storedMode;
    let setSyncMode;

    beforeEach(() => {
        renderPanel();
        storedMode = 'automatic';
        setSyncMode = vi.fn((mode) => {
            if (!MODES.includes(mode)) return false;
            storedMode = mode;
            return true;
        });

        settingsUI.setDependencies({
            authManager: { isGuestMode: () => false },
            dmManager: { inboxReady: true },
            syncManager: {
                getSyncMode: () => storedMode,
                setSyncMode
            },
            showNotification: vi.fn()
        });
    });

    it('checks the radio for the stored mode', () => {
        storedMode = 'not_on_start';

        settingsUI.updateSyncModeDisplay();

        expect(radios().filter(r => r.checked).map(r => r.value)).toEqual(['not_on_start']);
        expect(radios().every(r => !r.disabled)).toBe(true);
        expect(document.getElementById('sync-mode-no-inbox').classList.contains('hidden')).toBe(true);
    });

    it('persists a picked mode', () => {
        settingsUI.updateSyncModeDisplay();

        const manual = radios().find(r => r.value === 'manual_only');
        manual.checked = true;
        settingsUI.handleSyncModeChange({ target: manual });

        expect(setSyncMode).toHaveBeenCalledWith('manual_only');
        expect(radios().filter(r => r.checked).map(r => r.value)).toEqual(['manual_only']);
    });

    it('warns and reverts when the mode could not be saved', () => {
        settingsUI.setDependencies({
            syncManager: { getSyncMode: () => 'automatic', setSyncMode: () => false }
        });

        const manual = radios().find(r => r.value === 'manual_only');
        manual.checked = true;
        settingsUI.handleSyncModeChange({ target: manual });

        expect(settingsUI.deps.showNotification).toHaveBeenCalledWith('Could not save sync preference', 'error');
        expect(radios().filter(r => r.checked).map(r => r.value)).toEqual(['automatic']);
    });

    it('goes inert without a DM inbox — sync has nowhere to travel', () => {
        settingsUI.setDependencies({ dmManager: { inboxReady: false } });

        settingsUI.updateSyncModeDisplay();

        expect(radios().every(r => r.disabled)).toBe(true);
        expect(document.getElementById('sync-mode-no-inbox').classList.contains('hidden')).toBe(false);
        expect(document.getElementById('sync-mode-no-inbox-text').textContent).toContain('DM inbox');
    });

    it('goes inert in guest mode, and says why', () => {
        settingsUI.setDependencies({ authManager: { isGuestMode: () => true } });

        settingsUI.updateSyncModeDisplay();

        expect(radios().every(r => r.disabled)).toBe(true);
        expect(document.getElementById('sync-mode-no-inbox-text').textContent).toContain('You need an account with DM inbox');
    });
});
