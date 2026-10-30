/**
 * The Blocked Users erase reports what each storage provider let go, and shows
 * only when somebody is blocked.
 */

import { describe, it, expect, vi } from 'vitest';

vi.mock('../../src/js/logger.js', () => ({
    Logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }
}));

const { SettingsUI, describeBlockedErase } = await import('../../src/js/ui/SettingsUI.js');

const outcome = (o) => ({ providers: 2, erasedOn: 2, forbiddenOn: 0, unreachable: 0, messages: 3, files: 0, skippedFiles: 0, ...o });

describe('describeBlockedErase', () => {
    it('says there was nothing to erase', () => {
        expect(describeBlockedErase(null)).toEqual({ text: 'Nothing from blocked users in your inbox storage', type: 'info' });
        expect(describeBlockedErase(outcome({ messages: 0 })).type).toBe('info');
    });

    it('reports a full erase as success', () => {
        expect(describeBlockedErase(outcome({ files: 1 }))).toEqual({ text: 'Erased 3 messages and 1 file on 2 of 2 storage providers', type: 'success' });
    });

    it('warns when a provider kept its copy or a file could not be checked', () => {
        expect(describeBlockedErase(outcome({ messages: 1, erasedOn: 1 }))).toEqual({ text: 'Erased 1 message on 1 of 2 storage providers', type: 'warning' });
        expect(describeBlockedErase(outcome({ skippedFiles: 2 }))).toEqual({ text: 'Erased 3 messages on 2 of 2 storage providers; 2 files could not be checked', type: 'warning' });
        expect(describeBlockedErase(outcome({ messages: 0, files: 2 }))).toEqual({ text: 'Erased 2 files on 2 of 2 storage providers', type: 'success' });
    });

    it('warns when no provider of the inbox can erase', () => {
        expect(describeBlockedErase(outcome({ providers: 0, erasedOn: 0 }))).toEqual({ text: 'No storage provider of your inbox can erase 3 messages', type: 'warning' });
    });
});

describe('Blocked Users panel', () => {
    it('offers the erase only while somebody is blocked', () => {
        document.body.innerHTML = '<div id="blocked-peers-list"></div><div id="erase-blocked-section" class="hidden"></div>';
        const blocked = [];
        const ui = new SettingsUI();
        ui.deps = { secureStorage: { getBlockedPeers: () => blocked } };
        const shown = () => !document.getElementById('erase-blocked-section').classList.contains('hidden');

        ui.renderBlockedPeersList();
        expect(shown()).toBe(false);
        blocked.push('0xb10cked1111111111111111111111111111111');
        ui.renderBlockedPeersList();
        expect(shown()).toBe(true);
    });
});
