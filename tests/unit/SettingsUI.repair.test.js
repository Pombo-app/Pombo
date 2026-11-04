/**
 * The DM Inbox panel diagnoses on its own when it opens: the primary button
 * exists only to create a missing inbox, and a failed diagnosis offers to
 * check again.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../../src/js/logger.js', () => ({
    Logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }
}));

const gas = vi.hoisted(() => ({ balance: 10n ** 18n, price: 100n }));
vi.mock('../../src/js/ui/GasEstimator.js', async (importOriginal) => {
    const { GasEstimator } = await importOriginal();
    return {
        GasEstimator: {
            ...GasEstimator,
            getBalance: vi.fn(async () => Number(gas.balance)),
            getGasPrice: vi.fn(async () => Number(gas.price)),
            formatPOL: (w) => `${w} wei`,
            formatBalancePOL: (w) => `${w} wei`
        }
    };
});

const { SettingsUI, inboxFindings } = await import('../../src/js/ui/SettingsUI.js');

const healthy = () => ({
    messageStream: { exists: true, partitions: 13, partitionsCorrect: true, publicKeyPresent: true },
    ephemeralStream: { exists: true },
    permissions: { messagePublicPublish: true, ephemeralPublicPublish: true },
    storage: { enabled: true, provider: 'streamr', storageDays: 180 }
});

describe('inbox findings', () => {
    it('counts a false as an issue and a null as not checked', () => {
        const d = healthy();
        d.permissions.messagePublicPublish = false;
        d.storage.enabled = null;
        expect(inboxFindings(d)).toEqual({ issues: ['message permissions'], unchecked: ['storage'] });
    });

    it('does not ask what lives on a stream that is missing', () => {
        const d = healthy();
        d.messageStream = { exists: false, partitionsCorrect: false, publicKeyPresent: false };
        d.permissions.messagePublicPublish = false;
        d.storage.enabled = false;
        const { issues, unchecked } = inboxFindings(d);
        expect(issues).toEqual(['message stream', 'message permissions', 'storage']);
        expect(unchecked).toEqual([]);
    });
});

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

    describe('with a DM manager', () => {
        let dm;
        beforeEach(() => {
            dm = {
                hasInbox: vi.fn(async () => true),
                diagnoseInbox: vi.fn(async () => healthy()),
                repairInbox: vi.fn(async () => ({ steps: { messagePermissions: 'ok' } }))
            };
            ui.setDependencies({
                dmManager: dm,
                authManager: { getAddress: () => '0xme' },
                notificationUI: { showConfirmToast: vi.fn(async () => true) },
                showNotification: vi.fn()
            });
            ui._refreshInboxStorage = vi.fn(async () => {});
            gas.balance = 10n ** 18n;
        });

        it('says what it could not check instead of calling the inbox healthy', async () => {
            const d = healthy();
            d.storage.enabled = null;
            dm.diagnoseInbox.mockResolvedValue(d);
            await ui.runDiagnosis();
            expect(ui._repairStatus).toBe('error');
            expect(document.getElementById('repair-status-detail').textContent).toContain('Could not check: storage');
            expect(hidden('repair-fix-btn')).toBe(true);
        });

        it('does not repair what the balance cannot pay for', async () => {
            const d = healthy();
            d.storage.enabled = false;
            ui._repairDiagnosis = d;
            gas.balance = 1n;
            await ui.runRepair();
            expect(dm.repairInbox).not.toHaveBeenCalled();
        });

        it('reads the chain again after a repair', async () => {
            const d = healthy();
            d.permissions.messagePublicPublish = false;
            ui._repairDiagnosis = d;
            await ui.runRepair();
            expect(dm.repairInbox).toHaveBeenCalledTimes(1);
            expect(dm.diagnoseInbox).toHaveBeenCalledTimes(1);
            expect(ui._repairStatus).toBe('repaired');
        });
    });
});
