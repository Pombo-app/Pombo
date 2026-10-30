/**
 * The DM Inbox panel diagnoses on its own when it opens: the primary button
 * exists only to create a missing inbox, and a failed diagnosis offers to
 * check again.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../../src/js/logger.js', () => ({
    Logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }
}));

const { SettingsUI } = await import('../../src/js/ui/SettingsUI.js');

describe('DM Inbox panel', () => {
    let ui;

    beforeEach(() => {
        document.body.innerHTML = `
            <div id="repair-status-card">
                <span id="repair-status-icon"></span>
                <p id="repair-status-title"></p><p id="repair-status-detail"></p>
                <button id="repair-check-again-btn" class="hidden">Check again</button>
            </div>
            <button id="repair-diagnose-btn" class="hidden"><svg></svg><span></span></button>
            <button id="repair-fix-btn" class="hidden"><span>Repair</span></button>`;
        ui = new SettingsUI();
    });

    const hidden = (id) => document.getElementById(id).classList.contains('hidden');

    it('shows the primary button only to create a missing inbox', () => {
        ui._setRepairPrimaryAction('create');
        expect(hidden('repair-diagnose-btn')).toBe(false);
        expect(document.querySelector('#repair-diagnose-btn span').textContent).toBe('Create DM Inbox');

        ui._setRepairPrimaryAction('diagnose');
        expect(hidden('repair-diagnose-btn')).toBe(true);
    });

    it('offers Check again only after a failed diagnosis, and it runs the diagnosis', async () => {
        ui._setRepairStatus('error', 'Network down');
        expect(hidden('repair-check-again-btn')).toBe(false);

        ui._setRepairStatus('healthy');
        expect(hidden('repair-check-again-btn')).toBe(true);

        ui.runDiagnosis = vi.fn(async () => {});
        ui.initRepairUI();
        document.getElementById('repair-check-again-btn').click();
        expect(ui.runDiagnosis).toHaveBeenCalled();
    });
});
