/**
 * The gate parameters PomboGate fixes in initialize, and a token's symbol and
 * decimals, are read from the chain once per device; price and duration stay
 * on their TTL because the owner can change them.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { ethers } from 'ethers';

globalThis.ethers = ethers;

const { gateManager } = await import('../../src/js/gate.js');
const { CONFIG } = await import('../../src/js/config.js');

const GATE = '0xf7ad70759e314f89fa150c60968df74a2550fac8';
const TOKEN = '0x0d500b1d8e8ef31e21c99d1db9a6444d3adf1270';
const ALL_EIGHT = ['duration', 'minBalance', 'mode', 'owner', 'price', 'readOnly', 'token', 'wireIdentity'];

function gateStub(calls, failing = {}) {
    const read = (name, value) => async () => {
        calls.push(name);
        if (failing[name]) throw failing[name];
        return value;
    };
    return {
        owner: read('owner', '0xABCDEF0000000000000000000000000000000001'),
        mode: read('mode', 3n),
        token: read('token', TOKEN),
        minBalance: read('minBalance', 0n),
        price: read('price', 10n ** 16n),
        duration: read('duration', 86_400n),
        wireIdentity: read('wireIdentity', 1n),
        readOnly: read('readOnly', false)
    };
}

describe('gate info read from the chain', () => {
    let calls;

    beforeEach(() => {
        calls = [];
        localStorage.removeItem(CONFIG.storageKeys.chainFacts);
        gateManager._infoCache.clear();
        gateManager._withProvider = (op) => op(null);
        gateManager._readContract = () => gateStub(calls);
    });

    afterEach(() => {
        delete gateManager._withProvider;
        delete gateManager._readContract;
        localStorage.removeItem(CONFIG.storageKeys.chainFacts);
    });

    it('reads all eight fields once, then only price and duration in a later session', async () => {
        const first = await gateManager.getGateInfo(GATE);
        expect([...calls].sort()).toEqual(ALL_EIGHT);

        gateManager._infoCache.clear();
        calls.length = 0;
        const again = await gateManager.getGateInfo(GATE);

        expect([...calls].sort()).toEqual(['duration', 'price']);
        expect(again).toEqual(first);
        expect(again.minBalance).toBe(0n);
        expect(again.modeName).toBe(first.modeName);
    });

    it('remembers nothing about a gate without the v3 getters', async () => {
        gateManager._readContract = () => gateStub(calls, {
            owner: Object.assign(new Error('execution reverted'), { code: 'CALL_EXCEPTION' })
        });
        await expect(gateManager.getGateInfo(GATE)).rejects.toThrow('not v3');
        expect(JSON.parse(localStorage.getItem(CONFIG.storageKeys.chainFacts) || '{}').gates).toBeUndefined();
    });
});

describe('token metadata', () => {
    let reads;
    let decimals;

    beforeEach(() => {
        reads = 0;
        decimals = async () => 18n;
        localStorage.removeItem(CONFIG.storageKeys.chainFacts);
        gateManager._tokenMetaCache.clear();
        gateManager._tokenMetaPending.clear();
        gateManager._withProvider = (op) => op(null);
        gateManager._readToken = () => ({
            symbol: async () => { reads++; return 'WPOL'; },
            decimals: () => decimals()
        });
    });

    afterEach(() => {
        delete gateManager._withProvider;
        delete gateManager._readToken;
        localStorage.removeItem(CONFIG.storageKeys.chainFacts);
    });

    it('shares one read between concurrent callers and keeps the answer for later sessions', async () => {
        const [a, b] = await Promise.all([gateManager.getTokenMeta(TOKEN), gateManager.getTokenMeta(TOKEN)]);
        expect(a).toEqual({ symbol: 'WPOL', decimals: 18 });
        expect(b).toEqual(a);
        expect(reads).toBe(1);

        gateManager._tokenMetaCache.clear();
        expect(await gateManager.getTokenMeta(TOKEN)).toEqual(a);
        expect(reads).toBe(1);
    });

    it('does not keep an answer where a getter failed', async () => {
        decimals = async () => { throw new Error('rpc down'); };
        expect((await gateManager.getTokenMeta(TOKEN)).decimals).toBeNull();

        gateManager._tokenMetaCache.clear();
        decimals = async () => 18n;
        expect((await gateManager.getTokenMeta(TOKEN)).decimals).toBe(18);
        expect(reads).toBe(2);
    });
});
