/**
 * Streamr Controller - Helper Functions & Pure Methods Tests
 * Tests for deriveEphemeralId, deriveMessageId, isMessageStream, isEphemeralStream,
 * sanitizeStreamPath, getAddress, getDMInboxId, getDMEphemeralId, getDMPublicKey,
 * publishMessage, publishControl, publishReaction
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { ethers } from 'ethers';

// streamr.js reads the bundle-global `ethers` at runtime
globalThis.ethers = ethers;

// Mock auth before importing streamrController
vi.mock('../../src/js/auth.js', () => ({
    authManager: {
        getSigner: vi.fn()
    }
}));

import { 
    streamrController, 
    STREAM_CONFIG, 
    deriveEphemeralId, 
    deriveMessageId, 
    isMessageStream, 
    isEphemeralStream 
} from '../../src/js/streamr.js';

// ==================== Pure helper functions ====================
describe('Stream ID derivation functions', () => {
    describe('deriveEphemeralId()', () => {
        it('should convert -1 suffix to -2', () => {
            expect(deriveEphemeralId('owner/channel-1')).toBe('owner/channel-2');
        });

        it('should return null for null input', () => {
            expect(deriveEphemeralId(null)).toBeNull();
        });

        it('should return null for undefined input', () => {
            expect(deriveEphemeralId(undefined)).toBeNull();
        });

        it('should return null for empty string', () => {
            expect(deriveEphemeralId('')).toBeNull();
        });

        it('should only replace trailing -1', () => {
            expect(deriveEphemeralId('owner/my-1-channel-1')).toBe('owner/my-1-channel-2');
        });

        it('should not modify if no -1 suffix', () => {
            expect(deriveEphemeralId('owner/channel-3')).toBe('owner/channel-3');
        });

        it('should handle complex stream IDs', () => {
            expect(deriveEphemeralId('0xabc123/Pombo-Test-Channel-1')).toBe('0xabc123/Pombo-Test-Channel-2');
        });
    });

    describe('deriveMessageId()', () => {
        it('should convert -2 suffix to -1', () => {
            expect(deriveMessageId('owner/channel-2')).toBe('owner/channel-1');
        });

        it('should return null for null input', () => {
            expect(deriveMessageId(null)).toBeNull();
        });

        it('should return null for undefined input', () => {
            expect(deriveMessageId(undefined)).toBeNull();
        });

        it('should return null for empty string', () => {
            expect(deriveMessageId('')).toBeNull();
        });

        it('should only replace trailing -2', () => {
            expect(deriveMessageId('owner/my-2-channel-2')).toBe('owner/my-2-channel-1');
        });

        it('should not modify if no -2 suffix', () => {
            expect(deriveMessageId('owner/channel-5')).toBe('owner/channel-5');
        });
    });

    describe('isMessageStream()', () => {
        it('should return true for -1 suffix', () => {
            expect(isMessageStream('owner/channel-1')).toBe(true);
        });

        it('should return false for -2 suffix', () => {
            expect(isMessageStream('owner/channel-2')).toBe(false);
        });

        it('should return false for null', () => {
            expect(isMessageStream(null)).toBeFalsy();
        });

        it('should return false for undefined', () => {
            expect(isMessageStream(undefined)).toBeFalsy();
        });

        it('should return false for empty string', () => {
            expect(isMessageStream('')).toBeFalsy();
        });

        it('should check only the last character', () => {
            expect(isMessageStream('owner/thing-1-extra')).toBe(false);
        });
    });

    describe('isEphemeralStream()', () => {
        it('should return true for -2 suffix', () => {
            expect(isEphemeralStream('owner/channel-2')).toBe(true);
        });

        it('should return false for -1 suffix', () => {
            expect(isEphemeralStream('owner/channel-1')).toBe(false);
        });

        it('should return false for null', () => {
            expect(isEphemeralStream(null)).toBeFalsy();
        });

        it('should return false for undefined', () => {
            expect(isEphemeralStream(undefined)).toBeFalsy();
        });

        it('should return false for empty string', () => {
            expect(isEphemeralStream('')).toBeFalsy();
        });
    });

    describe('roundtrip conversions', () => {
        it('should round-trip message -> ephemeral -> message', () => {
            const original = 'owner/channel-1';
            const ephemeral = deriveEphemeralId(original);
            const backToMessage = deriveMessageId(ephemeral);
            expect(backToMessage).toBe(original);
        });

        it('should round-trip ephemeral -> message -> ephemeral', () => {
            const original = 'owner/channel-2';
            const message = deriveMessageId(original);
            const backToEphemeral = deriveEphemeralId(message);
            expect(backToEphemeral).toBe(original);
        });
    });
});

// ==================== STREAM_CONFIG ====================
describe('STREAM_CONFIG', () => {
    it('should have message stream suffix -1', () => {
        expect(STREAM_CONFIG.MESSAGE_STREAM.SUFFIX).toBe('-1');
    });

    it('should have ephemeral stream suffix -2', () => {
        expect(STREAM_CONFIG.EPHEMERAL_STREAM.SUFFIX).toBe('-2');
    });

    it('should have MESSAGES partition at 0', () => {
        expect(STREAM_CONFIG.MESSAGE_STREAM.MESSAGES).toBe(0);
    });

    it('should have CONTROL partition at 0', () => {
        expect(STREAM_CONFIG.EPHEMERAL_STREAM.CONTROL).toBe(0);
    });

    it('should have MEDIA_SIGNALS partition at 1', () => {
        expect(STREAM_CONFIG.EPHEMERAL_STREAM.MEDIA_SIGNALS).toBe(1);
    });

    it('should have MEDIA_DATA partition at 2', () => {
        expect(STREAM_CONFIG.EPHEMERAL_STREAM.MEDIA_DATA).toBe(2);
    });

    it('should have 12 partitions for message stream (content + control + moderation + 9 storage-file chunks)', () => {
        expect(STREAM_CONFIG.MESSAGE_STREAM.PARTITIONS).toBe(12);
    });

    it('should have 13 partitions for DM inbox message stream (P0-P3 + 9 storage-file chunks)', () => {
        expect(STREAM_CONFIG.MESSAGE_STREAM.DM_PARTITIONS).toBe(13);
    });

    it('should have 3 partitions for ephemeral stream', () => {
        expect(STREAM_CONFIG.EPHEMERAL_STREAM.PARTITIONS).toBe(3);
    });

    it('should have positive INITIAL_MESSAGES', () => {
        expect(STREAM_CONFIG.INITIAL_MESSAGES).toBeGreaterThan(0);
    });

    it('should have positive LOAD_MORE_COUNT', () => {
        expect(STREAM_CONFIG.LOAD_MORE_COUNT).toBeGreaterThan(0);
    });
});

// ==================== StreamrController instance methods ====================
describe('StreamrController', () => {
    let mockClient;

    beforeEach(() => {
        mockClient = {
            destroy: vi.fn().mockResolvedValue(undefined),
            unsubscribe: vi.fn().mockResolvedValue(undefined),
            getAddress: vi.fn().mockResolvedValue('0xtest123'),
            publish: vi.fn().mockResolvedValue(undefined),
            getStream: vi.fn()
        };
        streamrController.client = mockClient;
        streamrController.address = '0xtest123';
        streamrController.subscriptions = new Map();
    });

    afterEach(() => {
        streamrController.client = null;
        streamrController.address = null;
        vi.clearAllMocks();
    });

    describe('getAddress()', () => {
        it('should return stored address', async () => {
            const address = await streamrController.getAddress();
            expect(address).toBe('0xtest123');
        });

        it('should throw when client not initialized', async () => {
            streamrController.client = null;
            await expect(streamrController.getAddress()).rejects.toThrow('not initialized');
        });
    });

    describe('sanitizeStreamPath()', () => {
        it('should replace spaces with hyphens', () => {
            expect(streamrController.sanitizeStreamPath('my channel')).toBe('my-channel');
        });

        it('should remove special characters', () => {
            expect(streamrController.sanitizeStreamPath('hello@world!')).toBe('helloworld');
        });

        it('should collapse multiple hyphens', () => {
            expect(streamrController.sanitizeStreamPath('a---b')).toBe('a-b');
        });

        it('should trim hyphens from ends', () => {
            expect(streamrController.sanitizeStreamPath('-hello-')).toBe('hello');
        });

        it('should return "channel" for null', () => {
            expect(streamrController.sanitizeStreamPath(null)).toBe('channel');
        });

        it('should return "channel" for empty string', () => {
            expect(streamrController.sanitizeStreamPath('')).toBe('channel');
        });

        it('should return "channel" when all chars are invalid', () => {
            expect(streamrController.sanitizeStreamPath('!!@@##')).toBe('channel');
        });

        it('should truncate to 50 characters', () => {
            const longName = 'a'.repeat(100);
            const result = streamrController.sanitizeStreamPath(longName);
            expect(result.length).toBeLessThanOrEqual(50);
        });

        it('should allow alphanumeric, hyphens, and underscores', () => {
            expect(streamrController.sanitizeStreamPath('hello_world-123')).toBe('hello_world-123');
        });

        it('should handle unicode characters', () => {
            const result = streamrController.sanitizeStreamPath('café-général');
            // Unicode chars should be stripped
            expect(result).toBe('caf-gnral');
        });

        it('should handle multiple spaces', () => {
            expect(streamrController.sanitizeStreamPath('my   cool   channel')).toBe('my-cool-channel');
        });
    });

    describe('getDMInboxId()', () => {
        it('should return lowercased address with DM suffix', () => {
            const id = streamrController.getDMInboxId('0xABC123');
            expect(id).toMatch(/^0xabc123\/.+-1$/);
        });

        it('should be deterministic', () => {
            const id1 = streamrController.getDMInboxId('0xABC');
            const id2 = streamrController.getDMInboxId('0xABC');
            expect(id1).toBe(id2);
        });

        it('should produce message stream ID (ending with -1)', () => {
            const id = streamrController.getDMInboxId('0xtest');
            expect(id.endsWith('-1')).toBe(true);
        });
    });

    describe('getDMEphemeralId()', () => {
        it('should return lowercased address with ephemeral DM suffix', () => {
            const id = streamrController.getDMEphemeralId('0xABC123');
            expect(id).toMatch(/^0xabc123\/.+-2$/);
        });

        it('should produce ephemeral stream ID (ending with -2)', () => {
            const id = streamrController.getDMEphemeralId('0xtest');
            expect(id.endsWith('-2')).toBe(true);
        });

        it('should correspond to DM inbox (message <-> ephemeral)', () => {
            const inboxId = streamrController.getDMInboxId('0xAddress');
            const ephemeralId = streamrController.getDMEphemeralId('0xAddress');
            expect(deriveEphemeralId(inboxId)).toBe(ephemeralId);
            expect(deriveMessageId(ephemeralId)).toBe(inboxId);
        });
    });

    describe('getDMPublicKey()', () => {
        // The key must BE the address: the metadata read travels through
        // user-chosen RPCs with automatic public failover, so a forged `pk`
        // would be a full DM MITM — getDMPublicKey verifies before returning.
        const owner = new ethers.Wallet('0x' + '11'.repeat(32));
        const ownerPk = owner.signingKey.compressedPublicKey;

        it('should return the public key when it matches the inbox owner', async () => {
            const mockStream = {
                getDescription: vi.fn().mockResolvedValue(JSON.stringify({ pk: ownerPk }))
            };
            mockClient.getStream.mockResolvedValue(mockStream);

            const pk = await streamrController.getDMPublicKey(owner.address);
            expect(pk).toBe(ownerPk);
        });

        it('rejects a public key that does not match the inbox owner (RPC spoof)', async () => {
            const mockStream = {
                getDescription: vi.fn().mockResolvedValue(JSON.stringify({ pk: ownerPk }))
            };
            mockClient.getStream.mockResolvedValue(mockStream);

            const pk = await streamrController.getDMPublicKey('0x' + 'ab'.repeat(20));
            expect(pk).toBeNull();
        });

        it('rejects a malformed public key', async () => {
            const mockStream = {
                getDescription: vi.fn().mockResolvedValue(JSON.stringify({ pk: '0xpubkey123' }))
            };
            mockClient.getStream.mockResolvedValue(mockStream);

            const pk = await streamrController.getDMPublicKey(owner.address);
            expect(pk).toBeNull();
        });

        it('should return null when stream not found', async () => {
            mockClient.getStream.mockResolvedValue(null);

            const pk = await streamrController.getDMPublicKey('0xAddress');
            expect(pk).toBeNull();
        });

        it('should return null when description is empty', async () => {
            const mockStream = {
                getDescription: vi.fn().mockResolvedValue(null)
            };
            mockClient.getStream.mockResolvedValue(mockStream);

            const pk = await streamrController.getDMPublicKey('0xAddress');
            expect(pk).toBeNull();
        });

        it('should return null when description has no pk field', async () => {
            const mockStream = {
                getDescription: vi.fn().mockResolvedValue(JSON.stringify({ other: 'data' }))
            };
            mockClient.getStream.mockResolvedValue(mockStream);

            const pk = await streamrController.getDMPublicKey('0xAddress');
            expect(pk).toBeNull();
        });

        it('should return null on error', async () => {
            mockClient.getStream.mockRejectedValue(new Error('Network error'));

            const pk = await streamrController.getDMPublicKey('0xAddress');
            expect(pk).toBeNull();
        });
    });
});
