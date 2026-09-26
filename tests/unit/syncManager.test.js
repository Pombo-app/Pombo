/**
 * SyncManager Module Tests
 * Tests for cross-device synchronization functionality
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Mock dependencies before importing syncManager
vi.mock('../../src/js/logger.js', () => ({
    Logger: {
        info: vi.fn(),
        debug: vi.fn(),
        warn: vi.fn(),
        error: vi.fn()
    }
}));

vi.mock('../../src/js/config.js', () => ({
    CONFIG: {
        dm: {
            maxSentMessages: 200
        }
    }
}));

vi.mock('../../src/js/streamr.js', () => ({
    streamrController: {
        getDMInboxId: vi.fn().mockReturnValue('0xabc/Pombo-DM-1'),
        publish: vi.fn().mockResolvedValue(undefined),
        fetchPartitionHistory: vi.fn().mockResolvedValue([]),
        setDMPublishKey: vi.fn().mockResolvedValue(undefined),
        addDMDecryptKey: vi.fn().mockResolvedValue(undefined)
    },
    STREAM_CONFIG: {
        MESSAGE_STREAM: {
            PARTITIONS: 1,
            DM_PARTITIONS: 3,
            MESSAGES: 0,
            SYNC: 1,
            SYNC_BLOBS: 2
        }
    }
}));

vi.mock('../../src/js/dm.js', () => ({
    dmManager: {
        hasInbox: vi.fn().mockResolvedValue(true),
        sealAndPublish: vi.fn().mockResolvedValue({ messageId: { publisherId: '0xEphemeral' } })
    }
}));

vi.mock('../../src/js/secureStorage.js', () => ({
    secureStorage: {
        exportForSync: vi.fn().mockReturnValue({
            sentMessages: {},
            sentReactions: {},
            channels: [],
            blockedPeers: [],
            dmLeftAt: {},
            trustedContacts: {},
            ensCache: {},
            username: null,
            graphApiKey: null
        }),
        exportForBackup: vi.fn().mockReturnValue({
            sentMessages: {},
            sentReactions: {},
            channels: [],
            blockedPeers: [],
            dmLeftAt: {},
            trustedContacts: {},
            ensCache: {},
            username: null,
            graphApiKey: null
        }),
        importFromSync: vi.fn().mockResolvedValue({
            hasChanges: false,
            channelsUpdated: false,
            contactsUpdated: false,
            blockedPeersUpdated: false,
            usernameUpdated: false
        }),
        getUnsyncedImages: vi.fn().mockReturnValue({ [Symbol.asyncIterator]: () => ({ next: () => Promise.resolve({ done: true }) }) }),
        decryptBlob: vi.fn().mockResolvedValue('base64data'),
        markImageSynced: vi.fn().mockResolvedValue(undefined),
        saveImageToLedger: vi.fn().mockResolvedValue(undefined)
    }
}));

vi.mock('../../src/js/auth.js', () => ({
    authManager: {
        isGuestMode: vi.fn().mockReturnValue(false),
        getAddress: vi.fn().mockReturnValue('0xabc123'),
        wallet: null  // Will be set per test
    }
}));

vi.mock('../../src/js/dmCrypto.js', () => ({
    dmCrypto: {
        getMyPublicKey: vi.fn().mockReturnValue('0x02abcdef'),
        deriveSharedKey: vi.fn().mockResolvedValue({ type: 'secret' }),
        encrypt: vi.fn().mockResolvedValue({ ct: 'encrypted', iv: 'iv123', e: 'aes-256-gcm' }),
        decrypt: vi.fn().mockImplementation(async (env) => env._decrypted || { type: 'sync', v: 1, ts: Date.now(), data: {} }),
        isEncrypted: vi.fn().mockReturnValue(true),
        // Sealed sender (v2). Default off — legacy self-ECDH still has to work
        // for sync history already in storage.
        isSealed: vi.fn().mockReturnValue(false),
        open: vi.fn().mockResolvedValue({ sender: '0xabc123', message: { type: 'sync', v: 1 } })
    }
}));

vi.mock('../../src/js/channels.js', () => ({
    channelManager: {
        reloadChannelsFromSync: vi.fn().mockReturnValue({
            currentChannelRemoved: false,
            totalChannels: 0
        })
    }
}));

vi.mock('../../src/js/identity.js', () => ({
    identityManager: {
        loadTrustedContacts: vi.fn(),
        loadUsername: vi.fn()
    }
}));

vi.mock('../../src/js/media.js', () => ({
    mediaController: {
        handleMediaMessage: vi.fn()
    }
}));

import { syncManager } from '../../src/js/syncManager.js';
import { authManager } from '../../src/js/auth.js';
import { streamrController } from '../../src/js/streamr.js';
import { secureStorage } from '../../src/js/secureStorage.js';
import { dmCrypto } from '../../src/js/dmCrypto.js';
import { channelManager } from '../../src/js/channels.js';
import { identityManager } from '../../src/js/identity.js';
import { dmManager } from '../../src/js/dm.js';

describe('syncManager', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        syncManager.cancelAutoPush();
        syncManager.isSyncing = false;
        syncManager.lastSyncTs = null;
        syncManager.handlers = [];
        syncManager.pushQueued = false;
        syncManager.autoPushRetryCount = 0;
        syncManager.cancelPushConfirmation();
        // Reset authManager state
        authManager.wallet = { privateKey: '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef' };
        authManager.isGuestMode.mockReturnValue(false);
        authManager.getAddress.mockReturnValue('0xabc123');
        localStorage.clear();
    });

    describe('constructor', () => {
        it('should initialize with default state', () => {
            expect(syncManager.isSyncing).toBe(false);
            expect(syncManager.lastSyncTs).toBe(null);
            expect(syncManager.handlers).toEqual([]);
        });
    });

    describe('on/off event handlers', () => {
        it('should register event handler', () => {
            const handler = vi.fn();
            syncManager.on('sync_pushed', handler);
            
            expect(syncManager.handlers).toHaveLength(1);
            expect(syncManager.handlers[0]).toEqual({ event: 'sync_pushed', handler });
        });

        it('should remove event handler', () => {
            const handler = vi.fn();
            syncManager.on('sync_pushed', handler);
            syncManager.off('sync_pushed', handler);
            
            expect(syncManager.handlers).toHaveLength(0);
        });

        it('should only remove matching handler', () => {
            const handler1 = vi.fn();
            const handler2 = vi.fn();
            syncManager.on('sync_pushed', handler1);
            syncManager.on('sync_pushed', handler2);
            syncManager.off('sync_pushed', handler1);
            
            expect(syncManager.handlers).toHaveLength(1);
            expect(syncManager.handlers[0].handler).toBe(handler2);
        });
    });

    describe('notifyHandlers', () => {
        it('should call matching handlers', () => {
            const handler = vi.fn();
            syncManager.on('sync_pushed', handler);
            
            syncManager.notifyHandlers('sync_pushed', { ts: 12345 });
            
            expect(handler).toHaveBeenCalledWith({ ts: 12345 });
        });

        it('should not call non-matching handlers', () => {
            const handler = vi.fn();
            syncManager.on('sync_pulled', handler);
            
            syncManager.notifyHandlers('sync_pushed', { ts: 12345 });
            
            expect(handler).not.toHaveBeenCalled();
        });

        it('should continue if handler throws', () => {
            const handler1 = vi.fn().mockImplementation(() => { throw new Error('test'); });
            const handler2 = vi.fn();
            syncManager.on('sync_pushed', handler1);
            syncManager.on('sync_pushed', handler2);
            
            syncManager.notifyHandlers('sync_pushed', { ts: 12345 });
            
            expect(handler2).toHaveBeenCalled();
        });
    });

    describe('getInboxStreamId', () => {
        it('should return inbox stream ID', () => {
            authManager.getAddress.mockReturnValue('0xabc123');
            streamrController.getDMInboxId.mockReturnValue('0xabc123/Pombo-DM-1');
            
            const result = syncManager.getInboxStreamId();
            
            expect(result).toBe('0xabc123/Pombo-DM-1');
        });

        it('should return null if no address', () => {
            authManager.getAddress.mockReturnValue(null);
            
            const result = syncManager.getInboxStreamId();
            
            expect(result).toBe(null);
        });
    });

    describe('pushSync', () => {
        it('should skip in guest mode', async () => {
            authManager.isGuestMode.mockReturnValue(true);
            
            await syncManager.pushSync();
            
            expect(streamrController.publish).not.toHaveBeenCalled();
        });

        it('should skip if already syncing', async () => {
            syncManager.isSyncing = true;
            
            await syncManager.pushSync();
            
            expect(streamrController.publish).not.toHaveBeenCalled();
        });

        it('should throw if no private key', async () => {
            authManager.wallet = null;
            
            await expect(syncManager.pushSync()).rejects.toThrow('No wallet private key');
        });

        it('should encrypt and publish sync payload', async () => {
            authManager.wallet = { privateKey: '0x1234' };
            const mockState = { channels: [], sentMessages: {} };
            secureStorage.exportForSync.mockReturnValue(mockState);
            
            await syncManager.pushSync();
            
            // Sealed to ourselves and published under a throwaway identity
            expect(dmManager.sealAndPublish).toHaveBeenCalledWith(
                expect.any(String),
                expect.any(String),                          // our own address
                expect.objectContaining({ type: 'sync' }),
                1                                            // SYNC partition
            );
        });

        it('should update lastSyncTs after push', async () => {
            authManager.wallet = { privateKey: '0x1234' };
            const before = Date.now();
            
            await syncManager.pushSync();
            
            expect(syncManager.lastSyncTs).toBeGreaterThanOrEqual(before);
        });

        it('should reset isSyncing even on error', async () => {
            authManager.wallet = { privateKey: '0x1234' };
            dmManager.sealAndPublish.mockRejectedValueOnce(new Error("Network error"));
            
            await expect(syncManager.pushSync()).rejects.toThrow();
            
            expect(syncManager.isSyncing).toBe(false);
        });

        it('should record the pushed payload ts as applied', async () => {
            authManager.wallet = { privateKey: '0x1234' };
            streamrController.publish.mockResolvedValue(undefined);

            await syncManager.pushSync();

            expect(syncManager._getAppliedTsSet().has(syncManager.lastSyncTs)).toBe(true);
        });
    });

    describe('pullSync', () => {
        it('should skip in guest mode', async () => {
            authManager.isGuestMode.mockReturnValue(true);
            
            const result = await syncManager.pullSync();
            
            expect(result).toBe(null);
        });

        it('should skip if already syncing', async () => {
            syncManager.isSyncing = true;
            
            const result = await syncManager.pullSync();
            
            expect(result).toBe(null);
        });

        it('should return null if no messages', async () => {
            authManager.wallet = { privateKey: '0x1234' };
            streamrController.fetchPartitionHistory.mockResolvedValue([]);
            
            const result = await syncManager.pullSync();
            
            expect(result).toBe(null);
        });

        it('should ignore payloads it cannot open', async () => {
            // The publisherId check is gone: sealed pushes carry a throwaway
            // publisher, so "is the publisher me?" rejected our own sync.
            // The guarantee is unchanged and arguably stronger — payloads are
            // encrypted to our own key, so anything we cannot open is not ours.
            // Anyone may drop junk in the inbox; nobody else can make it open.
            authManager.wallet = { privateKey: '0x1234' };
            authManager.getAddress.mockReturnValue('0xabc123');
            streamrController.fetchPartitionHistory.mockResolvedValue([
                { content: { ct: 'junk from a stranger' }, publisherId: '0xOTHER', timestamp: 1000 }
            ]);
            dmCrypto.decrypt.mockRejectedValueOnce(new Error('bad auth tag'));

            const result = await syncManager.pullSync();

            expect(result).toBe(null);
        });

        it('should decrypt and merge payloads', async () => {
            authManager.wallet = { privateKey: '0x1234' };
            authManager.getAddress.mockReturnValue('0xabc123');
            
            const syncPayload = { type: 'sync', v: 1, ts: 1000, data: { channels: ['ch1'] } };
            dmCrypto.decrypt.mockResolvedValue(syncPayload);
            
            streamrController.fetchPartitionHistory.mockResolvedValue([
                { content: { ct: 'enc' }, publisherId: '0xABC123', timestamp: 1000 }
            ]);
            
            await syncManager.pullSync();
            
            expect(secureStorage.importFromSync).toHaveBeenCalled();
        });

        it('should skip payloads already applied in a previous pull (stale replica no-op)', async () => {
            authManager.wallet = { privateKey: '0x1234' };
            authManager.getAddress.mockReturnValue('0xabc123');

            syncManager._recordAppliedTs([1000]);
            dmCrypto.decrypt.mockResolvedValue({ type: 'sync', v: 1, ts: 1000, data: {} });
            streamrController.fetchPartitionHistory.mockResolvedValue([
                { content: { ct: 'enc' }, publisherId: '0xABC123', timestamp: 1000 }
            ]);

            const result = await syncManager.pullSync();

            expect(result).toBe(null);
            expect(secureStorage.importFromSync).not.toHaveBeenCalled();
            // No retry: newest fetched equals newest applied (normal no-change pull)
            expect(streamrController.fetchPartitionHistory).toHaveBeenCalledTimes(1);
        });

        it('should retry once on a provably stale read and merge newly found payloads', async () => {
            authManager.wallet = { privateKey: '0x1234' };
            authManager.getAddress.mockReturnValue('0xabc123');

            // We've already applied up to ts 2000, but the first resend only
            // returns ts 1000 — provably stale replica read.
            syncManager._recordAppliedTs([1000, 2000]);
            dmCrypto.decrypt.mockImplementation(async (env) => env._decrypted);
            streamrController.fetchPartitionHistory
                .mockResolvedValueOnce([
                    { content: { ct: 'enc', _decrypted: { type: 'sync', v: 1, ts: 1000, data: {} } }, publisherId: '0xABC123', timestamp: 1000 }
                ])
                .mockResolvedValueOnce([
                    { content: { ct: 'enc', _decrypted: { type: 'sync', v: 1, ts: 1000, data: {} } }, publisherId: '0xABC123', timestamp: 1000 },
                    { content: { ct: 'enc', _decrypted: { type: 'sync', v: 1, ts: 3000, data: { username: 'fresh' } } }, publisherId: '0xABC123', timestamp: 3000 }
                ]);

            const result = await syncManager.pullSync();

            expect(streamrController.fetchPartitionHistory).toHaveBeenCalledTimes(2);
            expect(secureStorage.importFromSync).toHaveBeenCalled();
            expect(result).not.toBe(null);
            // The newly discovered payload is now recorded as applied
            expect(syncManager._getAppliedTsSet().has(3000)).toBe(true);
        });

        it('should reload channels if updated', async () => {
            authManager.wallet = { privateKey: '0x1234' };
            authManager.getAddress.mockReturnValue('0xabc123');
            
            const syncPayload = { type: 'sync', v: 1, ts: 1000, data: { channels: ['ch1'] } };
            dmCrypto.decrypt.mockResolvedValue(syncPayload);
            secureStorage.importFromSync.mockImplementation(async (data, { onChannelsWritten } = {}) => {
                onChannelsWritten?.();
                return {
                    hasChanges: true,
                    channelsUpdated: true,
                    contactsUpdated: false,
                    blockedPeersUpdated: false,
                    usernameUpdated: false
                };
            });

            streamrController.fetchPartitionHistory.mockResolvedValue([
                { content: { ct: 'enc' }, publisherId: '0xABC123', timestamp: 1000 }
            ]);

            await syncManager.pullSync();

            expect(channelManager.reloadChannelsFromSync).toHaveBeenCalled();
        });

        it('reloads the channel map before the import yields, so a concurrent save cannot overwrite it', async () => {
            authManager.wallet = { privateKey: '0x1234' };
            authManager.getAddress.mockReturnValue('0xabc123');
            dmCrypto.decrypt.mockResolvedValue({ type: 'sync', v: 1, ts: 1000, data: { channels: ['ch1'] } });
            const order = [];
            secureStorage.importFromSync.mockImplementation(async (data, { onChannelsWritten } = {}) => {
                order.push('cache written');
                onChannelsWritten?.();
                await Promise.resolve();
                order.push('import yielded');
                return { hasChanges: true, channelsUpdated: true };
            });
            channelManager.reloadChannelsFromSync.mockImplementation(() => {
                order.push('map reloaded');
                return { currentChannelRemoved: false };
            });
            streamrController.fetchPartitionHistory.mockResolvedValue([
                { content: { ct: 'enc' }, publisherId: '0xABC123', timestamp: 1000 }
            ]);

            await syncManager.pullSync();

            expect(order).toEqual(['cache written', 'map reloaded', 'import yielded']);
        });

        it('should expose currentChannelRemoved in sync_pulled changes', async () => {
            authManager.wallet = { privateKey: '0x1234' };
            authManager.getAddress.mockReturnValue('0xabc123');

            const syncPayload = { type: 'sync', v: 1, ts: 1000, data: { channels: ['ch1'] } };
            const handler = vi.fn();
            dmCrypto.decrypt.mockResolvedValue(syncPayload);
            secureStorage.importFromSync.mockImplementation(async (data, { onChannelsWritten } = {}) => {
                onChannelsWritten?.();
                return {
                    hasChanges: true,
                    channelsUpdated: true,
                    contactsUpdated: false,
                    blockedPeersUpdated: false,
                    usernameUpdated: false
                };
            });
            channelManager.reloadChannelsFromSync.mockReturnValue({
                currentChannelRemoved: true,
                totalChannels: 0
            });

            streamrController.fetchPartitionHistory.mockResolvedValue([
                { content: { ct: 'enc' }, publisherId: '0xABC123', timestamp: 1000 }
            ]);

            syncManager.on('sync_pulled', handler);
            await syncManager.pullSync();

            expect(handler).toHaveBeenCalledWith(expect.objectContaining({
                changes: expect.objectContaining({
                    currentChannelRemoved: true
                })
            }));
        });

        it('should reload username after sync', async () => {
            authManager.wallet = { privateKey: '0x1234' };
            authManager.getAddress.mockReturnValue('0xabc123');
            
            const syncPayload = { type: 'sync', v: 1, ts: 1000, data: { username: 'SyncedName' } };
            dmCrypto.decrypt.mockResolvedValue(syncPayload);
            secureStorage.importFromSync.mockResolvedValue({
                hasChanges: true,
                channelsUpdated: false,
                contactsUpdated: false,
                blockedPeersUpdated: false,
                usernameUpdated: true
            });
            
            streamrController.fetchPartitionHistory.mockResolvedValue([
                { content: { ct: 'enc' }, publisherId: '0xABC123', timestamp: 1000 }
            ]);
            
            await syncManager.pullSync();
            
            expect(identityManager.loadUsername).toHaveBeenCalled();
        });

        it('should reload trusted contacts after sync', async () => {
            authManager.wallet = { privateKey: '0x1234' };
            authManager.getAddress.mockReturnValue('0xabc123');

            const syncPayload = { type: 'sync', v: 1, ts: 1000, data: { trustedContacts: { '0xpeer': { address: '0xpeer' } } } };
            dmCrypto.decrypt.mockResolvedValue(syncPayload);
            secureStorage.importFromSync.mockResolvedValue({
                hasChanges: true,
                channelsUpdated: false,
                contactsUpdated: true,
                blockedPeersUpdated: false,
                usernameUpdated: false
            });

            streamrController.fetchPartitionHistory.mockResolvedValue([
                { content: { ct: 'enc' }, publisherId: '0xABC123', timestamp: 1000 }
            ]);

            await syncManager.pullSync();

            expect(identityManager.loadTrustedContacts).toHaveBeenCalled();
        });

        it('should preserve an optimistic local channel snapshot when remote history is stale', async () => {
            authManager.wallet = { privateKey: '0x1234' };
            authManager.getAddress.mockReturnValue('0xabc123');

            const localChannels = [{ messageStreamId: 'ch-new', name: 'New Channel' }];
            const staleRemoteChannels = [{ messageStreamId: 'ch-old', name: 'Old Channel' }];

            secureStorage.exportForBackup.mockReturnValue({
                sentMessages: {},
                sentReactions: {},
                channels: localChannels,
                blockedPeers: [],
                dmLeftAt: {},
                trustedContacts: {},
                ensCache: {},
                username: null,
                graphApiKey: null
            });

            dmCrypto.decrypt.mockResolvedValue({
                type: 'sync',
                v: 1,
                ts: 1000,
                data: { channels: staleRemoteChannels }
            });

            streamrController.fetchPartitionHistory.mockResolvedValue([
                { content: { ct: 'enc' }, publisherId: '0xABC123', timestamp: 1000 }
            ]);

            await syncManager.pullSync({
                optimisticPayload: {
                    type: 'sync',
                    v: 1,
                    ts: 2000,
                    data: { channels: localChannels }
                }
            });

            // Per-channel merge: the fresh local channel must survive the
            // stale remote snapshot (union, no tombstones involved)
            const imported = secureStorage.importFromSync.mock.calls[0][0];
            expect(imported.channels.map(c => c.messageStreamId)).toContain('ch-new');
        });

        it('should keep a channel added to the cache while the merge ran', async () => {
            authManager.wallet = { privateKey: '0x1234' };
            authManager.getAddress.mockReturnValue('0xabc123');

            const emptyState = {
                sentMessages: {},
                sentReactions: {},
                channels: [],
                channelsLeftAt: {},
                blockedPeers: [],
                dmLeftAt: {},
                trustedContacts: {},
                ensCache: {},
                username: null,
                graphApiKey: null
            };
            // First export feeds the merge; the second (the live re-merge
            // after the merge completes) sees a channel imported meanwhile.
            secureStorage.exportForBackup
                .mockReturnValueOnce(emptyState)
                .mockReturnValueOnce({
                    ...emptyState,
                    channels: [{ messageStreamId: 'ch-imported', name: 'Imported' }]
                });

            dmCrypto.decrypt.mockResolvedValue({
                type: 'sync',
                v: 1,
                ts: 1000,
                data: { channels: [{ messageStreamId: 'ch-remote', name: 'Remote' }] }
            });

            streamrController.fetchPartitionHistory.mockResolvedValue([
                { content: { ct: 'enc' }, publisherId: '0xABC123', timestamp: 1000 }
            ]);

            await syncManager.pullSync();

            const imported = secureStorage.importFromSync.mock.calls[0][0];
            const ids = imported.channels.map(c => c.messageStreamId);
            expect(ids).toContain('ch-imported');
            expect(ids).toContain('ch-remote');
        });

        it('should keep a sent DM deleted while the merge ran deleted', async () => {
            authManager.wallet = { privateKey: '0x1234' };
            authManager.getAddress.mockReturnValue('0xabc123');

            const dm = '0xpeer/Pombo-DM-1';
            const message = { id: 'm1', type: 'text', text: 'hi', timestamp: 100 };
            const state = {
                sentMessages: { [dm]: [message] },
                sentReactions: {},
                channels: [],
                channelsLeftAt: {},
                blockedPeers: [],
                dmLeftAt: {},
                trustedContacts: {},
                ensCache: {},
                username: null,
                graphApiKey: null
            };
            secureStorage.exportForBackup
                .mockReturnValueOnce(state)
                .mockReturnValueOnce({ ...state, sentMessages: { [dm]: [] }, sentDeletedAt: { [dm]: { m1: 500 } } });

            dmCrypto.decrypt.mockResolvedValue({
                type: 'sync',
                v: 1,
                ts: 1000,
                data: { sentMessages: { [dm]: [message] } }
            });
            streamrController.fetchPartitionHistory.mockResolvedValue([
                { content: { ct: 'enc' }, publisherId: '0xABC123', timestamp: 1000 }
            ]);

            await syncManager.pullSync();

            const imported = secureStorage.importFromSync.mock.calls[0][0];
            expect(imported.sentMessages[dm]).toEqual([]);
            expect(imported.sentDeletedAt).toEqual({ [dm]: { m1: 500 } });
        });
    });

    describe('mergeState', () => {
        it('should keep a joined record over a later copy that has no join time', () => {
            const joined = { messageStreamId: 'ch-1', joinedAt: 1000, createdAt: 1000, wireIdentity: 'sealed' };
            const copy = { messageStreamId: 'ch-1', joinedAt: null, createdAt: 5000, wireIdentity: null };

            expect(syncManager.mergeState({ channels: [joined] }, { channels: [copy] }).channels)
                .toEqual([joined]);
            expect(syncManager.mergeState({ channels: [copy] }, { channels: [joined] }).channels)
                .toEqual([joined]);
        });

        it('should keep a re-join without a join time from being lost to the leave before it', () => {
            const joined = { messageStreamId: 'ch-1', joinedAt: 1000, createdAt: 1000, wireIdentity: 'sealed' };
            const rejoin = { messageStreamId: 'ch-1', joinedAt: null, createdAt: 3000, wireIdentity: null };

            const result = syncManager.mergeState(
                { channels: [joined] },
                { channels: [rejoin], channelsLeftAt: { 'ch-1': 2000 } });

            expect(result.channels).toEqual([joined]);
            expect(result.channelsLeftAt['ch-1']).toBeUndefined();
        });

        it('should still let the newer of two joins win', () => {
            const older = { messageStreamId: 'ch-1', joinedAt: 1000, name: 'older' };
            const newer = { messageStreamId: 'ch-1', joinedAt: 2000, name: 'newer' };

            expect(syncManager.mergeState({ channels: [newer] }, { channels: [older] }).channels[0].name)
                .toBe('newer');
            expect(syncManager.mergeState({ channels: [older] }, { channels: [newer] }).channels[0].name)
                .toBe('newer');
        });

        it('should union-merge epoch keys, base wins per entry', () => {
            const base = {
                channels: [{ messageStreamId: 'ch-1', joinedAt: 1000 }],
                epochKeys: {
                    'ch-1': {
                        epochs: { kid2: { keyHex: '0xlocal', epoch: 2 } },
                        announces: { 2: { keyId: 'kid2' } },
                        currentEpoch: 2
                    }
                }
            };
            const incoming = {
                channels: [{ messageStreamId: 'ch-1', joinedAt: 1000 }],
                epochKeys: {
                    'ch-1': {
                        epochs: {
                            kid1: { keyHex: '0xold', epoch: 1 },
                            kid2: { keyHex: '0xremote', epoch: 2 }
                        },
                        announces: { 1: { keyId: 'kid1' } },
                        currentEpoch: 1
                    }
                }
            };

            const result = syncManager.mergeState(base, incoming);

            expect(result.epochKeys['ch-1'].epochs.kid1.keyHex).toBe('0xold');
            expect(result.epochKeys['ch-1'].epochs.kid2.keyHex).toBe('0xlocal');
            expect(result.epochKeys['ch-1'].announces[1].keyId).toBe('kid1');
            expect(result.epochKeys['ch-1'].currentEpoch).toBe(2);
        });

        it('should keep the interactions key when both devices hold the channel', () => {
            const intKey = { keyId: 'i1.x', keyHex: '0xint', address: '0xaa', rev: 1 };
            const intAnnounce = { keyId: 'i1.x', keyHash: '0xh', address: '0xaa', rev: 1 };
            const pubKey = { keyId: 'p1.x', keyHex: '0xpub', address: '0xbb', rev: 1 };
            const base = {
                channels: [{ messageStreamId: 'ch-1', joinedAt: 1000 }],
                epochKeys: { 'ch-1': { epochs: {}, currentEpoch: 1, intKey, intAnnounce } }
            };
            const incoming = {
                channels: [{ messageStreamId: 'ch-1', joinedAt: 1000 }],
                epochKeys: { 'ch-1': { epochs: {}, currentEpoch: 1, pubKey } }
            };

            const merged = syncManager.mergeState(base, incoming).epochKeys['ch-1'];

            expect(merged.intKey).toEqual(intKey);
            expect(merged.intAnnounce).toEqual(intAnnounce);
            expect(merged.pubKey).toEqual(pubKey);
        });

        it('should let a re-keyed interactions key supersede the old one', () => {
            const old = { keyId: 'i1.x', keyHex: '0xold', address: '0xaa', rev: 1 };
            const reset = { keyId: 'i2.y', keyHex: '0xnew', address: '0xcc', rev: 2 };
            const channels = [{ messageStreamId: 'ch-1', joinedAt: 1000 }];

            const merged = syncManager.mergeState(
                { channels, epochKeys: { 'ch-1': { epochs: {}, intKey: old } } },
                { channels, epochKeys: { 'ch-1': { epochs: {}, intKey: reset } } }).epochKeys['ch-1'];

            expect(merged.intKey).toEqual(reset);
        });

        it('should keep epoch keys when the incoming payload predates the slice', () => {
            const base = {
                channels: [{ messageStreamId: 'ch-1', joinedAt: 1000 }],
                epochKeys: { 'ch-1': { epochs: { kid1: { keyHex: '0xaa' } }, currentEpoch: 1 } }
            };
            const incoming = { channels: [{ messageStreamId: 'ch-1', joinedAt: 1000 }] };

            const result = syncManager.mergeState(base, incoming);

            expect(result.epochKeys['ch-1'].epochs.kid1.keyHex).toBe('0xaa');
        });

        it('should retire epoch keys with the channel their tombstone removed', () => {
            const base = {
                channels: [{ messageStreamId: 'ch-1', joinedAt: 1000 }],
                epochKeys: { 'ch-1': { epochs: { kid1: { keyHex: '0xaa' } }, currentEpoch: 1 } }
            };
            const incoming = {
                channels: [],
                channelsLeftAt: { 'ch-1': 2000 }
            };

            const result = syncManager.mergeState(base, incoming);

            expect(result.channels).toHaveLength(0);
            expect(result.epochKeys['ch-1']).toBeUndefined();
        });

        it('should merge sent messages by ID', () => {
            const base = {
                sentMessages: {
                    'stream1': [{ id: 'msg1', timestamp: 1000 }]
                }
            };
            const incoming = {
                sentMessages: {
                    'stream1': [{ id: 'msg2', timestamp: 2000 }]
                }
            };
            
            const result = syncManager.mergeState(base, incoming);
            
            expect(result.sentMessages.stream1).toHaveLength(2);
        });

        it('should deduplicate messages with same ID', () => {
            const base = {
                sentMessages: {
                    'stream1': [{ id: 'msg1', timestamp: 1000 }]
                }
            };
            const incoming = {
                sentMessages: {
                    'stream1': [{ id: 'msg1', timestamp: 1000 }]
                }
            };
            
            const result = syncManager.mergeState(base, incoming);
            
            expect(result.sentMessages.stream1).toHaveLength(1);
        });

        it('should union channels per-channel (LWW-element-set)', () => {
            const base = {
                channels: [{ messageStreamId: 'ch1', name: 'Channel 1' }]
            };
            const incoming = {
                channels: [{ messageStreamId: 'ch2', name: 'Channel 2' }]
            };
            
            const result = syncManager.mergeState(base, incoming);
            
            // Union — without a leave tombstone, both channels survive
            expect(result.channels).toHaveLength(2);
            expect(result.channels.map(c => c.messageStreamId).sort()).toEqual(['ch1', 'ch2']);
        });

        it('should remove a channel when leave tombstone is newer than join', () => {
            const base = {
                channels: [{ messageStreamId: 'ch1', joinedAt: 1000 }]
            };
            const incoming = {
                channels: [],
                channelsLeftAt: { 'ch1': 2000 }
            };

            const result = syncManager.mergeState(base, incoming);

            expect(result.channels).toHaveLength(0);
            expect(result.channelsLeftAt.ch1).toBe(2000);
        });

        it('should keep a re-joined channel when join is newer than leave tombstone', () => {
            const base = {
                // Re-joined locally after having left in the past
                channels: [{ messageStreamId: 'ch1', joinedAt: 3000 }]
            };
            const incoming = {
                // Stale remote snapshot from before the re-join
                channels: [],
                channelsLeftAt: { 'ch1': 2000 }
            };

            const result = syncManager.mergeState(base, incoming);

            expect(result.channels).toHaveLength(1);
            expect(result.channels[0].messageStreamId).toBe('ch1');
            // Superseded tombstone is pruned
            expect(result.channelsLeftAt.ch1).toBeUndefined();
        });

        it('should keep the join on a join/leave timestamp tie', () => {
            const base = {
                channels: [{ messageStreamId: 'ch1', joinedAt: 2000 }]
            };
            const incoming = {
                channels: [],
                channelsLeftAt: { 'ch1': 2000 }
            };

            const result = syncManager.mergeState(base, incoming);

            expect(result.channels).toHaveLength(1);
        });

        it('should prefer incoming channel entry metadata when joins tie', () => {
            const base = {
                channels: [{ messageStreamId: 'ch1', joinedAt: 1000, name: 'Old Name' }]
            };
            const incoming = {
                channels: [{ messageStreamId: 'ch1', joinedAt: 1000, name: 'New Name' }]
            };

            const result = syncManager.mergeState(base, incoming);

            expect(result.channels).toHaveLength(1);
            expect(result.channels[0].name).toBe('New Name');
        });

        it('should fall back to createdAt when joinedAt is missing (legacy entries)', () => {
            const base = {
                channels: [{ messageStreamId: 'ch1', createdAt: 5000 }]
            };
            const incoming = {
                channels: [],
                channelsLeftAt: { 'ch1': 2000 }
            };

            const result = syncManager.mergeState(base, incoming);

            // Legacy join (createdAt) newer than tombstone → kept
            expect(result.channels).toHaveLength(1);
        });

        it('should prefer incoming username if set', () => {
            const base = { username: 'old' };
            const incoming = { username: 'new' };
            
            const result = syncManager.mergeState(base, incoming);
            
            expect(result.username).toBe('new');
        });

        it('should clear username if incoming latest snapshot removes it', () => {
            const base = { username: 'old' };
            const incoming = { username: null, sliceTs: { username: 10 } };

            const result = syncManager.mergeState(base, incoming);

            expect(result.username).toBe(null);
        });

        it('should use latest trustedContacts from incoming', () => {
            const base = { trustedContacts: { '0x1': { level: 1 } } };
            const incoming = { trustedContacts: { '0x2': { level: 2 } } };
            
            const result = syncManager.mergeState(base, incoming);
            
            expect(result.trustedContacts).toEqual(incoming.trustedContacts);
        });

        it('should merge sentReactions with remote-wins strategy', () => {
            const base = {
                sentReactions: {
                    'stream1': { 'msg1': { '👍': ['0x1'] }, 'msg2': { '❤️': ['0x1'] } }
                }
            };
            const incoming = {
                sentReactions: {
                    'stream1': { 'msg1': { '🔥': ['0x1'] } },
                    'stream2': { 'msg3': { '👍': ['0x2'] } }
                }
            };

            const result = syncManager.mergeState(base, incoming);

            // msg1: remote wins (🔥 replaces 👍)
            expect(result.sentReactions.stream1.msg1['🔥']).toEqual(['0x1']);
            expect(result.sentReactions.stream1.msg1['👍']).toBeUndefined();
            // msg2: local-only preserved
            expect(result.sentReactions.stream1.msg2['❤️']).toEqual(['0x1']);
            // stream2: from remote
            expect(result.sentReactions.stream2.msg3['👍']).toEqual(['0x2']);
        });

        it('should use latest blockedPeers from incoming', () => {
            const base = { blockedPeers: ['0xaaa'] };
            const incoming = { blockedPeers: ['0xaaa', '0xbbb'] };

            const result = syncManager.mergeState(base, incoming);

            expect(result.blockedPeers).toEqual(['0xaaa', '0xbbb']);
        });

        it('should keep base blockedPeers when incoming is undefined', () => {
            const base = { blockedPeers: ['0xaaa'] };
            const incoming = {};

            const result = syncManager.mergeState(base, incoming);

            expect(result.blockedPeers).toEqual(['0xaaa']);
        });

        it('should propagate unblock via latest-wins', () => {
            const base = { blockedPeers: ['0xaaa', '0xbbb'] };
            const incoming = { blockedPeers: ['0xbbb'] }; // 0xaaa unblocked remotely

            const result = syncManager.mergeState(base, incoming);

            expect(result.blockedPeers).toEqual(['0xbbb']);
        });

        it('should use latest dmLeftAt from incoming', () => {
            const base = { dmLeftAt: { '0xaaa': 100, '0xbbb': 300 } };
            const incoming = { dmLeftAt: { '0xaaa': 200, '0xccc': 400 } };

            const result = syncManager.mergeState(base, incoming);

            expect(result.dmLeftAt).toEqual({ '0xaaa': 200, '0xccc': 400 });
        });

        it('should keep base dmLeftAt when incoming is undefined', () => {
            const base = { dmLeftAt: { '0xaaa': 100 } };
            const incoming = {};

            const result = syncManager.mergeState(base, incoming);

            expect(result.dmLeftAt).toEqual({ '0xaaa': 100 });
        });

        it('should propagate clearDMLeftAt via latest-wins', () => {
            const base = { dmLeftAt: { '0xaaa': 100, '0xbbb': 200 } };
            const incoming = { dmLeftAt: {}, sliceTs: { dmLeftAt: 300 } }; // all cleared remotely

            const result = syncManager.mergeState(base, incoming);

            expect(result.dmLeftAt).toEqual({});
        });

        it('should not let an unstamped empty snapshot erase unstamped values', () => {
            const base = { dmLeftAt: { '0xaaa': 100 }, trustedContacts: { '0x1': { nickname: 'c' } }, username: 'Bob' };
            const incoming = { dmLeftAt: {}, trustedContacts: {}, username: null, sliceTs: {} };

            const result = syncManager.mergeState(base, incoming);

            expect(result.dmLeftAt).toEqual({ '0xaaa': 100 });
            expect(result.trustedContacts).toEqual({ '0x1': { nickname: 'c' } });
            expect(result.username).toBe('Bob');
        });

        it('should keep a locally newer timestamped slice over an older incoming snapshot', () => {
            const base = {
                trustedContacts: { '0x1': { name: 'fresh local' } },
                sliceTs: { trustedContacts: 2000 }
            };
            const incoming = {
                trustedContacts: {},
                sliceTs: { trustedContacts: 1000 }
            };

            const result = syncManager.mergeState(base, incoming);

            expect(result.trustedContacts).toEqual({ '0x1': { name: 'fresh local' } });
            expect(result.sliceTs.trustedContacts).toBe(2000);
        });

        it('should apply an incoming timestamped slice newer than base', () => {
            const base = {
                dmLeftAt: { '0xaaa': 100 },
                sliceTs: { dmLeftAt: 1000 }
            };
            const incoming = {
                dmLeftAt: {},
                sliceTs: { dmLeftAt: 2000 }
            };

            const result = syncManager.mergeState(base, incoming);

            expect(result.dmLeftAt).toEqual({});
            expect(result.sliceTs.dmLeftAt).toBe(2000);
        });

        it('should let a stamped local slice beat legacy payloads without sliceTs', () => {
            const base = {
                blockedPeers: ['0xaaa'],
                sliceTs: { blockedPeers: 500 }
            };
            const incoming = {
                blockedPeers: [] // legacy snapshot, no sliceTs
            };

            const result = syncManager.mergeState(base, incoming);

            expect(result.blockedPeers).toEqual(['0xaaa']);
        });

        it('should keep base graphApiKey when legacy incoming has none (truthy fallback)', () => {
            const base = { graphApiKey: 'key-123' };
            const incoming = { graphApiKey: null };

            const result = syncManager.mergeState(base, incoming);

            expect(result.graphApiKey).toBe('key-123');
        });

        it('should propagate stamped graphApiKey deletion', () => {
            const base = { graphApiKey: 'key-123', sliceTs: { graphApiKey: 1000 } };
            const incoming = { graphApiKey: null, sliceTs: { graphApiKey: 2000 } };

            const result = syncManager.mergeState(base, incoming);

            expect(result.graphApiKey).toBe(null);
        });
    });

    describe('mergeSentMessages', () => {
        it('should add new streams from remote', () => {
            const local = { 'stream1': [{ id: 'msg1' }] };
            const remote = { 'stream2': [{ id: 'msg2' }] };
            
            const result = syncManager.mergeSentMessages(local, remote);
            
            expect(result.stream1).toBeDefined();
            expect(result.stream2).toBeDefined();
        });

        it('should sort merged messages by timestamp', () => {
            const local = { 'stream1': [{ id: 'msg1', timestamp: 2000 }] };
            const remote = { 'stream1': [{ id: 'msg2', timestamp: 1000 }] };
            
            const result = syncManager.mergeSentMessages(local, remote);
            
            expect(result.stream1[0].timestamp).toBe(1000);
            expect(result.stream1[1].timestamp).toBe(2000);
        });
    });

    describe('mergeSentReactions', () => {
        it('should merge reactions from different streams', () => {
            const local = { 'stream1': { 'msg1': { '👍': ['0x1'] } } };
            const remote = { 'stream2': { 'msg2': { '❤️': ['0x2'] } } };

            const result = syncManager.mergeSentReactions(local, remote);

            expect(result.stream1.msg1['👍']).toEqual(['0x1']);
            expect(result.stream2.msg2['❤️']).toEqual(['0x2']);
        });

        it('should prefer remote state when same messageId exists in both', () => {
            const local = { 'stream1': { 'msg1': { '👍': ['0x1'] } } };
            const remote = { 'stream1': { 'msg1': { '❤️': ['0x1'] } } };

            const result = syncManager.mergeSentReactions(local, remote);

            // Remote wins — only ❤️, no 👍
            expect(result.stream1.msg1['❤️']).toEqual(['0x1']);
            expect(result.stream1.msg1['👍']).toBeUndefined();
        });

        it('should handle reaction removal via remote (empty message entry)', () => {
            const local = { 'stream1': { 'msg1': { '👍': ['0x1'] } } };
            const remote = { 'stream1': { 'msg1': {} } };

            const result = syncManager.mergeSentReactions(local, remote);

            // Remote removed all reactions for msg1
            expect(result.stream1).toBeUndefined();
        });

        it('should preserve local-only entries not in remote', () => {
            const local = { 'stream1': { 'msg1': { '👍': ['0x1'] }, 'msg2': { '❤️': ['0x1'] } } };
            const remote = { 'stream1': { 'msg1': { '🔥': ['0x1'] } } };

            const result = syncManager.mergeSentReactions(local, remote);

            // msg1: remote wins
            expect(result.stream1.msg1['🔥']).toEqual(['0x1']);
            expect(result.stream1.msg1['👍']).toBeUndefined();
            // msg2: local preserved (not in remote)
            expect(result.stream1.msg2['❤️']).toEqual(['0x1']);
        });

        it('should handle empty inputs', () => {
            expect(syncManager.mergeSentReactions({}, {})).toEqual({});
            expect(syncManager.mergeSentReactions(
                { 'stream1': { 'msg1': { '👍': ['0x1'] } } },
                {}
            ).stream1.msg1['👍']).toEqual(['0x1']);
        });
    });

    describe('fullSync', () => {
        it('should call push then pull (push-first order)', async () => {
            authManager.wallet = { privateKey: '0x1234' };
            const order = [];
            const pushSpy = vi.spyOn(syncManager, 'pushSync').mockImplementation(async () => { order.push('push'); });
            const pullSpy = vi.spyOn(syncManager, 'pullSync').mockImplementation(async () => { order.push('pull'); return null; });
            
            await syncManager.fullSync();
            
            expect(pushSpy).toHaveBeenCalled();
            expect(pullSpy).toHaveBeenCalled();
            expect(order).toEqual(['push', 'pull']);
            
            pushSpy.mockRestore();
            pullSpy.mockRestore();
        });
    });

    describe('getStatus', () => {
        it('should return current status', () => {
            syncManager.lastSyncTs = 12345;
            syncManager.isSyncing = true;
            
            const status = syncManager.getStatus();
            
            expect(status).toEqual({
                lastSyncTs: 12345,
                isSyncing: true
            });
        });
    });
});
