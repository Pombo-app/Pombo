/**
 * Streamr Controller - disconnect() and reconnect() Tests
 * Tests that disconnect gracefully handles errors in unsubscribe and client.destroy
 * Tests that reconnect properly gets signer from authManager
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Mock authManager before importing streamrController
vi.mock('../../src/js/auth.js', () => ({
    authManager: {
        getSigner: vi.fn()
    }
}));

// We test the disconnect logic in isolation by importing the module
// and directly manipulating the singleton's internal state.
import { streamrController } from '../../src/js/streamr.js';
import { authManager } from '../../src/js/auth.js';

describe('streamrController.disconnect()', () => {
    let mockClient;

    beforeEach(() => {
        // Create a mock Streamr client
        mockClient = {
            destroy: vi.fn().mockResolvedValue(undefined),
            unsubscribe: vi.fn().mockResolvedValue(undefined),
        };

        // Inject mock client into streamrController
        streamrController.client = mockClient;
        streamrController.address = '0xtest123';
        streamrController.subscriptions = new Map();
    });

    it('should clear client and address after disconnect', async () => {
        await streamrController.disconnect();

        expect(streamrController.client).toBeNull();
        expect(streamrController.address).toBeNull();
    });

    it('should call client.destroy()', async () => {
        await streamrController.disconnect();

        expect(mockClient.destroy).toHaveBeenCalledTimes(1);
    });

    it('should do nothing if client is null', async () => {
        streamrController.client = null;

        await streamrController.disconnect();

        expect(streamrController.address).toBeNull();
    });

    it('should survive client.destroy() throwing an error', async () => {
        mockClient.destroy.mockRejectedValue(new Error('Cannot read properties of undefined'));

        await streamrController.disconnect();

        // Should still clean up
        expect(streamrController.client).toBeNull();
        expect(streamrController.address).toBeNull();
    });

    it('should survive unsubscribe throwing an error', async () => {
        // Add a subscription that will fail to unsubscribe
        streamrController.subscriptions.set('stream-1', { unsubscribe: vi.fn() });

        // Mock the unsubscribe method on the controller to throw
        const originalUnsubscribe = streamrController.unsubscribe.bind(streamrController);
        streamrController.unsubscribe = vi.fn().mockRejectedValue(new Error('Already unsubscribed'));

        await streamrController.disconnect();

        // Should still clean up and call destroy
        expect(mockClient.destroy).toHaveBeenCalled();
        expect(streamrController.client).toBeNull();

        // Restore
        streamrController.unsubscribe = originalUnsubscribe;
    });

    it('should attempt to unsubscribe all streams before destroying', async () => {
        streamrController.subscriptions.set('stream-a', { sub: true });
        streamrController.subscriptions.set('stream-b', { sub: true });

        // Mock unsubscribe on the controller
        const originalUnsubscribe = streamrController.unsubscribe.bind(streamrController);
        streamrController.unsubscribe = vi.fn().mockResolvedValue(undefined);

        await streamrController.disconnect();

        expect(streamrController.unsubscribe).toHaveBeenCalledTimes(2);
        expect(streamrController.unsubscribe).toHaveBeenCalledWith('stream-a');
        expect(streamrController.unsubscribe).toHaveBeenCalledWith('stream-b');

        // Restore
        streamrController.unsubscribe = originalUnsubscribe;
    });

    it('should continue unsubscribing even if one fails', async () => {
        streamrController.subscriptions.set('stream-ok', { sub: true });
        streamrController.subscriptions.set('stream-fail', { sub: true });
        streamrController.subscriptions.set('stream-ok2', { sub: true });

        const originalUnsubscribe = streamrController.unsubscribe.bind(streamrController);
        let callCount = 0;
        streamrController.unsubscribe = vi.fn().mockImplementation(async (streamId) => {
            callCount++;
            if (streamId === 'stream-fail') {
                throw new Error('Network error');
            }
        });

        await streamrController.disconnect();

        // All 3 should have been attempted
        expect(streamrController.unsubscribe).toHaveBeenCalledTimes(3);
        // Client should still be destroyed
        expect(mockClient.destroy).toHaveBeenCalled();
        expect(streamrController.client).toBeNull();

        // Restore
        streamrController.unsubscribe = originalUnsubscribe;
    });
});

describe('streamrController.reconnect()', () => {
    let mockClient;
    let mockSigner;

    beforeEach(() => {
        // Create a mock Streamr client
        mockClient = {
            destroy: vi.fn().mockResolvedValue(undefined),
            unsubscribe: vi.fn().mockResolvedValue(undefined),
            getAddress: vi.fn().mockResolvedValue('0xtest123'),
        };

        // Create a mock signer
        mockSigner = {
            privateKey: '0x1234567890abcdef'
        };

        // Inject mocks
        streamrController.client = mockClient;
        streamrController.address = '0xtest123';
        streamrController.subscriptions = new Map();
        
        // Default: authManager returns a signer
        authManager.getSigner.mockReturnValue(mockSigner);
    });

    afterEach(() => {
        streamrController.client = null;
        streamrController.address = null;
        streamrController._clientReplacedHandlers = [];
        vi.useRealTimers();
        vi.clearAllMocks();
    });

    it('should return false if authManager has no signer', async () => {
        authManager.getSigner.mockReturnValue(null);

        const result = await streamrController.reconnect();

        expect(result).toBe(false);
    });

    it('should get signer from authManager', async () => {
        const originalInit = streamrController.init.bind(streamrController);
        streamrController.init = vi.fn().mockResolvedValue(true);
        
        await streamrController.reconnect();

        expect(authManager.getSigner).toHaveBeenCalled();
        
        streamrController.init = originalInit;
    });

    it('destroys the old client before making the new one, and drops its subscriptions', async () => {
        const originalInit = streamrController.init.bind(streamrController);
        const order = [];
        mockClient.destroy.mockImplementation(async () => { order.push('destroy'); });
        streamrController.init = vi.fn().mockImplementation(async () => { order.push('init'); return true; });
        streamrController.subscriptions.set('stream-a', { 0: { unsubscribe: vi.fn() } });

        await streamrController.reconnect();

        expect(order).toEqual(['destroy', 'init']);
        expect(streamrController.init).toHaveBeenCalledWith(mockSigner, { resubscribe: true });
        expect(streamrController.subscriptions.size).toBe(0);

        streamrController.init = originalInit;
    });

    it('stays in the session: no logout, so the pseudonyms are kept', async () => {
        const originalInit = streamrController.init.bind(streamrController);
        streamrController.init = vi.fn().mockResolvedValue(true);
        const disconnectSpy = vi.spyOn(streamrController, 'disconnect');

        await streamrController.reconnect();

        expect(disconnectSpy).not.toHaveBeenCalled();

        streamrController.init = originalInit;
        disconnectSpy.mockRestore();
    });

    // Stands in for init: installs a client whose node start is `start` and watches it.
    const initWithNode = (start) => vi.fn().mockImplementation(async (_signer, options) => {
        const client = { getNodeId: vi.fn(start), destroy: vi.fn().mockResolvedValue(undefined) };
        streamrController.client = client;
        streamrController._watchNode(client, options?.resubscribe);
        return true;
    });

    const quietRevival = () => [
        vi.spyOn(streamrController.revival, 'onAlive').mockImplementation(() => {}),
        vi.spyOn(streamrController.revival, 'onDead').mockImplementation(() => {})
    ];

    it('asks every handler to subscribe again once the new node is up, even after one fails', async () => {
        const originalInit = streamrController.init.bind(streamrController);
        const spies = quietRevival();
        streamrController.init = initWithNode(() => Promise.resolve('node-id'));
        const later = vi.fn();
        streamrController.onClientReplaced(async () => { throw new Error('inbox'); });
        streamrController.onClientReplaced(later);

        const result = await streamrController.reconnect();

        expect(result).toBe(true);
        await vi.waitFor(() => expect(later).toHaveBeenCalledTimes(1));

        streamrController.init = originalInit;
        spies.forEach((spy) => spy.mockRestore());
    });

    it('leaves the subscribing to the next rebuild when the new node fails to start', async () => {
        const originalInit = streamrController.init.bind(streamrController);
        const spies = quietRevival();
        streamrController.init = initWithNode(() => Promise.reject(new Error('Failed to connect to the entrypoints after 7 attempts')));
        const handler = vi.fn();
        streamrController.onClientReplaced(handler);

        await streamrController.reconnect();
        await new Promise((resolve) => setTimeout(resolve, 0));

        expect(handler).not.toHaveBeenCalled();

        streamrController.init = originalInit;
        spies.forEach((spy) => spy.mockRestore());
    });

    it('a node start that never settles does not hold the next replacement back', async () => {
        const originalInit = streamrController.init.bind(streamrController);
        const spies = quietRevival();
        streamrController.init = initWithNode(() => new Promise(() => {}));

        expect(await streamrController.reconnect()).toBe(true);
        expect(await streamrController.reconnect()).toBe(true);

        expect(streamrController.init).toHaveBeenCalledTimes(2);

        streamrController.init = originalInit;
        spies.forEach((spy) => spy.mockRestore());
    });

    it('gives up when the account changes while the old client stops', async () => {
        const originalInit = streamrController.init.bind(streamrController);
        streamrController.init = vi.fn().mockResolvedValue(true);
        const handler = vi.fn();
        streamrController.onClientReplaced(handler);
        let stopped;
        mockClient.destroy.mockReturnValue(new Promise((resolve) => { stopped = resolve; }));

        const done = streamrController.reconnect();
        await vi.waitFor(() => expect(mockClient.destroy).toHaveBeenCalled());
        await streamrController.disconnect();
        stopped();
        await done;

        expect(streamrController.init).not.toHaveBeenCalled();
        expect(handler).not.toHaveBeenCalled();

        streamrController.init = originalInit;
    });

    it('does not wait on an old client that never finishes stopping', async () => {
        vi.useFakeTimers();
        const originalInit = streamrController.init.bind(streamrController);
        streamrController.init = vi.fn().mockResolvedValue(true);
        mockClient.destroy.mockReturnValue(new Promise(() => {}));

        const done = streamrController.reconnect();
        await vi.advanceTimersByTimeAsync(5000);

        expect(await done).toBe(true);
        expect(streamrController.init).toHaveBeenCalledTimes(1);

        streamrController.init = originalInit;
    });

    it('should return true on successful reconnect', async () => {
        const originalInit = streamrController.init.bind(streamrController);
        streamrController.init = vi.fn().mockResolvedValue(true);

        const result = await streamrController.reconnect();

        expect(result).toBe(true);

        // Restore
        streamrController.init = originalInit;
    });

    it('should return false if init fails', async () => {
        const originalInit = streamrController.init.bind(streamrController);
        streamrController.init = vi.fn().mockRejectedValue(new Error('Init failed'));

        const result = await streamrController.reconnect();

        expect(result).toBe(false);

        // Restore
        streamrController.init = originalInit;
    });
});
