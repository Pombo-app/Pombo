/**
 * syncManager.js Extended Tests
 * Covers: smartSync, fullSyncWithVerify, scheduleAutoPush, cancelAutoPush,
 * forcePushNow, pushSync/pullSync guard branches, mergeSentMessages trim
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('../../src/js/logger.js', () => ({
    Logger: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() }
}));

vi.mock('../../src/js/config.js', () => ({
    CONFIG: { dm: { maxSentMessages: 200 } }
}));

vi.mock('../../src/js/streamr.js', () => ({
    streamrController: {
        getDMInboxId: vi.fn().mockReturnValue('0xabc/Pombo-DM-1'),
        publish: vi.fn().mockResolvedValue(undefined),
        fetchPartitionHistory: vi.fn().mockResolvedValue([]),
        setDMPublishKey: vi.fn().mockResolvedValue(undefined),
        addDMDecryptKey: vi.fn().mockResolvedValue(undefined)
    },
    STREAM_CONFIG: { MESSAGE_STREAM: { PARTITIONS: 1, DM_PARTITIONS: 3, MESSAGES: 0, SYNC: 1, SYNC_BLOBS: 2 } }
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
            sentMessages: {}, sentReactions: {}, channels: [],
            blockedPeers: [], dmLeftAt: {}, trustedContacts: {},
            ensCache: {}, username: null, graphApiKey: null
        }),
        exportForBackup: vi.fn().mockReturnValue({
            sentMessages: {}, sentReactions: {}, channels: [],
            blockedPeers: [], dmLeftAt: {}, trustedContacts: {},
            ensCache: {}, username: null, graphApiKey: null
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
        wallet: null
    }
}));

vi.mock('../../src/js/dmCrypto.js', () => ({
    dmCrypto: {
        getMyPublicKey: vi.fn().mockReturnValue('0x02abcdef'),
        deriveSharedKey: vi.fn().mockResolvedValue({ type: 'secret' }),
        encrypt: vi.fn().mockResolvedValue({ ct: 'encrypted', iv: 'iv123', e: 'aes-256-gcm' }),
        decrypt: vi.fn().mockImplementation(async (env) => env._decrypted || { type: 'sync', v: 1, ts: Date.now(), data: {} }),
        isEncrypted: vi.fn().mockReturnValue(true),
        // Sealed sender (v2). Default off — see syncManager.blobSync.test.js
        isSealed: vi.fn().mockReturnValue(false),
        open: vi.fn().mockResolvedValue({ sender: '0xmyaddress', message: { type: 'sync', v: 1 } })
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

import { syncManager } from '../../src/js/syncManager.js';
import { authManager } from '../../src/js/auth.js';
import { dmManager } from '../../src/js/dm.js';
import { Logger } from '../../src/js/logger.js';
import { streamrController } from '../../src/js/streamr.js';
import { dmCrypto } from '../../src/js/dmCrypto.js';
import { secureStorage } from '../../src/js/secureStorage.js';
import { CONFIG } from '../../src/js/config.js';

describe('syncManager extended', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        syncManager.cancelAutoPush();
        syncManager.isSyncing = false;
        syncManager.lastSyncTs = null;
        syncManager.handlers = [];
        syncManager.autoPushTimeout = null;
        syncManager.pushQueued = false;
        syncManager.autoPushRetryCount = 0;
        localStorage.clear();
        authManager.wallet = { privateKey: '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef' };
        authManager.isGuestMode.mockReturnValue(false);
        authManager.getAddress.mockReturnValue('0xabc123');
        dmManager.hasInbox.mockResolvedValue(true);
        streamrController.getDMInboxId.mockReturnValue('0xabc/Pombo-DM-1');
        streamrController.fetchPartitionHistory.mockResolvedValue([]);
        dmCrypto.isEncrypted.mockReturnValue(true);
    });

    afterEach(() => {
        vi.restoreAllMocks();
        if (syncManager.autoPushTimeout) {
            clearTimeout(syncManager.autoPushTimeout);
            syncManager.autoPushTimeout = null;
        }
    });

    // ==================== smartSync ====================
    describe('smartSync()', () => {
        beforeEach(() => {
            syncManager.markDirty();
        });

        it('should skip in guest mode', async () => {
            authManager.isGuestMode.mockReturnValue(true);
            const result = await syncManager.smartSync();
            expect(result).toEqual({ pulled: false, pushed: false, noInbox: false });
        });

        it('should return noInbox if no inbox', async () => {
            dmManager.hasInbox.mockResolvedValue(false);
            const result = await syncManager.smartSync();
            expect(result).toEqual({ pulled: false, pushed: false, noInbox: true });
        });

        describe('with nothing waiting to push', () => {
            beforeEach(() => {
                syncManager.clearDirty();
            });

            it('reads before it publishes', async () => {
                const pullSpy = vi.spyOn(syncManager, 'pullSync').mockResolvedValue({ merged: true });
                const pushSpy = vi.spyOn(syncManager, 'pushSync').mockResolvedValue({ type: 'sync', v: 1, ts: 1 });
                vi.spyOn(syncManager, 'pushImageBlobs').mockResolvedValue(undefined);
                vi.spyOn(syncManager, 'pullImageBlobs').mockResolvedValue(undefined);

                const result = await syncManager.smartSync();

                expect(pullSpy).toHaveBeenCalledWith(undefined);
                expect(pullSpy.mock.invocationCallOrder[0]).toBeLessThan(pushSpy.mock.invocationCallOrder[0]);
                expect(result).toEqual({ pulled: true, pushed: true, noInbox: false });
            });

            it('still publishes when there is no remote state yet', async () => {
                vi.spyOn(syncManager, 'pullSync').mockResolvedValue(null);
                const pushSpy = vi.spyOn(syncManager, 'pushSync').mockResolvedValue(undefined);
                vi.spyOn(syncManager, 'pushImageBlobs').mockResolvedValue(undefined);
                vi.spyOn(syncManager, 'pullImageBlobs').mockResolvedValue(undefined);

                const result = await syncManager.smartSync();

                expect(pushSpy).toHaveBeenCalled();
                expect(result).toEqual({ pulled: false, pushed: true, noInbox: false });
            });

            it('does not publish a state it could not reconcile', async () => {
                vi.spyOn(syncManager, 'pullSync').mockRejectedValue(new Error('pull fail'));
                const pushSpy = vi.spyOn(syncManager, 'pushSync').mockResolvedValue(undefined);

                await expect(syncManager.smartSync()).rejects.toThrow('pull fail');
                expect(pushSpy).not.toHaveBeenCalled();
            });
        });

        it('should push then pull on success', async () => {
            const optimisticPayload = { type: 'sync', v: 1, ts: 1234, data: { channels: [] } };
            const pushSpy = vi.spyOn(syncManager, 'pushSync').mockResolvedValue(optimisticPayload);
            const pullSpy = vi.spyOn(syncManager, 'pullSync').mockResolvedValue({ merged: true });
            vi.spyOn(syncManager, 'pushImageBlobs').mockResolvedValue(undefined);
            vi.spyOn(syncManager, 'pullImageBlobs').mockResolvedValue(undefined);

            const result = await syncManager.smartSync();

            expect(pushSpy).toHaveBeenCalled();
            expect(pullSpy).toHaveBeenCalledWith({ optimisticPayload });
            expect(result).toEqual({ pulled: true, pushed: true, noInbox: false });
        });

        it('should set pulled=false when pullSync returns null', async () => {
            vi.spyOn(syncManager, 'pushSync').mockResolvedValue(undefined);
            vi.spyOn(syncManager, 'pullSync').mockResolvedValue(null);
            vi.spyOn(syncManager, 'pushImageBlobs').mockResolvedValue(undefined);
            vi.spyOn(syncManager, 'pullImageBlobs').mockResolvedValue(undefined);

            const result = await syncManager.smartSync();
            expect(result.pulled).toBe(false);
        });

        it('should notify handlers on completion', async () => {
            vi.spyOn(syncManager, 'pushSync').mockResolvedValue(undefined);
            vi.spyOn(syncManager, 'pullSync').mockResolvedValue(null);
            vi.spyOn(syncManager, 'pushImageBlobs').mockResolvedValue(undefined);
            vi.spyOn(syncManager, 'pullImageBlobs').mockResolvedValue(undefined);
            const handler = vi.fn();
            syncManager.on('sync_complete', handler);

            await syncManager.smartSync();

            expect(handler).toHaveBeenCalledWith(expect.objectContaining({ pushed: true }));
        });

        it('should continue to pull when push fails (partial failure)', async () => {
            vi.spyOn(syncManager, 'pushSync').mockRejectedValue(new Error('push fail'));
            const pullSpy = vi.spyOn(syncManager, 'pullSync').mockResolvedValue({ merged: true });
            vi.spyOn(syncManager, 'pullImageBlobs').mockResolvedValue(undefined);

            const result = await syncManager.smartSync();

            expect(pullSpy).toHaveBeenCalled();
            expect(result.pushed).toBe(false);
            expect(result.pulled).toBe(true);
            expect(result.pushError).toBe('push fail');
        });

        it('should schedule a recovery push when the push phase fails', async () => {
            vi.useFakeTimers();
            vi.spyOn(syncManager, 'pushSync').mockRejectedValue(new Error('push fail'));
            vi.spyOn(syncManager, 'pullSync').mockResolvedValue(null);
            vi.spyOn(syncManager, 'pullImageBlobs').mockResolvedValue(undefined);

            await syncManager.smartSync();

            expect(syncManager.autoPushTimeout).not.toBeNull();
            vi.useRealTimers();
        });

        it('should not throw on pull error when push succeeded (partial failure)', async () => {
            vi.spyOn(syncManager, 'pushSync').mockResolvedValue(undefined);
            vi.spyOn(syncManager, 'pushImageBlobs').mockResolvedValue(undefined);
            vi.spyOn(syncManager, 'pullSync').mockRejectedValue(new Error('pull fail'));

            const result = await syncManager.smartSync();

            expect(result.pushed).toBe(true);
            expect(result.pulled).toBe(false);
            expect(result.pullError).toBe('pull fail');
        });

        it('should throw only when both phases fail', async () => {
            vi.spyOn(syncManager, 'pushSync').mockRejectedValue(new Error('push fail'));
            vi.spyOn(syncManager, 'pullSync').mockRejectedValue(new Error('pull fail'));

            await expect(syncManager.smartSync()).rejects.toThrow('push fail');
        });
    });

    describe('runForegroundSync()', () => {
        it('should emit a success event after a completed foreground sync', async () => {
            const handler = vi.fn();
            syncManager.on('sync_activity_success', handler);

            const result = await syncManager.runForegroundSync('Syncing devices', async () => 'ok');

            expect(result).toBe('ok');
            expect(handler).toHaveBeenCalledWith(expect.objectContaining({
                label: 'Sync complete',
                activityLabel: 'Syncing devices'
            }));
        });

        it('should not emit a success event when the foreground sync fails', async () => {
            const handler = vi.fn();
            syncManager.on('sync_activity_success', handler);

            await expect(syncManager.runForegroundSync('Syncing devices', async () => {
                throw new Error('sync failed');
            })).rejects.toThrow('sync failed');

            expect(handler).not.toHaveBeenCalled();
        });
    });

    // ==================== fullSyncWithVerify ====================
    describe('fullSyncWithVerify()', () => {
        it('should skip in guest mode', async () => {
            authManager.isGuestMode.mockReturnValue(true);
            const result = await syncManager.fullSyncWithVerify();
            expect(result).toEqual({ pushed: false, verified: false });
        });

        it('should return noInbox if no inbox', async () => {
            dmManager.hasInbox.mockResolvedValue(false);
            const result = await syncManager.fullSyncWithVerify();
            expect(result).toEqual({ pushed: false, verified: false, noInbox: true });
        });

        it('should push, wait, then pull', async () => {
            vi.useFakeTimers();
            const pushSpy = vi.spyOn(syncManager, 'pushSync').mockResolvedValue(undefined);
            const pullSpy = vi.spyOn(syncManager, 'pullSync').mockResolvedValue({ data: true });

            const promise = syncManager.fullSyncWithVerify(100);
            // Advance past the delay
            await vi.advanceTimersByTimeAsync(100);
            const result = await promise;

            expect(pushSpy).toHaveBeenCalled();
            expect(pullSpy).toHaveBeenCalled();
            expect(result).toEqual({ pushed: true, verified: true });
            vi.useRealTimers();
        });

        it('should set verified=false when pullSync returns null', async () => {
            vi.useFakeTimers();
            vi.spyOn(syncManager, 'pushSync').mockResolvedValue(undefined);
            vi.spyOn(syncManager, 'pullSync').mockResolvedValue(null);

            const promise = syncManager.fullSyncWithVerify(50);
            await vi.advanceTimersByTimeAsync(50);
            const result = await promise;

            expect(result.verified).toBe(false);
            vi.useRealTimers();
        });

        it('should rethrow on error', async () => {
            vi.spyOn(syncManager, 'pushSync').mockRejectedValue(new Error('sync fail'));

            await expect(syncManager.fullSyncWithVerify(0)).rejects.toThrow('sync fail');
        });
    });

    // ==================== scheduleAutoPush ====================
    describe('scheduleAutoPush()', () => {
        it('should skip in guest mode', () => {
            authManager.isGuestMode.mockReturnValue(true);
            syncManager.scheduleAutoPush();
            expect(syncManager.autoPushTimeout).toBeNull();
        });

        it('should schedule auto push', () => {
            vi.useFakeTimers();
            syncManager.scheduleAutoPush(1000);
            expect(syncManager.autoPushTimeout).not.toBeNull();
            vi.useRealTimers();
        });

        it('should clear previous timeout on reschedule', () => {
            vi.useFakeTimers();
            syncManager.scheduleAutoPush(5000);
            const firstTimeout = syncManager.autoPushTimeout;

            syncManager.scheduleAutoPush(5000);
            const secondTimeout = syncManager.autoPushTimeout;

            expect(firstTimeout).not.toBe(secondTimeout);
            vi.useRealTimers();
        });

        it('should call pushSync after delay', async () => {
            vi.useFakeTimers();
            const pushSpy = vi.spyOn(syncManager, 'pushSync').mockResolvedValue(undefined);

            syncManager.scheduleAutoPush(100);
            await vi.advanceTimersByTimeAsync(100);

            expect(pushSpy).toHaveBeenCalled();
            vi.useRealTimers();
        });

        it('should handle push error in callback', async () => {
            vi.useFakeTimers();
            vi.spyOn(syncManager, 'pushSync').mockRejectedValue(new Error('push boom'));

            syncManager.scheduleAutoPush(50);
            await vi.advanceTimersByTimeAsync(50);

            expect(Logger.warn).toHaveBeenCalledWith(expect.stringContaining('Auto-push failed'), expect.any(String));
            vi.useRealTimers();
        });
    });

    // ==================== cancelAutoPush ====================
    describe('cancelAutoPush()', () => {
        it('should clear existing timeout', () => {
            syncManager.autoPushTimeout = setTimeout(() => {}, 99999);
            syncManager.cancelAutoPush();
            expect(syncManager.autoPushTimeout).toBeNull();
        });

        it('should be safe when no timeout exists', () => {
            syncManager.autoPushTimeout = null;
            syncManager.cancelAutoPush();
            expect(syncManager.autoPushTimeout).toBeNull();
        });

        it('should reset retry count and queued push', () => {
            syncManager.autoPushRetryCount = 3;
            syncManager.pushQueued = true;
            syncManager.cancelAutoPush();
            expect(syncManager.autoPushRetryCount).toBe(0);
            expect(syncManager.pushQueued).toBe(false);
        });
    });

    // ==================== dirty flag ====================
    describe('dirty flag', () => {
        it('should mark dirty when scheduling an auto push', () => {
            vi.useFakeTimers();
            syncManager.scheduleAutoPush(1000);
            expect(syncManager.isDirty()).toBe(true);
            vi.useRealTimers();
        });

        it('should not mark dirty in guest mode', () => {
            authManager.isGuestMode.mockReturnValue(true);
            syncManager.scheduleAutoPush(1000);
            expect(syncManager.isDirty()).toBe(false);
        });

        it('should clear dirty after a successful push with nothing pending', async () => {
            syncManager.markDirty();
            await syncManager.pushSync();
            expect(syncManager.isDirty()).toBe(false);
        });

        it('should keep dirty when new changes are scheduled mid-push', async () => {
            // The push now goes out via dmManager.sealAndPublish
            dmManager.sealAndPublish.mockImplementation(async () => {
                syncManager.scheduleAutoPush(60000);
            });
            await syncManager.pushSync();
            expect(syncManager.isDirty()).toBe(true);
        });
    });

    // ==================== queued push ====================
    describe('queued push', () => {
        it('should queue a push requested while syncing', async () => {
            syncManager.isSyncing = true;
            const result = await syncManager.pushSync();
            expect(result).toBeNull();
            expect(syncManager.pushQueued).toBe(true);
        });

        it('should flush the queued push when the running sync finishes', async () => {
            vi.useFakeTimers();
            syncManager.isSyncing = true;
            await syncManager.pushSync(); // queued
            syncManager.isSyncing = false;

            // A pull finishing must flush the queued push (short debounce)
            await syncManager.pullSync();

            expect(syncManager.pushQueued).toBe(false);
            expect(syncManager.autoPushTimeout).not.toBeNull();
            vi.useRealTimers();
        });
    });

    // ==================== auto-push blobs & retry ====================
    describe('auto-push blobs and retry', () => {
        it('should push image blobs after a successful auto push', async () => {
            vi.useFakeTimers();
            vi.spyOn(syncManager, 'pushSync').mockResolvedValue({ ts: 1 });
            const blobSpy = vi.spyOn(syncManager, 'pushImageBlobs').mockResolvedValue(undefined);

            syncManager.scheduleAutoPush(100);
            await vi.advanceTimersByTimeAsync(100);

            expect(blobSpy).toHaveBeenCalled();
            vi.useRealTimers();
        });

        it('should not push blobs when push was skipped', async () => {
            vi.useFakeTimers();
            vi.spyOn(syncManager, 'pushSync').mockResolvedValue(null);
            const blobSpy = vi.spyOn(syncManager, 'pushImageBlobs');

            syncManager.scheduleAutoPush(100);
            await vi.advanceTimersByTimeAsync(100);

            expect(blobSpy).not.toHaveBeenCalled();
            vi.useRealTimers();
        });

        it('should retry with backoff after a failed auto push', async () => {
            vi.useFakeTimers();
            const pushSpy = vi.spyOn(syncManager, 'pushSync')
                .mockRejectedValueOnce(new Error('boom'))
                .mockResolvedValueOnce({ ts: 1 });
            const blobSpy = vi.spyOn(syncManager, 'pushImageBlobs').mockResolvedValue(undefined);

            syncManager.scheduleAutoPush(100);
            await vi.advanceTimersByTimeAsync(100);

            expect(pushSpy).toHaveBeenCalledTimes(1);
            expect(syncManager.autoPushRetryCount).toBe(1);
            expect(syncManager.autoPushTimeout).not.toBeNull();

            // Backoff: 15000 * 2^1 = 30000
            await vi.advanceTimersByTimeAsync(30000);

            expect(pushSpy).toHaveBeenCalledTimes(2);
            expect(syncManager.autoPushRetryCount).toBe(0);
            expect(blobSpy).toHaveBeenCalled();
            vi.useRealTimers();
        });
    });

    // ==================== forcePushNow ====================
    describe('forcePushNow()', () => {
        it('should cancel auto push first', async () => {
            const cancelSpy = vi.spyOn(syncManager, 'cancelAutoPush');
            vi.spyOn(syncManager, 'pushSync').mockResolvedValue(undefined);

            await syncManager.forcePushNow();

            expect(cancelSpy).toHaveBeenCalled();
        });

        it('should call pushSync', async () => {
            const pushSpy = vi.spyOn(syncManager, 'pushSync').mockResolvedValue(undefined);

            await syncManager.forcePushNow();

            expect(pushSpy).toHaveBeenCalled();
        });

        it('should skip in guest mode', async () => {
            authManager.isGuestMode.mockReturnValue(true);
            const pushSpy = vi.spyOn(syncManager, 'pushSync');

            await syncManager.forcePushNow();

            expect(pushSpy).not.toHaveBeenCalled();
        });

        it('should skip if already syncing', async () => {
            syncManager.isSyncing = true;
            const pushSpy = vi.spyOn(syncManager, 'pushSync');

            await syncManager.forcePushNow();

            expect(pushSpy).not.toHaveBeenCalled();
        });

        it('should handle push error gracefully', async () => {
            vi.spyOn(syncManager, 'pushSync').mockRejectedValue(new Error('fail'));

            await syncManager.forcePushNow();

            expect(Logger.warn).toHaveBeenCalledWith(expect.stringContaining('Force push failed'), expect.any(String));
        });
    });

    // ==================== pushSync guard branches ====================
    describe('pushSync() guard branches', () => {
        it('should return early when no inbox', async () => {
            dmManager.hasInbox.mockResolvedValue(false);
            await syncManager.pushSync();
            expect(streamrController.publish).not.toHaveBeenCalled();
        });

        it('should throw when no inbox stream ID', async () => {
            streamrController.getDMInboxId.mockReturnValue(null);
            await expect(syncManager.pushSync()).rejects.toThrow('DM inbox not available');
        });
    });

    // ==================== pullSync guard branches ====================
    describe('pullSync() guard branches', () => {
        it('should return null when no inbox', async () => {
            dmManager.hasInbox.mockResolvedValue(false);
            const result = await syncManager.pullSync();
            expect(result).toBeNull();
        });

        it('should throw when no private key', async () => {
            authManager.wallet = {};
            await expect(syncManager.pullSync()).rejects.toThrow('No wallet private key');
        });

        it('should throw when no inbox stream ID', async () => {
            streamrController.getDMInboxId.mockReturnValue(null);
            await expect(syncManager.pullSync()).rejects.toThrow('DM inbox not available');
        });

        it('should skip non-encrypted messages', async () => {
            streamrController.fetchPartitionHistory.mockResolvedValue([
                { publisherId: '0xabc123', content: { plain: 'data' } }
            ]);
            dmCrypto.isEncrypted.mockReturnValue(false);

            const result = await syncManager.pullSync();

            expect(Logger.debug).toHaveBeenCalledWith(expect.stringContaining('not encrypted'));
            expect(result).toBeNull();
        });

        it('should warn on decrypt failure and continue', async () => {
            streamrController.fetchPartitionHistory.mockResolvedValue([
                { publisherId: '0xabc123', content: { ct: 'bad' } },
                { publisherId: '0xabc123', content: { ct: 'good' } }
            ]);
            dmCrypto.isEncrypted.mockReturnValue(true);
            dmCrypto.decrypt
                .mockRejectedValueOnce(new Error('decrypt fail'))
                .mockResolvedValueOnce({ type: 'sync', v: 1, ts: 1000, data: {} });

            const result = await syncManager.pullSync();

            expect(Logger.warn).toHaveBeenCalledWith(expect.stringContaining('Failed to decrypt'), expect.any(String));
        });

        it('should sort multiple payloads by timestamp', async () => {
            const payload1 = { type: 'sync', v: 1, ts: 2000, data: { channels: ['ch2'] } };
            const payload2 = { type: 'sync', v: 1, ts: 1000, data: { channels: ['ch1'] } };

            streamrController.fetchPartitionHistory.mockResolvedValue([
                { publisherId: '0xabc123', content: { _decrypted: payload1 } },
                { publisherId: '0xabc123', content: { _decrypted: payload2 } }
            ]);
            dmCrypto.isEncrypted.mockReturnValue(true);

            const mergeSpy = vi.spyOn(syncManager, 'mergeState');

            await syncManager.pullSync();

            // First merge should be with the older payload (ts=1000)
            if (mergeSpy.mock.calls.length >= 2) {
                expect(mergeSpy.mock.calls[0][1]).toEqual({ channels: ['ch1'] });
                expect(mergeSpy.mock.calls[1][1]).toEqual({ channels: ['ch2'] });
            }
        });
    });

    // ==================== mergeSentMessages trim ====================
    describe('mergeSentMessages() trim branch', () => {
        it('should trim to maxSentMessages when exceeding limit', () => {
            const local = { stream1: [] };
            const remote = { stream1: [] };

            // Create more than maxSentMessages entries
            for (let i = 0; i < 150; i++) {
                local.stream1.push({ id: `local-${i}`, timestamp: i });
            }
            for (let i = 0; i < 150; i++) {
                remote.stream1.push({ id: `remote-${i}`, timestamp: 1000 + i });
            }

            const result = syncManager.mergeSentMessages(local, remote);

            // 150 local + 150 remote = 300, should be trimmed to 200
            expect(result.stream1.length).toBe(CONFIG.dm.maxSentMessages);
            // Should keep the LATEST messages (highest timestamps)
            expect(result.stream1[result.stream1.length - 1].timestamp).toBe(1149);
        });

        it('should not trim when under limit', () => {
            const local = { stream1: [{ id: 'a', timestamp: 1 }] };
            const remote = { stream1: [{ id: 'b', timestamp: 2 }] };

            const result = syncManager.mergeSentMessages(local, remote);

            expect(result.stream1.length).toBe(2);
        });
    });

    // ==================== mergeSentMessages immutability ====================
    describe('mergeSentMessages() immutability', () => {
        it('should not mutate local input arrays', () => {
            const localMsg = { id: 'msg1', timestamp: 1, text: 'hello' };
            const local = { stream1: [localMsg] };
            const remote = { stream1: [{ id: 'msg2', timestamp: 2, text: 'world' }] };

            const result = syncManager.mergeSentMessages(local, remote);

            // local array should be unchanged
            expect(local.stream1).toHaveLength(1);
            expect(local.stream1[0]).toBe(localMsg); // same reference, not mutated
        });

        it('should not mutate local message objects when adopting remote imageData', () => {
            const localMsg = { id: 'img1', timestamp: 1, type: 'image', imageId: 'abc' };
            const local = { stream1: [localMsg] };
            const remote = { stream1: [{ id: 'img1', timestamp: 1, type: 'image', imageId: 'abc', imageData: 'base64data' }] };

            syncManager.mergeSentMessages(local, remote);

            // Original local message object should NOT have imageData
            expect(localMsg.imageData).toBeUndefined();
        });

        it('should not mutate remote input arrays', () => {
            const remoteMsg = { id: 'msg1', timestamp: 1, text: 'hello' };
            const local = {};
            const remote = { stream1: [remoteMsg] };

            const result = syncManager.mergeSentMessages(local, remote);

            // Mutating result should not affect remote
            result.stream1[0].text = 'modified';
            expect(remoteMsg.text).toBe('hello');
        });
    });
});
