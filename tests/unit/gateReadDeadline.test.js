/**
 * Read deadline — an endpoint that accepts the call and never answers must
 * not hold a screen forever. The stalled attempt ends on its own, the next
 * endpoint is tried, and only then does the read fail.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { ethers } from 'ethers';

globalThis.ethers = ethers;

const { gateManager } = await import('../../src/js/gate.js');

const GATE = '0xf7ad70759e314f89fa150c60968df74a2550fac8';
const DEADLINE_MS = 20_000;

describe('gate read deadline', () => {
    let providers;

    beforeEach(() => {
        vi.useFakeTimers();
        providers = [];
        gateManager._rpcIndex = 0;
        gateManager._getProvider = () => {
            const provider = { id: providers.length };
            providers.push(provider);
            return provider;
        };
    });

    afterEach(() => {
        vi.useRealTimers();
        delete gateManager._getProvider;
    });

    it('gives up on a stalled endpoint and tries the next one', async () => {
        let attempts = 0;
        const read = gateManager._withProvider(() => {
            attempts += 1;
            return attempts === 1 ? new Promise(() => {}) : Promise.resolve('answer');
        });
        await vi.advanceTimersByTimeAsync(DEADLINE_MS + 1);
        await expect(read).resolves.toBe('answer');
        expect(attempts).toBe(2);
    });

    it('fails once both endpoints stall, instead of hanging', async () => {
        const read = gateManager._withProvider(() => new Promise(() => {}));
        const settled = read.catch((error) => error.message);
        await vi.advanceTimersByTimeAsync(2 * DEADLINE_MS + 2);
        await expect(settled).resolves.toMatch(/timed out/i);
    });

    it('lets a revert through without spending the deadline on it', async () => {
        const revert = Object.assign(new Error('execution reverted'), { code: 'CALL_EXCEPTION' });
        let attempts = 0;
        const read = gateManager._withProvider(() => {
            attempts += 1;
            return Promise.reject(revert);
        });
        await expect(read).rejects.toBe(revert);
        expect(attempts).toBe(1);
    });
});
