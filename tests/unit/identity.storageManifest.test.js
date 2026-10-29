/**
 * Tests for identity.js — the storage_file_announce manifest builder.
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

globalThis.ethers = {
    keccak256: vi.fn(() => '0xMockHash'),
    toUtf8Bytes: vi.fn((str) => new TextEncoder().encode(str)),
    Network: { from: vi.fn(() => ({ name: 'mainnet', chainId: 1n })) },
    JsonRpcProvider: vi.fn().mockImplementation(() => ({
        lookupAddress: vi.fn(() => Promise.resolve(null)),
        resolveName: vi.fn(() => Promise.resolve(null))
    }))
};

import { identityManager } from '../../src/js/identity.js';
import { authManager } from '../../src/js/auth.js';

const METADATA = {
    transferId: 'ab'.repeat(16),
    fileName: 'report.pdf',
    fileType: 'application/pdf',
    originalSize: 123456,
    compressedSize: 100000,
    compression: 'deflate',
    totalChunks: 12,
    chunkDataSize: 245000,
    chunkPartitions: 9,
    firstChunkPartition: 2,
    firstChunkTs: 1753200000000,
    lastChunkTs: 1753200060000,
    storedChunks: 12,
    encSalt: 'c2FsdHNhbHRzYWx0c2E='
};

describe('createStorageFileManifest', () => {
    it('returns the announce shape, unsigned (D6)', async () => {
        const msg = await identityManager.createStorageFileManifest({
            channelId: '0xchan/x-1', metadata: METADATA
        });
        expect(msg.type).toBe('storage_file_announce');
        expect(msg.v).toBe(1);
        expect(msg.sender).toBe('0xTestUser');   // local stamp, stripped at egress
        expect(msg.metadata).toEqual(METADATA);
        expect(msg.replyTo).toBeNull();

        expect(msg.signature).toBeUndefined();
        expect(msg.channelId).toBeUndefined();
        expect(authManager.signMessage).not.toHaveBeenCalled();
    });

    it('reuses a caller-provided id (optimistic bubble dedupe)', async () => {
        const msg = await identityManager.createStorageFileManifest({
            channelId: 'c', metadata: METADATA, id: 'preset-id-123'
        });
        expect(msg.id).toBe('preset-id-123');
    });
});
