/**
 * The pending channel creation record outlives a restart (it exists for
 * exactly that) and never leaves the device. The restart is real: the
 * encrypted cache is written, dropped and read back.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { secureStorage } from '../../src/js/secureStorage.js';

const ME = '0x' + 'aa'.repeat(20);
const record = (basePath, extra = {}) => ({
    basePath, owner: ME, name: 'Test', type: 'gated', password: null,
    publishKey: { keyId: 'p1.aaaaaa', keyHex: '0x' + '11'.repeat(32), address: '0x' + '22'.repeat(20), rev: 1 },
    startedAt: 1, ...extra
});

async function unlockRealStorage() {
    secureStorage.isGuestMode = false;
    secureStorage.stateDB = null;
    secureStorage.address = ME;
    secureStorage.storageKey = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
    secureStorage.cache = secureStorage.createEmptyCache();
    secureStorage.isUnlocked = true;
}

async function restart() {
    secureStorage.cache = null;
    await secureStorage.loadFromStorage();
}

describe('secureStorage pending channel creations', () => {
    let saved;

    beforeEach(async () => {
        saved = {
            cache: secureStorage.cache, isUnlocked: secureStorage.isUnlocked, isGuestMode: secureStorage.isGuestMode,
            address: secureStorage.address, storageKey: secureStorage.storageKey, stateDB: secureStorage.stateDB
        };
        localStorage.clear();
        await unlockRealStorage();
    });

    afterEach(() => {
        Object.assign(secureStorage, saved);
        localStorage.clear();
    });

    it('survives a restart, replaced by basePath and removed by it', async () => {
        await secureStorage.putPendingCreate(record(`${ME}/a`));
        await secureStorage.putPendingCreate(record(`${ME}/b`));
        await secureStorage.putPendingCreate(record(`${ME}/a`, { gateAddress: '0xgate' }));
        await restart();

        expect(secureStorage.getPendingCreates().map(r => [r.basePath, r.gateAddress ?? null]))
            .toEqual([[`${ME}/b`, null], [`${ME}/a`, '0xgate']]);

        await secureStorage.removePendingCreate(`${ME}/b`);
        await restart();
        expect(secureStorage.getPendingCreates().map(r => r.basePath)).toEqual([`${ME}/a`]);
    });

    it('never leaves the device: neither the sync nor the backup carries it', async () => {
        await secureStorage.putPendingCreate(record(`${ME}/a`));

        for (const exported of [secureStorage.exportForSync(), secureStorage.exportForBackup()]) {
            const text = JSON.stringify(exported);
            expect(text).not.toContain('pendingCreates');
            expect(text).not.toContain('11'.repeat(32));
        }
    });

    it('a guest keeps it in memory only', async () => {
        secureStorage.initAsGuest('0x' + 'cc'.repeat(20));
        await secureStorage.putPendingCreate(record('0xcc/a'));

        expect(secureStorage.getPendingCreates()).toHaveLength(1);
        expect(localStorage.length).toBe(0);
    });
});
