/**
 * identity.js Extended Tests
 * Covers: createMessage, verifyMessage, resolveAddress, pruneExpiredENSEntries (overflow)
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
    cryptoWorkerPool: {
        execute: vi.fn()
    }
}));

const mockLookupAddress = vi.fn(() => Promise.resolve(null));
const mockResolveName = vi.fn(() => Promise.resolve(null));

const mockEthers = {
    keccak256: vi.fn((data) => '0xMockHash'),
    toUtf8Bytes: vi.fn((str) => new Uint8Array([...str].map(c => c.charCodeAt(0)))),
    Network: {
        from: vi.fn(() => ({ name: 'mainnet', chainId: 1n }))
    },
    JsonRpcProvider: vi.fn().mockImplementation(() => ({
        lookupAddress: mockLookupAddress,
        resolveName: mockResolveName
    }))
};
globalThis.ethers = mockEthers;

import { identityManager } from '../../src/js/identity.js';
import { secureStorage } from '../../src/js/secureStorage.js';
import { authManager } from '../../src/js/auth.js';
import { cryptoWorkerPool } from '../../src/js/workers/cryptoWorkerPool.js';
import { Logger } from '../../src/js/logger.js';

describe('IdentityManager Extended', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        identityManager.trustedContacts = new Map();
        identityManager.ensCache = new Map();
        identityManager.pendingENSLookups = new Map();
        identityManager.providerHealth = new Map();
        identityManager.username = null;
        secureStorage.isStorageUnlocked.mockReturnValue(true);
        secureStorage.getTrustedContacts.mockReturnValue({});
        secureStorage.getENSCache.mockReturnValue({});
        authManager.getAddress.mockReturnValue('0xTestUser');
        authManager.signMessage.mockResolvedValue('0xMockSignature');
        mockLookupAddress.mockResolvedValue(null);
        mockResolveName.mockResolvedValue(null);
    });

    // ==================== createMessage ====================
    describe('createMessage()', () => {
        it('should create a message with all fields', async () => {
            const msg = await identityManager.createMessage('Hello', 'channel-1');

            expect(msg.type).toBe('text');
            expect(msg.text).toBe('Hello');
            expect(msg.timestamp).toBeGreaterThan(0);
            expect(msg.id).toMatch(/^[0-9a-f]{32}$/);
            expect(msg.replyTo).toBeNull();
        });

        it('stamps the local identity so the message renders before it is sent', async () => {
            const msg = await identityManager.createMessage('Hello', 'channel-1');

            // Set locally, stripped at egress, re-derived from the proof on
            // arrival — the sender's own copy never goes through ingest.
            expect(msg.account).toBe('0xTestUser');
            expect(msg.sender).toBe('0xTestUser');
        });

        it('carries no app-layer signature or channelId (D6/D7)', async () => {
            const msg = await identityManager.createMessage('Hello', 'channel-1');

            // Streamr signs the envelope and the proof authenticates the
            // account; a third signature only re-exposed the address.
            expect(msg.signature).toBeUndefined();
            expect(msg.channelId).toBeUndefined();
        });

        it('should include senderName when username is set', async () => {
            identityManager.username = 'Alice';

            const msg = await identityManager.createMessage('Hi', 'ch-1');

            expect(msg.senderName).toBe('Alice');
        });

        it('should set senderName to null when no username', async () => {
            identityManager.username = null;

            const msg = await identityManager.createMessage('Hi', 'ch-1');

            expect(msg.senderName).toBeNull();
        });

        it('should include replyTo when provided', async () => {
            const replyTo = { id: 'msg-original', text: 'Original', sender: '0xOther' };

            const msg = await identityManager.createMessage('Reply', 'ch-1', replyTo);

            expect(msg.replyTo).toEqual(replyTo);
        });

        it('should not hash the message', async () => {
            const hashSpy = vi.spyOn(identityManager, 'createMessageHash');

            await identityManager.createMessage('Test', 'ch-2');

            // The hash existed only to be signed. createMessageHash survives
            // for verifying pre-migration history, nothing else.
            expect(hashSpy).not.toHaveBeenCalled();
        });

        it('should not sign', async () => {
            await identityManager.createMessage('Sign me', 'ch-1');

            expect(authManager.signMessage).not.toHaveBeenCalled();
        });

        it('should generate unique IDs for each message', async () => {
            const msg1 = await identityManager.createMessage('A', 'ch');
            const msg2 = await identityManager.createMessage('B', 'ch');

            expect(msg1.id).not.toBe(msg2.id);
        });
    });

    // ==================== verifyMessage ====================
    describe('verifyMessage()', () => {
        const validMessage = {
            id: 'msg-123',
            text: 'Hello',
            sender: '0xSender',
            timestamp: Date.now(),
            channelId: 'ch-1',
            signature: '0xSig'
        };

        it('accepts an unsigned message and takes identity from the account', async () => {
            // The current format (D6). `account` was established by ecrecover
            // over the proof at ingest, before this message reached anyone.
            const result = await identityManager.verifyMessage({
                ...validMessage,
                signature: null,
                account: '0xProvenAccount'
            });

            expect(result.valid).toBe(true);
            expect(result.recoveredAddress).toBe('0xProvenAccount');
        });

        it('rejects an unsigned message with no account', async () => {
            const result = await identityManager.verifyMessage({
                ...validMessage,
                signature: null,
                account: null
            });

            expect(result.valid).toBe(false);
            expect(result.error).toBe('No account');
            expect(result.trustLevel).toBe(-1);
        });

        it('still rejects an unsigned message with an expired timestamp', async () => {
            // The replay window must not widen just because the app-layer
            // signature went away.
            const result = await identityManager.verifyMessage({
                ...validMessage,
                signature: null,
                account: '0xProvenAccount',
                timestamp: Date.now() - 10 * 60000
            });

            expect(result.valid).toBe(false);
            expect(result.isReplayAttempt).toBe(true);
        });

        it('should reject expired timestamp (replay attack)', async () => {
            const oldMsg = { ...validMessage, timestamp: Date.now() - 10 * 60000 };

            const result = await identityManager.verifyMessage(oldMsg);

            expect(result.valid).toBe(false);
            expect(result.isReplayAttempt).toBe(true);
            expect(result.trustLevel).toBe(-1);
        });

        it('should skip timestamp check when option is set', async () => {
            const oldMsg = { ...validMessage, timestamp: Date.now() - 10 * 60000 };
            cryptoWorkerPool.execute.mockResolvedValue({
                valid: true,
                recoveredAddress: '0xSender'
            });

            const result = await identityManager.verifyMessage(oldMsg, 'ch-1', { skipTimestampCheck: true });

            expect(result.valid).toBe(true);
        });

        it('should return invalid on signature mismatch', async () => {
            cryptoWorkerPool.execute.mockResolvedValue({
                valid: false,
                error: 'Signer mismatch',
                recoveredAddress: '0xOtherSigner'
            });

            const result = await identityManager.verifyMessage(validMessage);

            expect(result.valid).toBe(false);
            expect(result.error).toBe('Signer mismatch');
            expect(result.claimedSender).toBe('0xSender');
            expect(result.actualSigner).toBe('0xOtherSigner');
            expect(result.trustLevel).toBe(-1);
        });

        it('should return valid with trust level on success', async () => {
            cryptoWorkerPool.execute.mockResolvedValue({
                valid: true,
                recoveredAddress: '0xSender'
            });

            const result = await identityManager.verifyMessage(validMessage);

            expect(result.valid).toBe(true);
            expect(result.recoveredAddress).toBe('0xSender');
            expect(result.trustLevel).toBe(0); // unknown address
        });

        it('should return trust level 2 for trusted contact', async () => {
            await identityManager.addTrustedContact('0xSender', 'TrustedGuy');
            cryptoWorkerPool.execute.mockResolvedValue({
                valid: true,
                recoveredAddress: '0xSender'
            });

            const result = await identityManager.verifyMessage(validMessage);

            expect(result.trustLevel).toBe(2);
        });

        it('should include ENS name when available', async () => {
            identityManager.ensCache.set('0xsender', {
                name: 'sender.eth',
                timestamp: Date.now()
            });
            cryptoWorkerPool.execute.mockResolvedValue({
                valid: true,
                recoveredAddress: '0xSender'
            });

            const result = await identityManager.verifyMessage(validMessage);

            expect(result.ensName).toBe('sender.eth');
            expect(result.trustLevel).toBe(1); // ENS verified
        });

        it('should call cryptoWorkerPool with correct params', async () => {
            cryptoWorkerPool.execute.mockResolvedValue({
                valid: true,
                recoveredAddress: '0xSender'
            });

            await identityManager.verifyMessage(validMessage);

            expect(cryptoWorkerPool.execute).toHaveBeenCalledWith('VERIFY_SIGNATURE', {
                messageHash: '0xMockHash',
                signature: '0xSig',
                expectedSender: '0xSender'
            });
        });

        it('should handle worker exception gracefully', async () => {
            cryptoWorkerPool.execute.mockRejectedValue(new Error('Worker crashed'));

            const result = await identityManager.verifyMessage(validMessage);

            expect(result.valid).toBe(false);
            expect(result.error).toBe('Worker crashed');
            expect(result.trustLevel).toBe(-1);
            expect(Logger.error).toHaveBeenCalledWith(
                expect.stringContaining('Signature verification failed'),
                expect.any(Error)
            );
        });

        it('should use default error when verification has no error message', async () => {
            cryptoWorkerPool.execute.mockResolvedValue({
                valid: false,
                recoveredAddress: '0xBad'
            });

            const result = await identityManager.verifyMessage(validMessage);

            expect(result.error).toBe('Signature mismatch');
        });
    });

    // ==================== resolveAddress ====================
    describe('resolveAddress()', () => {
        it('should return null when no ENS provider', async () => {
            identityManager.ensProviders = [];

            const result = await identityManager.resolveAddress('vitalik.eth');

            expect(result).toBeNull();
        });

        it('should resolve ENS name to address', async () => {
            // Ensure provider is initialized
            const mockProvider = {
                _ensUrl: 'https://mock-rpc.test',
                resolveName: vi.fn().mockResolvedValue('0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045')
            };
            identityManager.ensProviders = [mockProvider];
            identityManager.providerHealth = new Map();

            const result = await identityManager.resolveAddress('vitalik.eth');

            expect(result).toBe('0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045');
            expect(mockProvider.resolveName).toHaveBeenCalledWith('vitalik.eth');
        });

        it('should return null on resolution error', async () => {
            identityManager.ensProviders = [{
                _ensUrl: 'https://mock-rpc.test',
                resolveName: vi.fn().mockRejectedValue(new Error('Network error'))
            }];
            identityManager.providerHealth = new Map();

            const result = await identityManager.resolveAddress('bad.eth');

            expect(result).toBeNull();
            expect(Logger.warn).toHaveBeenCalledWith(
                expect.stringContaining('ENS resolve failed'),
                'bad.eth',
                expect.stringContaining('all providers exhausted')
            );
        });

        it('should return null when name does not resolve', async () => {
            identityManager.ensProviders = [{
                _ensUrl: 'https://mock-rpc.test',
                resolveName: vi.fn().mockResolvedValue(null)
            }];
            identityManager.providerHealth = new Map();

            const result = await identityManager.resolveAddress('nonexistent.eth');

            expect(result).toBeNull();
        });
    });

    // ==================== pruneExpiredENSEntries (overflow) ====================
    describe('pruneExpiredENSEntries() overflow branch', () => {
        it('should evict oldest entries when exceeding max cache size', () => {
            const SIZE = identityManager.MAX_ENS_CACHE_SIZE;
            const now = Date.now();

            // Fill cache over the limit with non-expired entries
            for (let i = 0; i < SIZE + 10; i++) {
                identityManager.ensCache.set(`0xaddr${i}`, {
                    name: `user${i}.eth`,
                    timestamp: now - i * 1000 // Older entries have smaller timestamps
                });
            }

            expect(identityManager.ensCache.size).toBe(SIZE + 10);

            identityManager.pruneExpiredENSEntries();

            // Should trim to MAX_ENS_CACHE_SIZE
            expect(identityManager.ensCache.size).toBe(SIZE);

            // Oldest (highest index = smallest timestamp) should be evicted
            expect(identityManager.ensCache.has(`0xaddr${SIZE + 9}`)).toBe(false);
            // Newest should still be present
            expect(identityManager.ensCache.has('0xaddr0')).toBe(true);
        });

        it('should remove expired entries first', () => {
            const now = Date.now();
            const EXPIRED_TS = now - 25 * 60 * 60 * 1000; // 25h ago (expired, > 24h)

            identityManager.ensCache.set('0xexpired1', { name: 'old1.eth', timestamp: EXPIRED_TS });
            identityManager.ensCache.set('0xexpired2', { name: 'old2.eth', timestamp: EXPIRED_TS });
            identityManager.ensCache.set('0xfresh', { name: 'fresh.eth', timestamp: now });

            identityManager.pruneExpiredENSEntries();

            expect(identityManager.ensCache.has('0xexpired1')).toBe(false);
            expect(identityManager.ensCache.has('0xexpired2')).toBe(false);
            expect(identityManager.ensCache.has('0xfresh')).toBe(true);
        });
    });

    // ==================== loadTrustedContacts error ====================
    describe('loadTrustedContacts() error branch', () => {
        it('should catch and log errors', () => {
            secureStorage.getTrustedContacts.mockImplementation(() => {
                throw new Error('corrupt data');
            });

            identityManager.loadTrustedContacts();

            expect(Logger.error).toHaveBeenCalledWith(
                expect.stringContaining('Failed to load trusted contacts'),
                expect.any(Error)
            );
        });
    });

    // ==================== loadENSCache error ====================
    describe('loadENSCache() error branch', () => {
        it('should catch and log errors', () => {
            secureStorage.getENSCache.mockImplementation(() => {
                throw new Error('corrupt data');
            });

            identityManager.loadENSCache();

            expect(Logger.error).toHaveBeenCalledWith(
                expect.stringContaining('Failed to load ENS cache'),
                expect.any(Error)
            );
        });
    });

    // ==================== loadUsername error ====================
    describe('loadUsername() error branch', () => {
        it('should catch and log errors', () => {
            secureStorage.getUsername.mockImplementation(() => {
                throw new Error('corrupt');
            });

            identityManager.loadUsername();

            expect(Logger.error).toHaveBeenCalledWith(
                expect.stringContaining('Failed to load username'),
                expect.any(Error)
            );
        });
    });
});
