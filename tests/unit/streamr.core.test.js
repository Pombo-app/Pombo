/**
 * Streamr Controller - Core Methods Tests
 * Tests for publish, subscribe, permissions, storage, history, and stream management
 * Target: raise streamr.js coverage from ~7% to ~50%+
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Mock dependencies before importing
vi.mock('../../src/js/auth.js', () => ({
    authManager: {
        getSigner: vi.fn()
    }
}));

// Raw resends verify the envelope signature; these fixtures are plain
// objects with no signature, so the check is stubbed to accept and the
// real recovery keeps its own dedicated tests.
vi.mock('../../src/js/envelopeSigner.js', async (importOriginal) => ({
    ...(await importOriginal()),
    verifyEnvelopeAuthenticity: () => true,
}));

vi.mock('../../src/js/crypto.js', () => ({
    cryptoManager: {
        encryptJSON: vi.fn(async (data) => JSON.stringify(data)),
        decryptJSON: vi.fn(async (str) => JSON.parse(str)),
        generateRandomHex: vi.fn(() => 'abcd1234')
    }
}));

vi.mock('../../src/js/utils/retry.js', () => ({
    executeWithRetry: vi.fn(async (name, fn) => fn()),
    executeWithRetryAndVerify: vi.fn(async (name, fn, checkFn) => fn())
}));

vi.mock('../../src/js/utils/rpcErrors.js', () => ({
    isRpcError: vi.fn(() => false),
    createPermissionResult: vi.fn((has, rpc, msg) => ({ hasPermission: has, rpcError: rpc, errorMessage: msg || null }))
}));

import { streamrController, STREAM_CONFIG, isMessageStream, isEphemeralStream } from '../../src/js/streamr.js';
import { cryptoManager } from '../../src/js/crypto.js';
import { isRpcError, createPermissionResult } from '../../src/js/utils/rpcErrors.js';
import { executeWithRetry, executeWithRetryAndVerify } from '../../src/js/utils/retry.js';

// ==================== Test helpers ====================
function createMockClient(overrides = {}) {
    return {
        publish: vi.fn().mockResolvedValue(undefined),
        subscribe: vi.fn().mockResolvedValue({ unsubscribe: vi.fn().mockResolvedValue(undefined) }),
        getStream: vi.fn().mockResolvedValue(createMockStream()),
        getAddress: vi.fn().mockResolvedValue('0xmyaddress'),
        createStream: vi.fn().mockResolvedValue({ id: '0xowner/abcd1234-1' }),
        deleteStream: vi.fn().mockResolvedValue(undefined),
        setPermissions: vi.fn().mockResolvedValue(undefined),
        destroy: vi.fn().mockResolvedValue(undefined),
        unsubscribe: vi.fn().mockResolvedValue(undefined),
        resend: vi.fn().mockResolvedValue(createMockAsyncIterator([])),
        updateEncryptionKey: vi.fn().mockResolvedValue(undefined),
        addEncryptionKey: vi.fn().mockResolvedValue(undefined),
        ...overrides
    };
}

function createMockStream(overrides = {}) {
    return {
        id: '0xowner/stream-1',
        getDescription: vi.fn().mockResolvedValue(JSON.stringify({ pk: 'test-pk' })),
        setDescription: vi.fn().mockResolvedValue(undefined),
        getPermissions: vi.fn().mockReturnValue([]),
        getStorageNodes: vi.fn().mockReturnValue([]),
        getStorageDayCount: vi.fn().mockResolvedValue(180),
        setStorageDayCount: vi.fn().mockResolvedValue(undefined),
        addToStorageNode: vi.fn().mockResolvedValue(undefined),
        hasPermission: vi.fn().mockResolvedValue(true),
        ...overrides
    };
}

function createMockAsyncIterator(messages) {
    let index = 0;
    return {
        [Symbol.asyncIterator]() {
            return {
                next: async () => {
                    if (index < messages.length) {
                        return { done: false, value: messages[index++] };
                    }
                    return { done: true };
                }
            };
        }
    };
}

function createMockMessage(content, publisherId = '0xsender', timestamp = Date.now()) {
    return {
        content,
        publisherId,
        timestamp,
        getPublisherId: vi.fn(() => publisherId),
        getPartition: vi.fn(() => 0)
    };
}

// ==================== Setup ====================
describe('StreamrController Core', () => {
    let mockClient;
    let mockStream;

    beforeEach(() => {
        mockStream = createMockStream();
        mockClient = createMockClient({ getStream: vi.fn().mockResolvedValue(mockStream) });
        
        streamrController.client = mockClient;
        streamrController.address = '0xmyaddress';
        streamrController.subscriptions = new Map();
        streamrController.channels = new Map();
        streamrController._dmKeyAddedForPublisher = new Set();
        streamrController._dmPublishKeySet = new Set();

        // Reset global mocks
        window.StreamPermission = {
            PUBLISH: 'PUBLISH',
            SUBSCRIBE: 'SUBSCRIBE',
            GRANT: 'GRANT',
            EDIT: 'EDIT',
            DELETE: 'DELETE'
        };
        window.EncryptionKey = null;
    });

    afterEach(() => {
        streamrController.client = null;
        streamrController.address = null;
        streamrController.subscriptions.clear();
        streamrController._dmKeyAddedForPublisher.clear();
        streamrController._dmPublishKeySet.clear();
        vi.restoreAllMocks();
    });

    // ==================== init() ====================
    describe('init()', () => {
        beforeEach(() => {
            streamrController.client = null;
            streamrController.address = null;
        });

        it('should throw if StreamrClient not on window', async () => {
            delete window.StreamrClient;
            await expect(streamrController.init({ privateKey: '0xabc' }))
                .rejects.toThrow('StreamrClient not found');
        });

        it('should throw if signer has no privateKey', async () => {
            window.StreamrClient = vi.fn(() => mockClient);
            await expect(streamrController.init({}))
                .rejects.toThrow('Signer must have a privateKey');
        });

        it('should create a StreamrClient with signer', async () => {
            window.StreamrClient = function() { Object.assign(this, mockClient); };
            const result = await streamrController.init({ privateKey: '0xabc' });
            expect(result).toBe(true);
            expect(streamrController.client).toBeDefined();
        });

        it('should set address from client.getAddress()', async () => {
            window.StreamrClient = function() { Object.assign(this, mockClient); };
            await streamrController.init({ privateKey: '0xabc' });
            expect(streamrController.address).toBe('0xmyaddress');
        });

        it('should always have the hardcoded Pombo node address', async () => {
            window.StreamrClient = function() { Object.assign(this, mockClient); };
            await streamrController.init({ privateKey: '0xabc' });
            expect(STREAM_CONFIG.NODE_ADDRESS).toBe('0xae340e799e8151f6a4999d245e466197aa217667');
        });
    });

    // ==================== warmupNetwork() ====================
    describe('warmupNetwork()', () => {
        it('should do nothing if client is null', async () => {
            streamrController.client = null;
            await streamrController.warmupNetwork();
            // No error thrown
        });

        it('should subscribe and unsubscribe to warm up', async () => {
            const mockSub = { unsubscribe: vi.fn().mockResolvedValue(undefined) };
            mockClient.subscribe.mockResolvedValue(mockSub);
            await streamrController.warmupNetwork('test/stream-1');
            expect(mockClient.subscribe).toHaveBeenCalledWith('test/stream-1', expect.any(Function));
            expect(mockSub.unsubscribe).toHaveBeenCalled();
        });

        it('should use default push stream if no streamId provided', async () => {
            const mockSub = { unsubscribe: vi.fn().mockResolvedValue(undefined) };
            mockClient.subscribe.mockResolvedValue(mockSub);
            await streamrController.warmupNetwork();
            expect(mockClient.subscribe).toHaveBeenCalledWith(
                expect.stringContaining('/push'),
                expect.any(Function)
            );
        });

        it('should not throw if subscribe fails', async () => {
            mockClient.subscribe.mockRejectedValue(new Error('network'));
            await expect(streamrController.warmupNetwork()).resolves.toBeUndefined();
        });
    });

    // ==================== publish() ====================
    describe('publish()', () => {
        it('should throw if client is null', async () => {
            streamrController.client = null;
            await expect(streamrController.publish('stream-1', 0, { text: 'hi' }))
                .rejects.toThrow('Streamr client not initialized');
        });

        it('should call client.publish with streamId and partition', async () => {
            await streamrController.publish('stream-1', 0, { text: 'hi' });
            expect(mockClient.publish).toHaveBeenCalledWith(
                { streamId: 'stream-1', partition: 0 },
                { text: 'hi' }
            );
        });

        it('should encrypt data when password provided', async () => {
            await streamrController.publish('stream-1', 0, { text: 'hi' }, 'pass123');
            expect(cryptoManager.encryptJSON).toHaveBeenCalledWith({ text: 'hi' }, 'pass123');
            expect(mockClient.publish).toHaveBeenCalled();
        });

        it('should not encrypt when no password', async () => {
            await streamrController.publish('stream-1', 0, { text: 'hi' });
            expect(cryptoManager.encryptJSON).not.toHaveBeenCalled();
        });

        it('should throw on publish failure', async () => {
            mockClient.publish.mockRejectedValue(new Error('publish failed'));
            await expect(streamrController.publish('stream-1', 0, {}))
                .rejects.toThrow('publish failed');
        });
    });

    // ==================== publishMessage() ====================
    // Channel traffic no longer goes through client.publish(): it is published
    // under the channel's ephemeral identity (D1 + D2), so these assert the
    // single egress point rather than the SDK call underneath it.
    describe('publishMessage()', () => {
        let asChannel;

        beforeEach(() => {
            asChannel = vi.spyOn(streamrController, 'publishAsChannel')
                .mockResolvedValue({ timestamp: 1 });
        });

        afterEach(() => asChannel.mockRestore());

        it('should route through the channel egress point, not client.publish', async () => {
            // If this ever reverts to client.publish, that stream's publisherId
            // silently becomes the user's wallet again.
            await streamrController.publishMessage('stream-1', { id: '1' });

            expect(asChannel).toHaveBeenCalledWith(
                'stream-1', STREAM_CONFIG.MESSAGE_STREAM.MESSAGES,
                expect.any(Object), null
            );
            expect(mockClient.publish).not.toHaveBeenCalled();
        });

        it('should pass the password through', async () => {
            await streamrController.publishMessage('stream-1', { id: '1' }, 'pass');
            expect(asChannel).toHaveBeenCalledWith(
                'stream-1', expect.any(Number), expect.any(Object), 'pass'
            );
        });
    });

    describe('publishControl()', () => {
        it('should route control to EPHEMERAL_STREAM.CONTROL via the egress point', async () => {
            const asChannel = vi.spyOn(streamrController, 'publishAsChannel')
                .mockResolvedValue({});
            const control = { type: 'typing', userId: '0x1' };

            await streamrController.publishControl('stream-2', control);

            expect(asChannel).toHaveBeenCalledWith(
                'stream-2', STREAM_CONFIG.EPHEMERAL_STREAM.CONTROL, control, null
            );
            asChannel.mockRestore();
        });
    });

    describe('publishReaction()', () => {
        it('should route reactions to MESSAGE_STREAM.MESSAGES via the egress point', async () => {
            const asChannel = vi.spyOn(streamrController, 'publishAsChannel')
                .mockResolvedValue({});
            const reaction = { type: 'reaction', messageId: 'm1', emoji: '👍' };

            await streamrController.publishReaction('stream-1', reaction);

            expect(asChannel).toHaveBeenCalledWith(
                'stream-1', STREAM_CONFIG.MESSAGE_STREAM.MESSAGES, reaction, null
            );
            asChannel.mockRestore();
        });
    });

    // ==================== publishMediaSignal() / publishMediaData() ====================
    describe('publishMediaSignal()', () => {
        it('should route media signals to MEDIA_SIGNALS via the egress point', async () => {
            const asChannel = vi.spyOn(streamrController, 'publishAsChannel')
                .mockResolvedValue({});
            const signal = { type: 'image_request', imageId: 'img1' };

            await streamrController.publishMediaSignal('stream-2', signal);

            expect(asChannel).toHaveBeenCalledWith(
                'stream-2', STREAM_CONFIG.EPHEMERAL_STREAM.MEDIA_SIGNALS, signal, null
            );
            asChannel.mockRestore();
        });
    });

    describe('publishMediaData()', () => {
        it('should publish to EPHEMERAL_STREAM.MEDIA_DATA partition', async () => {
            const data = new Uint8Array([1, 2, 3]);
            await streamrController.publishMediaData('stream-2', data);
            expect(mockClient.publish).toHaveBeenCalledWith(
                { streamId: 'stream-2', partition: STREAM_CONFIG.EPHEMERAL_STREAM.MEDIA_DATA },
                data
            );
        });
    });

    // ==================== resendAdminState() ====================
    describe('resendAdminState()', () => {
        it('returns null when stream has no admin entries', async () => {
            mockClient.resend = vi.fn().mockResolvedValue(createMockAsyncIterator([]));
            const result = await streamrController.resendAdminState('stream-3');
            expect(result).toBeNull();
        });

        it('returns the highest-rev snapshot from the resend window', async () => {
            const messages = [
                createMockMessage({ type: 'ADMIN_STATE', rev: 1, ts: 100, state: { pins: [] } }),
                createMockMessage({ type: 'ADMIN_STATE', rev: 3, ts: 300, state: { pins: ['x'] } }),
                createMockMessage({ type: 'ADMIN_STATE', rev: 2, ts: 200, state: { pins: [] } })
            ];
            mockClient.resend = vi.fn().mockResolvedValue(createMockAsyncIterator(messages));
            const result = await streamrController.resendAdminState('stream-3');
            expect(result).not.toBeNull();
            expect(result.rev).toBe(3);
            expect(result.state.pins).toEqual(['x']);
        });

        it('breaks rev ties by larger ts', async () => {
            const messages = [
                createMockMessage({ type: 'ADMIN_STATE', rev: 5, ts: 100 }),
                createMockMessage({ type: 'ADMIN_STATE', rev: 5, ts: 500 }),
                createMockMessage({ type: 'ADMIN_STATE', rev: 5, ts: 200 })
            ];
            mockClient.resend = vi.fn().mockResolvedValue(createMockAsyncIterator(messages));
            const result = await streamrController.resendAdminState('stream-3');
            expect(result.ts).toBe(500);
        });

        it('passes { last } and partition to client.resend', async () => {
            mockClient.resend = vi.fn().mockResolvedValue(createMockAsyncIterator([]));
            await streamrController.resendAdminState('stream-3', { historyCount: 7 });
            expect(mockClient.resend).toHaveBeenCalledWith(
                { streamId: 'stream-3', partition: STREAM_CONFIG.ADMIN_STREAM.MODERATION },
                { last: 7, raw: true }
            );
        });

        it('returns null on resend exception', async () => {
            mockClient.resend = vi.fn().mockRejectedValue(new Error('network'));
            const result = await streamrController.resendAdminState('stream-3');
            expect(result).toBeNull();
        });

        it('decrypts encrypted entries when password is supplied', async () => {
            cryptoManager.decryptJSON.mockImplementationOnce(async () => ({
                type: 'ADMIN_STATE', rev: 4, ts: 400, state: { pins: [] }
            }));
            const messages = [createMockMessage('encrypted-blob')];
            mockClient.resend = vi.fn().mockResolvedValue(createMockAsyncIterator(messages));
            const result = await streamrController.resendAdminState('stream-3', { password: 'pw' });
            expect(cryptoManager.decryptJSON).toHaveBeenCalledWith('encrypted-blob', 'pw');
            expect(result.rev).toBe(4);
        });

        it('skips entries that fail to decrypt', async () => {
            cryptoManager.decryptJSON.mockImplementationOnce(async () => { throw new Error('bad key'); });
            cryptoManager.decryptJSON.mockImplementationOnce(async () => ({
                type: 'ADMIN_STATE', rev: 2, ts: 200
            }));
            const messages = [
                createMockMessage('bad'),
                createMockMessage('good')
            ];
            mockClient.resend = vi.fn().mockResolvedValue(createMockAsyncIterator(messages));
            const result = await streamrController.resendAdminState('stream-3', { password: 'pw' });
            expect(result.rev).toBe(2);
        });
    });

    // ==================== subscribeToPartition() ====================
    describe('subscribeToPartition()', () => {
        it('should throw if client is null', async () => {
            streamrController.client = null;
            await expect(streamrController.subscribeToPartition('stream', 0, vi.fn()))
                .rejects.toThrow('Streamr client not initialized');
        });

        it('should call client.subscribe with streamId and partition', async () => {
            const handler = vi.fn();
            await streamrController.subscribeToPartition('stream-1', 0, handler);
            expect(mockClient.subscribe).toHaveBeenCalledWith(
                { streamId: 'stream-1', partition: 0 },
                expect.any(Function)
            );
        });

        it('should store subscription in subscriptions map', async () => {
            await streamrController.subscribeToPartition('stream-1', 0, vi.fn());
            const partitionSubs = streamrController.subscriptions.get('stream-1');
            expect(partitionSubs).toBeDefined();
            expect(partitionSubs[0]).toBeDefined();
        });

        it('should return existing subscription if already subscribed', async () => {
            const existingSub = { unsubscribe: vi.fn() };
            streamrController.subscriptions.set('stream-1', { 0: existingSub });
            const result = await streamrController.subscribeToPartition('stream-1', 0, vi.fn());
            expect(result).toBe(existingSub);
            expect(mockClient.subscribe).not.toHaveBeenCalled();
        });

        it('should decrypt messages when password provided', async () => {
            let capturedHandler;
            mockClient.subscribe.mockImplementation(async (opts, handler) => {
                capturedHandler = handler;
                return { unsubscribe: vi.fn() };
            });

            const handler = vi.fn();
            await streamrController.subscribeToPartition('stream-1', 0, handler, 'pass');
            
            // Simulate receiving encrypted message
            await capturedHandler('encrypted-string', { getPublisherId: () => '0xsender' });
            expect(cryptoManager.decryptJSON).toHaveBeenCalledWith('encrypted-string', 'pass');
        });

        it('should inject account from StreamMessage', async () => {
            let capturedHandler;
            mockClient.subscribe.mockImplementation(async (opts, handler) => {
                capturedHandler = handler;
                return { unsubscribe: vi.fn() };
            });

            const handler = vi.fn();
            await streamrController.subscribeToPartition('stream-1', 0, handler);
            
            const data = { text: 'hello' };
            await capturedHandler(data, { getPublisherId: () => '0xpublisher' });
            expect(handler).toHaveBeenCalledWith(expect.objectContaining({ account: '0xpublisher' }));
        });
    });

    // ==================== subscribeSimple() ====================
    describe('subscribeSimple()', () => {
        it('should subscribe to partition 0', async () => {
            const handler = vi.fn();
            await streamrController.subscribeSimple('stream-1', handler);
            expect(mockClient.subscribe).toHaveBeenCalledWith(
                { streamId: 'stream-1', partition: 0 },
                expect.any(Function)
            );
        });
    });

    // ==================== unsubscribe() ====================
    describe('unsubscribe()', () => {
        it('should unsubscribe all partitions and remove from map', async () => {
            const sub0 = { unsubscribe: vi.fn().mockResolvedValue(undefined) };
            const sub1 = { unsubscribe: vi.fn().mockResolvedValue(undefined) };
            streamrController.subscriptions.set('stream-1', { 0: sub0, 1: sub1 });

            await streamrController.unsubscribe('stream-1');

            expect(sub0.unsubscribe).toHaveBeenCalled();
            expect(sub1.unsubscribe).toHaveBeenCalled();
            expect(streamrController.subscriptions.has('stream-1')).toBe(false);
        });

        it('should do nothing for unknown streamId', async () => {
            await streamrController.unsubscribe('unknown-stream');
            // No error thrown
        });
    });

    // ==================== unsubscribeFromPartition() ====================
    describe('unsubscribeFromPartition()', () => {
        it('should unsubscribe single partition', async () => {
            const sub0 = { unsubscribe: vi.fn().mockResolvedValue(undefined) };
            const sub1 = { unsubscribe: vi.fn().mockResolvedValue(undefined) };
            streamrController.subscriptions.set('stream-1', { 0: sub0, 1: sub1 });

            await streamrController.unsubscribeFromPartition('stream-1', 0);

            expect(sub0.unsubscribe).toHaveBeenCalled();
            expect(sub1.unsubscribe).not.toHaveBeenCalled();
            expect(streamrController.subscriptions.get('stream-1')[1]).toBe(sub1);
        });

        it('should clean up map if no partitions remain', async () => {
            const sub0 = { unsubscribe: vi.fn().mockResolvedValue(undefined) };
            streamrController.subscriptions.set('stream-1', { 0: sub0 });

            await streamrController.unsubscribeFromPartition('stream-1', 0);

            expect(streamrController.subscriptions.has('stream-1')).toBe(false);
        });

        it('should do nothing for non-existent partition', async () => {
            await streamrController.unsubscribeFromPartition('stream-1', 5);
            // No error thrown
        });
    });

    // ==================== isSubscribedToPartition() ====================
    describe('isSubscribedToPartition()', () => {
        it('should return true when subscribed', () => {
            streamrController.subscriptions.set('stream-1', { 0: {} });
            expect(streamrController.isSubscribedToPartition('stream-1', 0)).toBe(true);
        });

        it('should return false when not subscribed', () => {
            expect(streamrController.isSubscribedToPartition('stream-1', 0)).toBeFalsy();
        });

        it('should return false for wrong partition', () => {
            streamrController.subscriptions.set('stream-1', { 0: {} });
            expect(streamrController.isSubscribedToPartition('stream-1', 1)).toBeFalsy();
        });
    });

    // ==================== ensureMediaSubscription() ====================
    describe('ensureMediaSubscription()', () => {
        it('should subscribe to both media partitions if not subscribed', async () => {
            const handler = vi.fn();
            await streamrController.ensureMediaSubscription('stream-2', handler);
            expect(mockClient.subscribe).toHaveBeenCalledWith(
                { streamId: 'stream-2', partition: STREAM_CONFIG.EPHEMERAL_STREAM.MEDIA_SIGNALS },
                expect.any(Function)
            );
            expect(mockClient.subscribe).toHaveBeenCalledWith(
                { streamId: 'stream-2', partition: STREAM_CONFIG.EPHEMERAL_STREAM.MEDIA_DATA },
                expect.any(Function)
            );
        });

        it('should skip if already subscribed to both media partitions', async () => {
            streamrController.subscriptions.set('stream-2', {
                [STREAM_CONFIG.EPHEMERAL_STREAM.MEDIA_SIGNALS]: {},
                [STREAM_CONFIG.EPHEMERAL_STREAM.MEDIA_DATA]: {}
            });
            await streamrController.ensureMediaSubscription('stream-2', vi.fn());
            expect(mockClient.subscribe).not.toHaveBeenCalled();
        });
    });

    // ==================== grantPublicPermissions() ====================
    describe('grantPublicPermissions()', () => {
        it('should set public subscribe and publish', async () => {
            await streamrController.grantPublicPermissions('stream-1');
            expect(mockClient.setPermissions).toHaveBeenCalledWith({
                streamId: 'stream-1',
                assignments: [{ public: true, permissions: ['subscribe', 'publish'] }]
            });
        });

        it('should accept stream object with id property', async () => {
            await streamrController.grantPublicPermissions({ id: 'stream-1' });
            expect(mockClient.setPermissions).toHaveBeenCalledWith(
                expect.objectContaining({ streamId: 'stream-1' })
            );
        });
    });

    // ==================== grantPublicReadOnlyPermissions() ====================
    describe('grantPublicReadOnlyPermissions()', () => {
        it('should set public subscribe only', async () => {
            await streamrController.grantPublicReadOnlyPermissions('stream-1');
            expect(mockClient.setPermissions).toHaveBeenCalledWith({
                streamId: 'stream-1',
                assignments: [{ public: true, permissions: ['subscribe'] }]
            });
        });
    });

    // ==================== grantManyToOnePermissions() ====================
    describe('grantManyToOnePermissions()', () => {
        it('should set public publish only', async () => {
            await streamrController.grantManyToOnePermissions('dm-stream');
            expect(mockClient.setPermissions).toHaveBeenCalledWith({
                streamId: 'dm-stream',
                assignments: [{ public: true, permissions: ['publish'] }]
            });
        });
    });

    // ==================== setStreamPermissions() ====================
    describe('setStreamPermissions()', () => {
        it('should throw if client is null', async () => {
            streamrController.client = null;
            await expect(streamrController.setStreamPermissions('s'))
                .rejects.toThrow('Streamr client not initialized');
        });

        it('should set public permissions when public=true', async () => {
            await streamrController.setStreamPermissions('s', { public: true });
            expect(mockClient.setPermissions).toHaveBeenCalledWith({
                streamId: 's',
                assignments: [{ public: true, permissions: ['subscribe', 'publish'] }]
            });
        });

        it('should set member permissions for each address (lowercase)', async () => {
            await streamrController.setStreamPermissions('s', {
                members: ['0xABC', '0xDEF']
            });
            const call = mockClient.setPermissions.mock.calls[0][0];
            expect(call.assignments).toHaveLength(2);
            expect(call.assignments[0].userId).toBe('0xabc');
            expect(call.assignments[1].userId).toBe('0xdef');
        });

        it('should do nothing when no assignments', async () => {
            await streamrController.setStreamPermissions('s', {});
            expect(mockClient.setPermissions).not.toHaveBeenCalled();
        });

        it('should combine public + member permissions', async () => {
            await streamrController.setStreamPermissions('s', {
                public: true,
                members: ['0xABC']
            });
            const call = mockClient.setPermissions.mock.calls[0][0];
            expect(call.assignments).toHaveLength(2);
            expect(call.assignments[0].public).toBe(true);
            expect(call.assignments[1].userId).toBe('0xabc');
        });
    });

    // ==================== grantPermissionsToAddresses() ====================
    // ==================== getStreamPermissions() ====================
    describe('getStreamPermissions()', () => {
        it('should throw if client is null', async () => {
            streamrController.client = null;
            await expect(streamrController.getStreamPermissions('s'))
                .rejects.toThrow('Streamr client not initialized');
        });

        it('should return array result from getPermissions()', async () => {
            mockStream.getPermissions.mockReturnValue([{ userId: '0x1', permissions: ['subscribe'] }]);
            const result = await streamrController.getStreamPermissions('s');
            expect(result).toEqual([{ userId: '0x1', permissions: ['subscribe'] }]);
        });

        it('should handle async iterator from getPermissions()', async () => {
            const perms = [{ userId: '0x1' }, { userId: '0x2' }];
            let idx = 0;
            mockStream.getPermissions.mockReturnValue({
                [Symbol.asyncIterator]() {
                    return {
                        next: async () => {
                            if (idx < perms.length) return { done: false, value: perms[idx++] };
                            return { done: true };
                        }
                    };
                }
            });
            const result = await streamrController.getStreamPermissions('s');
            expect(result).toEqual(perms);
        });

        it('should handle promise result from getPermissions()', async () => {
            const perms = [{ userId: '0x1' }];
            mockStream.getPermissions.mockReturnValue(Promise.resolve(perms));
            const result = await streamrController.getStreamPermissions('s');
            expect(result).toEqual(perms);
        });

        it('should throw on error', async () => {
            mockClient.getStream.mockRejectedValue(new Error('not found'));
            await expect(streamrController.getStreamPermissions('s'))
                .rejects.toThrow('not found');
        });
    });

    // ==================== hasDeletePermission() ====================
    describe('hasDeletePermission()', () => {
        it('should return null (unknown, never cacheable) if client is null', async () => {
            streamrController.client = null;
            expect(await streamrController.hasDeletePermission('s')).toBe(null);
        });

        it('should return true for the namespace owner without any RPC', async () => {
            const { authManager } = await import('../../src/js/auth.js');
            const orig = authManager.getAddress;
            authManager.getAddress = () => '0xOwnerAddr';
            try {
                streamrController.client = null;   // no client needed at all
                expect(await streamrController.hasDeletePermission('0xowneraddr/stream-1')).toBe(true);
            } finally {
                authManager.getAddress = orig;
            }
        });

        it('should return true when has DELETE permission', async () => {
            mockStream.hasPermission.mockResolvedValue(true);
            expect(await streamrController.hasDeletePermission('s')).toBe(true);
        });

        it('should return false when lacks DELETE permission', async () => {
            mockStream.hasPermission.mockResolvedValue(false);
            expect(await streamrController.hasDeletePermission('s')).toBe(false);
        });

        it('should fall back to streamId check when StreamPermission not available', async () => {
            window.StreamPermission = null;
            mockClient.getAddress.mockResolvedValue('0xowner');
            expect(await streamrController.hasDeletePermission('0xowner/stream-1')).toBe(true);
        });

        it('should return null (unknown, never cacheable) on error', async () => {
            mockClient.getStream.mockRejectedValue(new Error('fail'));
            expect(await streamrController.hasDeletePermission('s')).toBe(null);
        });
    });

    // ==================== hasPublishPermission() ====================
    describe('hasPublishPermission()', () => {
        it('should return false result if client is null', async () => {
            streamrController.client = null;
            const result = await streamrController.hasPublishPermission('s');
            expect(result.hasPermission).toBe(false);
        });

        it('should return true when has PUBLISH permission', async () => {
            mockStream.hasPermission.mockResolvedValue(true);
            const result = await streamrController.hasPublishPermission('s');
            expect(createPermissionResult).toHaveBeenCalledWith(true, false);
        });

        it('should return false when lacks PUBLISH permission', async () => {
            mockStream.hasPermission.mockResolvedValue(false);
            await streamrController.hasPublishPermission('s');
            expect(createPermissionResult).toHaveBeenCalledWith(false, false);
        });

        it('should return rpcError result on RPC error', async () => {
            isRpcError.mockReturnValue(true);
            mockStream.hasPermission.mockRejectedValue(new Error('CALL_EXCEPTION'));
            await streamrController.hasPublishPermission('s');
            expect(createPermissionResult).toHaveBeenCalledWith(null, true, 'CALL_EXCEPTION');
        });

        it('should return false when StreamPermission not available', async () => {
            window.StreamPermission = null;
            await streamrController.hasPublishPermission('s');
            expect(createPermissionResult).toHaveBeenCalledWith(false, false);
        });
    });

    // ==================== hasSubscribePermission() ====================
    describe('hasSubscribePermission()', () => {
        it('should return false if client is null', async () => {
            streamrController.client = null;
            expect(await streamrController.hasSubscribePermission('s')).toBe(false);
        });

        it('should return true when has SUBSCRIBE permission', async () => {
            mockStream.hasPermission.mockResolvedValue(true);
            expect(await streamrController.hasSubscribePermission('s')).toBe(true);
        });

        it('should return false on error', async () => {
            mockStream.hasPermission.mockRejectedValue(new Error('fail'));
            expect(await streamrController.hasSubscribePermission('s')).toBe(false);
        });

        it('should return false when StreamPermission not available', async () => {
            window.StreamPermission = null;
            expect(await streamrController.hasSubscribePermission('s')).toBe(false);
        });
    });

    // ==================== checkPermissions() ====================
    describe('checkPermissions()', () => {
        it('should return all false if client is null', async () => {
            streamrController.client = null;
            const result = await streamrController.checkPermissions('s');
            expect(result).toEqual({
                canPublish: false, canSubscribe: false,
                canGrant: false, canEdit: false, canDelete: false, isOwner: false
            });
        });

        it('should return all permission results from hasPermission', async () => {
            mockStream.hasPermission.mockResolvedValue(true);
            const result = await streamrController.checkPermissions('s');
            expect(result.canPublish).toBe(true);
            expect(result.canSubscribe).toBe(true);
            expect(result.canGrant).toBe(true);
            expect(result.canEdit).toBe(true);
            expect(result.canDelete).toBe(true);
            expect(result.isOwner).toBe(true);
        });

        it('should set isOwner true only when canGrant+canEdit+canDelete', async () => {
            let callCount = 0;
            mockStream.hasPermission.mockImplementation(async ({ permission }) => {
                // PUBLISH=true, SUBSCRIBE=true, GRANT=false, EDIT=true, DELETE=true
                callCount++;
                if (permission === 'GRANT') return false;
                return true;
            });
            const result = await streamrController.checkPermissions('s');
            expect(result.isOwner).toBe(false);
        });

        it('should return all false on error', async () => {
            mockClient.getStream.mockRejectedValue(new Error('fail'));
            const result = await streamrController.checkPermissions('s');
            expect(result.isOwner).toBe(false);
            expect(result.canPublish).toBe(false);
        });

        it('should return all false when StreamPermission not available', async () => {
            window.StreamPermission = null;
            const result = await streamrController.checkPermissions('s');
            expect(result.isOwner).toBe(false);
        });
    });

    // ==================== getStreamStorageInfo() ====================
    describe('getStreamStorageInfo()', () => {
        it('should return disabled if client is null', async () => {
            streamrController.client = null;
            const result = await streamrController.getStreamStorageInfo('s');
            expect(result).toEqual({ enabled: false, nodes: [], storageDays: null });
        });

        it('should return enabled with nodes when storage nodes exist', async () => {
            mockStream.getStorageNodes.mockReturnValue(['0xnode1']);
            const result = await streamrController.getStreamStorageInfo('s');
            expect(result.enabled).toBe(true);
            expect(result.nodes).toEqual(['0xnode1']);
            expect(result.storageDays).toBe(180);
        });

        it('should handle async iterable storage nodes', async () => {
            let idx = 0;
            const nodes = ['0xnode1', '0xnode2'];
            mockStream.getStorageNodes.mockReturnValue({
                [Symbol.asyncIterator]() {
                    return {
                        next: async () => {
                            if (idx < nodes.length) return { done: false, value: nodes[idx++] };
                            return { done: true };
                        }
                    };
                }
            });
            const result = await streamrController.getStreamStorageInfo('s');
            expect(result.enabled).toBe(true);
            expect(result.nodes).toEqual(['0xnode1', '0xnode2']);
        });

        it('should handle promise storage nodes', async () => {
            mockStream.getStorageNodes.mockReturnValue(Promise.resolve(['0xnode1']));
            const result = await streamrController.getStreamStorageInfo('s');
            expect(result.enabled).toBe(true);
        });

        it('should return disabled when no nodes', async () => {
            mockStream.getStorageNodes.mockReturnValue([]);
            const result = await streamrController.getStreamStorageInfo('s');
            expect(result.enabled).toBe(false);
            expect(result.storageDays).toBeNull();
        });

        it('should return disabled on error', async () => {
            mockClient.getStream.mockRejectedValue(new Error('fail'));
            const result = await streamrController.getStreamStorageInfo('s');
            expect(result.enabled).toBe(false);
        });
    });

    // ==================== enableStorage() ====================
    describe('enableStorage()', () => {
        beforeEach(() => {
            STREAM_CONFIG.NODE_ADDRESS = '0xstorage';
        });

        it('should throw if client is null', async () => {
            streamrController.client = null;
            await expect(streamrController.enableStorage('stream-1'))
                .rejects.toThrow('Client not initialized');
        });

        it('should reject non-message streams', async () => {
            const result = await streamrController.enableStorage('stream-2');
            expect(result).toEqual({ success: false, provider: null, storageDays: null });
        });

        it('should add to storage node for message stream', async () => {
            await streamrController.enableStorage('stream-1');
            expect(mockStream.addToStorageNode).toHaveBeenCalled();
        });

        it('should set storage days for streamr provider', async () => {
            STREAM_CONFIG.NODE_ADDRESS = '0xstorage';
            await streamrController.enableStorage('stream-1', { storageProvider: 'streamr' });
            expect(mockStream.setStorageDayCount).toHaveBeenCalled();
        });

        it('should return success result', async () => {
            const result = await streamrController.enableStorage('stream-1');
            expect(result.success).toBe(true);
        });

        it('should return failure on error', async () => {
            executeWithRetry.mockRejectedValueOnce(new Error('fail'));
            const result = await streamrController.enableStorage('stream-1');
            expect(result.success).toBe(false);
        });

        // Retention is a second transaction and fails on its own. Reporting
        // back the value that was asked for is what lets the channel record
        // claim a retention the stream never got.
        describe('retention outcome', () => {
            it('reports the retention that landed', async () => {
                const result = await streamrController.enableStorage('stream-1', { storageDays: 30 });
                expect(result.storageDays).toBe(30);
                expect(result.retentionApplied).toBe(true);
            });

            it('reports no retention when setStorageDayCount never succeeds', async () => {
                mockStream.setStorageDayCount.mockRejectedValue(new Error('rpc down'));
                const result = await streamrController.enableStorage('stream-1', { storageDays: 30 });
                expect(result.storageDays).toBeNull();
                expect(result.retentionApplied).toBe(false);
            });

            it('still reports the storage node as enabled when only the retention failed', async () => {
                mockStream.setStorageDayCount.mockRejectedValue(new Error('rpc down'));
                const result = await streamrController.enableStorage('stream-1', { storageDays: 30 });
                expect(result.success).toBe(true);
                expect(mockStream.addToStorageNode).toHaveBeenCalled();
            });

            it('retries the retention independently of the node assignment', async () => {
                await streamrController.enableStorage('stream-1', { storageDays: 30 });
                const named = executeWithRetry.mock.calls.map(([name]) => name);
                expect(named).toContain('enableStorage');
                expect(named).toContain('setStorageDayCount');
            });

            it('reports no retention when the node assignment itself failed', async () => {
                executeWithRetry.mockRejectedValueOnce(new Error('fail'));
                const result = await streamrController.enableStorage('stream-1', { storageDays: 30 });
                expect(result.storageDays).toBeNull();
                expect(result.retentionApplied).toBe(false);
                expect(mockStream.setStorageDayCount).not.toHaveBeenCalled();
            });

            it('ticks progress the same number of times whether the retention lands or not', async () => {
                const onProgress = vi.fn();
                await streamrController.enableStorage('stream-1', { storageDays: 30, onProgress });
                const whenApplied = onProgress.mock.calls.length;

                onProgress.mockClear();
                mockStream.setStorageDayCount.mockRejectedValue(new Error('rpc down'));
                await streamrController.enableStorage('stream-1', { storageDays: 30, onProgress });
                expect(onProgress.mock.calls.length).toBe(whenApplied);
            });
        });
    });

    // ==================== addStorageNodeToStream() ====================
    // Storage on the keys stream is what makes the epoch-key protocol
    // asynchronous, so the settings panel has to be able to grow and shrink
    // its redundancy like any other stored stream.
    describe('addStorageNodeToStream() stream types', () => {
        // A real 40-hex address: unlike enableStorage, this path validates
        // the node address for every provider.
        beforeEach(() => {
            STREAM_CONFIG.NODE_ADDRESS = '0xae340e799e8151f6a4999d245e466197aa217667';
        });

        it('accepts the message stream', async () => {
            const result = await streamrController.addStorageNodeToStream('stream-1');
            expect(result.success).toBe(true);
        });

        it('accepts the admin stream', async () => {
            const result = await streamrController.addStorageNodeToStream('stream-3');
            expect(result.success).toBe(true);
        });

        it('accepts the keys stream', async () => {
            const result = await streamrController.addStorageNodeToStream('stream-4');
            expect(result.success).toBe(true);
            expect(mockStream.addToStorageNode).toHaveBeenCalled();
        });

        it('refuses the ephemeral stream, which must never be stored', async () => {
            const result = await streamrController.addStorageNodeToStream('stream-2');
            expect(result.success).toBe(false);
            expect(result.error).toMatch(/not allowed/i);
        });
    });

    // ==================== setStorageDays() ====================
    describe('setStorageDays()', () => {
        it('should throw if client is null', async () => {
            streamrController.client = null;
            await expect(streamrController.setStorageDays('s', 90)).rejects.toThrow();
        });

        it('should call stream.setStorageDayCount', async () => {
            const result = await streamrController.setStorageDays('s', 90);
            expect(mockStream.setStorageDayCount).toHaveBeenCalledWith(90);
            expect(result).toBe(true);
        });

        it('should return false on error', async () => {
            mockStream.setStorageDayCount.mockRejectedValue(new Error('fail'));
            const result = await streamrController.setStorageDays('s', 90);
            expect(result).toBe(false);
        });
    });

    // ==================== getStorageDays() ====================
    describe('getStorageDays()', () => {
        it('should throw if client is null', async () => {
            streamrController.client = null;
            await expect(streamrController.getStorageDays('s')).rejects.toThrow();
        });

        it('should return storage days', async () => {
            mockStream.getStorageDayCount.mockResolvedValue(180);
            expect(await streamrController.getStorageDays('s')).toBe(180);
        });

        it('should return null on error', async () => {
            mockStream.getStorageDayCount.mockRejectedValue(new Error('fail'));
            expect(await streamrController.getStorageDays('s')).toBeNull();
        });
    });

    // ==================== fetchHistory() ====================
    describe('fetchHistory()', () => {
        it('should throw if client is null', async () => {
            streamrController.client = null;
            await expect(streamrController.fetchHistory('s')).rejects.toThrow();
        });

        it('should return messages from resend iterator', async () => {
            const msgs = [
                createMockMessage({ id: '1', text: 'hello' }),
                createMockMessage({ id: '2', text: 'world' })
            ];
            mockClient.resend.mockResolvedValue(createMockAsyncIterator(msgs));

            const result = await streamrController.fetchHistory('stream-1', 0, 10);
            expect(result).toEqual([
                { id: '1', text: 'hello' },
                { id: '2', text: 'world' }
            ]);
        });

        it('should call resend with last and partition', async () => {
            mockClient.resend.mockResolvedValue(createMockAsyncIterator([]));
            await streamrController.fetchHistory('stream-1', 0, 50);
            expect(mockClient.resend).toHaveBeenCalledWith(
                { streamId: 'stream-1', partition: 0 },
                { last: 50, raw: true }
            );
        });

        it('should skip decrypt errors and continue', async () => {
            let calls = 0;
            const iter = {
                [Symbol.asyncIterator]() {
                    return {
                        next: async () => {
                            calls++;
                            if (calls === 1) throw Object.assign(new Error('key'), { code: 'DECRYPT_ERROR' });
                            // publisherId: raw reads now check who may write on
                            // the stream, and a message without one is nobody's.
                            if (calls === 2) return { done: false, value: { content: { id: '1' }, publisherId: '0xsender' } };
                            return { done: true };
                        }
                    };
                }
            };
            mockClient.resend.mockResolvedValue(iter);
            const result = await streamrController.fetchHistory('stream-1');
            expect(result).toEqual([{ id: '1' }]);
        });

        it('should return empty array on fetch error', async () => {
            mockClient.resend.mockRejectedValue(new Error('network'));
            const result = await streamrController.fetchHistory('stream-1');
            expect(result).toEqual([]);
        });
    });

    // ==================== fetchPartitionHistory() ====================
    describe('fetchPartitionHistory()', () => {
        it('should throw if client is null', async () => {
            streamrController.client = null;
            await expect(streamrController.fetchPartitionHistory('s', 0)).rejects.toThrow();
        });

        it('should return messages with publisherId and timestamp', async () => {
            const msgs = [
                createMockMessage({ id: '1' }, '0xpub1', 1000),
                createMockMessage({ id: '2' }, '0xpub2', 2000)
            ];
            mockClient.resend.mockResolvedValue(createMockAsyncIterator(msgs));

            const result = await streamrController.fetchPartitionHistory('stream-1', 1, 10);
            expect(result).toHaveLength(2);
            expect(result[0]).toEqual({
                content: { id: '1' },
                publisherId: '0xpub1',
                timestamp: 1000
            });
        });

        it('should use streamId+partition object for resend', async () => {
            mockClient.resend.mockResolvedValue(createMockAsyncIterator([]));
            await streamrController.fetchPartitionHistory('stream-1', 1, 5);
            expect(mockClient.resend).toHaveBeenCalledWith(
                { streamId: 'stream-1', partition: 1 },
                { last: 5, raw: true }
            );
        });

        it('should return empty array on error', async () => {
            mockClient.resend.mockRejectedValue(new Error('fail'));
            const result = await streamrController.fetchPartitionHistory('stream-1', 0);
            expect(result).toEqual([]);
        });

        it('should run a confirmation pass on short results and union messages', async () => {
            const msg1 = createMockMessage({ id: '1' }, '0xpub1', 1000);
            const msg2 = createMockMessage({ id: '2' }, '0xpub1', 2000);
            mockClient.resend
                .mockResolvedValueOnce(createMockAsyncIterator([msg1]))        // truncated
                .mockResolvedValueOnce(createMockAsyncIterator([msg1, msg2])); // full

            const result = await streamrController.fetchPartitionHistory('stream-1', 1, 10);

            expect(mockClient.resend).toHaveBeenCalledTimes(2);
            expect(result).toHaveLength(2);
            expect(result.map(m => m.content.id)).toEqual(['1', '2']);
        });

        it('should not run a confirmation pass when the window is full', async () => {
            const msgs = [
                createMockMessage({ id: '1' }, '0xpub1', 1000),
                createMockMessage({ id: '2' }, '0xpub1', 2000)
            ];
            mockClient.resend.mockResolvedValue(createMockAsyncIterator(msgs));

            const result = await streamrController.fetchPartitionHistory('stream-1', 1, 2);

            expect(mockClient.resend).toHaveBeenCalledTimes(1);
            expect(result).toHaveLength(2);
        });

        it('should keep the first pass when the confirmation pass fails', async () => {
            const msg1 = createMockMessage({ id: '1' }, '0xpub1', 1000);
            mockClient.resend
                .mockResolvedValueOnce(createMockAsyncIterator([msg1]))
                .mockRejectedValueOnce(new Error('ws drop'));

            const result = await streamrController.fetchPartitionHistory('stream-1', 1, 10);

            expect(result).toHaveLength(1);
            expect(result[0].content.id).toBe('1');
        });
    });

    // ==================== fetchOlderHistory() ====================
    describe('fetchOlderHistory()', () => {
        it('should throw if client is null', async () => {
            streamrController.client = null;
            await expect(streamrController.fetchOlderHistory('s', 0, Date.now()))
                .rejects.toThrow();
        });

        it('should fetch messages before given timestamp', async () => {
            const msgs = [
                createMockMessage({ id: '1', text: 'a', sender: '0x1', timestamp: 100, type: 'text' }),
                createMockMessage({ id: '2', text: 'b', sender: '0x1', timestamp: 200, type: 'text' })
            ];
            mockClient.resend.mockResolvedValue(createMockAsyncIterator(msgs));

            const result = await streamrController.fetchOlderHistory('stream-1', 0, 500, 10);
            expect(result.messages).toHaveLength(2);
        });

        it('should call resend with from/to timestamps', async () => {
            mockClient.resend.mockResolvedValue(createMockAsyncIterator([]));
            await streamrController.fetchOlderHistory('stream-1', 0, 5000, 10);
            expect(mockClient.resend).toHaveBeenCalledWith({
                streamId: 'stream-1',
                partition: 0
            }, {
                from: { timestamp: 0 },
                to: { timestamp: 5000 },
                raw: true
            });
        });

        it('should return hasMore=true when more messages than count', async () => {
            const msgs = [];
            for (let i = 0; i < 5; i++) {
                msgs.push(createMockMessage({ id: `${i}`, text: 'x', sender: '0x1', timestamp: i * 100, type: 'text' }));
            }
            mockClient.resend.mockResolvedValue(createMockAsyncIterator(msgs));
            const result = await streamrController.fetchOlderHistory('stream-1', 0, 9999, 3);
            expect(result.hasMore).toBe(true);
            expect(result.messages).toHaveLength(3);
        });

        it('should skip ephemeral messages (presence, typing)', async () => {
            const msgs = [
                createMockMessage({ type: 'presence', userId: '0x1' }),
                createMockMessage({ id: '1', text: 'real', sender: '0x1', timestamp: 100, type: 'text' })
            ];
            mockClient.resend.mockResolvedValue(createMockAsyncIterator(msgs));
            const result = await streamrController.fetchOlderHistory('stream-1', 0, 9999, 10);
            expect(result.messages).toHaveLength(1);
            expect(result.messages[0].type).toBe('text');
        });

        it('should abort when signal is aborted', async () => {
            const controller = new AbortController();
            controller.abort();
            // Even with messages, should return empty when already aborted
            const msgs = [createMockMessage({ id: '1', text: 'x', sender: '0x1', timestamp: 100, type: 'text' })];
            mockClient.resend.mockResolvedValue(createMockAsyncIterator(msgs));
            const result = await streamrController.fetchOlderHistory('stream-1', 0, 9999, 10, null, controller.signal);
            expect(result.messages).toHaveLength(0);
        });

        it('should decrypt with password', async () => {
            const encryptedMsg = createMockMessage(JSON.stringify({ id: '1', text: 'hi', sender: '0x1', timestamp: 100, type: 'text' }));
            mockClient.resend.mockResolvedValue(createMockAsyncIterator([encryptedMsg]));
            const result = await streamrController.fetchOlderHistory('stream-1', 0, 9999, 10, 'pass');
            expect(cryptoManager.decryptJSON).toHaveBeenCalled();
        });

        it('should return empty on fetch error', async () => {
            mockClient.resend.mockRejectedValue(new Error('fail'));
            const result = await streamrController.fetchOlderHistory('stream-1', 0, 1000);
            expect(result).toEqual({ messages: [], hasMore: false });
        });

        it('should confirm exhaustion with a second pass and merge truncated results', async () => {
            // First pass: silently truncated (storage WS drop) — only 1 message
            const truncated = [
                createMockMessage({ id: '1', text: 'a', sender: '0x1', timestamp: 100, type: 'text' })
            ];
            // Confirmation pass on a fresh connection: full range — 3 messages
            const full = [
                createMockMessage({ id: '1', text: 'a', sender: '0x1', timestamp: 100, type: 'text' }),
                createMockMessage({ id: '2', text: 'b', sender: '0x1', timestamp: 200, type: 'text' }),
                createMockMessage({ id: '3', text: 'c', sender: '0x1', timestamp: 300, type: 'text' })
            ];
            mockClient.resend
                .mockResolvedValueOnce(createMockAsyncIterator(truncated))
                .mockResolvedValueOnce(createMockAsyncIterator(full));

            const result = await streamrController.fetchOlderHistory('stream-1', 0, 9999, 10);

            // Both passes ran (exhaustion was claimed by the first)
            expect(mockClient.resend).toHaveBeenCalledTimes(2);
            // Union of both passes, deduped by id
            expect(result.messages).toHaveLength(3);
            expect(result.messages.map(m => m.id)).toEqual(['1', '2', '3']);
        });

        it('should not run a confirmation pass when hasMore is already true', async () => {
            const msgs = [];
            for (let i = 0; i < 5; i++) {
                msgs.push(createMockMessage({ id: `${i}`, text: 'x', sender: '0x1', timestamp: i * 100, type: 'text' }));
            }
            mockClient.resend.mockResolvedValue(createMockAsyncIterator(msgs));

            const result = await streamrController.fetchOlderHistory('stream-1', 0, 9999, 3);

            expect(result.hasMore).toBe(true);
            expect(mockClient.resend).toHaveBeenCalledTimes(1);
        });
    });

    // ==================== subscribeWithHistory() ====================
    describe('subscribeWithHistory()', () => {
        it('should throw if client is null', async () => {
            streamrController.client = null;
            await expect(streamrController.subscribeWithHistory('s', 0, vi.fn()))
                .rejects.toThrow();
        });

        it('should subscribe to streamId and partition', async () => {
            const handler = vi.fn();
            await streamrController.subscribeWithHistory('stream-1', 0, handler, 10);
            expect(mockClient.subscribe).toHaveBeenCalledWith(
                { streamId: 'stream-1', partition: 0 },
                expect.any(Function),
                expect.any(Function)
            );
        });

        it('should fetch history when historyCount > 0', async () => {
            mockClient.resend.mockResolvedValue(createMockAsyncIterator([]));
            const handler = vi.fn();
            await streamrController.subscribeWithHistory('stream-1', 0, handler, 10);
            // fetchHistoryAsync is fire-and-forget and resolves the gated
            // lookup before the resend — wait for the call instead of
            // asserting synchronously
            await vi.waitFor(() => expect(mockClient.resend).toHaveBeenCalled());
        });

        it('should not fetch history when historyCount is 0', async () => {
            const handler = vi.fn();
            await streamrController.subscribeWithHistory('stream-1', 0, handler, 0);
            expect(mockClient.resend).not.toHaveBeenCalled();
        });

        it('should decrypt messages when password provided', async () => {
            let capturedHandler;
            mockClient.subscribe.mockImplementation(async (opts, handler) => {
                capturedHandler = handler;
                return { unsubscribe: vi.fn() };
            });
            mockClient.resend.mockResolvedValue(createMockAsyncIterator([]));

            await streamrController.subscribeWithHistory('stream-1', 0, vi.fn(), 0, 'pass');
            
            // Simulate encrypted message through handler
            await capturedHandler('encrypted-data', { getPublisherId: () => '0x1' });
            expect(cryptoManager.decryptJSON).toHaveBeenCalledWith('encrypted-data', 'pass');
        });

        it('should return subscription object', async () => {
            const mockSub = { unsubscribe: vi.fn() };
            mockClient.subscribe.mockResolvedValue(mockSub);
            mockClient.resend.mockResolvedValue(createMockAsyncIterator([]));
            const result = await streamrController.subscribeWithHistory('stream-1', 0, vi.fn(), 10);
            expect(result).toBe(mockSub);
        });
    });

    // ==================== fetchHistoryAsync() ====================
    describe('fetchHistoryAsync()', () => {
        it('should pass messages to handler', async () => {
            const handler = vi.fn();
            const msgs = [
                createMockMessage({ id: '1', text: 'hi', sender: '0x1', timestamp: 100, type: 'text' })
            ];
            mockClient.resend.mockResolvedValue(createMockAsyncIterator(msgs));

            await streamrController.fetchHistoryAsync('stream-1', 0, 10, handler);
            expect(handler).toHaveBeenCalledWith(expect.objectContaining({ id: '1', text: 'hi' }));
        });

        it('should skip ephemeral types (presence, typing)', async () => {
            const handler = vi.fn();
            const msgs = [
                createMockMessage({ type: 'presence', userId: '0x1' }),
                createMockMessage({ type: 'typing', userId: '0x1' }),
                createMockMessage({ id: '1', text: 'ok', sender: '0x1', timestamp: 100, type: 'text' })
            ];
            mockClient.resend.mockResolvedValue(createMockAsyncIterator(msgs));

            await streamrController.fetchHistoryAsync('stream-1', 0, 10, handler);
            expect(handler).toHaveBeenCalledTimes(1);
        });

        it('should inject account from getPublisherId()', async () => {
            const handler = vi.fn();
            const msgs = [
                createMockMessage({ id: '1', text: 'hi', sender: '0x1', timestamp: 100, type: 'text' }, '0xpub1')
            ];
            mockClient.resend.mockResolvedValue(createMockAsyncIterator(msgs));

            await streamrController.fetchHistoryAsync('stream-1', 0, 10, handler);
            expect(handler).toHaveBeenCalledWith(expect.objectContaining({ account: '0xpub1' }));
        });

        it('should not throw on network error', async () => {
            const handler = vi.fn();
            mockClient.resend.mockRejectedValue(new Error('CORS'));
            await expect(streamrController.fetchHistoryAsync('stream-1', 0, 10, handler))
                .resolves.toBeUndefined();
        });

        it('should decrypt with password', async () => {
            const handler = vi.fn();
            const msgs = [
                createMockMessage(JSON.stringify({ id: '1', text: 'hi', sender: '0x1', timestamp: 100, type: 'text' }))
            ];
            mockClient.resend.mockResolvedValue(createMockAsyncIterator(msgs));
            await streamrController.fetchHistoryAsync('stream-1', 0, 10, handler, 'pass');
            expect(cryptoManager.decryptJSON).toHaveBeenCalled();
        });

        it('should accept valid message types on partition 0', async () => {
            const handler = vi.fn();
            const msgs = [
                createMockMessage({ id: '1', text: 'hi', sender: '0x1', timestamp: 100, type: 'text' }),
                createMockMessage({ type: 'reaction', messageId: 'm1', emoji: '👍' }),
                createMockMessage({ type: 'image', imageId: 'img1' }),
                createMockMessage({ type: 'file_announce', metadata: {} })
            ];
            mockClient.resend.mockResolvedValue(createMockAsyncIterator(msgs));
            await streamrController.fetchHistoryAsync('stream-1', 0, 10, handler);
            expect(handler).toHaveBeenCalledTimes(4);
        });

        it('should accept encrypted envelope messages', async () => {
            const handler = vi.fn();
            const msgs = [
                createMockMessage({ ct: 'base64data', iv: 'base64iv', e: 'aes-256-gcm' })
            ];
            mockClient.resend.mockResolvedValue(createMockAsyncIterator(msgs));
            await streamrController.fetchHistoryAsync('stream-1', 0, 10, handler);
            expect(handler).toHaveBeenCalledTimes(1);
        });

        it('should skip invalid message types on partition 0', async () => {
            const handler = vi.fn();
            const msgs = [
                createMockMessage({ type: 'unknown_type', data: {} }),
                createMockMessage({ random: 'data' })
            ];
            mockClient.resend.mockResolvedValue(createMockAsyncIterator(msgs));
            await streamrController.fetchHistoryAsync('stream-1', 0, 10, handler);
            expect(handler).not.toHaveBeenCalled();
        });

        it('should continue on decrypt error in iterator', async () => {
            const handler = vi.fn();
            let calls = 0;
            const iter = {
                [Symbol.asyncIterator]() {
                    return {
                        next: async () => {
                            calls++;
                            if (calls === 1) throw Object.assign(new Error('key'), { code: 'DECRYPT_ERROR' });
                            if (calls === 2) return { done: false, value: createMockMessage({ id: '1', text: 'hi', sender: '0x1', timestamp: 100, type: 'text' }) };
                            return { done: true };
                        }
                    };
                }
            };
            mockClient.resend.mockResolvedValue(iter);
            await streamrController.fetchHistoryAsync('stream-1', 0, 10, handler);
            expect(handler).toHaveBeenCalledTimes(1);
        });
    });

    // ==================== subscribeToDualStream() ====================
    describe('subscribeToDualStream()', () => {
        it('should throw if client is null', async () => {
            streamrController.client = null;
            await expect(streamrController.subscribeToDualStream('m-1', 'e-2', {}))
                .rejects.toThrow();
        });

        it('should subscribe to message stream with history', async () => {
            mockClient.resend.mockResolvedValue(createMockAsyncIterator([]));
            const handlers = { onMessage: vi.fn(), onControl: vi.fn() };
            await streamrController.subscribeToDualStream('stream-1', 'stream-2', handlers, null, 10);

            // Should have subscriptions for both streams
            expect(streamrController.subscriptions.has('stream-1')).toBe(true);
            expect(streamrController.subscriptions.has('stream-2')).toBe(true);
        });

        it('should store media handler for lazy P1/P2 subscription', async () => {
            mockClient.resend.mockResolvedValue(createMockAsyncIterator([]));
            const handlers = { onMessage: vi.fn(), onControl: vi.fn(), onMedia: vi.fn() };
            await streamrController.subscribeToDualStream('stream-1', 'stream-2', handlers);

            // subscribe called for message(p0), control(p0) only — P1/P2 are lazy
            expect(mockClient.subscribe).toHaveBeenCalledTimes(2);
            // Media handler stored for later ensureMediaSubscription()
            expect(streamrController.mediaHandlers.has('stream-2')).toBe(true);
            expect(streamrController.mediaHandlers.get('stream-2').handler).toBe(handlers.onMedia);
        });

        it('should skip already subscribed streams', async () => {
            streamrController.subscriptions.set('stream-1', { 0: {} });
            streamrController.subscriptions.set('stream-2', { 0: {} });
            mockClient.resend.mockResolvedValue(createMockAsyncIterator([]));

            const handlers = { onMessage: vi.fn(), onControl: vi.fn() };
            await streamrController.subscribeToDualStream('stream-1', 'stream-2', handlers);

            expect(mockClient.subscribe).not.toHaveBeenCalled();
        });

        it('should return true on success', async () => {
            mockClient.resend.mockResolvedValue(createMockAsyncIterator([]));
            const result = await streamrController.subscribeToDualStream(
                'stream-1', 'stream-2', { onMessage: vi.fn() }
            );
            expect(result).toBe(true);
        });

        it('should handle onMessage only (no onControl/onMedia)', async () => {
            mockClient.resend.mockResolvedValue(createMockAsyncIterator([]));
            const handlers = { onMessage: vi.fn() };
            await streamrController.subscribeToDualStream('stream-1', 'stream-2', handlers);

            // Only 1 subscribe call (message partition)
            expect(mockClient.subscribe).toHaveBeenCalledTimes(1);
        });
    });

    // ==================== unsubscribeFromDualStream() ====================
    describe('unsubscribeFromDualStream()', () => {
        it('should unsubscribe from both streams', async () => {
            const msgSub = { unsubscribe: vi.fn().mockResolvedValue(undefined) };
            const ephSub = { unsubscribe: vi.fn().mockResolvedValue(undefined) };
            streamrController.subscriptions.set('stream-1', { 0: msgSub });
            streamrController.subscriptions.set('stream-2', { 0: ephSub });

            await streamrController.unsubscribeFromDualStream('stream-1', 'stream-2');

            expect(msgSub.unsubscribe).toHaveBeenCalled();
            expect(ephSub.unsubscribe).toHaveBeenCalled();
        });
    });

    // ==================== deleteStream() ====================
    describe('deleteStream()', () => {
        it('should throw if client is null', async () => {
            streamrController.client = null;
            await expect(streamrController.deleteStream('stream-1'))
                .rejects.toThrow('Streamr client not initialized');
        });

        it('should throw for invalid stream ID format', async () => {
            await expect(streamrController.deleteStream('invalid-stream'))
                .rejects.toThrow('Invalid stream ID format');
        });

        it('should delete both message and ephemeral streams', async () => {
            await streamrController.deleteStream('owner/stream-1');
            // executeWithRetry is called for delete operations
            expect(executeWithRetry).toHaveBeenCalled();
        });

        it('should derive ephemeral from message stream ID', async () => {
            await streamrController.deleteStream('owner/stream-1');
            // Should delete both -1 and -2
            const retryCallNames = executeWithRetry.mock.calls.map(c => c[0]);
            expect(retryCallNames.some(name => name.includes('message'))).toBe(true);
        });

        it('should derive message from ephemeral stream ID', async () => {
            await streamrController.deleteStream('owner/stream-2');
            const retryCallNames = executeWithRetry.mock.calls.map(c => c[0]);
            expect(retryCallNames.some(name => name.includes('message'))).toBe(true);
        });

        it('deletes every stream of the channel (-1, -2, -3, -4, -5)', async () => {
            // -4 and -5 exist only on gated channels, but deletion is
            // unconditional: the idempotent "already gone" path absorbs the
            // other types, and skipping one is what orphans it — with its
            // paid storage — after the channel is gone.
            await streamrController.deleteStream('owner/stream-1');
            const deletedIds = mockClient.deleteStream.mock.calls.map(c => c[0]);
            expect(deletedIds).toEqual(expect.arrayContaining([
                'owner/stream-1', 'owner/stream-2', 'owner/stream-3',
                'owner/stream-4', 'owner/stream-5'
            ]));
            expect(mockClient.deleteStream).toHaveBeenCalledTimes(5);
        });

        it('should treat streamDoesNotExist as idempotent success (no throw)', async () => {
            // All three deletes report the stream is already gone
            mockClient.deleteStream.mockRejectedValue(
                Object.assign(new Error('error_streamDoesNotExist'), { reason: 'error_streamDoesNotExist' })
            );
            // Already gone counts as deleted: nothing is left standing.
            await expect(streamrController.deleteStream('owner/stream-1')).resolves.toEqual([]);
        });

        it('should not throw when admin stream (-3) does not exist (legacy channels)', async () => {
            // Only -3 fails with streamDoesNotExist; -1 and -2 succeed
            mockClient.deleteStream.mockImplementation(async (sid) => {
                if (sid.endsWith('-3')) {
                    const err = new Error('error_streamDoesNotExist');
                    err.reason = 'error_streamDoesNotExist';
                    throw err;
                }
                return undefined;
            });
            await expect(streamrController.deleteStream('owner/stream-1')).resolves.toEqual([]);
        });

        /**
         * A stream the network refused is reported back, not swallowed: it is
         * what keeps the channel on the device as the handle for a retry.
         */
        it('reports the streams that could not be deleted', async () => {
            mockClient.deleteStream.mockImplementation(async (sid) => {
                if (sid.endsWith('-3')) throw new Error('RPC down');
                return undefined;
            });
            await expect(streamrController.deleteStream('owner/stream-1'))
                .resolves.toEqual(['owner/stream-3']);
        });
    });

    // ==================== createStream() ====================
    describe('createStream()', () => {
        it('should throw if client is null', async () => {
            streamrController.client = null;
            await expect(streamrController.createStream('test', '0xowner'))
                .rejects.toThrow('Streamr client not initialized');
        });

        it('should create dual streams and return both IDs', async () => {
            const mockMsg = { id: '0xmyaddress/abcd1234-1' };
            const mockEph = { id: '0xmyaddress/abcd1234-2' };
            let callCount = 0;
            executeWithRetryAndVerify.mockImplementation(async (name, fn) => {
                callCount++;
                if (callCount === 1) return mockMsg;
                return mockEph;
            });

            const result = await streamrController.createStream('Test Channel', '0xowner');
            expect(result.messageStreamId).toBe('0xmyaddress/abcd1234-1');
            expect(result.ephemeralStreamId).toBe('0xmyaddress/abcd1234-2');
            expect(result.type).toBe('public');
            expect(result.name).toBe('Test Channel');
        });

        it('should set public permissions for public channels', async () => {
            const mockMsg = { id: '0xmyaddress/abcd1234-1' };
            const mockEph = { id: '0xmyaddress/abcd1234-2' };
            let callCount = 0;
            executeWithRetryAndVerify.mockImplementation(async (name, fn) => {
                callCount++;
                if (callCount === 1) return mockMsg;
                return mockEph;
            });

            await streamrController.createStream('Test', '0xowner', 'public');
            // setPermissions called for both streams (public permissions)
            expect(mockClient.setPermissions).toHaveBeenCalled();
        });

        it('should use read-only permissions for readOnly channels', async () => {
            const mockMsg = { id: '0xmyaddress/abcd1234-1' };
            const mockEph = { id: '0xmyaddress/abcd1234-2' };
            let callCount = 0;
            executeWithRetryAndVerify.mockImplementation(async (name, fn) => {
                callCount++;
                if (callCount === 1) return mockMsg;
                return mockEph;
            });

            await streamrController.createStream('ReadOnly', '0xowner', 'public', { readOnly: true });
            // First perm call is read-only (subscribe only)
            const firstPermCall = mockClient.setPermissions.mock.calls[0][0];
            expect(firstPermCall.assignments[0].permissions).toEqual(['subscribe']);
        });
    });

    // ==================== createDMInbox() ====================
    describe('createDMInbox()', () => {
        it('should throw if client is null', async () => {
            streamrController.client = null;
            await expect(streamrController.createDMInbox('pk123'))
                .rejects.toThrow('Streamr client not initialized');
        });

        it('should create or get both DM streams', async () => {
            // First getStream call throws (stream doesn't exist), then createStream succeeds
            mockClient.getStream.mockRejectedValue(new Error('not found'));
            
            let createCount = 0;
            executeWithRetryAndVerify.mockImplementation(async (name, fn) => {
                createCount++;
                return { id: createCount === 1 ? '0xmyaddress/Pombo-DM-1' : '0xmyaddress/Pombo-DM-2' };
            });

            const result = await streamrController.createDMInbox('pk123');
            expect(result.messageStreamId).toContain('Pombo-DM-1');
            expect(result.ephemeralStreamId).toContain('Pombo-DM-2');
        });

        it('should set many-to-one permissions', async () => {
            mockClient.getStream.mockRejectedValue(new Error('not found'));
            let count = 0;
            executeWithRetryAndVerify.mockImplementation(async () => {
                count++;
                return { id: count === 1 ? '0xmyaddress/Pombo-DM-1' : '0xmyaddress/Pombo-DM-2' };
            });

            await streamrController.createDMInbox('pk123');
            // grantManyToOnePermissions called → setPermissions with publish only
            const permCalls = mockClient.setPermissions.mock.calls;
            expect(permCalls.length).toBeGreaterThanOrEqual(2);
            expect(permCalls[0][0].assignments[0].permissions).toEqual(['publish']);
        });

        it('should reuse existing streams (idempotent)', async () => {
            // getStream succeeds - streams already exist
            mockClient.getStream.mockResolvedValue(mockStream);
            mockStream.getDescription.mockResolvedValue(JSON.stringify({ pk: 'existing-pk' }));

            const result = await streamrController.createDMInbox('pk123');
            expect(result.messageStreamId).toBeDefined();
            // Should NOT have called executeWithRetryAndVerify (no creation needed)
            expect(executeWithRetryAndVerify).not.toHaveBeenCalled();
        });
    });

});
