/**
 * Access-cache TTL — a grant is kept for the full window, a refusal is not.
 * The member holding a cached "no" is the one who just paid, was unbanned or
 * was made a moderator, and nothing outside their own client can drop it.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { ethers } from 'ethers';

globalThis.ethers = ethers;

const { gateManager } = await import('../../src/js/gate.js');
const { CONFIG } = await import('../../src/js/config.js');

const GATE = '0xf7ad70759e314f89fa150c60968df74a2550fac8';
const USER = '0x1111111111111111111111111111111111111111';

describe('access cache TTL', () => {
    let calls;
    let answer;

    beforeEach(() => {
        vi.useFakeTimers();
        vi.setSystemTime(1_755_000_000_000);
        calls = 0;
        answer = false;
        gateManager._accessCache.clear();
        gateManager._withProvider = (op) => op(null);
        gateManager._readContract = () => ({
            checkAccess: async () => { calls += 1; return answer; }
        });
    });

    afterEach(() => {
        vi.useRealTimers();
        delete gateManager._readContract;
        delete gateManager._withProvider;
    });

    it('keeps a grant for the whole window', async () => {
        answer = true;
        expect(await gateManager.checkAccess(GATE, USER)).toBe(true);
        vi.advanceTimersByTime(CONFIG.gate.checkAccessCacheMs - 1000);
        expect(await gateManager.checkAccess(GATE, USER)).toBe(true);
        expect(calls).toBe(1);
    });

    it('asks again seconds after a refusal, so a payment is seen', async () => {
        expect(await gateManager.checkAccess(GATE, USER)).toBe(false);
        vi.advanceTimersByTime(CONFIG.gate.accessDenialCacheMs + 1000);
        answer = true;
        expect(await gateManager.checkAccess(GATE, USER)).toBe(true);
        expect(calls).toBe(2);
    });

    it('still spares the chain between two refusals in the same breath', async () => {
        await gateManager.checkAccess(GATE, USER);
        vi.advanceTimersByTime(1000);
        await gateManager.checkAccess(GATE, USER);
        expect(calls).toBe(1);
    });
});
