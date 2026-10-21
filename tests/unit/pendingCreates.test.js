import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../src/js/logger.js', () => ({
    Logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }
}));

import {
    PendingCreates, PENDING_STATE, PENDING_CREATE_MAX_AGE_MS,
    packCreateOptions, unpackCreateOptions
} from '../../src/js/channels/PendingCreates.js';

const NOW = 10_000_000;

function setup({ streamExists = async () => false, findGate = async () => null } = {}) {
    let records = [];
    const host = {
        records: () => records,
        put: vi.fn(async (record) => {
            records = [...records.filter(r => r.basePath !== record.basePath), record];
        }),
        remove: vi.fn(async (basePath) => {
            records = records.filter(r => r.basePath !== basePath);
        }),
        streamExists: vi.fn(streamExists),
        findGate: vi.fn(findGate),
        now: () => NOW
    };
    return { pending: new PendingCreates(host), host, stored: () => records };
}

const record = (overrides = {}) => ({
    basePath: '0xowner/abcd', owner: '0xowner', name: 'Test', type: 'public',
    startedAt: NOW - 1000, gateAddress: null, startBlock: 100, ...overrides
});

describe('PendingCreates', () => {
    describe('reconcile', () => {
        it('a -1 on chain makes a creation resumable', async () => {
            const { pending } = setup({ streamExists: async (id) => id === '0xowner/abcd-1' });
            await pending.update(record());

            expect(await pending.reconcile(record())).toBe(PENDING_STATE.RESUMABLE);
            expect(pending.resumable().map(r => r.basePath)).toEqual(['0xowner/abcd']);
        });

        it('nothing on chain within the hour is kept and stays out of Finish', async () => {
            const { pending, stored } = setup();
            await pending.update(record());

            expect(await pending.reconcile(record())).toBe(PENDING_STATE.WAITING);
            expect(stored()).toHaveLength(1);
            expect(pending.resumable()).toEqual([]);
        });

        it('nothing on chain after the hour drops the record', async () => {
            const { pending, stored } = setup();
            const old = record({ startedAt: NOW - PENDING_CREATE_MAX_AGE_MS });
            await pending.update(old);

            expect(await pending.reconcile(old)).toBe(PENDING_STATE.DISCARDED);
            expect(stored()).toEqual([]);
        });

        it('an unreadable chain keeps even an old record', async () => {
            const { pending, stored } = setup({ streamExists: async () => { throw new Error('RPC down'); } });
            const old = record({ startedAt: NOW - 2 * PENDING_CREATE_MAX_AGE_MS });
            await pending.update(old);

            expect(await pending.reconcile(old)).toBe(PENDING_STATE.UNREADABLE);
            expect(stored()).toHaveLength(1);
        });

        it('a gated creation whose gate is recorded is resumable without reading the chain', async () => {
            const { pending, host } = setup();
            const gated = record({ type: 'gated', gateAddress: '0xgate' });
            await pending.update(gated);

            expect(await pending.reconcile(gated)).toBe(PENDING_STATE.RESUMABLE);
            expect(host.findGate).not.toHaveBeenCalled();
            expect(host.streamExists).not.toHaveBeenCalled();
        });

        it('a gate the record never saw is found on chain and written into it', async () => {
            const { pending, stored } = setup({ findGate: async () => '0xfound' });
            const gated = record({ type: 'gated' });
            await pending.update(gated);

            expect(await pending.reconcile(gated)).toBe(PENDING_STATE.RESUMABLE);
            expect(stored()[0].gateAddress).toBe('0xfound');
        });

        it('a gated creation with no gate after the hour is dropped', async () => {
            const { pending, stored } = setup();
            const gated = record({ type: 'gated', startedAt: NOW - PENDING_CREATE_MAX_AGE_MS - 1 });
            await pending.update(gated);

            expect(await pending.reconcile(gated)).toBe(PENDING_STATE.DISCARDED);
            expect(stored()).toEqual([]);
        });

        it('leaves alone a creation this session is running', async () => {
            const { pending, host, stored } = setup();
            const old = record({ startedAt: 0 });
            await pending.begin(old);

            expect(await pending.reconcile(old)).toBe(PENDING_STATE.RUNNING);
            expect(host.streamExists).not.toHaveBeenCalled();
            expect(stored()).toHaveLength(1);
        });

        it('does not write back a gate for a record finished meanwhile', async () => {
            let finishMeanwhile;
            const { pending, stored } = setup({ findGate: async () => { await finishMeanwhile(); return '0xfound'; } });
            const gated = record({ type: 'gated' });
            await pending.update(gated);
            finishMeanwhile = () => pending.complete(gated.basePath);

            await pending.reconcile(gated);
            expect(stored()).toEqual([]);
        });
    });

    describe('running guard', () => {
        it('claims a creation once', async () => {
            const { pending } = setup();
            expect(pending.claim('0xowner/abcd')).toBe(true);
            expect(pending.claim('0xowner/abcd')).toBe(false);
            pending.release('0xowner/abcd');
            expect(pending.claim('0xowner/abcd')).toBe(true);
        });

        it('refuses to discard a creation still running', async () => {
            const { pending, stored } = setup();
            await pending.begin(record());

            await expect(pending.discard('0xowner/abcd')).rejects.toThrow('still being created');
            expect(stored()).toHaveLength(1);
        });

        it('complete drops the record and frees the claim', async () => {
            const { pending, stored } = setup();
            await pending.begin(record());
            await pending.complete('0xowner/abcd');

            expect(stored()).toEqual([]);
            expect(pending.claim('0xowner/abcd')).toBe(true);
        });
    });

    describe('options', () => {
        it('stores uint256 gate values as text and drops callbacks', () => {
            const packed = packCreateOptions({
                gateMode: 3, gatePrice: 10n ** 18n, gateDuration: 86400n * 30n,
                onProgress: () => {}, storageDays: 30, customStorageAddress: undefined
            });

            expect(JSON.parse(JSON.stringify(packed))).toEqual({
                gateMode: 3, gatePrice: '1000000000000000000', gateDuration: '2592000', storageDays: 30
            });
            expect(unpackCreateOptions(packed)).toEqual({
                gateMode: 3, gatePrice: 10n ** 18n, gateDuration: 2592000n, storageDays: 30
            });
        });
    });
});
