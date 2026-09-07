/**
 * Tests for subscriptionManager.js - Dynamic subscription lifecycle management
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock dependencies before import
vi.mock('../../src/js/logger.js', () => ({
    Logger: {
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn()
    }
}));

vi.mock('../../src/js/streamr.js', () => ({
    streamrController: {
        unsubscribe: vi.fn(),
        unsubscribeFromDualStream: vi.fn(),
        unsubscribeFromPartition: vi.fn().mockResolvedValue(undefined),
        subscribe: vi.fn(),
        resend: vi.fn().mockResolvedValue([]),
        isInitialized: vi.fn().mockReturnValue(true),
        publish: vi.fn(),
        subscribeToDualStream: vi.fn().mockResolvedValue(undefined),
        resendAdminState: vi.fn().mockResolvedValue(null),
        publishControl: vi.fn().mockResolvedValue(undefined),
        fetchOlderHistory: vi.fn().mockResolvedValue({ messages: [] }),
        fetchHistoryAsync: vi.fn().mockResolvedValue(undefined),
        subscribeToPartition: vi.fn().mockResolvedValue(undefined)
    },
    STREAM_CONFIG: {
        partitions: 1,
        INITIAL_MESSAGES: 50,
        ADMIN_HISTORY_COUNT: 10,
        MESSAGE_STREAM: { MESSAGES: 0, CONTROL: 1 },
        EPHEMERAL_STREAM: { CONTROL: 0, MEDIA_SIGNALS: 1, MEDIA_DATA: 2 },
        ADMIN_STREAM: { MODERATION: 0 },
        INTERACTIONS_STREAM: { REACTIONS: 0 }
    },
    deriveEphemeralId: vi.fn((id) => `${id}/ephemeral`),
    deriveAdminId: vi.fn((id) => `${id}/admin`),
    deriveInteractionsId: vi.fn((id) => `${id}/interactions`)
}));

vi.mock('../../src/js/memberCatchUp.js', () => ({
    memberCatchUp: { start: vi.fn(), stop: vi.fn(), getStreamId: vi.fn().mockReturnValue(null) }
}));

vi.mock('../../src/js/adminStatePoller.js', () => ({
    ResendPoller: class { start() {} stop() {} pollNow() {} getStreamId() { return null; } },
    adminStatePoller: {
        start: vi.fn(),
        stop: vi.fn(),
        pollNow: vi.fn(),
        markFresh: vi.fn(),
        getStreamId: vi.fn().mockReturnValue(null)
    }
}));

vi.mock('../../src/js/channelLatestMessageManager.js', () => ({
    channelLatestMessageManager: {
        setFromLocal: vi.fn()
    }
}));

vi.mock('../../src/js/channels.js', () => ({
    channelManager: {
        getChannel: vi.fn(),
        getAllChannels: vi.fn().mockReturnValue([]),
        subscribeToChannel: vi.fn().mockResolvedValue(undefined),
        startPresenceTracking: vi.fn(),
        stopPresenceTracking: vi.fn(),
        handlePresenceMessage: vi.fn(),
        handleTextMessage: vi.fn(),
        handleMediaMessage: vi.fn(),
        refreshAdminState: vi.fn().mockResolvedValue(false)
    }
}));

vi.mock('../../src/js/secureStorage.js', () => ({
    secureStorage: {
        isStorageUnlocked: vi.fn().mockReturnValue(true),
        getAllChannelLastAccess: vi.fn().mockReturnValue({}),
        getLastOpenedChannel: vi.fn().mockReturnValue(null),
        setLastOpenedChannel: vi.fn()
    }
}));

vi.mock('../../src/js/auth.js', () => ({
    authManager: {
        getAddress: vi.fn().mockReturnValue('0xmyaddress')
    }
}));

vi.mock('../../src/js/identity.js', () => ({
    identityManager: {
        getCurrentIdentity: vi.fn().mockReturnValue({ nickname: 'Test', address: '0xtest' })
    }
}));

vi.mock('../../src/js/media.js', () => ({
    mediaController: {
        processIncomingMediaChunk: vi.fn(),
        hasActiveMediaTransfers: vi.fn().mockReturnValue(false)
    }
}));

// Import after mocks
import { subscriptionManager } from '../../src/js/subscriptionManager.js';
import { channelManager } from '../../src/js/channels.js';
import { channelLatestMessageManager } from '../../src/js/channelLatestMessageManager.js';
import { streamrController, STREAM_CONFIG } from '../../src/js/streamr.js';
import { secureStorage } from '../../src/js/secureStorage.js';
import { mediaController } from '../../src/js/media.js';

describe('SubscriptionManager', () => {
    beforeEach(() => {
        // Reset state
        subscriptionManager.activeChannelId = null;
        subscriptionManager.previewChannelId = null;
        subscriptionManager.previewPresenceInterval = null;
        subscriptionManager.backgroundPoller = null;
        subscriptionManager.channelActivity.clear();
        subscriptionManager.activityHandlers = [];
        subscriptionManager.pollIndex = 0;
        subscriptionManager.isPolling = false;
        
        // Reset config to defaults
        subscriptionManager.config = {
            POLL_INTERVAL: 30000,
            POLL_BATCH_SIZE: 3,
            POLL_STAGGER_DELAY: 2000,
            MIN_POLL_INTERVAL: 10000,
            MAX_CONCURRENT_SUBS: 1,
            ACTIVITY_CHECK_MESSAGES: 3,
        };
        
        vi.clearAllMocks();
        vi.useFakeTimers();
    });

    afterEach(() => {
        vi.restoreAllMocks();
        vi.useRealTimers();
        
        // Clean up intervals
        if (subscriptionManager.previewPresenceInterval) {
            clearInterval(subscriptionManager.previewPresenceInterval);
        }
        if (subscriptionManager.backgroundPoller) {
            clearInterval(subscriptionManager.backgroundPoller);
        }
    });

    describe('constructor', () => {
        it('should initialize with null active channel', () => {
            expect(subscriptionManager.activeChannelId).toBeNull();
        });
        
        it('should initialize with null preview channel', () => {
            expect(subscriptionManager.previewChannelId).toBeNull();
        });
        
        it('should have empty activity map', () => {
            expect(subscriptionManager.channelActivity).toBeInstanceOf(Map);
            expect(subscriptionManager.channelActivity.size).toBe(0);
        });
        
        it('should have configuration defaults', () => {
            expect(subscriptionManager.config.POLL_INTERVAL).toBe(30000);
            expect(subscriptionManager.config.POLL_BATCH_SIZE).toBe(3);
        });
    });

    describe('setActiveChannel()', () => {
        it('should set active channel id', async () => {
            await subscriptionManager.setActiveChannel('stream1');
            
            expect(subscriptionManager.activeChannelId).toBe('stream1');
        });
        
        it('should call channelManager.subscribeToChannel', async () => {
            await subscriptionManager.setActiveChannel('stream1');
            
            expect(channelManager.subscribeToChannel).toHaveBeenCalledWith('stream1', null);
        });
        
        it('should pass password to subscribeToChannel', async () => {
            await subscriptionManager.setActiveChannel('stream1', 'secret123');
            
            expect(channelManager.subscribeToChannel).toHaveBeenCalledWith('stream1', 'secret123');
        });
        
        it('should not change if same channel already active', async () => {
            subscriptionManager.activeChannelId = 'stream1';
            
            await subscriptionManager.setActiveChannel('stream1');
            
            expect(channelManager.subscribeToChannel).not.toHaveBeenCalled();
        });
        
        it('should downgrade previous active channel', async () => {
            subscriptionManager.activeChannelId = 'old-stream';
            channelManager.getChannel.mockReturnValue({ messages: [], ephemeralStreamId: 'old-stream/ephemeral' });
            
            await subscriptionManager.setActiveChannel('new-stream');
            
            expect(streamrController.unsubscribeFromDualStream).toHaveBeenCalled();
        });
        
        it('should warn on null streamId', async () => {
            await subscriptionManager.setActiveChannel(null);
            
            expect(subscriptionManager.activeChannelId).toBeNull();
        });
    });

    describe('clearActiveChannel()', () => {
        it('should downgrade active channel', async () => {
            subscriptionManager.activeChannelId = 'stream1';
            channelManager.getChannel.mockReturnValue({ messages: [], ephemeralStreamId: 'stream1/ephemeral' });
            
            await subscriptionManager.clearActiveChannel();
            
            expect(streamrController.unsubscribeFromDualStream).toHaveBeenCalled();
        });
        
        it('should set activeChannelId to null', async () => {
            subscriptionManager.activeChannelId = 'stream1';
            channelManager.getChannel.mockReturnValue({ messages: [], ephemeralStreamId: 'stream1/ephemeral' });
            
            await subscriptionManager.clearActiveChannel();
            
            expect(subscriptionManager.activeChannelId).toBeNull();
        });
    });

    describe('isActiveChannel()', () => {
        it('should return true for active channel', () => {
            subscriptionManager.activeChannelId = 'stream1';
            
            expect(subscriptionManager.isActiveChannel('stream1')).toBe(true);
        });
        
        it('should return false for non-active channel', () => {
            subscriptionManager.activeChannelId = 'stream1';
            
            expect(subscriptionManager.isActiveChannel('stream2')).toBe(false);
        });
        
        it('should return false when no active channel', () => {
            expect(subscriptionManager.isActiveChannel('stream1')).toBe(false);
        });
    });

    describe('getActiveChannelId()', () => {
        it('should return active channel id', () => {
            subscriptionManager.activeChannelId = 'stream1';
            
            expect(subscriptionManager.getActiveChannelId()).toBe('stream1');
        });
        
        it('should return null when no active channel', () => {
            expect(subscriptionManager.getActiveChannelId()).toBeNull();
        });
    });

    describe('Preview Mode', () => {
        describe('isInPreviewMode()', () => {
            it('should return false when no preview channel', () => {
                expect(subscriptionManager.isInPreviewMode()).toBe(false);
            });
            
            it('should return true when preview channel active', () => {
                subscriptionManager.previewChannelId = 'preview-stream';
                
                expect(subscriptionManager.isInPreviewMode()).toBe(true);
            });
        });

        describe('getPreviewChannelId()', () => {
            it('should return preview channel id', () => {
                subscriptionManager.previewChannelId = 'preview-stream';
                
                expect(subscriptionManager.getPreviewChannelId()).toBe('preview-stream');
            });
            
            it('should return null when not in preview mode', () => {
                expect(subscriptionManager.getPreviewChannelId()).toBeNull();
            });
        });

        describe('clearPreviewChannel()', () => {
            it('should clear preview channel id', async () => {
                subscriptionManager.previewChannelId = 'preview-stream';
                
                await subscriptionManager.clearPreviewChannel();
                
                expect(subscriptionManager.previewChannelId).toBeNull();
            });
            
            it('should stop preview presence interval', async () => {
                subscriptionManager.previewChannelId = 'preview-stream';
                subscriptionManager.previewPresenceInterval = setInterval(() => {}, 1000);
                
                await subscriptionManager.clearPreviewChannel();
                
                expect(subscriptionManager.previewPresenceInterval).toBeNull();
            });
        });
    });

    describe('Activity Tracking', () => {
        describe('getChannelActivity()', () => {
            it('should return activity for tracked channel', () => {
                const activity = { lastMessageTime: Date.now(), unreadCount: 5 };
                subscriptionManager.channelActivity.set('stream1', activity);
                
                const result = subscriptionManager.getChannelActivity('stream1');
                
                expect(result).toBe(activity);
            });
            
            it('should return null for untracked channel', () => {
                expect(subscriptionManager.getChannelActivity('unknown')).toBeNull();
            });
        });

        describe('getUnreadCount()', () => {
            it('should return unread count', () => {
                subscriptionManager.channelActivity.set('stream1', { unreadCount: 10 });
                
                expect(subscriptionManager.getUnreadCount('stream1')).toBe(10);
            });
            
            it('should return 0 for untracked channel', () => {
                expect(subscriptionManager.getUnreadCount('unknown')).toBe(0);
            });
        });

        describe('clearUnreadCount()', () => {
            it('should clear unread count', () => {
                subscriptionManager.channelActivity.set('stream1', { unreadCount: 10 });
                
                subscriptionManager.clearUnreadCount('stream1');
                
                expect(subscriptionManager.getUnreadCount('stream1')).toBe(0);
            });
            
            it('should handle untracked channel gracefully', () => {
                // Should not throw
                subscriptionManager.clearUnreadCount('unknown');
            });
        });
    });

    describe('Event Handlers', () => {
        describe('onActivity()', () => {
            it('should register activity handler', () => {
                const handler = vi.fn();
                
                subscriptionManager.onActivity(handler);
                
                expect(subscriptionManager.activityHandlers).toContain(handler);
            });
        });

        describe('offActivity()', () => {
            it('should remove activity handler', () => {
                const handler = vi.fn();
                subscriptionManager.activityHandlers = [handler];
                
                subscriptionManager.offActivity(handler);
                
                expect(subscriptionManager.activityHandlers).not.toContain(handler);
            });
        });

        describe('notifyActivityHandlers()', () => {
            it('should call all handlers with activity data', () => {
                const handler1 = vi.fn();
                const handler2 = vi.fn();
                subscriptionManager.activityHandlers = [handler1, handler2];
                const activity = { unreadCount: 5 };
                
                subscriptionManager.notifyActivityHandlers('stream1', activity);
                
                expect(handler1).toHaveBeenCalledWith('stream1', activity);
                expect(handler2).toHaveBeenCalledWith('stream1', activity);
            });
            
            it('should continue on handler error', () => {
                const handler1 = vi.fn().mockImplementation(() => { throw new Error('fail'); });
                const handler2 = vi.fn();
                subscriptionManager.activityHandlers = [handler1, handler2];
                
                subscriptionManager.notifyActivityHandlers('stream1', {});
                
                expect(handler2).toHaveBeenCalled();
            });
        });
    });

    describe('Background Polling', () => {
        describe('startBackgroundPoller()', () => {
            it('should set interval for polling', () => {
                subscriptionManager.startBackgroundPoller();
                
                expect(subscriptionManager.backgroundPoller).not.toBeNull();
            });
            
            it('should not start if already running', () => {
                subscriptionManager.backgroundPoller = setInterval(() => {}, 1000);
                const originalPoller = subscriptionManager.backgroundPoller;
                
                subscriptionManager.startBackgroundPoller();
                
                expect(subscriptionManager.backgroundPoller).toBe(originalPoller);
            });
        });

        describe('stopBackgroundPoller()', () => {
            it('should clear background poller interval', () => {
                subscriptionManager.backgroundPoller = setInterval(() => {}, 1000);
                
                subscriptionManager.stopBackgroundPoller();
                
                expect(subscriptionManager.backgroundPoller).toBeNull();
            });
            
            it('should handle null poller gracefully', () => {
                subscriptionManager.backgroundPoller = null;
                
                // Should not throw
                subscriptionManager.stopBackgroundPoller();
            });
        });

        describe('initializeActivityState()', () => {
            it('should initialize activity for all channels', () => {
                channelManager.getAllChannels.mockReturnValue([
                    { messageStreamId: 'stream1', messages: [] },
                    { messageStreamId: 'stream2', messages: [] }
                ]);
                
                subscriptionManager.initializeActivityState();
                
                expect(subscriptionManager.channelActivity.has('stream1')).toBe(true);
                expect(subscriptionManager.channelActivity.has('stream2')).toBe(true);
            });
            
            it('should use lastAccess time from storage when available', () => {
                secureStorage.getAllChannelLastAccess.mockReturnValue({
                    'stream1': 5000
                });
                channelManager.getAllChannels.mockReturnValue([
                    { messageStreamId: 'stream1', messages: [] }
                ]);
                
                subscriptionManager.initializeActivityState();
                
                const activity = subscriptionManager.channelActivity.get('stream1');
                expect(activity.lastMessageTime).toBe(5000);
            });
            
            it('should set unreadCount to 0 initially', () => {
                channelManager.getAllChannels.mockReturnValue([
                    { messageStreamId: 'stream1', messages: [] }
                ]);
                
                subscriptionManager.initializeActivityState();
                
                const activity = subscriptionManager.channelActivity.get('stream1');
                expect(activity.unreadCount).toBe(0);
            });
        });
    });

    describe('updateConfig()', () => {
        it('should update config values', () => {
            subscriptionManager.updateConfig({ POLL_INTERVAL: 60000 });
            
            expect(subscriptionManager.config.POLL_INTERVAL).toBe(60000);
        });
        
        it('should preserve existing config values', () => {
            const originalBatchSize = subscriptionManager.config.POLL_BATCH_SIZE;
            
            subscriptionManager.updateConfig({ POLL_INTERVAL: 60000 });
            
            expect(subscriptionManager.config.POLL_BATCH_SIZE).toBe(originalBatchSize);
        });
    });

    describe('removeChannel()', () => {
        it('should remove channel activity', async () => {
            subscriptionManager.channelActivity.set('stream1', { unreadCount: 5 });
            
            await subscriptionManager.removeChannel('stream1');
            
            expect(subscriptionManager.channelActivity.has('stream1')).toBe(false);
        });
        
        it('should clear active channel if removed', async () => {
            subscriptionManager.activeChannelId = 'stream1';
            
            await subscriptionManager.removeChannel('stream1');
            
            expect(subscriptionManager.activeChannelId).toBeNull();
        });
        
        it('should reset lastOpenedChannel if pointing to removed channel', async () => {
            secureStorage.getLastOpenedChannel.mockReturnValue('stream1');
            
            await subscriptionManager.removeChannel('stream1');
            
            expect(secureStorage.setLastOpenedChannel).toHaveBeenCalledWith(null);
        });
    });

    describe('cleanup()', () => {
        it('should stop background poller', async () => {
            subscriptionManager.backgroundPoller = setInterval(() => {}, 1000);
            
            await subscriptionManager.cleanup();
            
            expect(subscriptionManager.backgroundPoller).toBeNull();
        });
        
        it('should clear preview channel', async () => {
            subscriptionManager.previewChannelId = 'preview';
            
            await subscriptionManager.cleanup();
            
            expect(subscriptionManager.previewChannelId).toBeNull();
        });
        
        it('should clear active channel', async () => {
            subscriptionManager.activeChannelId = 'active';
            channelManager.getChannel.mockReturnValue({ messages: [], ephemeralStreamId: 'active/ephemeral' });
            
            await subscriptionManager.cleanup();
            
            expect(subscriptionManager.activeChannelId).toBeNull();
        });
        
        it('should clear activity map', async () => {
            subscriptionManager.channelActivity.set('stream1', { unreadCount: 5 });
            
            await subscriptionManager.cleanup();
            
            expect(subscriptionManager.channelActivity.size).toBe(0);
        });
        
        it('should reset poll index', async () => {
            subscriptionManager.pollIndex = 5;
            
            await subscriptionManager.cleanup();
            
            expect(subscriptionManager.pollIndex).toBe(0);
        });
        
        it('should reset isPolling flag', async () => {
            subscriptionManager.isPolling = true;
            
            await subscriptionManager.cleanup();
            
            expect(subscriptionManager.isPolling).toBe(false);
        });
        
        it('should clear activity handlers', async () => {
            subscriptionManager.activityHandlers = [vi.fn(), vi.fn()];
            
            await subscriptionManager.cleanup();
            
            expect(subscriptionManager.activityHandlers).toEqual([]);
        });
    });

    describe('setPreviewChannel()', () => {
        beforeEach(() => {
            // Mock streamrController.subscribeToDualStream
            streamrController.subscribeToDualStream = vi.fn().mockResolvedValue(undefined);
            streamrController.publishControl = vi.fn().mockResolvedValue(undefined);
        });

        it('should set preview channel id', async () => {
            await subscriptionManager.setPreviewChannel('preview-stream');
            
            expect(subscriptionManager.previewChannelId).toBe('preview-stream');
        });

        it('should subscribe to dual stream', async () => {
            await subscriptionManager.setPreviewChannel('preview-stream');
            
            expect(streamrController.subscribeToDualStream).toHaveBeenCalled();
            const call = streamrController.subscribeToDualStream.mock.calls[0];
            expect(call[0]).toBe('preview-stream');
            expect(call[1]).toBe('preview-stream/ephemeral');
            expect(typeof call[2].onOverride).toBe('function');
        });

        it('should not change if same preview already active', async () => {
            subscriptionManager.previewChannelId = 'same-stream';
            
            await subscriptionManager.setPreviewChannel('same-stream');
            
            expect(streamrController.subscribeToDualStream).not.toHaveBeenCalled();
        });

        it('should clear previous preview channel', async () => {
            subscriptionManager.previewChannelId = 'old-preview';
            streamrController.unsubscribeFromDualStream = vi.fn().mockResolvedValue(undefined);
            
            await subscriptionManager.setPreviewChannel('new-preview');
            
            expect(streamrController.unsubscribeFromDualStream).toHaveBeenCalled();
        });

        it('should downgrade active channel when setting preview', async () => {
            subscriptionManager.activeChannelId = 'active-stream';
            channelManager.getChannel.mockReturnValue({ messages: [], ephemeralStreamId: 'active-stream/ephemeral' });
            
            await subscriptionManager.setPreviewChannel('preview-stream');
            
            expect(subscriptionManager.activeChannelId).toBeNull();
        });

        it('should warn on null streamId', async () => {
            await subscriptionManager.setPreviewChannel(null);
            
            expect(subscriptionManager.previewChannelId).toBeNull();
            expect(streamrController.subscribeToDualStream).not.toHaveBeenCalled();
        });

        it('should clear previewChannelId on subscription error', async () => {
            streamrController.subscribeToDualStream.mockRejectedValue(new Error('Subscription failed'));
            
            await expect(subscriptionManager.setPreviewChannel('failing-stream')).rejects.toThrow('Subscription failed');
            
            expect(subscriptionManager.previewChannelId).toBeNull();
        });

        it('should start preview presence broadcasting', async () => {
            await subscriptionManager.setPreviewChannel('preview-stream');
            
            // Presence is published immediately
            expect(streamrController.publishControl).toHaveBeenCalled();
        });
    });

    describe('promotePreviewToActive()', () => {
        beforeEach(() => {
            streamrController.subscribeToDualStream = vi.fn().mockResolvedValue(undefined);
            streamrController.publishControl = vi.fn().mockResolvedValue(undefined);
        });

        it('should promote preview to active channel', async () => {
            subscriptionManager.previewChannelId = 'preview-stream';
            
            await subscriptionManager.promotePreviewToActive('preview-stream');
            
            expect(subscriptionManager.activeChannelId).toBe('preview-stream');
            expect(subscriptionManager.previewChannelId).toBeNull();
        });

        it('should stop preview presence interval', async () => {
            subscriptionManager.previewChannelId = 'preview-stream';
            subscriptionManager.previewPresenceInterval = setInterval(() => {}, 1000);
            
            await subscriptionManager.promotePreviewToActive('preview-stream');
            
            expect(subscriptionManager.previewPresenceInterval).toBeNull();
        });

        it('should not promote if not current preview channel', async () => {
            subscriptionManager.previewChannelId = 'other-stream';
            
            await subscriptionManager.promotePreviewToActive('different-stream');
            
            expect(subscriptionManager.activeChannelId).toBeNull();
        });

        it('should not promote if no preview channel', async () => {
            subscriptionManager.previewChannelId = null;
            
            await subscriptionManager.promotePreviewToActive('stream');
            
            expect(subscriptionManager.activeChannelId).toBeNull();
        });
    });

    describe('downgradeToBackground()', () => {
        it('should store activity state from messages', async () => {
            const now = Date.now();
            channelManager.getChannel.mockReturnValue({
                messages: [{ timestamp: now - 1000 }, { timestamp: now }],
                ephemeralStreamId: 'stream1/ephemeral'
            });
            
            await subscriptionManager.downgradeToBackground('stream1');
            
            const activity = subscriptionManager.channelActivity.get('stream1');
            expect(activity.lastMessageTime).toBe(now);
        });

        it('should unsubscribe from both streams', async () => {
            channelManager.getChannel.mockReturnValue({
                messages: [],
                ephemeralStreamId: 'stream1/ephemeral'
            });
            
            await subscriptionManager.downgradeToBackground('stream1');
            
            expect(streamrController.unsubscribeFromDualStream).toHaveBeenCalledWith('stream1', 'stream1/ephemeral');
        });

        it('should derive ephemeral ID if not in channel', async () => {
            channelManager.getChannel.mockReturnValue({
                messages: []
            });
            
            await subscriptionManager.downgradeToBackground('stream1');
            
            expect(streamrController.unsubscribeFromDualStream).toHaveBeenCalledWith('stream1', 'stream1/ephemeral');
        });

        it('should handle null streamId gracefully', async () => {
            await subscriptionManager.downgradeToBackground(null);
            
            expect(streamrController.unsubscribeFromDualStream).not.toHaveBeenCalled();
        });

        it('should handle unsubscribe error gracefully', async () => {
            channelManager.getChannel.mockReturnValue({ messages: [], ephemeralStreamId: 'stream1/ephemeral' });
            streamrController.unsubscribeFromDualStream.mockRejectedValue(new Error('Unsubscribe failed'));
            
            // Should not throw
            await subscriptionManager.downgradeToBackground('stream1');
        });
    });

    // Stub for streamrController.fetchHistoryAsync — invokes the per-message
    // handler with each provided message (mirrors the real {last:N} resend).
    function stubFetchHistoryAsync(messages = []) {
        streamrController.fetchHistoryAsync = vi.fn().mockImplementation(
            async (_streamId, _partition, _count, handler) => {
                for (const m of messages) await handler(m);
            }
        );
        return streamrController.fetchHistoryAsync;
    }

    describe('pollBackgroundChannels()', () => {
        beforeEach(() => {
            stubFetchHistoryAsync();
        });

        it('should skip if already polling', async () => {
            subscriptionManager.isPolling = true;
            channelManager.getAllChannels.mockReturnValue([{ messageStreamId: 'stream1' }]);
            
            await subscriptionManager.pollBackgroundChannels();
            
            expect(streamrController.fetchHistoryAsync).not.toHaveBeenCalled();
        });

        it('should skip active channel', async () => {
            subscriptionManager.activeChannelId = 'stream1';
            channelManager.getAllChannels.mockReturnValue([
                { messageStreamId: 'stream1' },
                { messageStreamId: 'stream2' }
            ]);
            subscriptionManager.channelActivity.set('stream2', { lastMessageTime: 0, unreadCount: 0, lastChecked: 0 });
            
            await subscriptionManager.pollBackgroundChannels();
            
            // Should only poll stream2
            const calls = streamrController.fetchHistoryAsync.mock.calls;
            const polledIds = calls.map(c => c[0]);
            expect(polledIds).not.toContain('stream1');
        });

        it('should process channels in batches', async () => {
            // Use shorter stagger delay for test
            subscriptionManager.config.POLL_STAGGER_DELAY = 0;
            
            channelManager.getAllChannels.mockReturnValue([
                { messageStreamId: 'stream1' },
                { messageStreamId: 'stream2' },
                { messageStreamId: 'stream3' },
                { messageStreamId: 'stream4' },
                { messageStreamId: 'stream5' }
            ]);
            
            // Initialize activity with lastChecked = 0 so all pass the MIN_POLL_INTERVAL check
            for (let i = 1; i <= 5; i++) {
                subscriptionManager.channelActivity.set(`stream${i}`, { lastMessageTime: 0, unreadCount: 0, lastChecked: 0 });
            }
            
            // Need to use real timers for this test since it awaits setTimeout
            vi.useRealTimers();
            
            await subscriptionManager.pollBackgroundChannels();
            
            // POLL_BATCH_SIZE is 3 by default
            expect(streamrController.fetchHistoryAsync.mock.calls.length).toBeLessThanOrEqual(3);
            
            vi.useFakeTimers();
        });

        it('should set isPolling flag during polling', async () => {
            channelManager.getAllChannels.mockReturnValue([]);
            
            const pollingDuringCall = subscriptionManager.isPolling;
            await subscriptionManager.pollBackgroundChannels();
            
            expect(subscriptionManager.isPolling).toBe(false);
        });

        it('should respect MIN_POLL_INTERVAL', async () => {
            channelManager.getAllChannels.mockReturnValue([{ messageStreamId: 'stream1' }]);
            subscriptionManager.channelActivity.set('stream1', {
                lastMessageTime: 0,
                unreadCount: 0,
                lastChecked: Date.now() // Just checked
            });
            
            await subscriptionManager.pollBackgroundChannels();
            
            expect(streamrController.fetchHistoryAsync).not.toHaveBeenCalled();
        });

        it('should skip when no background channels', async () => {
            channelManager.getAllChannels.mockReturnValue([]);
            
            await subscriptionManager.pollBackgroundChannels();
            
            expect(streamrController.fetchHistoryAsync).not.toHaveBeenCalled();
        });
    });

    describe('checkChannelActivity()', () => {
        beforeEach(() => {
            stubFetchHistoryAsync();
        });

        it('should fetch recent history for channel', async () => {
            const channel = { messageStreamId: 'stream1', password: null };
            subscriptionManager.channelActivity.set('stream1', { lastMessageTime: 0, unreadCount: 0, lastChecked: 0 });
            
            await subscriptionManager.checkChannelActivity(channel);
            
            expect(streamrController.fetchHistoryAsync).toHaveBeenCalled();
            expect(streamrController.fetchHistoryAsync.mock.calls[0][0]).toBe('stream1');
        });

        it('should count new messages since last check', async () => {
            const now = Date.now();
            stubFetchHistoryAsync([
                { id: 'm1', text: 'hello', sender: '0x1', timestamp: now - 500 },
                { id: 'm2', text: 'world', sender: '0x2', timestamp: now - 100 }
            ]);
            subscriptionManager.channelActivity.set('stream1', { lastMessageTime: now - 1000, unreadCount: 0, lastChecked: 0 });
            
            await subscriptionManager.checkChannelActivity({ messageStreamId: 'stream1' });
            
            const activity = subscriptionManager.channelActivity.get('stream1');
            expect(activity.unreadCount).toBe(2);
        });

        it('should update lastMessageTime to latest', async () => {
            const now = Date.now();
            stubFetchHistoryAsync([
                { id: 'm1', text: 'hello', sender: '0x1', timestamp: now - 500 },
                { id: 'm2', text: 'world', sender: '0x2', timestamp: now - 100 }
            ]);
            subscriptionManager.channelActivity.set('stream1', { lastMessageTime: now - 1000, unreadCount: 0, lastChecked: 0 });
            
            await subscriptionManager.checkChannelActivity({ messageStreamId: 'stream1' });
            
            const activity = subscriptionManager.channelActivity.get('stream1');
            expect(activity.lastMessageTime).toBe(now - 100);
        });

        it('should notify handlers on new activity', async () => {
            const handler = vi.fn();
            subscriptionManager.activityHandlers = [handler];
            const now = Date.now();
            stubFetchHistoryAsync([{ id: 'm1', text: 'hello', sender: '0x1', timestamp: now }]);
            subscriptionManager.channelActivity.set('stream1', { lastMessageTime: now - 1000, unreadCount: 0, lastChecked: 0 });
            
            await subscriptionManager.checkChannelActivity({ messageStreamId: 'stream1' });
            
            expect(handler).toHaveBeenCalledWith('stream1', expect.objectContaining({ unreadCount: 1 }));
        });

        it('should push the newest previewable message into channelLatestMessageManager', async () => {
            const now = Date.now();
            stubFetchHistoryAsync([
                { id: 'm1', type: 'text', text: 'older', account: '0x1', senderName: 'Alice', timestamp: now - 500 },
                { id: 'm2', type: 'reaction', emoji: '🔥', account: '0x2', timestamp: now - 300 },
                { id: 'm3', type: 'text', text: 'newest', account: '0x3', senderName: 'Bob', timestamp: now - 100 }
            ]);
            subscriptionManager.channelActivity.set('stream1', { lastMessageTime: now - 1000, unreadCount: 0, lastChecked: 0 });

            await subscriptionManager.checkChannelActivity({ messageStreamId: 'stream1' });

            expect(channelLatestMessageManager.setFromLocal).toHaveBeenCalledWith('stream1', expect.objectContaining({
                id: 'm3',
                text: 'newest',
                sender: '0x3',
                senderName: 'Bob',
                timestamp: now - 100
            }));
        });

        it('should not update the preview when only reactions are newer', async () => {
            const now = Date.now();
            stubFetchHistoryAsync([
                { id: 'm1', type: 'reaction', emoji: '🔥', account: '0x1', timestamp: now - 100 }
            ]);
            subscriptionManager.channelActivity.set('stream1', { lastMessageTime: now - 1000, unreadCount: 0, lastChecked: 0 });

            await subscriptionManager.checkChannelActivity({ messageStreamId: 'stream1' });

            expect(channelLatestMessageManager.setFromLocal).not.toHaveBeenCalled();
        });

        it('should not notify if no new messages', async () => {
            const handler = vi.fn();
            subscriptionManager.activityHandlers = [handler];
            stubFetchHistoryAsync([]);
            subscriptionManager.channelActivity.set('stream1', { lastMessageTime: Date.now(), unreadCount: 0, lastChecked: 0 });
            
            await subscriptionManager.checkChannelActivity({ messageStreamId: 'stream1' });
            
            expect(handler).not.toHaveBeenCalled();
        });

        it('should update lastChecked even on error', async () => {
            streamrController.fetchHistoryAsync = vi.fn().mockRejectedValue(new Error('Fetch failed'));
            const beforeTime = Date.now();
            subscriptionManager.channelActivity.set('stream1', { lastMessageTime: 0, unreadCount: 0, lastChecked: 0 });
            
            await expect(subscriptionManager.checkChannelActivity({ messageStreamId: 'stream1' })).rejects.toThrow();
            
            const activity = subscriptionManager.channelActivity.get('stream1');
            expect(activity.lastChecked).toBeGreaterThanOrEqual(beforeTime);
        });

        it('should use channel password for fetch', async () => {
            const channel = { messageStreamId: 'stream1', password: 'secret' };
            subscriptionManager.channelActivity.set('stream1', { lastMessageTime: 0, unreadCount: 0, lastChecked: 0 });
            
            await subscriptionManager.checkChannelActivity(channel);
            
            // fetchHistoryAsync(streamId, partition, count, handler, password, ...)
            expect(streamrController.fetchHistoryAsync.mock.calls[0][4]).toBe('secret');
        });

        it('should handle streamId fallback', async () => {
            const channel = { streamId: 'legacy-stream' };
            subscriptionManager.channelActivity.set('legacy-stream', { lastMessageTime: 0, unreadCount: 0, lastChecked: 0 });
            
            await subscriptionManager.checkChannelActivity(channel);
            
            expect(streamrController.fetchHistoryAsync.mock.calls[0][0]).toBe('legacy-stream');
        });
    });

    describe('forcePollChannel()', () => {
        beforeEach(() => {
            stubFetchHistoryAsync();
        });

        it('should poll specified channel', async () => {
            channelManager.getChannel.mockReturnValue({ messageStreamId: 'stream1' });
            subscriptionManager.channelActivity.set('stream1', { lastMessageTime: 0, unreadCount: 0, lastChecked: 0 });
            
            await subscriptionManager.forcePollChannel('stream1');
            
            expect(streamrController.fetchHistoryAsync).toHaveBeenCalled();
        });

        it('should skip if channel not found', async () => {
            channelManager.getChannel.mockReturnValue(null);
            
            await subscriptionManager.forcePollChannel('unknown');
            
            expect(streamrController.fetchOlderHistory).not.toHaveBeenCalled();
        });

        it('should skip active channel', async () => {
            subscriptionManager.activeChannelId = 'stream1';
            channelManager.getChannel.mockReturnValue({ messageStreamId: 'stream1' });
            
            await subscriptionManager.forcePollChannel('stream1');
            
            expect(streamrController.fetchOlderHistory).not.toHaveBeenCalled();
        });

        it('should handle polling error gracefully', async () => {
            channelManager.getChannel.mockReturnValue({ messageStreamId: 'stream1' });
            subscriptionManager.channelActivity.set('stream1', { lastMessageTime: 0, unreadCount: 0, lastChecked: 0 });
            streamrController.fetchOlderHistory.mockRejectedValue(new Error('Poll failed'));
            
            // Should not throw
            await subscriptionManager.forcePollChannel('stream1');
        });
    });

    describe('_stopPreviewPresence()', () => {
        it('should clear preview presence interval', () => {
            subscriptionManager.previewPresenceInterval = setInterval(() => {}, 1000);
            
            subscriptionManager._stopPreviewPresence();
            
            expect(subscriptionManager.previewPresenceInterval).toBeNull();
        });

        it('should handle null interval gracefully', () => {
            subscriptionManager.previewPresenceInterval = null;
            
            // Should not throw
            subscriptionManager._stopPreviewPresence();
            
            expect(subscriptionManager.previewPresenceInterval).toBeNull();
        });
    });

    describe('_handlePreviewMessage()', () => {
        it('should forward to channelManager if channel exists', () => {
            subscriptionManager.previewChannelId = 'stream1';
            channelManager.getChannel.mockReturnValue({ streamId: 'stream1' });
            const msg = { id: 'msg1', type: 'text' };

            subscriptionManager._handlePreviewMessage('stream1', msg);

            expect(channelManager.handleTextMessage).toHaveBeenCalledWith('stream1', msg);
        });

        it('should forward to onPreviewMessage callback if channel not in manager', () => {
            subscriptionManager.previewChannelId = 'stream1';
            channelManager.getChannel.mockReturnValue(null);
            const callback = vi.fn();
            subscriptionManager.onPreviewMessage = callback;
            const msg = { id: 'msg1' };

            subscriptionManager._handlePreviewMessage('stream1', msg);

            expect(callback).toHaveBeenCalledWith(msg);

            subscriptionManager.onPreviewMessage = null;
        });

        it('should forward to channelManager when source matches activeChannelId (post-promote)', () => {
            // After promotePreviewToActive the preview slot is null but
            // the stream is in channelManager and tracked as active.
            subscriptionManager.previewChannelId = null;
            subscriptionManager.activeChannelId = 'active-stream';
            channelManager.getChannel.mockReturnValue({ streamId: 'active-stream' });

            subscriptionManager._handlePreviewMessage('active-stream', { id: 'msg1' });

            expect(channelManager.handleTextMessage).toHaveBeenCalledWith('active-stream', expect.any(Object));
        });

        it('should drop messages from orphan/stale subscriptions', () => {
            // sourceStreamId doesn't match preview/active and channel is
            // not registered — typical rapid-Explore-switch leak signature.
            subscriptionManager.previewChannelId = 'current-preview';
            subscriptionManager.activeChannelId = null;
            channelManager.getChannel.mockReturnValue(null);
            subscriptionManager.onPreviewMessage = vi.fn();
            // Stub the orphan unsub so we don't hit streamrController in tests.
            subscriptionManager._scheduleOrphanPreviewUnsub = vi.fn();

            subscriptionManager._handlePreviewMessage('stale-stream', { id: 'msg1' });

            expect(channelManager.handleTextMessage).not.toHaveBeenCalled();
            expect(subscriptionManager.onPreviewMessage).not.toHaveBeenCalled();
            expect(subscriptionManager._scheduleOrphanPreviewUnsub).toHaveBeenCalledWith('stale-stream');

            subscriptionManager.onPreviewMessage = null;
        });
    });

    describe('_handlePreviewEphemeral()', () => {
        it('should handle presence messages', () => {
            subscriptionManager.previewChannelId = 'stream1';
            const msg = { type: 'presence', user: 'testuser' };

            subscriptionManager._handlePreviewEphemeral('stream1', msg);

            expect(channelManager.handlePresenceMessage).toHaveBeenCalledWith('stream1', msg);
        });

        it('should handle typing messages', () => {
            subscriptionManager.previewChannelId = 'stream1';
            channelManager.notifyHandlers = vi.fn();
            const msg = { type: 'typing', user: 'testuser' };

            subscriptionManager._handlePreviewEphemeral('stream1', msg);

            expect(channelManager.notifyHandlers).toHaveBeenCalledWith('typing', expect.objectContaining({ streamId: 'stream1' }));
        });

        it('should drop ephemerals from orphan/stale subscriptions', () => {
            subscriptionManager.previewChannelId = 'current-preview';
            subscriptionManager.activeChannelId = null;
            channelManager.getChannel.mockReturnValue(null);
            channelManager.handlePresenceMessage.mockClear?.();
            subscriptionManager._scheduleOrphanPreviewUnsub = vi.fn();

            subscriptionManager._handlePreviewEphemeral('stale-stream', { type: 'presence' });

            expect(channelManager.handlePresenceMessage).not.toHaveBeenCalled();
            expect(subscriptionManager._scheduleOrphanPreviewUnsub).toHaveBeenCalledWith('stale-stream');
        });
    });

    describe('Config defaults', () => {
        it('should have correct POLL_STAGGER_DELAY', () => {
            expect(subscriptionManager.config.POLL_STAGGER_DELAY).toBe(2000);
        });

        it('should have correct MIN_POLL_INTERVAL', () => {
            expect(subscriptionManager.config.MIN_POLL_INTERVAL).toBe(10000);
        });

        it('should have correct MAX_CONCURRENT_SUBS', () => {
            expect(subscriptionManager.config.MAX_CONCURRENT_SUBS).toBe(1);
        });

        it('should have correct ACTIVITY_CHECK_MESSAGES', () => {
            expect(subscriptionManager.config.ACTIVITY_CHECK_MESSAGES).toBe(3);
        });
    });
});
