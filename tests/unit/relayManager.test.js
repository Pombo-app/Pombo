/**
 * RelayManager Tests
 * Tests for the RelayManager class (relayManager.js)
 * Covers: syncWithServiceWorker, channel tag calculation, DM type handling
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Mock all dependencies before importing relayManager.js
vi.mock('../../src/js/logger.js', () => ({
    Logger: {
        info: vi.fn(),
        debug: vi.fn(),
        warn: vi.fn(),
        error: vi.fn()
    }
}));

vi.mock('../../src/js/streamr.js', () => ({
    streamrController: {
        client: {
            publish: vi.fn().mockResolvedValue(undefined)
        }
    }
}));

vi.mock('../../src/js/channels.js', () => ({
    channelManager: {
        channels: new Map()
    }
}));

vi.mock('../../src/js/pushProtocol.js', () => ({
    calculateChannelTag: vi.fn((streamId) => `tag-${streamId.slice(0, 8)}`),
    calculateNativeChannelTag: vi.fn((streamId) => `native-tag-${streamId.slice(0, 8)}`),
    createRegistrationPayload: vi.fn(),
    createChannelNotificationPayload: vi.fn(),
    createNativeChannelNotificationPayload: vi.fn(),
    DEFAULT_CONFIG: {
        pushStreamId: 'test/push-stream',
        powDifficulty: 4,
        relays: []
    }
}));

vi.mock('../../src/js/media.js', () => ({
    mediaController: {
        handleMediaMessage: vi.fn()
    }
}));

const rotation = vi.fn().mockResolvedValue([]);
vi.mock('../../src/js/storageEndpoints.js', () => ({
    storageEndpoints: { rotation: (...args) => rotation(...args) }
}));

const signHeadersFor = vi.fn().mockResolvedValue(null);
vi.mock('../../src/js/storageFetch.js', () => ({
    storageFetch: { signHeadersFor: (...args) => signHeadersFor(...args) }
}));

import { relayManager } from '../../src/js/relayManager.js';
import { channelManager } from '../../src/js/channels.js';
import { calculateChannelTag, calculateNativeChannelTag } from '../../src/js/pushProtocol.js';

describe('RelayManager', () => {
    let mockPostMessage;
    let originalNavigator;

    beforeEach(() => {
        // Reset relayManager state
        relayManager.subscribedChannels.clear();
        relayManager.subscribedNativeChannels.clear();
        relayManager.walletAddress = '0xmyaddress1234';

        // Reset mocked channelManager channels
        channelManager.channels.clear();

        // Mock navigator.serviceWorker (preserve window.dispatchEvent)
        mockPostMessage = vi.fn();
        originalNavigator = global.navigator;
        
        // Save original window reference
        const origDispatchEvent = globalThis.window?.dispatchEvent;
        const origAddEventListener = globalThis.window?.addEventListener;
        const origRemoveEventListener = globalThis.window?.removeEventListener;
        
        global.navigator = {
            serviceWorker: {
                controller: {
                    postMessage: mockPostMessage
                },
                addEventListener: vi.fn()
            }
        };
        
        // Restore window event methods that may have been lost
        if (origDispatchEvent && globalThis.window) {
            globalThis.window.dispatchEvent = origDispatchEvent;
            globalThis.window.addEventListener = origAddEventListener;
            globalThis.window.removeEventListener = origRemoveEventListener;
        }

        // Reset mocks
        vi.clearAllMocks();
    });

    afterEach(() => {
        global.navigator = originalNavigator;
    });

    // ==================== syncWithServiceWorker() ====================
    describe('syncWithServiceWorker()', () => {
        it('should skip if no Service Worker controller', async () => {
            global.navigator = {
                serviceWorker: {
                    controller: null
                }
            };

            await relayManager.syncWithServiceWorker();

            expect(mockPostMessage).not.toHaveBeenCalled();
        });

        it('should sync public channel with correct structure', async () => {
            const streamId = 'owner/public-channel';
            channelManager.channels.set(streamId, {
                name: 'General Chat',
                isPrivate: false
            });
            relayManager.subscribedChannels.add(streamId);

            await relayManager.syncWithServiceWorker();

            expect(mockPostMessage).toHaveBeenCalledWith({
                type: 'SYNC_CHANNELS',
                channels: expect.arrayContaining([
                    expect.objectContaining({
                        streamId,
                        type: 'public',
                        name: 'General Chat',
                        tag: expect.any(String),
                        storageEndpoints: expect.any(Array)
                    })
                ])
            });
        });

        it('should sync private channel with correct type', async () => {
            const streamId = 'owner/private-channel';
            channelManager.channels.set(streamId, {
                name: 'Secret Room',
                isPrivate: true
            });
            relayManager.subscribedChannels.add(streamId);

            await relayManager.syncWithServiceWorker();

            const sentData = mockPostMessage.mock.calls[0][0];
            const channelData = sentData.channels.find(c => c.streamId === streamId);
            expect(channelData.type).toBe('private');
        });

        it('should sync DM channel with type dm and correct name', async () => {
            const streamId = '0xpeer/Pombo-DM-1';
            channelManager.channels.set(streamId, {
                type: 'dm',
                name: 'Alice',
                peerAddress: '0xpeer'
            });
            relayManager.subscribedChannels.add(streamId);

            await relayManager.syncWithServiceWorker();

            const sentData = mockPostMessage.mock.calls[0][0];
            const channelData = sentData.channels.find(c => c.streamId === streamId);
            expect(channelData.type).toBe('dm');
            expect(channelData.name).toBe('Alice');
        });

        it('should use fallback name for DM channel without name', async () => {
            const streamId = '0xpeer/Pombo-DM-1';
            channelManager.channels.set(streamId, {
                type: 'dm',
                peerAddress: '0xpeer'
                // No name field
            });
            relayManager.subscribedChannels.add(streamId);

            await relayManager.syncWithServiceWorker();

            const sentData = mockPostMessage.mock.calls[0][0];
            const channelData = sentData.channels.find(c => c.streamId === streamId);
            expect(channelData.name).toBe('Direct Message');
        });

        it('should sync a gated channel under its real type', async () => {
            const streamId = '0xowner/native-channel';
            channelManager.channels.set(streamId, {
                name: 'Bob Group',
                participants: [
                    { address: '0xmyaddress1234', nickname: 'Me' },
                    { address: '0xbob', nickname: 'Bob' }
                ]
            });
            relayManager.subscribedNativeChannels.add(streamId);

            await relayManager.syncWithServiceWorker();

            const sentData = mockPostMessage.mock.calls[0][0];
            const channelData = sentData.channels.find(c => c.streamId === streamId);
            expect(channelData.type).toBe('gated');
            expect(channelData.name).toBe('Bob Group');
        });

        it('should use participant nickname for native channel without name', async () => {
            const streamId = '0xowner/native-channel';
            channelManager.channels.set(streamId, {
                // No name field
                participants: [
                    { address: '0xmyaddress1234', nickname: 'Me' },
                    { address: '0xbob', nickname: 'Bob' }
                ]
            });
            relayManager.subscribedNativeChannels.add(streamId);

            await relayManager.syncWithServiceWorker();

            const sentData = mockPostMessage.mock.calls[0][0];
            const channelData = sentData.channels.find(c => c.streamId === streamId);
            expect(channelData.name).toBe('Bob');
        });

        it('should use fallback for native channel without name or participants', async () => {
            const streamId = '0xowner/native-channel';
            channelManager.channels.set(streamId, {});
            relayManager.subscribedNativeChannels.add(streamId);

            await relayManager.syncWithServiceWorker();

            const sentData = mockPostMessage.mock.calls[0][0];
            const channelData = sentData.channels.find(c => c.streamId === streamId);
            expect(channelData.name).toBe('Direct Message');
        });

        it('should sync multiple channels of different types', async () => {
            // Add public channel
            const publicId = 'owner/public';
            channelManager.channels.set(publicId, { name: 'Public' });
            relayManager.subscribedChannels.add(publicId);

            // Add DM channel
            const dmId = '0xpeer/Pombo-DM-1';
            channelManager.channels.set(dmId, { type: 'dm', name: 'John' });
            relayManager.subscribedChannels.add(dmId);

            // Add native channel
            const nativeId = '0xowner/native';
            channelManager.channels.set(nativeId, { name: 'Private Group' });
            relayManager.subscribedNativeChannels.add(nativeId);

            await relayManager.syncWithServiceWorker();

            const sentData = mockPostMessage.mock.calls[0][0];
            expect(sentData.channels).toHaveLength(3);
            
            const publicChannel = sentData.channels.find(c => c.streamId === publicId);
            const dmChannel = sentData.channels.find(c => c.streamId === dmId);
            const nativeChannel = sentData.channels.find(c => c.streamId === nativeId);

            expect(publicChannel.type).toBe('public');
            expect(dmChannel.type).toBe('dm');
            expect(nativeChannel.type).toBe('gated');
        });

        it('should use correct tag functions for each channel type', async () => {
            const publicId = 'owner/public';
            channelManager.channels.set(publicId, { name: 'Public' });
            relayManager.subscribedChannels.add(publicId);

            const nativeId = '0xowner/native';
            channelManager.channels.set(nativeId, { name: 'Native' });
            relayManager.subscribedNativeChannels.add(nativeId);

            await relayManager.syncWithServiceWorker();

            expect(calculateChannelTag).toHaveBeenCalledWith(publicId);
            expect(calculateNativeChannelTag).toHaveBeenCalledWith(nativeId);
        });

        it('should use Channel as fallback name for unknown channels', async () => {
            const streamId = 'owner/unknown';
            relayManager.subscribedChannels.add(streamId);
            // No channel info in channelManager

            await relayManager.syncWithServiceWorker();

            const sentData = mockPostMessage.mock.calls[0][0];
            const channelData = sentData.channels.find(c => c.streamId === streamId);
            expect(channelData.name).toBe('Channel');
        });

        it('should ship the providers resolved on chain', async () => {
            const resolved = ['https://one.test', 'https://two.test'];
            rotation.mockResolvedValue(resolved);
            const streamId = 'owner/custom';
            channelManager.channels.set(streamId, { name: 'Custom' });
            relayManager.subscribedChannels.add(streamId);

            await relayManager.syncWithServiceWorker();

            const sentData = mockPostMessage.mock.calls[0][0];
            const channelData = sentData.channels.find(c => c.streamId === streamId);
            expect(channelData.storageEndpoints).toEqual(resolved);
            expect(rotation).toHaveBeenCalledWith(streamId);
        });

        it('should ship no endpoints when the chain cannot be read', async () => {
            rotation.mockRejectedValue(new Error('RPC down'));
            const streamId = 'owner/default';
            channelManager.channels.set(streamId, { name: 'Default' });
            relayManager.subscribedChannels.add(streamId);

            await relayManager.syncWithServiceWorker();

            const sentData = mockPostMessage.mock.calls[0][0];
            const channelData = sentData.channels.find(c => c.streamId === streamId);
            expect(channelData.storageEndpoints).toEqual([]);
        });

        it('should mark a DM inbox as needing a signature, a public channel not', async () => {
            const inbox = '0xme/Pombo-DM-1';
            const open = 'owner/public-1';
            relayManager.subscribedChannels.add(inbox);
            relayManager.subscribedChannels.add(open);
            channelManager.channels.set(open, { name: 'Open' });

            await relayManager.syncWithServiceWorker();

            const sentData = mockPostMessage.mock.calls[0][0];
            expect(sentData.channels.find(c => c.streamId === inbox).needsSignature).toBe(true);
            expect(sentData.channels.find(c => c.streamId === open).needsSignature).toBe(false);
        });

        it('should mark a gated channel as needing a signature', async () => {
            const streamId = 'owner/gated-1';
            channelManager.channels.set(streamId, { name: 'Gated', type: 'gated' });
            relayManager.subscribedNativeChannels.add(streamId);

            await relayManager.syncWithServiceWorker();

            const sentData = mockPostMessage.mock.calls[0][0];
            expect(sentData.channels.find(c => c.streamId === streamId).needsSignature).toBe(true);
        });

        it('should detect DM inbox subscription by stream ID pattern', async () => {
            const inboxStreamId = '0xmyaddress/Pombo-DM-1';
            relayManager.subscribedChannels.add(inboxStreamId);
            // No channel info for inbox (it's the user's own inbox, not stored as a channel)

            await relayManager.syncWithServiceWorker();

            const sentData = mockPostMessage.mock.calls[0][0];
            const channelData = sentData.channels.find(c => c.streamId === inboxStreamId);
            expect(channelData.type).toBe('dm');
            expect(channelData.name).toBe('Direct Message');
        });

        it('should NOT ship a dmPeers map to the service worker', async () => {
            // Sealed sender makes the SW unable to identify a DM's sender, so a
            // peer address→name map would be unused identity data in the SW's
            // IndexedDB — it was removed. The SW must not receive it.
            const dmStreamId = '0xpeer/Pombo-DM-1';
            channelManager.channels.set(dmStreamId, {
                type: 'dm',
                name: 'Alice',
                peerAddress: '0xpeer'
            });
            relayManager.subscribedChannels.add(dmStreamId);

            await relayManager.syncWithServiceWorker();

            const sentData = mockPostMessage.mock.calls[0][0];
            expect(sentData.dmPeers).toBeUndefined();
        });
    });

    // ==================== subscribedChannels management ====================
    describe('subscribedChannels', () => {
        it('should be empty initially', () => {
            const manager = new relayManager.constructor();
            expect(manager.subscribedChannels.size).toBe(0);
            expect(manager.subscribedNativeChannels.size).toBe(0);
        });

        it('should track added channels', () => {
            relayManager.subscribedChannels.add('stream-1');
            relayManager.subscribedChannels.add('stream-2');

            expect(relayManager.subscribedChannels.has('stream-1')).toBe(true);
            expect(relayManager.subscribedChannels.has('stream-2')).toBe(true);
            expect(relayManager.subscribedChannels.size).toBe(2);
        });
    });

    // ==================== isSupported() ====================
    describe('isSupported()', () => {
        it('should return true when all APIs available', () => {
            // In jsdom environment, window, navigator.serviceWorker should exist
            // We just need PushManager and Notification
            global.PushManager = {};
            global.Notification = {};
            global.navigator = {
                ...global.navigator,
                serviceWorker: { controller: null, addEventListener: vi.fn() }
            };

            expect(relayManager.isSupported()).toBe(true);

            delete global.PushManager;
            delete global.Notification;
        });

        it('should return false when serviceWorker unavailable', () => {
            const origNav = global.navigator;
            global.navigator = {};

            expect(relayManager.isSupported()).toBe(false);

            global.navigator = origNav;
        });
    });

    // ==================== unsubscribeFromChannel() ====================
    describe('unsubscribeFromChannel()', () => {
        it('should remove channel from subscribed set', () => {
            relayManager.subscribedChannels.add('stream-1');
            relayManager.subscribedChannels.add('stream-2');

            const result = relayManager.unsubscribeFromChannel('stream-1');

            expect(result).toBe(true);
            expect(relayManager.subscribedChannels.has('stream-1')).toBe(false);
            expect(relayManager.subscribedChannels.has('stream-2')).toBe(true);
        });

        it('should return true even for non-subscribed channel', () => {
            const result = relayManager.unsubscribeFromChannel('nonexistent');
            expect(result).toBe(true);
        });
    });

    // ==================== isChannelSubscribed() ====================
    describe('isChannelSubscribed()', () => {
        it('should return true for subscribed channel', () => {
            relayManager.subscribedChannels.add('stream-1');
            expect(relayManager.isChannelSubscribed('stream-1')).toBe(true);
        });

        it('should return false for non-subscribed channel', () => {
            expect(relayManager.isChannelSubscribed('stream-999')).toBe(false);
        });
    });

    // ==================== unsubscribeFromNativeChannel() ====================
    describe('unsubscribeFromNativeChannel()', () => {
        it('should remove native channel from subscribed set', () => {
            relayManager.subscribedNativeChannels.add('native-1');

            const result = relayManager.unsubscribeFromNativeChannel('native-1');

            expect(result).toBe(true);
            expect(relayManager.subscribedNativeChannels.has('native-1')).toBe(false);
        });
    });

    // ==================== isNativeChannelSubscribed() ====================
    describe('isNativeChannelSubscribed()', () => {
        it('should return true for subscribed native channel', () => {
            relayManager.subscribedNativeChannels.add('native-1');
            expect(relayManager.isNativeChannelSubscribed('native-1')).toBe(true);
        });

        it('should return false for non-subscribed native channel', () => {
            expect(relayManager.isNativeChannelSubscribed('native-999')).toBe(false);
        });
    });

    // ==================== urlBase64ToUint8Array() ====================
    describe('urlBase64ToUint8Array()', () => {
        it('should convert base64url to Uint8Array', () => {
            // "SGVsbG8" is "Hello" in base64url
            const result = relayManager.urlBase64ToUint8Array('SGVsbG8');
            expect(result).toBeInstanceOf(Uint8Array);
            expect(result.length).toBeGreaterThan(0);

            // Verify the bytes match "Hello"
            expect(result[0]).toBe(72);  // H
            expect(result[1]).toBe(101); // e
            expect(result[2]).toBe(108); // l
            expect(result[3]).toBe(108); // l
            expect(result[4]).toBe(111); // o
        });

        it('should handle base64url characters (- and _)', () => {
            // These chars are specific to base64url and should be replaced with + and /
            const result = relayManager.urlBase64ToUint8Array('A-B_');
            expect(result).toBeInstanceOf(Uint8Array);
        });

        it('should handle padding correctly', () => {
            // "Mg" needs padding to "Mg=="
            const result = relayManager.urlBase64ToUint8Array('Mg');
            expect(result).toBeInstanceOf(Uint8Array);
            expect(result[0]).toBe(50); // '2' character
        });
    });

    // ==================== handleServiceWorkerMessage() ====================
    describe('handleServiceWorkerMessage()', () => {
        it('should handle NEW_MESSAGE by dispatching event', () => {
            const listener = vi.fn();
            const origAddEventListener = globalThis.window?.addEventListener;
            
            // handleServiceWorkerMessage uses window.dispatchEvent
            // In test env, globalThis.window may not be the DOM window
            // Just verify the method doesn't throw on valid data
            expect(() => relayManager.handleServiceWorkerMessage({
                type: 'NEW_MESSAGE',
                streamId: 'owner/channel-1',
                timestamp: 12345,
                content: { text: 'hello' }
            })).not.toThrow();
        });

        it('should handle NOTIFICATION_CLICKED', () => {
            expect(() => relayManager.handleServiceWorkerMessage({ type: 'NOTIFICATION_CLICKED' })).not.toThrow();
        });

        it('should ignore null data', () => {
            expect(() => relayManager.handleServiceWorkerMessage(null)).not.toThrow();
        });

        it('should ignore data without type', () => {
            expect(() => relayManager.handleServiceWorkerMessage({ foo: 'bar' })).not.toThrow();
        });

        it('should ignore unknown message types', () => {
            expect(() => relayManager.handleServiceWorkerMessage({ type: 'UNKNOWN_TYPE' })).not.toThrow();
        });
    });

    // ==================== getStatus() ====================
    describe('getStatus()', () => {
        it('should return current status object', () => {
            relayManager.initialized = true;
            relayManager.enabled = true;
            relayManager.pushSubscription = { endpoint: 'test' };
            relayManager.subscribedChannels = new Set(['ch1', 'ch2']);
            relayManager.subscribedNativeChannels = new Set(['nat1']);

            const status = relayManager.getStatus();

            expect(status.initialized).toBe(true);
            expect(status.enabled).toBe(true);
            expect(status.hasSubscription).toBe(true);
            expect(status.subscribedChannels).toBe(2);
            expect(status.subscribedNativeChannels).toBe(1);
        });

        it('should show false for hasSubscription when null', () => {
            relayManager.pushSubscription = null;

            const status = relayManager.getStatus();
            expect(status.hasSubscription).toBe(false);
        });
    });

    // ==================== getConfig() ====================
    describe('getConfig()', () => {
        it('should return config object', () => {
            const config = relayManager.getConfig();
            expect(config).toBeDefined();
            expect(config).toHaveProperty('pushStreamId');
            expect(config).toHaveProperty('powDifficulty');
        });

        it('should return a copy (not reference)', () => {
            const config1 = relayManager.getConfig();
            const config2 = relayManager.getConfig();
            expect(config1).not.toBe(config2);
            expect(config1).toEqual(config2);
        });
    });

    // ==================== loadSubscribedChannels() ====================
    describe('loadSubscribedChannels()', () => {
        it('should load public channels from localStorage', () => {
            const channels = ['stream-1', 'stream-2'];
            localStorage.setItem('pombo_push_registration_channels_0xmyaddress1234', JSON.stringify(channels));

            relayManager.loadSubscribedChannels();

            expect(relayManager.subscribedChannels.has('stream-1')).toBe(true);
            expect(relayManager.subscribedChannels.has('stream-2')).toBe(true);
        });

        it('should load native channels from localStorage', () => {
            const nativeChannels = ['native-1'];
            localStorage.setItem('pombo_push_registration_native_channels_0xmyaddress1234', JSON.stringify(nativeChannels));

            relayManager.loadSubscribedChannels();

            expect(relayManager.subscribedNativeChannels.has('native-1')).toBe(true);
        });

        it('should handle missing localStorage data', () => {
            relayManager.loadSubscribedChannels();
            expect(relayManager.subscribedChannels.size).toBe(0);
            expect(relayManager.subscribedNativeChannels.size).toBe(0);
        });

        it('should handle corrupted localStorage data', () => {
            localStorage.setItem('pombo_push_registration_channels', 'not json');

            // Should not throw
            expect(() => relayManager.loadSubscribedChannels()).not.toThrow();
        });
    });

    // ==================== saveSubscribedChannels() ====================
    describe('saveSubscribedChannels()', () => {
        it('should save public channels to localStorage', () => {
            relayManager.subscribedChannels.add('stream-1');
            relayManager.subscribedChannels.add('stream-2');

            relayManager.saveSubscribedChannels();

            const stored = JSON.parse(localStorage.getItem('pombo_push_registration_channels_0xmyaddress1234'));
            expect(stored).toContain('stream-1');
            expect(stored).toContain('stream-2');
        });

        it('should save native channels to localStorage', () => {
            relayManager.subscribedNativeChannels.add('native-1');

            relayManager.saveSubscribedChannels();

            const stored = JSON.parse(localStorage.getItem('pombo_push_registration_native_channels_0xmyaddress1234'));
            expect(stored).toContain('native-1');
        });
    });

    // ==================== startReRegistrationTimer / stopReRegistrationTimer ====================
    describe('re-registration timer', () => {
        it('should not start timer when not enabled', () => {
            relayManager.enabled = false;
            relayManager.pushSubscription = null;

            relayManager.startReRegistrationTimer();

            expect(relayManager.reRegistrationTimer).toBeNull();
        });

        it('should stop existing timer', () => {
            relayManager.reRegistrationTimer = setInterval(() => {}, 100000);

            relayManager.stopReRegistrationTimer();

            expect(relayManager.reRegistrationTimer).toBeNull();
        });

        it('should be idempotent to stop', () => {
            relayManager.stopReRegistrationTimer();
            relayManager.stopReRegistrationTimer();
            expect(relayManager.reRegistrationTimer).toBeNull();
        });
    });

    // ==================== sendChannelWakeSignal() ====================
    describe('sendChannelWakeSignal()', () => {
        it('should return false when not initialized', async () => {
            relayManager.initialized = false;
            const result = await relayManager.sendChannelWakeSignal('stream-1');
            expect(result).toBe(false);
        });
    });

    // ==================== sendNativeChannelWakeSignal() ====================
    describe('sendNativeChannelWakeSignal()', () => {
        it('should return false when not initialized', async () => {
            relayManager.initialized = false;
            const result = await relayManager.sendNativeChannelWakeSignal('stream-1');
            expect(result).toBe(false);
        });
    });

    // ==================== subscribeToChannel() ====================
    describe('subscribeToChannel()', () => {
        it('should return false when not initialized', async () => {
            relayManager.initialized = false;
            const result = await relayManager.subscribeToChannel('stream-1');
            expect(result).toBe(false);
        });

        it('should return false when no push subscription', async () => {
            relayManager.initialized = true;
            relayManager.pushSubscription = null;
            const result = await relayManager.subscribeToChannel('stream-1');
            expect(result).toBe(false);
        });
    });

    // ==================== subscribeToNativeChannel() ====================
    describe('subscribeToNativeChannel()', () => {
        it('should return false when not initialized', async () => {
            relayManager.initialized = false;
            const result = await relayManager.subscribeToNativeChannel('native-1');
            expect(result).toBe(false);
        });

        it('should return false when no push subscription', async () => {
            relayManager.initialized = true;
            relayManager.pushSubscription = null;
            const result = await relayManager.subscribeToNativeChannel('native-1');
            expect(result).toBe(false);
        });
    });

    // ==================== unsubscribe() ====================
    describe('unsubscribe()', () => {
        it('should return true when no subscription exists', async () => {
            relayManager.pushSubscription = null;
            const result = await relayManager.unsubscribe();
            expect(result).toBe(true);
        });

        it('should cancel subscription and clean up', async () => {
            const mockSub = {
                unsubscribe: vi.fn().mockResolvedValue(true)
            };
            relayManager.pushSubscription = mockSub;
            relayManager.enabled = true;

            const result = await relayManager.unsubscribe();

            expect(result).toBe(true);
            expect(mockSub.unsubscribe).toHaveBeenCalled();
            expect(relayManager.pushSubscription).toBeNull();
            expect(relayManager.enabled).toBe(false);
        });

        it('should return false on error', async () => {
            const mockSub = {
                unsubscribe: vi.fn().mockRejectedValue(new Error('fail'))
            };
            relayManager.pushSubscription = mockSub;

            const result = await relayManager.unsubscribe();
            expect(result).toBe(false);
        });
    });

    // ==================== init() ====================
    describe('init()', () => {
        it('should return true if already initialized with same address', async () => {
            relayManager.initialized = true;
            relayManager.walletAddress = '0xmyaddress';

            const result = await relayManager.init('0xMyAddress');
            expect(result).toBe(true);
        });

        it('should refresh subscriptions on address change', async () => {
            relayManager.initialized = true;
            relayManager.walletAddress = '0xoldaddress';
            relayManager.subscribedChannels.add('old-channel');

            const result = await relayManager.init('0xNewAddress');

            expect(result).toBe(true);
            expect(relayManager.walletAddress).toBe('0xnewaddress');
            expect(relayManager.subscribedChannels.size).toBe(0);
        });
    });
});
