/**
 * identity.js — ENS privacy behaviour
 *
 * Every reverse lookup tells the RPC operator who you talk to. Two defences:
 *   1. verifyMessage never resolves — it reads cache only, so merely *seeing*
 *      a message (including unrendered history) issues no request at all.
 *   2. Real lookups go out buried among decoys, concurrently and shuffled.
 *
 * These tests pin both, plus the isolation guarantees decoys must keep.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../src/js/auth.js', () => ({
    authManager: {
        getAddress: vi.fn(() => '0xTestUser'),
        signMessage: vi.fn(() => Promise.resolve('0xMockSignature'))
    }
}));

vi.mock('../../src/js/secureStorage.js', () => ({
    secureStorage: {
        isStorageUnlocked: vi.fn(() => true),
        getUsername: vi.fn(() => null),
        setUsername: vi.fn(),
        getTrustedContacts: vi.fn(() => ({})),
        setTrustedContacts: vi.fn(),
        getENSCache: vi.fn(() => ({})),
        setENSCache: vi.fn()
    }
}));

vi.mock('../../src/js/logger.js', () => ({
    Logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }
}));

vi.mock('../../src/js/workers/cryptoWorkerPool.js', () => ({
    cryptoWorkerPool: { execute: vi.fn() }
}));

const mockLookupAddress = vi.fn(() => Promise.resolve(null));

let decoyCounter = 0;
const mockEthers = {
    keccak256: vi.fn(() => '0xMockHash'),
    toUtf8Bytes: vi.fn((str) => new Uint8Array([...str].map(c => c.charCodeAt(0)))),
    // Distinct, predictable decoy addresses so tests can tell them from the real one
    randomBytes: vi.fn(() => new Uint8Array(20).fill(++decoyCounter & 0xff)),
    hexlify: vi.fn((bytes) => '0xdecoy' + bytes[0].toString(16).padStart(2, '0')),
    Network: { from: vi.fn(() => ({ name: 'mainnet', chainId: 1n })) },
    JsonRpcProvider: vi.fn().mockImplementation(() => ({
        lookupAddress: mockLookupAddress,
        resolveName: vi.fn(() => Promise.resolve(null))
    }))
};
globalThis.ethers = mockEthers;

import { identityManager } from '../../src/js/identity.js';
import { cryptoWorkerPool } from '../../src/js/workers/cryptoWorkerPool.js';
import { CONFIG } from '../../src/js/config.js';
import { secureStorage } from '../../src/js/secureStorage.js';

const ORIGINAL_DECOY_COUNT = CONFIG.identity.ensDecoyCount;

describe('identity — ENS privacy', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        decoyCounter = 0;
        CONFIG.identity.ensDecoyCount = ORIGINAL_DECOY_COUNT;
        identityManager.trustedContacts = new Map();
        identityManager.ensCache = new Map();
        identityManager.pendingENSLookups = new Map();
        identityManager.providerHealth = new Map();
        identityManager._ensQueue = new Set();
        identityManager._ensQueueRunning = false;
        identityManager.onENSResolved = null;
        mockLookupAddress.mockResolvedValue(null);
        // Inject a single provider directly (same convention as
        // identity.extended.test.js). One provider keeps the lookup counts
        // exact — going through init() would give five and blur the decoy math.
        identityManager.ensProviders = [{
            _ensUrl: 'https://mock-rpc.test',
            lookupAddress: mockLookupAddress
        }];
    });

    describe('verifyMessage never touches the network', () => {
        const message = {
            id: 'm1', text: 'hi', sender: '0xSender',
            timestamp: Date.now(), channelId: 'c1', signature: '0xSig'
        };

        it('issues no lookup for an address that is not cached', async () => {
            cryptoWorkerPool.execute.mockResolvedValue({ valid: true, recoveredAddress: '0xSender' });

            const result = await identityManager.verifyMessage(message);

            expect(result.valid).toBe(true);
            expect(result.ensName).toBeNull();
            expect(mockLookupAddress).not.toHaveBeenCalled();
        });

        it('still serves a cached name without a lookup', async () => {
            identityManager.ensCache.set('0xsender', { name: 'sender.eth', timestamp: Date.now() });
            cryptoWorkerPool.execute.mockResolvedValue({ valid: true, recoveredAddress: '0xSender' });

            const result = await identityManager.verifyMessage(message);

            expect(result.ensName).toBe('sender.eth');
            expect(result.trustLevel).toBe(1);
            expect(mockLookupAddress).not.toHaveBeenCalled();
        });

        it('ignores an expired cache entry rather than pinning a stale name', async () => {
            identityManager.ensCache.set('0xsender', {
                name: 'old.eth',
                timestamp: Date.now() - (CONFIG.identity.ensCacheDurationMs + 1000)
            });
            cryptoWorkerPool.execute.mockResolvedValue({ valid: true, recoveredAddress: '0xSender' });

            const result = await identityManager.verifyMessage(message);

            expect(result.ensName).toBeNull();
            expect(mockLookupAddress).not.toHaveBeenCalled();
        });
    });

    describe('getCachedENS', () => {
        it('returns null on miss and for non-string input', () => {
            expect(identityManager.getCachedENS('0xNobody')).toBeNull();
            expect(identityManager.getCachedENS(null)).toBeNull();
            expect(identityManager.getCachedENS(undefined)).toBeNull();
        });

        it('honours the shorter TTL for cached nulls', () => {
            identityManager.ensCache.set('0xa', {
                name: null,
                timestamp: Date.now() - (CONFIG.identity.ensNullCacheDurationMs + 1000)
            });
            // Expired negative entry must not be treated as a fresh "no ENS"
            expect(identityManager.getCachedENS('0xA')).toBeNull();
            expect(identityManager.ensCache.get('0xa')).toBeDefined();
        });
    });

    describe('decoy lookups', () => {
        it('issues N+1 lookups for one real address', async () => {
            CONFIG.identity.ensDecoyCount = 3;
            mockLookupAddress.mockResolvedValue('real.eth');

            const name = await identityManager.resolveENS('0xReal');

            expect(name).toBe('real.eth');
            expect(mockLookupAddress).toHaveBeenCalledTimes(4);
        });

        it('includes the real address exactly once among the decoys', async () => {
            CONFIG.identity.ensDecoyCount = 3;
            mockLookupAddress.mockImplementation(addr =>
                Promise.resolve(addr === '0xReal' ? 'real.eth' : null));

            await identityManager.resolveENS('0xReal');

            const queried = mockLookupAddress.mock.calls.map(c => c[0]);
            expect(queried.filter(a => a === '0xReal')).toHaveLength(1);
            expect(queried.filter(a => a.startsWith('0xdecoy'))).toHaveLength(3);
        });

        it('does not always issue the real address first', async () => {
            // Ordering must not be a giveaway. Over many runs the real address
            // has to land somewhere other than position 0 at least once.
            CONFIG.identity.ensDecoyCount = 3;
            mockLookupAddress.mockResolvedValue(null);

            const positions = new Set();
            for (let i = 0; i < 40; i++) {
                mockLookupAddress.mockClear();
                identityManager.ensCache = new Map();
                identityManager.pendingENSLookups = new Map();
                await identityManager.resolveENS('0xReal');
                positions.add(mockLookupAddress.mock.calls.findIndex(c => c[0] === '0xReal'));
            }
            expect(positions.size).toBeGreaterThan(1);
        });

        it('caches only the real result, never a decoy', async () => {
            CONFIG.identity.ensDecoyCount = 3;
            mockLookupAddress.mockImplementation(addr =>
                Promise.resolve(addr === '0xReal' ? 'real.eth' : 'decoy.eth'));

            await identityManager.resolveENS('0xReal');

            expect(identityManager.ensCache.get('0xreal').name).toBe('real.eth');
            for (const key of identityManager.ensCache.keys()) {
                expect(key.startsWith('0xdecoy')).toBe(false);
            }
        });

        it('a failing decoy does not put the provider into cooldown', async () => {
            CONFIG.identity.ensDecoyCount = 3;
            mockLookupAddress.mockImplementation(addr =>
                addr === '0xReal' ? Promise.resolve('real.eth') : Promise.reject(new Error('rate limited')));

            const name = await identityManager.resolveENS('0xReal');

            expect(name).toBe('real.eth');
            expect(identityManager.providerHealth.size).toBe(0);
        });

        it('a failing real lookup still propagates and marks the provider', async () => {
            CONFIG.identity.ensDecoyCount = 3;
            mockLookupAddress.mockImplementation(addr =>
                addr === '0xReal' ? Promise.reject(new Error('boom')) : Promise.resolve(null));

            const name = await identityManager.resolveENS('0xReal');

            expect(name).toBeNull();                          // all providers exhausted
            expect(identityManager.providerHealth.size).toBeGreaterThan(0);
        });

        it('fires cover once per resolution, not once per provider', async () => {
            // A null result walks every provider. Decoying each attempt turned
            // one resolution into decoys×providers requests and got us 429'd
            // off the free tiers, which made real lookups fail at random.
            CONFIG.identity.ensDecoyCount = 2;
            identityManager.ensProviders = ['a', 'b', 'c'].map(id => ({
                _ensUrl: `https://mock-${id}.test`,
                lookupAddress: mockLookupAddress
            }));
            mockLookupAddress.mockResolvedValue(null);   // forces the full walk

            await identityManager.resolveENS('0xReal');

            // 3 real (one per provider) + 2 decoys fired once — not 2 per provider
            expect(mockLookupAddress).toHaveBeenCalledTimes(5);
            const queried = mockLookupAddress.mock.calls.map(c => c[0]);
            expect(queried.filter(a => a === '0xReal')).toHaveLength(3);
            expect(queried.filter(a => a.startsWith('0xdecoy'))).toHaveLength(2);
        });

        it('issues exactly one lookup when decoys are disabled', async () => {
            CONFIG.identity.ensDecoyCount = 0;
            mockLookupAddress.mockResolvedValue('real.eth');

            await identityManager.resolveENS('0xReal');

            expect(mockLookupAddress).toHaveBeenCalledTimes(1);
            expect(mockLookupAddress).toHaveBeenCalledWith('0xReal');
        });
    });

    describe('queueENSResolution', () => {
        it('skips an address with a fresh positive cache entry', async () => {
            identityManager.ensCache.set('0xa', { name: 'a.eth', timestamp: Date.now() });
            identityManager.queueENSResolution('0xA');
            expect(identityManager._ensQueue.size).toBe(0);
        });

        it('skips an address cached as having no ENS', async () => {
            // Otherwise every render would re-query addresses without a name
            identityManager.ensCache.set('0xa', { name: null, timestamp: Date.now() });
            identityManager.queueENSResolution('0xA');
            expect(identityManager._ensQueue.size).toBe(0);
        });

        it('resolves and notifies onENSResolved', async () => {
            CONFIG.identity.ensDecoyCount = 0;
            mockLookupAddress.mockResolvedValue('found.eth');
            const onResolved = vi.fn();
            identityManager.onENSResolved = onResolved;

            identityManager.queueENSResolution('0xNew');
            await vi.waitFor(() => expect(onResolved).toHaveBeenCalled());

            expect(onResolved).toHaveBeenCalledWith('0xnew', 'found.eth');
        });

        it('does not notify when the address has no ENS name', async () => {
            CONFIG.identity.ensDecoyCount = 0;
            mockLookupAddress.mockResolvedValue(null);
            const onResolved = vi.fn();
            identityManager.onENSResolved = onResolved;

            identityManager.queueENSResolution('0xNew');
            await vi.waitFor(() => expect(identityManager._ensQueueRunning).toBe(false));

            expect(onResolved).not.toHaveBeenCalled();
        });

        it('ignores junk input without queueing', () => {
            identityManager.queueENSResolution(null);
            identityManager.queueENSResolution('');
            identityManager.queueENSResolution(42);
            expect(identityManager._ensQueue.size).toBe(0);
        });

        it('survives a throwing onENSResolved handler', async () => {
            CONFIG.identity.ensDecoyCount = 0;
            mockLookupAddress.mockResolvedValue('found.eth');
            identityManager.onENSResolved = () => { throw new Error('UI blew up'); };

            identityManager.queueENSResolution('0xNew');
            await vi.waitFor(() => expect(identityManager._ensQueueRunning).toBe(false));

            expect(identityManager.ensCache.get('0xnew').name).toBe('found.eth');
        });
    });
});
describe('identity — a cached "no name"', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        CONFIG.identity.ensDecoyCount = 0;
        identityManager.ensCache = new Map();
        identityManager.pendingENSLookups = new Map();
        identityManager.providerHealth = new Map();
        mockLookupAddress.mockReset();
        mockLookupAddress.mockResolvedValue(null);
        identityManager.ensProviders = [{ _ensUrl: 'https://mock-rpc.test', lookupAddress: mockLookupAddress }];
    });

    it('keeps a null some provider confirmed for the positive TTL, and stores it', async () => {
        expect(await identityManager.resolveENS('0xNoName')).toBeNull();
        const entry = identityManager.ensCache.get('0xnoname');
        expect(entry.confirmed).toBe(true);
        await Promise.resolve();
        expect(secureStorage.setENSCache).toHaveBeenCalled();

        entry.timestamp = Date.now() - (CONFIG.identity.ensNullCacheDurationMs + 1000);
        await identityManager.resolveENS('0xNoName');
        expect(mockLookupAddress).toHaveBeenCalledTimes(1);
    });

    it('asks again soon when only failures produced the null', async () => {
        mockLookupAddress.mockRejectedValue(new Error('provider down'));
        expect(await identityManager.resolveENS('0xFails')).toBeNull();
        const entry = identityManager.ensCache.get('0xfails');
        expect(entry.confirmed).toBeUndefined();

        entry.timestamp = Date.now() - (CONFIG.identity.ensNullCacheDurationMs + 1000);
        identityManager.providerHealth = new Map();
        mockLookupAddress.mockResolvedValue(null);
        await identityManager.resolveENS('0xFails');
        expect(mockLookupAddress).toHaveBeenCalledTimes(2);
    });

    it('drops only the unconfirmed nulls when the stored cache is loaded', async () => {
        const now = Date.now();
        secureStorage.getENSCache.mockReturnValue({
            '0xconfirmed': { name: null, timestamp: now, confirmed: true },
            '0xfailed': { name: null, timestamp: now },
            '0xnamed': { name: 'named.eth', timestamp: now }
        });
        await identityManager.init();
        expect(identityManager.ensCache.has('0xconfirmed')).toBe(true);
        expect(identityManager.ensCache.has('0xfailed')).toBe(false);
        expect(identityManager.ensCache.has('0xnamed')).toBe(true);
        secureStorage.getENSCache.mockReturnValue({});
    });
});
