/**
 * SyncManager Image Blob Sync Tests (Fase 2)
 * Tests for pushImageBlobs, pullImageBlobs, smartSync blob integration
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
            sentMessages: {}, sentReactions: {}, channels: [],
            blockedPeers: [], dmLeftAt: {}, trustedContacts: {},
            ensCache: {}, username: null, graphApiKey: null
        }),
        importFromSync: vi.fn().mockResolvedValue(false),
        getUnsyncedImages: vi.fn().mockReturnValue({
            [Symbol.asyncIterator]: () => ({ next: () => Promise.resolve({ done: true }) })
        }),
        decryptBlob: vi.fn().mockResolvedValue('base64-image-data'),
        markImageSynced: vi.fn().mockResolvedValue(undefined),
        saveImageToLedger: vi.fn().mockResolvedValue(undefined),
        _deleteLedgerRecord: vi.fn().mockResolvedValue(undefined)
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
        decrypt: vi.fn().mockImplementation(async (env) => {
            if (env._decrypted) return env._decrypted;
            return { type: 'sync_blob', v: 2, ts: Date.now(), imageId: 'pulled-img', streamId: 'stream-1', data: 'pulled-data' };
        }),
        isEncrypted: vi.fn().mockReturnValue(true),
        // Sealed sender (v2). Default off so these keep exercising the legacy
        // self-ECDH path, which still has to work for already-stored history.
        isSealed: vi.fn().mockReturnValue(false),
        open: vi.fn().mockResolvedValue({ sender: '0xmyaddress', message: { type: 'sync_blob', v: 2 } })
    }
}));

vi.mock('../../src/js/channels.js', () => ({
    channelManager: { loadChannels: vi.fn() }
}));

vi.mock('../../src/js/identity.js', () => ({
    identityManager: {
        loadUsername: vi.fn()
    }
}));

import { syncManager } from '../../src/js/syncManager.js';
import { authManager } from '../../src/js/auth.js';
import { dmManager } from '../../src/js/dm.js';
import { streamrController, STREAM_CONFIG } from '../../src/js/streamr.js';
import { dmCrypto } from '../../src/js/dmCrypto.js';
import { secureStorage } from '../../src/js/secureStorage.js';

describe('syncManager blob sync', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        syncManager.cancelAutoPush();
        syncManager.isSyncing = false;
        syncManager.lastSyncTs = null;
        syncManager.handlers = [];
        syncManager.pushQueued = false;
        syncManager.autoPushRetryCount = 0;
        authManager.wallet = { privateKey: '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef' };
        authManager.isGuestMode.mockReturnValue(false);
        authManager.getAddress.mockReturnValue('0xabc123');
        dmManager.hasInbox.mockResolvedValue(true);
        localStorage.clear();
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    // ==================== pushImageBlobs ====================
    describe('pushImageBlobs()', () => {
        it('should skip in guest mode', async () => {
            authManager.isGuestMode.mockReturnValue(true);
            await syncManager.pushImageBlobs();
            expect(streamrController.publish).not.toHaveBeenCalled();
        });

        it('should skip when no inbox', async () => {
            dmManager.hasInbox.mockResolvedValue(false);
            await syncManager.pushImageBlobs();
            expect(streamrController.publish).not.toHaveBeenCalled();
        });

        it('should skip when no wallet', async () => {
            authManager.wallet = null;
            await syncManager.pushImageBlobs();
            expect(streamrController.publish).not.toHaveBeenCalled();
        });

        it('should do nothing when no unsynced images', async () => {
            await syncManager.pushImageBlobs();
            expect(streamrController.publish).not.toHaveBeenCalled();
        });

        it('should push unsynced images to SYNC_BLOBS partition', async () => {
            // Mock getUnsyncedImages to yield one image record
            const records = [
                { imageId: 'img-1', streamId: 'stream-1', encryptedData: new ArrayBuffer(8), iv: [1,2,3] }
            ];
            let idx = 0;
            secureStorage.getUnsyncedImages.mockReturnValue({
                [Symbol.asyncIterator]: () => ({
                    next: () => {
                        if (idx < records.length) {
                            return Promise.resolve({ value: records[idx++], done: false });
                        }
                        return Promise.resolve({ done: true });
                    }
                })
            });

            await syncManager.pushImageBlobs();

            // Should decrypt the blob
            expect(secureStorage.decryptBlob).toHaveBeenCalledWith(
                records[0].encryptedData, records[0].iv
            );

            // Sealed to ourselves and published to partition 2 under a
            // throwaway identity, so sync traffic is indistinguishable from an
            // incoming message on the inbox stream.
            expect(dmManager.sealAndPublish).toHaveBeenCalledWith(
                '0xabc/Pombo-DM-1',
                '0xabc123',
                expect.objectContaining({ type: expect.stringMatching(/^sync_blob/) }),
                STREAM_CONFIG.MESSAGE_STREAM.SYNC_BLOBS
            );

            // Should mark as synced
            expect(secureStorage.markImageSynced).toHaveBeenCalledWith('img-1');
        });

        it('should continue on individual blob failure', async () => {
            const records = [
                { imageId: 'fail-img', streamId: 'stream-1', encryptedData: new ArrayBuffer(8), iv: [1,2,3] },
                { imageId: 'ok-img', streamId: 'stream-1', encryptedData: new ArrayBuffer(8), iv: [4,5,6] }
            ];
            let idx = 0;
            secureStorage.getUnsyncedImages.mockReturnValue({
                [Symbol.asyncIterator]: () => ({
                    next: () => {
                        if (idx < records.length) {
                            return Promise.resolve({ value: records[idx++], done: false });
                        }
                        return Promise.resolve({ done: true });
                    }
                })
            });

            secureStorage.decryptBlob
                .mockRejectedValueOnce(new Error('decrypt fail'))
                .mockResolvedValueOnce('ok-data');

            await syncManager.pushImageBlobs();

            // Corrupt blob should be removed from ledger and not marked synced
            expect(secureStorage._deleteLedgerRecord).toHaveBeenCalledWith('fail-img');
            // Second blob should still be published
            expect(secureStorage.markImageSynced).toHaveBeenCalledWith('ok-img');
            expect(secureStorage.markImageSynced).not.toHaveBeenCalledWith('fail-img');
        });
    });

    // ==================== pullImageBlobs ====================
    describe('pullImageBlobs()', () => {
        it('should skip in guest mode', async () => {
            authManager.isGuestMode.mockReturnValue(true);
            await syncManager.pullImageBlobs();
            expect(secureStorage.saveImageToLedger).not.toHaveBeenCalled();
        });

        it('should skip when no inbox', async () => {
            dmManager.hasInbox.mockResolvedValue(false);
            await syncManager.pullImageBlobs();
            expect(secureStorage.saveImageToLedger).not.toHaveBeenCalled();
        });

        it('should skip when no wallet', async () => {
            authManager.wallet = null;
            await syncManager.pullImageBlobs();
            expect(secureStorage.saveImageToLedger).not.toHaveBeenCalled();
        });

        it('should fetch from SYNC_BLOBS partition', async () => {
            streamrController.fetchPartitionHistory.mockResolvedValue([]);
            await syncManager.pullImageBlobs();

            expect(streamrController.fetchPartitionHistory).toHaveBeenCalledWith(
                '0xabc/Pombo-DM-1',
                STREAM_CONFIG.MESSAGE_STREAM.SYNC_BLOBS,
                200
            );
        });

        it('should import blobs from own messages', async () => {
            streamrController.fetchPartitionHistory.mockResolvedValue([
                {
                    publisherId: '0xabc123',
                    content: { ct: 'enc', iv: 'iv', e: 'aes-256-gcm' }
                }
            ]);

            await syncManager.pullImageBlobs();

            expect(secureStorage.saveImageToLedger).toHaveBeenCalledWith(
                'pulled-img', 'pulled-data', 'stream-1'
            );
            // Pulled images must be marked synced to avoid re-push
            expect(secureStorage.markImageSynced).toHaveBeenCalledWith('pulled-img');
        });

        it('should ignore messages from other senders', async () => {
            streamrController.fetchPartitionHistory.mockResolvedValue([
                {
                    publisherId: '0xOTHER',
                    content: { ct: 'enc', iv: 'iv', e: 'aes-256-gcm' }
                }
            ]);

            await syncManager.pullImageBlobs();
            expect(secureStorage.saveImageToLedger).not.toHaveBeenCalled();
        });

        it('should ignore non-encrypted messages', async () => {
            dmCrypto.isEncrypted.mockReturnValueOnce(false);
            streamrController.fetchPartitionHistory.mockResolvedValue([
                { publisherId: '0xabc123', content: { plaintext: 'data' } }
            ]);

            await syncManager.pullImageBlobs();
            expect(secureStorage.saveImageToLedger).not.toHaveBeenCalled();
        });

        it('should skip payloads with wrong type', async () => {
            dmCrypto.decrypt.mockResolvedValueOnce({ type: 'sync', v: 1, data: {} });
            streamrController.fetchPartitionHistory.mockResolvedValue([
                { publisherId: '0xabc123', content: { ct: 'enc', iv: 'iv', e: 'aes-256-gcm' } }
            ]);

            await syncManager.pullImageBlobs();
            expect(secureStorage.saveImageToLedger).not.toHaveBeenCalled();
        });

        it('should continue on decrypt failure', async () => {
            dmCrypto.decrypt
                .mockRejectedValueOnce(new Error('bad key'))
                .mockResolvedValueOnce({ type: 'sync_blob', v: 2, imageId: 'ok', streamId: 's1', data: 'd1' });

            streamrController.fetchPartitionHistory.mockResolvedValue([
                { publisherId: '0xabc123', content: { ct: 'bad', iv: 'iv', e: 'aes-256-gcm' } },
                { publisherId: '0xabc123', content: { ct: 'good', iv: 'iv', e: 'aes-256-gcm' } }
            ]);

            await syncManager.pullImageBlobs();
            expect(secureStorage.saveImageToLedger).toHaveBeenCalledWith('ok', 'd1', 's1');
        });
    });

    // ==================== smartSync integration ====================
    describe('smartSync() blob integration', () => {
        it('should call pushImageBlobs and pullImageBlobs', async () => {
            const pushSpy = vi.spyOn(syncManager, 'pushSync').mockResolvedValue(undefined);
            const pullSpy = vi.spyOn(syncManager, 'pullSync').mockResolvedValue(null);
            const pushBlobSpy = vi.spyOn(syncManager, 'pushImageBlobs').mockResolvedValue(undefined);
            const pullBlobSpy = vi.spyOn(syncManager, 'pullImageBlobs').mockResolvedValue(undefined);

            await syncManager.smartSync();

            // Nothing waiting to push: pullSync → pullImageBlobs → pushSync → pushImageBlobs
            expect(pushSpy).toHaveBeenCalled();
            expect(pushBlobSpy).toHaveBeenCalled();
            expect(pullSpy).toHaveBeenCalled();
            expect(pullBlobSpy).toHaveBeenCalled();

            // Verify ordering
            const pushOrder = pushSpy.mock.invocationCallOrder[0];
            const pushBlobOrder = pushBlobSpy.mock.invocationCallOrder[0];
            const pullOrder = pullSpy.mock.invocationCallOrder[0];
            const pullBlobOrder = pullBlobSpy.mock.invocationCallOrder[0];
            expect(pullOrder).toBeLessThan(pullBlobOrder);
            expect(pullBlobOrder).toBeLessThan(pushOrder);
            expect(pushOrder).toBeLessThan(pushBlobOrder);
        });
    });
});
