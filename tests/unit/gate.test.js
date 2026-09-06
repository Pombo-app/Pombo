/**
 * gateManager — checkAccess caching and fail-closed behaviour.
 *
 * The eth_call itself is the chain's business (pinned by the Foundry suite in
 * Pombo Contracts); what the client owns is the cache discipline — one call
 * per (gate, user) per TTL, invalidation after moderation txs, and NO ACCESS
 * on RPC failure (an outage must never hand an epoch key to an ex-member).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { ethers } from 'ethers';

globalThis.ethers = ethers;

const { gateManager, GATE_MODE } = await import('../../src/js/gate.js');
const { CONFIG } = await import('../../src/js/config.js');

const GATE = '0xf7ad70759e314f89fa150c60968df74a2550fac8';
const ALICE = '0x1111111111111111111111111111111111111111';
const BOB = '0x2222222222222222222222222222222222222222';

describe('gateManager.checkAccess', () => {
    let calls;

    beforeEach(() => {
        vi.useFakeTimers();
        vi.setSystemTime(1_755_000_000_000);
        calls = [];
        gateManager._accessCache.clear();
        // No real JsonRpcProvider under vitest — the op gets a null provider
        // and the contract stub below answers.
        gateManager._withProvider = (op) => op(null);
        gateManager._readContract = (gateAddress) => ({
            checkAccess: async (user) => {
                calls.push([gateAddress, user]);
                return user.toLowerCase() === ALICE;
            }
        });
    });

    afterEach(() => {
        vi.useRealTimers();
        delete gateManager._readContract; // restore prototype methods
        delete gateManager._withProvider;
    });

    it('returns the chain answer and caches it for the TTL', async () => {
        expect(await gateManager.checkAccess(GATE, ALICE)).toBe(true);
        expect(await gateManager.checkAccess(GATE, ALICE)).toBe(true);
        expect(calls.length).toBe(1);

        vi.advanceTimersByTime(CONFIG.gate.checkAccessCacheMs + 1);
        expect(await gateManager.checkAccess(GATE, ALICE)).toBe(true);
        expect(calls.length).toBe(2);
    });

    it('caches negative answers too (no hammering the RPC for strangers)', async () => {
        expect(await gateManager.checkAccess(GATE, BOB)).toBe(false);
        expect(await gateManager.checkAccess(GATE, BOB)).toBe(false);
        expect(calls.length).toBe(1);
    });

    it('invalidateAccess(gate, user) drops exactly that entry', async () => {
        await gateManager.checkAccess(GATE, ALICE);
        await gateManager.checkAccess(GATE, BOB);
        gateManager.invalidateAccess(GATE, ALICE);
        await gateManager.checkAccess(GATE, ALICE);
        await gateManager.checkAccess(GATE, BOB);
        expect(calls.length).toBe(3); // Alice refetched, Bob still cached
    });

    it('fails CLOSED when the RPC errors, and does not cache the failure', async () => {
        gateManager._readContract = () => ({
            checkAccess: async () => { throw new Error('rpc down'); }
        });
        expect(await gateManager.checkAccess(GATE, ALICE)).toBe(false);

        // RPC recovers → next call answers truthfully (failure was not cached)
        gateManager._readContract = () => ({
            checkAccess: async () => true
        });
        expect(await gateManager.checkAccess(GATE, ALICE)).toBe(true);
    });

    it('checkAccessOrNull surfaces an RPC failure as null (content filtering fails OPEN)', async () => {
        gateManager._readContract = () => ({
            checkAccess: async () => { throw new Error('rpc down'); }
        });
        expect(await gateManager.checkAccessOrNull(GATE, ALICE)).toBe(null);

        gateManager._readContract = () => ({
            checkAccess: async () => false
        });
        expect(await gateManager.checkAccessOrNull(GATE, ALICE)).toBe(false);
    });
});

describe('gateManager.paidUntilCached', () => {
    let calls;
    const UNTIL = 1_756_000_000; // unix seconds

    beforeEach(() => {
        vi.useFakeTimers();
        vi.setSystemTime(1_755_000_000_000);
        calls = 0;
        gateManager._accessCache.clear();
        gateManager._paidCache.clear();
        gateManager._withProvider = (op) => op(null);
        gateManager._readContract = () => ({
            paidUntil: async () => { calls += 1; return BigInt(UNTIL); }
        });
    });

    afterEach(() => {
        vi.useRealTimers();
        delete gateManager._readContract;
        delete gateManager._withProvider;
    });

    it('reads once per TTL window and returns unix seconds as a number', async () => {
        expect(await gateManager.paidUntilCached(GATE, ALICE)).toBe(UNTIL);
        expect(await gateManager.paidUntilCached(GATE, ALICE)).toBe(UNTIL);
        expect(calls).toBe(1);

        vi.advanceTimersByTime(CONFIG.gate.checkAccessCacheMs + 1);
        await gateManager.paidUntilCached(GATE, ALICE);
        expect(calls).toBe(2);
    });

    it('is cleared by invalidateAccess so a renewal shows immediately', async () => {
        await gateManager.paidUntilCached(GATE, ALICE);
        gateManager.invalidateAccess(GATE, ALICE);
        await gateManager.paidUntilCached(GATE, ALICE);
        expect(calls).toBe(2);
    });

    it('returns null on RPC failure without caching it (no "expired" flash)', async () => {
        gateManager._readContract = () => ({
            paidUntil: async () => { throw new Error('rpc down'); }
        });
        expect(await gateManager.paidUntilCached(GATE, ALICE)).toBe(null);

        gateManager._readContract = () => ({
            paidUntil: async () => BigInt(UNTIL)
        });
        expect(await gateManager.paidUntilCached(GATE, ALICE)).toBe(UNTIL);
    });
});

describe('gateManager.getGateMembers (v3 states batch)', () => {
    const OWNER = '0x3333333333333333333333333333333333333333';
    let statesCalls;
    let flagReads;

    const cacheInfo = (mode = GATE_MODE.PAID) => {
        gateManager._infoCache.set(GATE.toLowerCase(), {
            at: Date.now(),
            info: {
                owner: OWNER, mode, modeName: mode === GATE_MODE.NONE ? 'none' : 'paid',
                token: null, minBalance: 0n, price: 0n, duration: 0n,
                wireIdentity: 0, wireIdentityName: 'visible', readOnly: false
            }
        });
    };

    const stubGate = ({ statesReverts = false } = {}) => ({
        states: async (users) => {
            statesCalls.push(users);
            if (statesReverts) throw new Error('execution reverted: token broken');
            return users.map((address) => ({
                access: address !== BOB,
                banned: address === BOB,
                moderator: false,
                allowed: address !== BOB,
                paidUntil: 1_756_000_000n
            }));
        },
        allowlist: async (addr) => { flagReads.push(['allowlist', addr]); return false; },
        banned: async (addr) => { flagReads.push(['banned', addr]); return addr === BOB; },
        moderators: async (addr) => { flagReads.push(['moderators', addr]); return false; },
        paidUntil: async (addr) => { flagReads.push(['paidUntil', addr]); return 1_756_000_000n; }
    });

    beforeEach(() => {
        statesCalls = [];
        flagReads = [];
        gateManager._infoCache.clear();
        gateManager._withProvider = (op) => op(null);
        gateManager._readContract = () => stubGate();
    });

    afterEach(() => {
        delete gateManager._readContract;
        delete gateManager._withProvider;
        gateManager._infoCache.clear();
    });

    it('covers the whole candidate set in ONE states() call', async () => {
        cacheInfo();
        const members = await gateManager.getGateMembers(GATE, [ALICE, BOB]);
        expect(statesCalls.length).toBe(1);
        expect(statesCalls[0]).toEqual([OWNER, ALICE, BOB]);
        const alice = members.find((m) => m.address === ALICE);
        expect(alice.access).toBe(true);
        expect(alice.paidUntil).toBe(1_756_000_000);
        const bob = members.find((m) => m.address === BOB);
        expect(bob.banned).toBe(true);
        expect(bob.access).toBe(false);
    });

    it('falls back to flag reads with NO access when states() reverts (broken gate token)', async () => {
        cacheInfo(GATE_MODE.PAID);
        gateManager._readContract = () => stubGate({ statesReverts: true });
        const members = await gateManager.getGateMembers(GATE, [ALICE]);
        // fail-closed: nobody but the owner is reported as having access
        const alice = members.find((m) => m.address === ALICE);
        expect(alice.access).toBe(false);
        const owner = members.find((m) => m.address === OWNER);
        expect(owner.access).toBe(true);
        // but the moderation-relevant flags still come through
        expect(flagReads.some(([what]) => what === 'banned')).toBe(true);
    });
});

describe('gateManager.getGateInfo TTL (v3: price/duration are mutable)', () => {
    let reads;

    beforeEach(() => {
        vi.useFakeTimers();
        vi.setSystemTime(1_755_000_000_000);
        reads = 0;
        gateManager._infoCache.clear();
        gateManager._withProvider = (op) => op(null);
        gateManager._readContract = () => ({
            owner: async () => '0x3333333333333333333333333333333333333333',
            mode: async () => GATE_MODE.PAID,
            token: async () => '0x4444444444444444444444444444444444444444',
            minBalance: async () => 0n,
            price: async () => { reads += 1; return 5_000_000n; },
            duration: async () => 86_400n,
            wireIdentity: async () => 1,
            readOnly: async () => true
        });
    });

    afterEach(() => {
        vi.useRealTimers();
        delete gateManager._readContract;
        delete gateManager._withProvider;
        gateManager._infoCache.clear();
    });

    it('caches within the TTL, re-reads after it, and exposes the v3 fields', async () => {
        const info = await gateManager.getGateInfo(GATE);
        expect(info.wireIdentityName).toBe('sealed');
        expect(info.readOnly).toBe(true);
        await gateManager.getGateInfo(GATE);
        expect(reads).toBe(1);
        vi.advanceTimersByTime(CONFIG.gate.checkAccessCacheMs + 1);
        await gateManager.getGateInfo(GATE);
        expect(reads).toBe(2);
    });

    it('invalidateInfo drops the entry immediately (after setPrice/setDuration)', async () => {
        await gateManager.getGateInfo(GATE);
        gateManager.invalidateInfo(GATE);
        await gateManager.getGateInfo(GATE);
        expect(reads).toBe(2);
    });
});

describe('formatRemaining', () => {
    it('renders days, hours, and the sub-hour floor', async () => {
        const { formatRemaining } = await import('../../src/js/ui/SubscriptionBannerUI.js');
        expect(formatRemaining(12 * 86_400_000)).toBe('12 days');
        expect(formatRemaining(1 * 86_400_000)).toBe('1 day');
        expect(formatRemaining(5 * 3_600_000)).toBe('5h');
        expect(formatRemaining(30 * 60_000)).toBe('less than an hour');
    });
});

describe('gateManager._makeProvider', () => {
    it('unwraps Streamr-shaped endpoint entries ({ url }) into a URL string', () => {
        // Regression: passing the raw { url } object made JsonRpcProvider
        // treat it as a FetchRequest → "url.clone is not a function" on the
        // very first gate transaction in the running app.
        const provider = gateManager._makeProvider();
        const connection = provider._getConnection();
        expect(typeof connection.url).toBe('string');
        expect(connection.url).toMatch(/^https?:\/\//);
    });
});

describe('GATE_MODE / WIRE_IDENTITY', () => {
    it('mirror the on-chain enum order (ABI compatibility)', async () => {
        const { WIRE_IDENTITY } = await import('../../src/js/gate.js');
        expect(GATE_MODE.NONE).toBe(0);
        expect(GATE_MODE.TOKEN_BALANCE).toBe(1);
        expect(GATE_MODE.NFT_OWNERSHIP).toBe(2);
        expect(GATE_MODE.PAID).toBe(3);
        expect(WIRE_IDENTITY.VISIBLE).toBe(0);
        expect(WIRE_IDENTITY.SEALED).toBe(1);
    });
});
