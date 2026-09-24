/**
 * Tests for media.js core functionality
 * Focus: lifecycle, message dispatch, P2P transfer, caching, seeding persistence
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Mock dependencies before importing
vi.mock('../../src/js/streamr.js', () => ({
    streamrController: {
        publishMessage: vi.fn().mockResolvedValue(undefined),
        publishMediaSignal: vi.fn().mockResolvedValue(undefined),
        publishMediaData: vi.fn().mockResolvedValue(undefined),
        publishMediaDataAs: vi.fn().mockResolvedValue(undefined),
        ensureMediaSubscription: vi.fn().mockResolvedValue(undefined)
    },
    deriveEphemeralId: vi.fn((id) => `ephemeral-${id}`),
    STREAM_CONFIG: {
        EPHEMERAL_STREAM: {
            PARTITIONS: 3,
            CONTROL: 0,
            MEDIA_SIGNALS: 1,
            MEDIA_DATA: 2
        }
    }
}));

vi.mock('../../src/js/auth.js', () => ({
    authManager: {
        getAddress: vi.fn().mockReturnValue('0xmyaddress'),
        wallet: { privateKey: '0xprivatekey' }
    }
}));

vi.mock('../../src/js/channels.js', () => ({
    channelManager: {
        getChannel: vi.fn(),
        notifyHandlers: vi.fn()
    }
}));

vi.mock('../../src/js/identity.js', () => ({
    identityManager: {
        createSignedMessage: vi.fn().mockResolvedValue({
            id: 'msg-123',
            sender: '0xmyaddress',
            timestamp: Date.now()
        }),
        createSignedFileManifest: vi.fn().mockResolvedValue({
            type: 'file_announce',
            id: 'msg-123',
            sender: '0xmyaddress',
            timestamp: Date.now(),
            signature: '0xsig'
        }),
        getTrustLevel: vi.fn().mockResolvedValue('verified')
    }
}));

vi.mock('../../src/js/logger.js', () => ({
    Logger: {
        info: vi.fn(),
        debug: vi.fn(),
        error: vi.fn(),
        warn: vi.fn()
    }
}));

vi.mock('../../src/js/secureStorage.js', () => ({
    secureStorage: {
        addSentMessage: vi.fn().mockResolvedValue(undefined)
    }
}));

vi.mock('../../src/js/channelIdentity.js', () => ({
    getChannelIdentity: vi.fn(() => ({
        identity: { __channelIdentity: true },
        publisherId: '0xephemeralpublisher',
        proof: '0x' + '11'.repeat(65)
    })),
    dropChannelIdentity: vi.fn(),
    clearChannelIdentities: vi.fn()
}));

vi.mock('../../src/js/publisherProof.js', () => ({
    recoverPublisherAccount: vi.fn(() => null),
    createPublisherProof: vi.fn(() => '0x' + '11'.repeat(65)),
    clearPublisherProofCache: vi.fn()
}));

vi.mock('../../src/js/dm.js', () => ({
    dmManager: {
        getPeerPublicKey: vi.fn().mockResolvedValue('peerPubKey123'),
        sealAndPublish: vi.fn().mockResolvedValue(undefined),
        sealFor: vi.fn().mockResolvedValue({
            envelope: { v: 2, epk: '0x02epk', ct: 'sealed', iv: 'iv', e: 'aes-256-gcm' },
            ephemeralPrivateKey: '0xephemeral'
        }),
        publishSealed: vi.fn().mockResolvedValue(undefined)
    }
}));

vi.mock('../../src/js/dmCrypto.js', () => ({
    dmCrypto: {
        getSharedKey: vi.fn().mockResolvedValue('sharedAesKey'),
        encrypt: vi.fn().mockResolvedValue({ encrypted: true })
    }
}));

// Import after mocks
import { mediaController, MEDIA_CONFIG, PieceRtoEstimator } from '../../src/js/media.js';
import { cryptoManager } from '../../src/js/crypto.js';
import { streamrController, deriveEphemeralId } from '../../src/js/streamr.js';
import { authManager } from '../../src/js/auth.js';
import { channelManager } from '../../src/js/channels.js';
import { identityManager } from '../../src/js/identity.js';
import { secureStorage } from '../../src/js/secureStorage.js';
import { dmManager } from '../../src/js/dm.js';
import { dmCrypto } from '../../src/js/dmCrypto.js';

describe('media.js core', () => {
    let originalMaxCacheBytes;

    beforeEach(() => {
        vi.clearAllMocks();
        vi.restoreAllMocks();
        // Save and reset MAX_IMAGE_CACHE_BYTES (tests may modify it)
        originalMaxCacheBytes = mediaController.MAX_IMAGE_CACHE_BYTES;
        // Reset state
        mediaController.imageCache.clear();
        mediaController.imageCacheBytes = 0;
        mediaController.localFiles.clear();
        mediaController.downloadedUrls.clear();
        mediaController.incomingFiles.clear();
        mediaController.fileSeeders.clear();
        mediaController.pieceSendQueue = [];
        mediaController.isSendingPieces = false;
        mediaController.lastPieceSentTime = 0;
        mediaController.currentOwnerAddress = null;
        mediaController.persistedStorageSize = 0;
        mediaController.handlers = {};
        mediaController.db = null;
        mediaController._pendingImageRequests = new Map();
    });

    afterEach(() => {
        mediaController.MAX_IMAGE_CACHE_BYTES = originalMaxCacheBytes;
    });

    // ==================== LIFECYCLE ====================
    describe('Lifecycle', () => {
        describe('constructor', () => {
            it('initializes imageCache as empty Map', () => {
                expect(mediaController.imageCache).toBeInstanceOf(Map);
            });

            it('initializes localFiles as empty Map', () => {
                expect(mediaController.localFiles).toBeInstanceOf(Map);
            });

            it('initializes incomingFiles as empty Map', () => {
                expect(mediaController.incomingFiles).toBeInstanceOf(Map);
            });

            it('initializes fileSeeders as empty Map', () => {
                expect(mediaController.fileSeeders).toBeInstanceOf(Map);
            });

            it('initializes handlers object', () => {
                expect(mediaController.handlers).toBeDefined();
            });

            it('initializes persistedStorageSize to 0', () => {
                expect(mediaController.persistedStorageSize).toBe(0);
            });
        });

        describe('setOwner', () => {
            it('sets currentOwnerAddress lowercase', async () => {
                mediaController.db = null; // no DB = loadPersistedSeedFiles is a no-op
                await mediaController.setOwner('0xABCDEF');
                expect(mediaController.currentOwnerAddress).toBe('0xabcdef');
            });

            it('handles null address', async () => {
                await mediaController.setOwner(null);
                expect(mediaController.currentOwnerAddress).toBeNull();
            });

            it('handles undefined address', async () => {
                await mediaController.setOwner(undefined);
                expect(mediaController.currentOwnerAddress).toBeNull();
            });
        });

        describe('reset', () => {
            it('clears imageCache', () => {
                mediaController.imageCache.set('img1', 'data');
                mediaController.reset();
                expect(mediaController.imageCache.size).toBe(0);
            });

            it('resets imageCacheBytes', () => {
                mediaController.imageCacheBytes = 5000;
                mediaController.reset();
                expect(mediaController.imageCacheBytes).toBe(0);
            });

            it('clears localFiles', () => {
                mediaController.localFiles.set('f1', {});
                mediaController.reset();
                expect(mediaController.localFiles.size).toBe(0);
            });

            it('clears downloadedUrls', () => {
                mediaController.downloadedUrls.set('f1', 'blob:url');
                mediaController.reset();
                expect(mediaController.downloadedUrls.size).toBe(0);
            });

            it('clears incomingFiles', () => {
                mediaController.incomingFiles.set('f1', {});
                mediaController.reset();
                expect(mediaController.incomingFiles.size).toBe(0);
            });

            it('clears fileSeeders', () => {
                mediaController.fileSeeders.set('f1', new Set());
                mediaController.reset();
                expect(mediaController.fileSeeders.size).toBe(0);
            });

            it('resets piece send queue', () => {
                mediaController.pieceSendQueue = [{ some: 'item' }];
                mediaController.activeSends = 2;
                mediaController.reset();
                expect(mediaController.pieceSendQueue).toEqual([]);
                expect(mediaController.activeSends).toBe(0);
            });

            it('resets currentOwnerAddress', () => {
                mediaController.currentOwnerAddress = '0xabc';
                mediaController.reset();
                expect(mediaController.currentOwnerAddress).toBeNull();
            });

            it('resets persistedStorageSize', () => {
                mediaController.persistedStorageSize = 10000;
                mediaController.reset();
                expect(mediaController.persistedStorageSize).toBe(0);
            });

            it('clears download timers', () => {
                const clearSpy = vi.spyOn(global, 'clearTimeout');
                const timer = setTimeout(() => {}, 99999);
                mediaController.incomingFiles.set('f1', {
                    seederDiscoveryTimer: timer,
                    requestsInFlight: new Map([[0, { timeoutId: setTimeout(() => {}, 99999) }]])
                });
                mediaController.reset();
                expect(clearSpy).toHaveBeenCalled();
                clearSpy.mockRestore();
            });

            it('revokes blob URLs', () => {
                const revokeSpy = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
                mediaController.downloadedUrls.set('f1', 'blob:http://test/abc');
                mediaController.downloadedUrls.set('f2', 'blob:http://test/def');
                mediaController.reset();
                expect(revokeSpy).toHaveBeenCalledTimes(2);
                revokeSpy.mockRestore();
            });
        });
    });

    // ==================== handleMediaMessage DISPATCH ====================
    describe('handleMediaMessage dispatch', () => {
        it('dispatches piece_request to handlePieceRequest', () => {
            const spy = vi.spyOn(mediaController, 'handlePieceRequest');
            mediaController.handleMediaMessage('stream-1', { type: 'piece_request', fileId: 'f1' });
            expect(spy).toHaveBeenCalledWith('stream-1', { type: 'piece_request', fileId: 'f1' });
            spy.mockRestore();
        });

        it('dispatches file_piece to handleFilePiece', () => {
            const spy = vi.spyOn(mediaController, 'handleFilePiece');
            mediaController.handleMediaMessage('stream-1', { type: 'file_piece', fileId: 'f1', pieceIndex: 0 });
            expect(spy).toHaveBeenCalledWith('stream-1', { type: 'file_piece', fileId: 'f1', pieceIndex: 0 });
            spy.mockRestore();
        });

        it('dispatches source_request to handleSourceRequest', () => {
            const spy = vi.spyOn(mediaController, 'handleSourceRequest');
            mediaController.handleMediaMessage('stream-1', { type: 'source_request', fileId: 'f1' });
            expect(spy).toHaveBeenCalledWith('stream-1', { type: 'source_request', fileId: 'f1' });
            spy.mockRestore();
        });

        it('dispatches source_announce to handleSourceAnnounce', () => {
            const spy = vi.spyOn(mediaController, 'handleSourceAnnounce');
            mediaController.handleMediaMessage('stream-1', { type: 'source_announce', fileId: 'f1' });
            expect(spy).toHaveBeenCalledWith({ type: 'source_announce', fileId: 'f1' });
            spy.mockRestore();
        });

        it('handles unknown type without error', () => {
            expect(() => mediaController.handleMediaMessage('stream-1', { type: 'unknown_type' })).not.toThrow();
        });
    });

    // ==================== IMAGE HANDLING ====================
    describe('Image Handling', () => {
        describe('handleImageData', () => {
            it('caches image data', () => {
                mediaController.handleImageData({ type: 'image_data', imageId: 'img1', data: 'base64data' });
                expect(mediaController.imageCache.get('img1')).toBe('base64data');
            });

            it('updates imageCacheBytes', () => {
                mediaController.handleImageData({ type: 'image_data', imageId: 'img1', data: 'abc' });
                expect(mediaController.imageCacheBytes).toBe(6); // 'abc'.length * 2
            });

            it('calls onImageReceived handler', () => {
                const handler = vi.fn();
                mediaController.handlers.onImageReceived = handler;
                mediaController.handleImageData({ type: 'image_data', imageId: 'img1', data: 'data' });
                expect(handler).toHaveBeenCalledWith('img1', 'data');
            });

            it('ignores wrong type', () => {
                mediaController.handleImageData({ type: 'not_image_data', imageId: 'img1', data: 'data' });
                expect(mediaController.imageCache.size).toBe(0);
            });

            it('ignores missing imageId', () => {
                mediaController.handleImageData({ type: 'image_data', data: 'data' });
                expect(mediaController.imageCache.size).toBe(0);
            });

            it('ignores missing data', () => {
                mediaController.handleImageData({ type: 'image_data', imageId: 'img1' });
                expect(mediaController.imageCache.size).toBe(0);
            });
        });

        describe('cacheImage', () => {
            it('caches image data', () => {
                mediaController.cacheImage('img1', 'base64data');
                expect(mediaController.imageCache.get('img1')).toBe('base64data');
            });

            it('updates byte count', () => {
                mediaController.cacheImage('img1', 'abc');
                expect(mediaController.imageCacheBytes).toBe(6);
            });

            it('does not overwrite existing cache entry', () => {
                mediaController.imageCache.set('img1', 'original');
                mediaController.cacheImage('img1', 'replacement');
                expect(mediaController.imageCache.get('img1')).toBe('original');
            });

            it('calls eviction if needed', () => {
                const spy = vi.spyOn(mediaController, 'evictImageCacheIfNeeded');
                mediaController.cacheImage('img1', 'data');
                expect(spy).toHaveBeenCalled();
                spy.mockRestore();
            });
        });

        describe('compressImageToTarget', () => {
            const LIMIT = 1 * 1024 * 1024;

            beforeEach(() => {
                vi.spyOn(mediaController, 'supportsCanvasMime').mockReturnValue(true);
            });

            it('returns null when the output mime is not supported', async () => {
                mediaController.supportsCanvasMime.mockReturnValue(false);
                const encodeSpy = vi.spyOn(mediaController, 'encodeImageToBlob');

                const result = await mediaController.compressImageToTarget({}, 'image/webp', {
                    initialQuality: 1.0,
                    minQuality: 0.7
                });

                expect(result).toBeNull();
                expect(encodeSpy).not.toHaveBeenCalled();
            });

            it('returns the maximum quality at full resolution when everything fits', async () => {
                vi.spyOn(mediaController, 'encodeImageToBlob').mockImplementation(async (_i, _m, _q, scale) => ({
                    size: 100 * 1024,
                    type: 'image/webp',
                    scale
                }));

                const result = await mediaController.compressImageToTarget({}, 'image/webp', {
                    initialQuality: 1.0,
                    minQuality: 0.7
                });

                expect(result.quality).toBe(1.0);
                expect(result.blob.scale).toBe(1);
                expect(result.blob.size).toBeLessThanOrEqual(LIMIT);
            });

            it('keeps the result under the assembled byte limit', async () => {
                vi.spyOn(mediaController, 'encodeImageToBlob').mockImplementation(async (_i, _m, q) => ({
                    size: Math.round(500 * 1024 + q * 600 * 1024),
                    type: 'image/webp'
                }));

                const result = await mediaController.compressImageToTarget({}, 'image/webp', {
                    initialQuality: 1.0,
                    minQuality: 0.7
                });

                expect(result).not.toBeNull();
                expect(result.blob.size).toBeLessThanOrEqual(LIMIT);
            });

            it('prefers the highest quality that still fits at the largest viable resolution', async () => {
                vi.spyOn(mediaController, 'encodeImageToBlob').mockImplementation(async (_i, _m, q) => ({
                    size: Math.round(500 * 1024 + q * 600 * 1024),
                    type: 'image/webp'
                }));

                const result = await mediaController.compressImageToTarget({}, 'image/webp', {
                    initialQuality: 1.0,
                    minQuality: 0.7
                });

                expect(result.blob.size).toBeLessThanOrEqual(LIMIT);
                expect(LIMIT - result.blob.size).toBeLessThan(20 * 1024);
                expect(result.quality).toBeGreaterThan(0.7);
                expect(result.quality).toBeLessThan(1.0);
            });

            it('downscales when no quality fits at full resolution', async () => {
                const seenScales = new Set();
                vi.spyOn(mediaController, 'encodeImageToBlob').mockImplementation(async (_i, _m, q, scale) => {
                    seenScales.add(scale);
                    const baseSize = scale > 0.6 ? 2.5 * 1024 * 1024 : 700 * 1024;
                    return {
                        size: Math.round(baseSize * (0.6 + q * 0.4)),
                        type: 'image/webp',
                        scale
                    };
                });

                const result = await mediaController.compressImageToTarget({}, 'image/webp', {
                    initialQuality: 1.0,
                    minQuality: 0.7
                });

                expect(result).not.toBeNull();
                expect(result.blob.size).toBeLessThanOrEqual(LIMIT);
                expect(result.blob.scale).toBeLessThan(1);
                expect(seenScales.size).toBeGreaterThan(1);
            });

            it('returns null when no scale and quality combination fits', async () => {
                vi.spyOn(mediaController, 'encodeImageToBlob').mockResolvedValue({
                    size: 5 * 1024 * 1024,
                    type: 'image/webp'
                });

                const result = await mediaController.compressImageToTarget({}, 'image/webp', {
                    initialQuality: 1.0,
                    minQuality: 0.7
                });

                expect(result).toBeNull();
            });
        });

        describe('evictImageCacheIfNeeded', () => {
            it('does nothing if under limit', () => {
                mediaController.imageCacheBytes = 100;
                mediaController.imageCache.set('img1', 'data');
                mediaController.evictImageCacheIfNeeded();
                expect(mediaController.imageCache.size).toBe(1);
            });

            it('evicts entries when over byte limit', () => {
                mediaController.MAX_IMAGE_CACHE_BYTES = 10;
                mediaController.imageCache.set('img1', 'aaaa'); // 8 bytes
                mediaController.imageCache.set('img2', 'bbbb'); // 8 bytes
                mediaController.imageCache.set('img3', 'cccc'); // 8 bytes
                mediaController.imageCacheBytes = 24;
                mediaController.evictImageCacheIfNeeded();
                // Should evict oldest entries until under limit
                expect(mediaController.imageCacheBytes).toBeLessThanOrEqual(10);
            });

            it('evicts in insertion order (LRU)', () => {
                mediaController.MAX_IMAGE_CACHE_BYTES = 10;
                mediaController.imageCache.set('first', 'aaaa');
                mediaController.imageCache.set('second', 'bbbb');
                mediaController.imageCache.set('third', 'cccc');
                mediaController.imageCacheBytes = 24;
                mediaController.evictImageCacheIfNeeded();
                // 'first' should be evicted first, then 'second'
                expect(mediaController.imageCache.has('first')).toBe(false);
            });
        });
    });

    // ==================== handleFilePiece ====================
    describe('handleFilePiece', () => {
        const createTransfer = (pieceCount = 3) => ({
            metadata: {
                fileId: 'file-1',
                fileSize: pieceCount * 100,
                pieceCount,
                pieceHashes: []
            },
            streamId: 'stream-1',
            password: null,
            pieceStatus: new Array(pieceCount).fill('pending'),
            requestsInFlight: new Map(),
            receivedCount: 0,
            pieces: new Array(pieceCount).fill(null),
            useIndexedDB: false,
            window: MEDIA_CONFIG.PIECE_WINDOW_START,
            lastWindowBackoffAt: 0,
            rto: new PieceRtoEstimator(MEDIA_CONFIG.PIECE_REQUEST_TIMEOUT)
        });

        it('skips own pieces (self-filtering)', async () => {
            authManager.getAddress.mockReturnValue('0xMyAddress');
            const transfer = createTransfer();
            mediaController.incomingFiles.set('file-1', transfer);

            await mediaController.handleFilePiece('stream-1', {
                fileId: 'file-1',
                pieceIndex: 0,
                account: '0xMyAddress',
                data: 'base64data'
            });

            expect(transfer.receivedCount).toBe(0);
        });

        it('skips pieces for unknown transfers', async () => {
            authManager.getAddress.mockReturnValue('0xme');
            // No transfer registered
            await expect(
                mediaController.handleFilePiece('stream-1', {
                    fileId: 'no-such-file',
                    pieceIndex: 0,
                    account: '0xother',
                    data: 'data'
                })
            ).resolves.not.toThrow();
        });

        it('skips already done pieces', async () => {
            authManager.getAddress.mockReturnValue('0xme');
            const transfer = createTransfer();
            transfer.pieceStatus[0] = 'done';
            mediaController.incomingFiles.set('file-1', transfer);

            await mediaController.handleFilePiece('stream-1', {
                fileId: 'file-1',
                pieceIndex: 0,
                account: '0xother',
                data: 'data'
            });

            expect(transfer.receivedCount).toBe(0);
        });

        it('skips already-done pieces', async () => {
            authManager.getAddress.mockReturnValue('0xme');
            const transfer = createTransfer();
            transfer.pieceStatus[0] = 'done'; // already received
            mediaController.incomingFiles.set('file-1', transfer);

            await mediaController.handleFilePiece('stream-1', {
                fileId: 'file-1',
                pieceIndex: 0,
                account: '0xother',
                data: 'data'
            });

            expect(transfer.receivedCount).toBe(0);
        });

        it('resets to pending on base64 decode failure', async () => {
            authManager.getAddress.mockReturnValue('0xme');
            const transfer = createTransfer();
            transfer.pieceStatus[0] = 'requested';
            mediaController.incomingFiles.set('file-1', transfer);

            vi.spyOn(mediaController, 'base64ToArrayBuffer').mockReturnValue(null);
            vi.spyOn(mediaController, 'manageDownload').mockImplementation(() => {});

            await mediaController.handleFilePiece('stream-1', {
                fileId: 'file-1',
                pieceIndex: 0,
                account: '0xother',
                data: 'baddata'
            });

            expect(transfer.pieceStatus[0]).toBe('pending');
        });

        it('resets to pending on hash mismatch', async () => {
            authManager.getAddress.mockReturnValue('0xme');
            const transfer = createTransfer();
            transfer.pieceStatus[0] = 'requested';
            transfer.metadata.pieceHashes[0] = 'expected_hash_abc';
            mediaController.incomingFiles.set('file-1', transfer);

            vi.spyOn(mediaController, 'base64ToArrayBuffer').mockReturnValue(new ArrayBuffer(8));
            vi.spyOn(mediaController, 'sha256').mockResolvedValue('wrong_hash_xyz');
            vi.spyOn(mediaController, 'manageDownload').mockImplementation(() => {});

            await mediaController.handleFilePiece('stream-1', {
                fileId: 'file-1',
                pieceIndex: 0,
                account: '0xother',
                data: 'encoded'
            });

            expect(transfer.pieceStatus[0]).toBe('pending');
        });

        it('stores piece and updates state on valid piece', async () => {
            authManager.getAddress.mockReturnValue('0xme');
            const transfer = createTransfer();
            transfer.pieceStatus[0] = 'requested';
            transfer.metadata.pieceHashes[0] = 'correct_hash';
            const timeoutId = setTimeout(() => {}, 99999);
            transfer.requestsInFlight.set(0, { seederId: '0xseeder', timeoutId });
            mediaController.incomingFiles.set('file-1', transfer);

            const buf = new ArrayBuffer(8);
            vi.spyOn(mediaController, 'base64ToArrayBuffer').mockReturnValue(buf);
            vi.spyOn(mediaController, 'sha256').mockResolvedValue('correct_hash');
            vi.spyOn(mediaController, 'manageDownload').mockImplementation(() => {});
            const clearSpy = vi.spyOn(global, 'clearTimeout');

            await mediaController.handleFilePiece('stream-1', {
                fileId: 'file-1',
                pieceIndex: 0,
                account: '0xother',
                data: 'encoded'
            });

            expect(transfer.pieceStatus[0]).toBe('done');
            expect(transfer.receivedCount).toBe(1);
            expect(transfer.pieces[0]).toBeInstanceOf(Uint8Array);
            expect(clearSpy).toHaveBeenCalledWith(timeoutId);
            clearSpy.mockRestore();
        });

        it('calls onFileProgress handler', async () => {
            authManager.getAddress.mockReturnValue('0xme');
            const handler = vi.fn();
            mediaController.handlers.onFileProgress = handler;

            const transfer = createTransfer(5);
            transfer.pieceStatus[2] = 'requested';
            transfer.metadata.pieceHashes[2] = 'hash';
            mediaController.incomingFiles.set('file-1', transfer);

            vi.spyOn(mediaController, 'base64ToArrayBuffer').mockReturnValue(new ArrayBuffer(8));
            vi.spyOn(mediaController, 'sha256').mockResolvedValue('hash');
            vi.spyOn(mediaController, 'manageDownload').mockImplementation(() => {});

            await mediaController.handleFilePiece('stream-1', {
                fileId: 'file-1',
                pieceIndex: 2,
                account: '0xother',
                data: 'data'
            });

            // Sixth argument is the measured rate; null on the first piece, since a
            // rate needs at least two samples and a second of span
            expect(handler).toHaveBeenCalledWith('file-1', 20, 1, 5, 500, null);
        });

        it('calls assembleFile when all pieces done', async () => {
            authManager.getAddress.mockReturnValue('0xme');
            const transfer = createTransfer(2);
            transfer.pieceStatus[0] = 'done';
            transfer.pieces[0] = new Uint8Array(8);
            transfer.receivedCount = 1;
            transfer.pieceStatus[1] = 'requested';
            transfer.metadata.pieceHashes[1] = 'hash2';
            mediaController.incomingFiles.set('file-1', transfer);

            vi.spyOn(mediaController, 'base64ToArrayBuffer').mockReturnValue(new ArrayBuffer(8));
            vi.spyOn(mediaController, 'sha256').mockResolvedValue('hash2');
            const assembleSpy = vi.spyOn(mediaController, 'assembleFile').mockResolvedValue(undefined);

            await mediaController.handleFilePiece('stream-1', {
                fileId: 'file-1',
                pieceIndex: 1,
                account: '0xother',
                data: 'data'
            });

            expect(assembleSpy).toHaveBeenCalledWith('file-1');
            assembleSpy.mockRestore();
        });

        // The delivery feedback loop: a good piece widens the window and immediately
        // tops the outstanding requests back up. This is what replaces push mode.
        it('widens the window and tops up requests on a delivered piece', async () => {
            authManager.getAddress.mockReturnValue('0xme');
            const transfer = createTransfer(5);
            transfer.pieceStatus[1] = 'requested';
            transfer.metadata.pieceHashes[1] = 'hash2';
            const windowBefore = transfer.window;
            mediaController.incomingFiles.set('file-1', transfer);

            vi.spyOn(mediaController, 'base64ToArrayBuffer').mockReturnValue(new ArrayBuffer(8));
            vi.spyOn(mediaController, 'sha256').mockResolvedValue('hash2');
            const manageSpy = vi.spyOn(mediaController, 'manageDownload').mockImplementation(() => {});

            await mediaController.handleFilePiece('stream-1', {
                fileId: 'file-1',
                pieceIndex: 1,
                account: '0xother',
                data: 'data'
            });

            expect(transfer.window).toBe(windowBefore + 1);
            expect(manageSpy).toHaveBeenCalledWith('file-1');
            manageSpy.mockRestore();
        });

        it('does not widen the window past the maximum', async () => {
            authManager.getAddress.mockReturnValue('0xme');
            const transfer = createTransfer(5);
            transfer.window = MEDIA_CONFIG.PIECE_WINDOW_MAX;
            transfer.pieceStatus[1] = 'requested';
            transfer.metadata.pieceHashes[1] = 'hash2';
            mediaController.incomingFiles.set('file-1', transfer);

            vi.spyOn(mediaController, 'base64ToArrayBuffer').mockReturnValue(new ArrayBuffer(8));
            vi.spyOn(mediaController, 'sha256').mockResolvedValue('hash2');
            const manageSpy = vi.spyOn(mediaController, 'manageDownload').mockImplementation(() => {});

            await mediaController.handleFilePiece('stream-1', {
                fileId: 'file-1',
                pieceIndex: 1,
                account: '0xother',
                data: 'data'
            });

            expect(transfer.window).toBe(MEDIA_CONFIG.PIECE_WINDOW_MAX);
            manageSpy.mockRestore();
        });
    });

    // ==================== assembleFile ====================
    describe('assembleFile', () => {
        it('assembles pieces into blob and notifies completion', async () => {
            const piece0 = new Uint8Array([1, 2, 3]);
            const piece1 = new Uint8Array([4, 5, 6]);
            const transfer = {
                metadata: {
                    fileId: 'file-1',
                    fileName: 'test.mp4',
                    fileSize: 6,
                    fileType: 'video/mp4',
                    pieceCount: 2,
                    pieceHashes: ['h1', 'h2']
                },
                streamId: 'stream-1',
                password: null,
                isPrivateChannel: false,
                pieceStatus: ['done', 'done'],
                pieces: [piece0, piece1],
                receivedCount: 2,
                useIndexedDB: false,
                seederDiscoveryTimer: null
            };
            mediaController.incomingFiles.set('file-1', transfer);

            const onComplete = vi.fn();
            mediaController.handlers.onFileComplete = onComplete;

            vi.spyOn(mediaController, 'announceFileSource').mockResolvedValue(undefined);
            vi.spyOn(mediaController, 'persistSeedFile').mockResolvedValue(false);

            await mediaController.assembleFile('file-1');

            // Should have cached URL
            expect(mediaController.downloadedUrls.has('file-1')).toBe(true);
            // Should notify completion
            expect(onComplete).toHaveBeenCalledWith('file-1', transfer.metadata, expect.any(String), expect.any(Blob));
            // Should register as local file for seeding
            expect(mediaController.localFiles.has('file-1')).toBe(true);
            // Should clean up transfer
            expect(mediaController.incomingFiles.has('file-1')).toBe(false);
        });

        it('aborts if not all pieces are done', async () => {
            const transfer = {
                metadata: { fileId: 'file-1', pieceCount: 3, fileSize: 9 },
                pieceStatus: ['done', 'pending', 'done'],
                pieces: [new Uint8Array(3), null, new Uint8Array(3)],
                receivedCount: 2,
                useIndexedDB: false
            };
            mediaController.incomingFiles.set('file-1', transfer);
            const manageSpy = vi.spyOn(mediaController, 'manageDownload').mockImplementation(() => {});

            await mediaController.assembleFile('file-1');

            // Should still be downloading
            expect(mediaController.incomingFiles.has('file-1')).toBe(true);
            expect(manageSpy).toHaveBeenCalledWith('file-1');
            manageSpy.mockRestore();
        });

        it('does nothing if transfer not found', async () => {
            await expect(mediaController.assembleFile('nonexistent')).resolves.not.toThrow();
        });

        it('announces as seeder after assembly', async () => {
            const transfer = {
                metadata: { fileId: 'file-1', fileName: 'test.mp4', fileSize: 3, fileType: 'video/mp4', pieceCount: 1, pieceHashes: ['h'] },
                streamId: 'stream-1',
                password: 'pwd',
                isPrivateChannel: true,
                pieceStatus: ['done'],
                pieces: [new Uint8Array([1, 2, 3])],
                receivedCount: 1,
                useIndexedDB: false,
                seederDiscoveryTimer: null
            };
            mediaController.incomingFiles.set('file-1', transfer);
            const announceSpy = vi.spyOn(mediaController, 'announceFileSource').mockResolvedValue(undefined);
            vi.spyOn(mediaController, 'persistSeedFile').mockResolvedValue(false);

            await mediaController.assembleFile('file-1');

            expect(announceSpy).toHaveBeenCalledWith('stream-1', 'file-1', 'pwd');
            announceSpy.mockRestore();
        });

        it('clears seeder discovery timer on completion', async () => {
            const clearSpy = vi.spyOn(global, 'clearTimeout');
            const timer = setTimeout(() => {}, 99999);
            const transfer = {
                metadata: { fileId: 'file-1', fileName: 'test.mp4', fileSize: 3, fileType: 'video/mp4', pieceCount: 1, pieceHashes: ['h'] },
                streamId: 'stream-1',
                password: null,
                isPrivateChannel: false,
                pieceStatus: ['done'],
                pieces: [new Uint8Array([1, 2, 3])],
                receivedCount: 1,
                useIndexedDB: false,
                seederDiscoveryTimer: timer
            };
            mediaController.incomingFiles.set('file-1', transfer);
            vi.spyOn(mediaController, 'announceFileSource').mockResolvedValue(undefined);
            vi.spyOn(mediaController, 'persistSeedFile').mockResolvedValue(false);

            await mediaController.assembleFile('file-1');

            expect(clearSpy).toHaveBeenCalledWith(timer);
            clearSpy.mockRestore();
        });

        // The blob is built straight from the piece array (no contiguous copy),
        // so guard the thing that would break silently: order and exact bytes.
        it('preserves piece order and byte content in the assembled blob', async () => {
            const transfer = {
                metadata: {
                    fileId: 'file-bytes', fileName: 'a.bin', fileSize: 6,
                    fileType: 'application/octet-stream', pieceCount: 2, pieceHashes: ['h1', 'h2']
                },
                streamId: 'stream-1',
                password: null,
                isPrivateChannel: false,
                pieceStatus: ['done', 'done'],
                pieces: [new Uint8Array([1, 2, 3]), new Uint8Array([4, 5, 6])],
                receivedCount: 2,
                useIndexedDB: false,
                seederDiscoveryTimer: null
            };
            mediaController.incomingFiles.set('file-bytes', transfer);

            let captured;
            mediaController.handlers.onFileComplete = (id, meta, url, blob) => { captured = blob; };
            vi.spyOn(mediaController, 'announceFileSource').mockResolvedValue(undefined);
            vi.spyOn(mediaController, 'persistSeedFile').mockResolvedValue(false);

            await mediaController.assembleFile('file-bytes');

            expect(captured.size).toBe(6);
            expect(new Uint8Array(await captured.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3, 4, 5, 6]));
        });
    });

    // ==================== handlePieceRequest ====================
    describe('handlePieceRequest', () => {
        it('sends piece when request is for us', async () => {
            authManager.getAddress.mockReturnValue('0xMyAddr');
            mediaController.localFiles.set('file-1', { file: new Blob(['test']), metadata: {} });
            const sendSpy = vi.spyOn(mediaController, 'sendPiece').mockResolvedValue(undefined);

            await mediaController.handlePieceRequest('stream-1', {
                fileId: 'file-1',
                pieceIndex: 0,
                targetSeederId: '0xmyaddr' // lowercase matches
            });

            expect(sendSpy).toHaveBeenCalledWith('stream-1', 'file-1', 0);
            sendSpy.mockRestore();
        });

        it('ignores request not targeted at us', async () => {
            authManager.getAddress.mockReturnValue('0xMyAddr');
            const sendSpy = vi.spyOn(mediaController, 'sendPiece').mockResolvedValue(undefined);

            await mediaController.handlePieceRequest('stream-1', {
                fileId: 'file-1',
                pieceIndex: 0,
                targetSeederId: '0xOtherPeer'
            });

            expect(sendSpy).not.toHaveBeenCalled();
            sendSpy.mockRestore();
        });

        it('ignores request for unknown file', async () => {
            authManager.getAddress.mockReturnValue('0xMyAddr');
            const sendSpy = vi.spyOn(mediaController, 'sendPiece').mockResolvedValue(undefined);

            await mediaController.handlePieceRequest('stream-1', {
                fileId: 'unknown',
                pieceIndex: 0,
                targetSeederId: '0xmyaddr'
            });

            expect(sendSpy).not.toHaveBeenCalled();
            sendSpy.mockRestore();
        });

        it('handles null address gracefully', async () => {
            authManager.getAddress.mockReturnValue(null);
            await expect(mediaController.handlePieceRequest('stream-1', {
                fileId: 'file-1',
                pieceIndex: 0,
                targetSeederId: '0xaddr'
            })).resolves.not.toThrow();
        });
    });

    // ==================== sendPiece / _sendPieceImmediate ====================
    describe('sendPiece / _sendPieceImmediate', () => {
        it('queues piece and processes', async () => {
            const blob = new Blob([new Uint8Array([1, 2, 3, 4])]);
            mediaController.localFiles.set('file-1', {
                file: blob,
                metadata: { pieceCount: 1 }
            });
            channelManager.getChannel.mockReturnValue({ password: null });

            await mediaController.sendPiece('stream-1', 'file-1', 0);

            // Channel pieces publish under the channel's ephemeral identity,
            // never the wallet, with the proof carried inline in the frame.
            expect(streamrController.publishMediaDataAs).toHaveBeenCalledWith(
                'ephemeral-stream-1',
                expect.any(Uint8Array),
                { __channelIdentity: true }
            );
            expect(streamrController.publishMediaData).not.toHaveBeenCalled();
        });

        it('_sendPieceImmediate skips if file not found', async () => {
            await mediaController._sendPieceImmediate('stream-1', 'nonexistent', 0);
            expect(streamrController.publishMediaData).not.toHaveBeenCalled();
        });

        it('sends with encryption password', async () => {
            const blob = new Blob([new Uint8Array([10, 20])]);
            mediaController.localFiles.set('file-1', {
                file: blob,
                metadata: { pieceCount: 1 }
            });
            channelManager.getChannel.mockReturnValue({ password: 'secret123' });
            const encryptBinary = vi.spyOn(cryptoManager, 'encryptBinary');

            await mediaController._sendPieceImmediate('stream-1', 'file-1', 0);

            // The password still encrypts the frame; what changed is who signs it
            expect(encryptBinary).toHaveBeenCalledWith(expect.any(Uint8Array), 'secret123');
            encryptBinary.mockRestore();
            expect(streamrController.publishMediaDataAs).toHaveBeenCalledWith(
                'ephemeral-stream-1',
                expect.any(Uint8Array),
                { __channelIdentity: true }
            );
        });
    });

    // ==================== requestFileSources ====================
    describe('requestFileSources', () => {
        it('publishes source_request to ephemeral stream', async () => {
            await mediaController.requestFileSources('stream-1', 'file-1');

            expect(streamrController.publishMediaSignal).toHaveBeenCalledWith(
                'ephemeral-stream-1',
                { type: 'source_request', fileId: 'file-1' },
                null
            );
        });

        it('passes password for encrypted channels', async () => {
            await mediaController.requestFileSources('stream-1', 'file-1', 'pwd');

            expect(streamrController.publishMediaSignal).toHaveBeenCalledWith(
                'ephemeral-stream-1',
                { type: 'source_request', fileId: 'file-1' },
                'pwd'
            );
        });
    });

    // ==================== handleSourceRequest ====================
    describe('handleSourceRequest', () => {
        it('announces as source if file is local', async () => {
            mediaController.localFiles.set('file-1', { file: new Blob() });
            channelManager.getChannel.mockReturnValue({ password: null });
            const announceSpy = vi.spyOn(mediaController, 'announceFileSource').mockResolvedValue(undefined);

            await mediaController.handleSourceRequest('stream-1', { fileId: 'file-1' });

            expect(announceSpy).toHaveBeenCalledWith('stream-1', 'file-1', null);
            announceSpy.mockRestore();
        });

        it('announces with password for encrypted channel', async () => {
            mediaController.localFiles.set('file-1', { file: new Blob() });
            channelManager.getChannel.mockReturnValue({ password: 'secret' });
            const announceSpy = vi.spyOn(mediaController, 'announceFileSource').mockResolvedValue(undefined);

            await mediaController.handleSourceRequest('stream-1', { fileId: 'file-1' });

            expect(announceSpy).toHaveBeenCalledWith('stream-1', 'file-1', 'secret');
            announceSpy.mockRestore();
        });

        it('does nothing if file not local', async () => {
            const announceSpy = vi.spyOn(mediaController, 'announceFileSource').mockResolvedValue(undefined);

            await mediaController.handleSourceRequest('stream-1', { fileId: 'no-file' });

            expect(announceSpy).not.toHaveBeenCalled();
            announceSpy.mockRestore();
        });
    });

    // ==================== announceFileSource ====================
    describe('announceFileSource', () => {
        it('publishes source_announce to ephemeral stream', async () => {
            await mediaController.announceFileSource('stream-1', 'file-1');

            expect(streamrController.publishMediaSignal).toHaveBeenCalledWith(
                'ephemeral-stream-1',
                { type: 'source_announce', fileId: 'file-1', pieceCount: 0 },
                null
            );
        });

        it('passes password for encryption', async () => {
            await mediaController.announceFileSource('stream-1', 'file-1', 'pwd');

            expect(streamrController.publishMediaSignal).toHaveBeenCalledWith(
                'ephemeral-stream-1',
                { type: 'source_announce', fileId: 'file-1', pieceCount: 0 },
                'pwd'
            );
        });
    });

    // ==================== startDownload ====================
    describe('startDownload', () => {
        it('initializes transfer state', async () => {
            vi.spyOn(mediaController, 'startSeederDiscovery').mockImplementation(() => {});
            const metadata = {
                fileId: 'file-dl-1',
                fileName: 'test.mp4',
                fileSize: 1024,
                fileType: 'video/mp4',
                pieceCount: 3,
                pieceHashes: ['h1', 'h2', 'h3']
            };

            await mediaController.startDownload('stream-1', metadata);

            const transfer = mediaController.incomingFiles.get('file-dl-1');
            expect(transfer).toBeDefined();
            expect(transfer.metadata).toBe(metadata);
            expect(transfer.pieceStatus).toEqual(['pending', 'pending', 'pending']);
            expect(transfer.receivedCount).toBe(0);
            expect(transfer.pieces).toHaveLength(3);
            expect(transfer.downloadStarted).toBe(false);
        });

        it('initializes fileSeeders set', async () => {
            vi.spyOn(mediaController, 'startSeederDiscovery').mockImplementation(() => {});
            await mediaController.startDownload('stream-1', {
                fileId: 'file-dl-2', fileName: 'a', fileSize: 100, fileType: 'video/mp4', pieceCount: 1, pieceHashes: ['h']
            });
            expect(mediaController.fileSeeders.get('file-dl-2')).toBeInstanceOf(Set);
        });

        it('skips if download already in progress', async () => {
            const spy = vi.spyOn(mediaController, 'startSeederDiscovery').mockImplementation(() => {});
            mediaController.incomingFiles.set('file-dl-3', {});

            await mediaController.startDownload('stream-1', {
                fileId: 'file-dl-3', fileName: 'a', fileSize: 100, fileType: 'video/mp4', pieceCount: 1, pieceHashes: ['h']
            });

            expect(spy).not.toHaveBeenCalled();
            spy.mockRestore();
        });

        it('calls startSeederDiscovery', async () => {
            const spy = vi.spyOn(mediaController, 'startSeederDiscovery').mockImplementation(() => {});
            await mediaController.startDownload('stream-1', {
                fileId: 'file-dl-4', fileName: 'a', fileSize: 100, fileType: 'video/mp4', pieceCount: 1, pieceHashes: ['h']
            });
            expect(spy).toHaveBeenCalledWith('file-dl-4');
            spy.mockRestore();
        });

        // Resume: pieces persist in IndexedDB across sessions, so a restarted
        // download must only ask the network for what is actually missing.
        it('resumes from persisted pieces and skips the network when already complete', async () => {
            const previousDb = mediaController.db;
            mediaController.db = {}; // truthy => transfer opts into IndexedDB
            const discoverySpy = vi.spyOn(mediaController, 'startSeederDiscovery').mockImplementation(() => {});
            const assembleSpy = vi.spyOn(mediaController, 'assembleFile').mockResolvedValue(undefined);
            const restoreSpy = vi.spyOn(mediaController, 'restorePiecesFromIndexedDB')
                .mockImplementation(async (id, transfer) => {
                    transfer.pieceStatus.fill('done');
                    transfer.receivedCount = 4;
                    return 4;
                });

            await mediaController.startDownload('stream-1', {
                fileId: 'file-resume-1', fileName: 'big.mp4', fileSize: 20 * 1024 * 1024,
                fileType: 'video/mp4', pieceCount: 4, pieceHashes: ['a', 'b', 'c', 'd']
            });

            expect(assembleSpy).toHaveBeenCalledWith('file-resume-1');
            expect(discoverySpy).not.toHaveBeenCalled();

            discoverySpy.mockRestore();
            assembleSpy.mockRestore();
            restoreSpy.mockRestore();
            mediaController.db = previousDb;
        });

        it('resumes partially and still discovers seeders for the missing pieces', async () => {
            const previousDb = mediaController.db;
            mediaController.db = {};
            const discoverySpy = vi.spyOn(mediaController, 'startSeederDiscovery').mockImplementation(() => {});
            const assembleSpy = vi.spyOn(mediaController, 'assembleFile').mockResolvedValue(undefined);
            const restoreSpy = vi.spyOn(mediaController, 'restorePiecesFromIndexedDB')
                .mockImplementation(async (id, transfer) => {
                    transfer.pieceStatus[0] = 'done';
                    transfer.receivedCount = 1;
                    return 1;
                });

            await mediaController.startDownload('stream-1', {
                fileId: 'file-resume-2', fileName: 'big.mp4', fileSize: 20 * 1024 * 1024,
                fileType: 'video/mp4', pieceCount: 4, pieceHashes: ['a', 'b', 'c', 'd']
            });

            expect(assembleSpy).not.toHaveBeenCalled();
            expect(discoverySpy).toHaveBeenCalledWith('file-resume-2');
            expect(mediaController.incomingFiles.get('file-resume-2').pieceStatus)
                .toEqual(['done', 'pending', 'pending', 'pending']);

            discoverySpy.mockRestore();
            assembleSpy.mockRestore();
            restoreSpy.mockRestore();
            mediaController.db = previousDb;
        });

        it('does not look for persisted pieces on small files (RAM-only path)', async () => {
            const previousDb = mediaController.db;
            mediaController.db = {};
            const discoverySpy = vi.spyOn(mediaController, 'startSeederDiscovery').mockImplementation(() => {});
            const restoreSpy = vi.spyOn(mediaController, 'restorePiecesFromIndexedDB');

            await mediaController.startDownload('stream-1', {
                fileId: 'file-small-1', fileName: 'small.mp4', fileSize: 1024,
                fileType: 'video/mp4', pieceCount: 1, pieceHashes: ['h']
            });

            expect(restoreSpy).not.toHaveBeenCalled();

            discoverySpy.mockRestore();
            restoreSpy.mockRestore();
            mediaController.db = previousDb;
        });
    });

    // ==================== requestPiece ====================
    describe('requestPiece', () => {
        it('sets piece status to requested', async () => {
            const transfer = {
                metadata: { pieceCount: 3 },
                streamId: 'stream-1',
                password: null,
                pieceStatus: ['pending', 'pending', 'pending'],
                requestsInFlight: new Map(),
                rto: new PieceRtoEstimator(MEDIA_CONFIG.PIECE_REQUEST_TIMEOUT)
            };
            mediaController.incomingFiles.set('file-1', transfer);

            await mediaController.requestPiece('file-1', 1, '0xseeder');

            expect(transfer.pieceStatus[1]).toBe('requested');
        });

        it('tracks request in flight', async () => {
            const transfer = {
                metadata: { pieceCount: 3 },
                streamId: 'stream-1',
                password: null,
                pieceStatus: ['pending', 'pending', 'pending'],
                requestsInFlight: new Map(),
                rto: new PieceRtoEstimator(MEDIA_CONFIG.PIECE_REQUEST_TIMEOUT)
            };
            mediaController.incomingFiles.set('file-1', transfer);

            await mediaController.requestPiece('file-1', 0, '0xseeder');

            expect(transfer.requestsInFlight.has(0)).toBe(true);
            expect(transfer.requestsInFlight.get(0).seederId).toBe('0xseeder');
        });

        it('publishes piece_request to ephemeral stream', async () => {
            const transfer = {
                metadata: { pieceCount: 1 },
                streamId: 'stream-1',
                password: null,
                pieceStatus: ['pending'],
                requestsInFlight: new Map(),
                rto: new PieceRtoEstimator(MEDIA_CONFIG.PIECE_REQUEST_TIMEOUT)
            };
            mediaController.incomingFiles.set('file-1', transfer);

            await mediaController.requestPiece('file-1', 0, '0xseeder');

            expect(streamrController.publishMediaSignal).toHaveBeenCalledWith(
                'ephemeral-stream-1',
                { type: 'piece_request', fileId: 'file-1', pieceIndex: 0, targetSeederId: '0xseeder' },
                null
            );
        });

        it('does nothing if transfer not found', async () => {
            await mediaController.requestPiece('no-file', 0, '0xseeder');
            expect(streamrController.publishMediaSignal).not.toHaveBeenCalled();
        });
    });

    // ==================== PieceRtoEstimator ====================
    // Mirror of the Android PieceTimeout behaviors (core/PieceTimeoutTest.kt).
    describe('PieceRtoEstimator', () => {
        it('starts at the initial timeout before any sample', () => {
            const rto = new PieceRtoEstimator(5000);
            expect(rto.currentMs()).toBe(5000);
        });

        it('adapts the timeout to the measured round-trip', () => {
            const rto = new PieceRtoEstimator(5000);
            rto.onSample(2000);
            // First sample seeds srtt=2000, rttvar=1000 → 2000 + 4×1000
            expect(rto.currentMs()).toBe(6000);
        });

        it('never arms below the floor or above the ceiling', () => {
            const fast = new PieceRtoEstimator(5000, 3000, 60000);
            fast.onSample(10); // srtt+4·rttvar = 30, far below the floor
            expect(fast.currentMs()).toBe(3000);

            const slow = new PieceRtoEstimator(5000, 3000, 60000);
            slow.onSample(2000); // base 6000; repeated backoff must clamp at the ceiling
            for (let i = 0; i < 10; i++) slow.onTimeout();
            expect(slow.currentMs()).toBe(60000);
        });

        it('doubles the wait on every timeout', () => {
            const rto = new PieceRtoEstimator(5000, 3000, 60000);
            rto.onSample(2000);       // currentMs 6000
            rto.onTimeout();
            expect(rto.currentMs()).toBe(12000);
            rto.onTimeout();
            expect(rto.currentMs()).toBe(24000);
        });

        it('clears the backoff once a piece arrives', () => {
            const rto = new PieceRtoEstimator(5000, 3000, 60000);
            rto.onSample(2000);
            rto.onTimeout();
            expect(rto.currentMs()).toBe(12000);
            // A steady second sample clears the ×2 backoff AND tightens the
            // variance (rttvar 1000 → 750): 2000 + 4×750
            rto.onSample(2000);
            expect(rto.currentMs()).toBe(5000);
        });

        it('reads a clear multiple of the best round-trip as congestion', () => {
            const rto = new PieceRtoEstimator(5000);
            rto.onSample(500); // establishes minRtt
            for (let i = 0; i < 20; i++) rto.onSample(4000);
            expect(rto.isCongested()).toBe(true);
        });

        it('does not read normal jitter as congestion', () => {
            const rto = new PieceRtoEstimator(5000);
            rto.onSample(500);
            rto.onSample(600);
            rto.onSample(700);
            expect(rto.isCongested()).toBe(false);
        });

        it('is never congested before any measurement', () => {
            const rto = new PieceRtoEstimator(5000);
            expect(rto.isCongested()).toBe(false);
        });

        it('ignores non-positive samples', () => {
            const rto = new PieceRtoEstimator(5000);
            rto.onSample(0);
            rto.onSample(-100);
            expect(rto.currentMs()).toBe(5000);
        });
    });

    // ==================== manageDownload ====================
    describe('manageDownload', () => {
        it('requests pending pieces from available seeders', () => {
            vi.useFakeTimers();
            const transfer = {
                metadata: { pieceCount: 3 },
                streamId: 'stream-1',
                password: null,
                pieceStatus: ['pending', 'done', 'pending'],
                requestsInFlight: new Map(),
                downloadStarted: true,
                lastSeederRequest: Date.now(),
                seederRequestCount: 1,
                window: MEDIA_CONFIG.PIECE_WINDOW_START
            };
            mediaController.incomingFiles.set('file-1', transfer);
            mediaController.fileSeeders.set('file-1', new Set(['0xseeder1']));
            const requestSpy = vi.spyOn(mediaController, 'requestPiece').mockImplementation(() => {});

            mediaController.manageDownload('file-1');

            expect(requestSpy).toHaveBeenCalledTimes(2); // pieces 0 and 2
            requestSpy.mockRestore();
            vi.useRealTimers();
        });

        it('does not exceed the adaptive request window', () => {
            vi.useFakeTimers();
            const window = MEDIA_CONFIG.PIECE_WINDOW_START;
            const transfer = {
                metadata: { pieceCount: window + 2 },
                streamId: 'stream-1',
                password: null,
                pieceStatus: new Array(window + 2).fill('pending'),
                requestsInFlight: new Map(),
                downloadStarted: true,
                lastSeederRequest: Date.now(),
                seederRequestCount: 1,
                window
            };
            // Saturate the window; the two remaining pieces must stay unrequested
            for (let i = 0; i < window; i++) {
                transfer.requestsInFlight.set(i, { seederId: '0x1' });
                transfer.pieceStatus[i] = 'requested';
            }
            mediaController.incomingFiles.set('file-1', transfer);
            mediaController.fileSeeders.set('file-1', new Set(['0xseeder1']));
            const requestSpy = vi.spyOn(mediaController, 'requestPiece').mockImplementation(() => {});

            mediaController.manageDownload('file-1');

            expect(requestSpy).not.toHaveBeenCalled();
            requestSpy.mockRestore();
            vi.useRealTimers();
        });

        it('fills up to the window when it has been widened', () => {
            vi.useFakeTimers();
            const transfer = {
                metadata: { pieceCount: 20 },
                streamId: 'stream-1',
                password: null,
                pieceStatus: new Array(20).fill('pending'),
                requestsInFlight: new Map(),
                downloadStarted: true,
                lastSeederRequest: Date.now(),
                seederRequestCount: 1,
                window: 12
            };
            mediaController.incomingFiles.set('file-1', transfer);
            mediaController.fileSeeders.set('file-1', new Set(['0xseeder1']));
            // Real requestPiece registers in-flight synchronously; the mock does not,
            // so emulate that bookkeeping to exercise the window bound honestly.
            const requestSpy = vi.spyOn(mediaController, 'requestPiece')
                .mockImplementation((id, pieceIndex) => {
                    transfer.requestsInFlight.set(pieceIndex, { seederId: '0x1' });
                    transfer.pieceStatus[pieceIndex] = 'requested';
                });

            mediaController.manageDownload('file-1');

            expect(requestSpy).toHaveBeenCalledTimes(12);
            requestSpy.mockRestore();
            vi.useRealTimers();
        });

        it('uses round-robin across seeders', () => {
            vi.useFakeTimers();
            const transfer = {
                metadata: { pieceCount: 4 },
                streamId: 'stream-1',
                password: null,
                pieceStatus: ['pending', 'pending', 'pending', 'pending'],
                requestsInFlight: new Map(),
                downloadStarted: true,
                lastSeederRequest: Date.now(),
                seederRequestCount: 1,
                window: MEDIA_CONFIG.PIECE_WINDOW_START
            };
            mediaController.incomingFiles.set('file-1', transfer);
            mediaController.fileSeeders.set('file-1', new Set(['0xseeder1', '0xseeder2']));
            const requestSpy = vi.spyOn(mediaController, 'requestPiece').mockImplementation(() => {});

            mediaController.manageDownload('file-1');

            // With 2 seeders, should alternate
            const calls = requestSpy.mock.calls;
            expect(calls.length).toBeGreaterThanOrEqual(2);
            // First and second should use different seeders
            const seeders = new Set(calls.map(c => c[2]));
            expect(seeders.size).toBe(2);
            requestSpy.mockRestore();
            vi.useRealTimers();
        });

        it('schedules retry if no seeders', () => {
            vi.useFakeTimers();
            const transfer = {
                metadata: { pieceCount: 1 },
                streamId: 'stream-1',
                password: null,
                pieceStatus: ['pending'],
                requestsInFlight: new Map(),
                downloadStarted: true,
                lastSeederRequest: Date.now(),
                seederRequestCount: 1,
                window: MEDIA_CONFIG.PIECE_WINDOW_START
            };
            mediaController.incomingFiles.set('file-1', transfer);
            mediaController.fileSeeders.set('file-1', new Set()); // empty
            const spy = vi.spyOn(mediaController, 'requestPiece').mockImplementation(() => {});

            mediaController.manageDownload('file-1');

            // Should not request pieces
            expect(spy).not.toHaveBeenCalled();
            spy.mockRestore();
            vi.useRealTimers();
        });

        // A piece every known seeder has ruined must not deadlock: forget the grudge
        // and go looking for peers we do not know about yet
        it('clears exclusions and widens the search when every seeder is excluded', () => {
            vi.useFakeTimers();
            const transfer = {
                metadata: { pieceCount: 1 },
                streamId: 'stream-1',
                password: null,
                pieceStatus: ['pending'],
                requestsInFlight: new Map(),
                pieceExclusions: new Map([[0, new Set(['0xseeder1'])]]),
                seederStrikes: new Map(),
                seederCursor: 0,
                downloadStarted: true,
                lastSeederRequest: Date.now(),
                seederRequestCount: 1,
                window: MEDIA_CONFIG.PIECE_WINDOW_START
            };
            mediaController.incomingFiles.set('file-1', transfer);
            mediaController.fileSeeders.set('file-1', new Set(['0xseeder1']));
            const requestSpy = vi.spyOn(mediaController, 'requestPiece').mockImplementation(() => {});
            const sourcesSpy = vi.spyOn(mediaController, 'requestFileSources').mockResolvedValue(undefined);

            mediaController.manageDownload('file-1');

            expect(requestSpy).not.toHaveBeenCalled();
            expect(sourcesSpy).toHaveBeenCalled();
            // The grudge is dropped, so the next pass can try that seeder again
            expect(transfer.pieceExclusions.has(0)).toBe(false);

            requestSpy.mockRestore();
            sourcesSpy.mockRestore();
            vi.useRealTimers();
        });

        // manageDownload is re-entered on every delivery and every timeout, so the
        // no-seeder branch must not schedule a fresh timer on each call.
        it('keeps a single pending retry while there are no seeders', () => {
            vi.useFakeTimers();
            const transfer = {
                metadata: { pieceCount: 1 },
                streamId: 'stream-1',
                password: null,
                pieceStatus: ['pending'],
                requestsInFlight: new Map(),
                downloadStarted: true,
                lastSeederRequest: Date.now(),
                seederRequestCount: 1,
                window: MEDIA_CONFIG.PIECE_WINDOW_START,
                noSeederRetryTimer: null
            };
            mediaController.incomingFiles.set('file-1', transfer);
            mediaController.fileSeeders.set('file-1', new Set()); // empty

            mediaController.manageDownload('file-1');
            const firstTimer = transfer.noSeederRetryTimer;
            mediaController.manageDownload('file-1');
            mediaController.manageDownload('file-1');

            expect(firstTimer).toBeTruthy();
            expect(transfer.noSeederRetryTimer).toBe(firstTimer);
            expect(vi.getTimerCount()).toBe(1);

            vi.useRealTimers();
        });
    });

    // ==================== adaptive request window (AIMD) ====================
    describe('adaptive request window', () => {
        it('grows by one per delivered piece, capped at the max', () => {
            const transfer = { window: MEDIA_CONFIG.PIECE_WINDOW_MAX - 1 };

            mediaController.growWindow(transfer);
            expect(transfer.window).toBe(MEDIA_CONFIG.PIECE_WINDOW_MAX);

            mediaController.growWindow(transfer);
            expect(transfer.window).toBe(MEDIA_CONFIG.PIECE_WINDOW_MAX);
        });

        it('halves on a timeout', () => {
            const transfer = { window: 32, lastWindowBackoffAt: 0 };

            mediaController.shrinkWindow(transfer);

            expect(transfer.window).toBe(16);
        });

        it('never backs off below the floor', () => {
            const transfer = { window: MEDIA_CONFIG.PIECE_WINDOW_MIN, lastWindowBackoffAt: 0 };

            mediaController.shrinkWindow(transfer);

            expect(transfer.window).toBe(MEDIA_CONFIG.PIECE_WINDOW_MIN);
        });

        it('treats a burst of simultaneous timeouts as one stall', () => {
            const transfer = { window: 32, lastWindowBackoffAt: 0 };

            // Every outstanding request expires at roughly the same moment
            mediaController.shrinkWindow(transfer);
            mediaController.shrinkWindow(transfer);
            mediaController.shrinkWindow(transfer);

            expect(transfer.window).toBe(16);
        });

        it('backs off again once the cooldown has passed', () => {
            const transfer = { window: 32, lastWindowBackoffAt: 0 };

            mediaController.shrinkWindow(transfer);
            expect(transfer.window).toBe(16);

            transfer.lastWindowBackoffAt = Date.now() - MEDIA_CONFIG.PIECE_WINDOW_BACKOFF_COOLDOWN - 1;
            mediaController.shrinkWindow(transfer);

            expect(transfer.window).toBe(8);
        });
    });

    // ==================== piece failure cap ====================
    describe('piece failure cap', () => {
        const makeTransfer = () => ({
            metadata: { pieceCount: 3, fileSize: 300, pieceHashes: ['a', 'b', 'c'] },
            pieceStatus: ['pending', 'pending', 'pending'],
            pieceFailures: new Map(),
            requestsInFlight: new Map(),
            window: MEDIA_CONFIG.PIECE_WINDOW_START
        });

        it('retries a piece while it is under the cap', () => {
            const transfer = makeTransfer();
            mediaController.incomingFiles.set('f1', transfer);
            const manageSpy = vi.spyOn(mediaController, 'manageDownload').mockImplementation(() => {});

            mediaController.registerPieceFailure(transfer, 'f1', 1, 'hash mismatch');

            expect(transfer.pieceStatus[1]).toBe('pending');
            expect(manageSpy).toHaveBeenCalledWith('f1');
            expect(mediaController.incomingFiles.has('f1')).toBe(true);
            manageSpy.mockRestore();
        });

        it('aborts the download once a piece exceeds the cap', () => {
            const transfer = makeTransfer();
            mediaController.incomingFiles.set('f1', transfer);
            mediaController.fileSeeders.set('f1', new Set(['0xa']));
            const errorCb = vi.fn();
            mediaController.handlers.onFileError = errorCb;
            const manageSpy = vi.spyOn(mediaController, 'manageDownload').mockImplementation(() => {});

            for (let i = 0; i < MEDIA_CONFIG.MAX_PIECE_FAILURES; i++) {
                mediaController.registerPieceFailure(transfer, 'f1', 1, 'hash mismatch');
            }

            expect(errorCb).toHaveBeenCalledWith('f1', expect.stringContaining('Piece 1'));
            expect(mediaController.incomingFiles.has('f1')).toBe(false);
            manageSpy.mockRestore();
        });

        // A bad piece must not poison the budget of every other piece
        it('counts failures per piece, not per transfer', () => {
            const transfer = makeTransfer();
            mediaController.incomingFiles.set('f1', transfer);
            const manageSpy = vi.spyOn(mediaController, 'manageDownload').mockImplementation(() => {});

            for (let i = 0; i < MEDIA_CONFIG.MAX_PIECE_FAILURES - 1; i++) {
                mediaController.registerPieceFailure(transfer, 'f1', 0, 'hash mismatch');
                mediaController.registerPieceFailure(transfer, 'f1', 1, 'hash mismatch');
            }

            expect(mediaController.incomingFiles.has('f1')).toBe(true);
            manageSpy.mockRestore();
        });

        it('gives up through handleFilePiece when a seeder keeps sending bad data', async () => {
            authManager.getAddress.mockReturnValue('0xme');
            mediaController.incomingFiles.set('file-1', {
                metadata: {
                    fileId: 'file-1', fileSize: 300, pieceCount: 3,
                    pieceHashes: ['want-a', 'want-b', 'want-c']
                },
                streamId: 'stream-1',
                password: null,
                pieceStatus: ['pending', 'pending', 'pending'],
                pieceFailures: new Map(),
                requestsInFlight: new Map(),
                receivedCount: 0,
                pieces: [null, null, null],
                useIndexedDB: false,
                window: MEDIA_CONFIG.PIECE_WINDOW_START
            });
            const errorCb = vi.fn();
            mediaController.handlers.onFileError = errorCb;

            vi.spyOn(mediaController, 'base64ToArrayBuffer').mockReturnValue(new ArrayBuffer(8));
            vi.spyOn(mediaController, 'sha256').mockResolvedValue('wrong-hash');
            vi.spyOn(mediaController, 'manageDownload').mockImplementation(() => {});

            // The last delivery trips the cap; handleFilePiece no-ops after that
            for (let i = 0; i < MEDIA_CONFIG.MAX_PIECE_FAILURES; i++) {
                await mediaController.handleFilePiece('stream-1', {
                    fileId: 'file-1',
                    pieceIndex: 0,
                    account: '0xother',
                    data: 'data'
                });
            }

            expect(errorCb).toHaveBeenCalledWith('file-1', expect.stringContaining('Piece 0'));
            expect(mediaController.incomingFiles.has('file-1')).toBe(false);
        });
    });

    // ==================== transfer rate ====================
    describe('transfer rate', () => {
        const at = (t) => 1_000_000 + t;

        // Samples are pushed with the real clock, so build them directly to control time
        const withSamples = (samples) => ({ speedSamples: samples.map(([t, bytes]) => ({ at: at(t), bytes })) });

        it('returns null with fewer than two samples', () => {
            expect(mediaController.getTransferRate({ speedSamples: [] })).toBeNull();
            expect(mediaController.getTransferRate(withSamples([[0, 100]]))).toBeNull();
        });

        it('returns null until a second has been measured', () => {
            const transfer = withSamples([[0, 0], [500, 500_000]]);
            expect(mediaController.getTransferRate(transfer, at(500))).toBeNull();
        });

        it('measures bytes over the elapsed span', () => {
            const transfer = withSamples([[0, 0], [2000, 200_000]]);
            expect(mediaController.getTransferRate(transfer, at(2000))).toBe(100_000);
        });

        // The bug the storage POC surfaced: samples only arrive on delivery, so
        // dividing by the newest sample would freeze the rate on a dead transfer
        it('decays toward zero while a transfer is stalled', () => {
            const transfer = withSamples([[0, 0], [2000, 200_000]]);

            const atDelivery = mediaController.getTransferRate(transfer, at(2000));
            const afterStall = mediaController.getTransferRate(transfer, at(8000));

            expect(afterStall).toBeLessThan(atDelivery);
            expect(afterStall).toBe(25_000); // 200KB spread over 8s, not 2s
        });

        it('drops samples that fall out of the window', () => {
            const transfer = withSamples([[0, 0], [1000, 100_000], [20_000, 500_000]]);

            mediaController.getTransferRate(transfer, at(20_000));

            // The first sample is older than the 10s window and is pruned
            expect(transfer.speedSamples).toHaveLength(2);
            expect(transfer.speedSamples[0].bytes).toBe(100_000);
        });

        it('accumulates delivered bytes across pieces', () => {
            const transfer = {};
            mediaController.recordThroughput(transfer, 1000);
            mediaController.recordThroughput(transfer, 500);

            expect(transfer.bytesTransferred).toBe(1500);
            expect(transfer.speedSamples).toHaveLength(2);
        });
    });

    // ==================== seeder selection and eviction ====================
    describe('seeder selection', () => {
        const transferWith = (overrides = {}) => ({
            metadata: { pieceCount: 4, pieceHashes: ['a', 'b', 'c', 'd'] },
            pieceStatus: ['pending', 'pending', 'pending', 'pending'],
            pieceFailures: new Map(),
            pieceExclusions: new Map(),
            seederStrikes: new Map(),
            seederCursor: 0,
            requestsInFlight: new Map(),
            window: MEDIA_CONFIG.PIECE_WINDOW_START,
            ...overrides
        });

        // The cursor used to reset per call, so a retried piece — usually the only
        // pending one — went back to the same peer forever
        it('advances the cursor across calls so retries rotate', () => {
            const transfer = transferWith();
            const seeders = ['0xa', '0xb', '0xc'];

            const picks = [
                mediaController.pickSeederFor(transfer, seeders, 0),
                mediaController.pickSeederFor(transfer, seeders, 0),
                mediaController.pickSeederFor(transfer, seeders, 0)
            ];

            expect(picks).toEqual(['0xa', '0xb', '0xc']);
        });

        it('skips a seeder that already served this piece corrupt', () => {
            const transfer = transferWith();
            transfer.pieceExclusions.set(1, new Set(['0xa']));

            const pick = mediaController.pickSeederFor(transfer, ['0xa', '0xb'], 1);

            expect(pick).toBe('0xb');
        });

        it('excludes per piece, not globally', () => {
            const transfer = transferWith();
            transfer.pieceExclusions.set(1, new Set(['0xa']));

            // Piece 2 carries no grudge, so 0xa is still eligible for it
            const picks = new Set([
                mediaController.pickSeederFor(transfer, ['0xa', '0xb'], 2),
                mediaController.pickSeederFor(transfer, ['0xa', '0xb'], 2)
            ]);

            expect(picks.has('0xa')).toBe(true);
        });

        it('reports no candidate when every seeder is excluded', () => {
            const transfer = transferWith();
            transfer.pieceExclusions.set(0, new Set(['0xa', '0xb']));

            expect(mediaController.pickSeederFor(transfer, ['0xa', '0xb'], 0)).toBeNull();
        });

        it('reports no candidate when there are no seeders at all', () => {
            expect(mediaController.pickSeederFor(transferWith(), [], 0)).toBeNull();
        });
    });

    describe('seeder eviction', () => {
        const transferWith = () => ({
            metadata: { pieceCount: 4, pieceHashes: ['a', 'b', 'c', 'd'] },
            pieceStatus: ['pending', 'pending', 'pending', 'pending'],
            pieceFailures: new Map(),
            pieceExclusions: new Map(),
            seederStrikes: new Map(),
            seederCursor: 0,
            requestsInFlight: new Map(),
            window: MEDIA_CONFIG.PIECE_WINDOW_START
        });

        it('excludes the blamed peer from that piece', () => {
            const transfer = transferWith();
            mediaController.fileSeeders.set('f-blame', new Set(['0xbad', '0xgood']));

            mediaController.blameSeeder(transfer, 'f-blame', 2, '0xBAD');

            expect(transfer.pieceExclusions.get(2).has('0xbad')).toBe(true);
        });

        it('keeps a peer in the swarm below the strike limit', () => {
            const transfer = transferWith();
            mediaController.fileSeeders.set('f-strikes', new Set(['0xbad', '0xgood']));

            for (let i = 0; i < MEDIA_CONFIG.MAX_SEEDER_STRIKES - 1; i++) {
                mediaController.blameSeeder(transfer, 'f-strikes', i, '0xbad');
            }

            expect(mediaController.fileSeeders.get('f-strikes').has('0xbad')).toBe(true);
        });

        // Per-piece exclusion alone would let a broken peer ruin every piece in turn
        it('drops a peer that keeps serving corrupt pieces', () => {
            const transfer = transferWith();
            mediaController.fileSeeders.set('f-evict', new Set(['0xbad', '0xgood']));
            const seederUpdate = vi.fn();
            mediaController.handlers.onSeederUpdate = seederUpdate;

            for (let i = 0; i < MEDIA_CONFIG.MAX_SEEDER_STRIKES; i++) {
                mediaController.blameSeeder(transfer, 'f-evict', i, '0xbad');
            }

            const seeders = mediaController.fileSeeders.get('f-evict');
            expect(seeders.has('0xbad')).toBe(false);
            expect(seeders.has('0xgood')).toBe(true);
            expect(seederUpdate).toHaveBeenCalledWith('f-evict', 1);
        });

        it('blames the publisher of the bad bytes through handleFilePiece', async () => {
            authManager.getAddress.mockReturnValue('0xme');
            const transfer = transferWith();
            transfer.metadata.fileSize = 400;
            transfer.pieces = [null, null, null, null];
            transfer.useIndexedDB = false;
            transfer.receivedCount = 0;
            mediaController.incomingFiles.set('f-attr', transfer);
            mediaController.fileSeeders.set('f-attr', new Set(['0xother']));

            vi.spyOn(mediaController, 'base64ToArrayBuffer').mockReturnValue(new ArrayBuffer(8));
            vi.spyOn(mediaController, 'sha256').mockResolvedValue('wrong');
            vi.spyOn(mediaController, 'manageDownload').mockImplementation(() => {});

            await mediaController.handleFilePiece('stream-1', {
                fileId: 'f-attr', pieceIndex: 1, account: '0xOther', data: 'x'
            });

            expect(transfer.pieceExclusions.get(1).has('0xother')).toBe(true);
        });
    });

    // ==================== upload stats ====================
    describe('upload stats', () => {
        it('reports nothing for a file we never served', () => {
            expect(mediaController.getUploadStats('unknown')).toEqual({ bytesPerSec: null, leechers: 0 });
        });

        it('counts each requesting peer once', () => {
            mediaController.recordLeecher('f-count', '0xAlice');
            mediaController.recordLeecher('f-count', '0xALICE');
            mediaController.recordLeecher('f-count', '0xBob');

            expect(mediaController.getUploadStats('f-count').leechers).toBe(2);
        });

        it('ignores a request with no publisher', () => {
            mediaController.recordLeecher('f-nopub', undefined);
            expect(mediaController.getUploadStats('f-nopub').leechers).toBe(0);
        });

        // A swarm has no leave event, so the count has to age out on its own
        it('drops leechers that have gone quiet', () => {
            mediaController.recordLeecher('f-stale', '0xAlice');
            const state = mediaController.uploads.get('f-stale');
            state.leechers.set('0xalice', Date.now() - MEDIA_CONFIG.LEECHER_TIMEOUT_MS - 1);

            expect(mediaController.getUploadStats('f-stale').leechers).toBe(0);
        });

        it('measures the serving rate from bytes sent', () => {
            const state = mediaController.uploadStateFor('f-rate');
            state.speedSamples = [
                { at: 1_000_000, bytes: 0 },
                { at: 1_002_000, bytes: 200_000 }
            ];

            expect(mediaController.getUploadStats('f-rate', 1_002_000).bytesPerSec).toBe(100_000);
        });

        it('throttles serving updates instead of firing per piece', () => {
            const handler = vi.fn();
            mediaController.handlers.onUploadProgress = handler;

            mediaController.emitUploadStats('f-throttle');
            mediaController.emitUploadStats('f-throttle');
            mediaController.emitUploadStats('f-throttle');

            expect(handler).toHaveBeenCalledTimes(1);

            const state = mediaController.uploads.get('f-throttle');
            if (state?.decayTimer) clearInterval(state.decayTimer);
        });

        // Pieces stop the instant a leecher finishes, so without a ticker the rate
        // would stay frozen at whatever was flowing at that moment
        it('keeps republishing after the last piece so the rate can decay', () => {
            vi.useFakeTimers();
            const handler = vi.fn();
            mediaController.handlers.onUploadProgress = handler;

            mediaController.emitUploadStats('f-decay');
            const afterFirst = handler.mock.calls.length;

            vi.advanceTimersByTime(MEDIA_CONFIG.UPLOAD_STATS_INTERVAL_MS * 2);

            expect(handler.mock.calls.length).toBeGreaterThan(afterFirst);
            vi.useRealTimers();
        });

        it('stops ticking once nothing is flowing and nobody is asking', () => {
            vi.useFakeTimers();
            mediaController.handlers.onUploadProgress = vi.fn();

            mediaController.emitUploadStats('f-idle');
            vi.advanceTimersByTime(MEDIA_CONFIG.UPLOAD_STATS_INTERVAL_MS * 2);

            expect(mediaController.uploads.get('f-idle').decayTimer).toBeNull();
            vi.useRealTimers();
        });
    });

    // ==================== hasActiveDMTransfers ====================
    // Guards the DM ephemeral stream teardown: all DMs share one stream, so this
    // question has to span conversations rather than take a single stream id.
    describe('hasActiveDMTransfers', () => {
        it('returns false when nothing is in flight', () => {
            expect(mediaController.hasActiveDMTransfers()).toBe(false);
        });

        it('detects a file being seeded for a DM', () => {
            mediaController.localFiles.set('f1', { streamId: 'dm-stream', metadata: {} });
            channelManager.getChannel.mockImplementation(
                (id) => (id === 'dm-stream' ? { type: 'dm' } : { type: 'public' })
            );

            expect(mediaController.hasActiveDMTransfers()).toBe(true);
        });

        it('detects a download in progress in a DM', () => {
            mediaController.incomingFiles.set('f1', { streamId: 'dm-stream' });
            channelManager.getChannel.mockImplementation(
                (id) => (id === 'dm-stream' ? { type: 'dm' } : { type: 'public' })
            );

            expect(mediaController.hasActiveDMTransfers()).toBe(true);
        });

        it('ignores transfers that belong to non-DM channels', () => {
            mediaController.localFiles.set('f1', { streamId: 'public-stream', metadata: {} });
            channelManager.getChannel.mockReturnValue({ type: 'public' });

            expect(mediaController.hasActiveDMTransfers()).toBe(false);
        });

        // A file seeded for a DM we have since left has no channel worth holding for
        it('ignores files whose channel no longer exists', () => {
            mediaController.localFiles.set('f1', { streamId: 'gone', metadata: {} });
            channelManager.getChannel.mockReturnValue(undefined);

            expect(mediaController.hasActiveDMTransfers()).toBe(false);
        });
    });

    // ==================== SEEDING PERSISTENCE ====================
    describe('Seeding Persistence', () => {
        describe('persistSeedFile', () => {
            const makeDbMock = () => ({
                objectStoreNames: { contains: (name) => name === 'seedFiles' }
            });

            it('returns false without db', async () => {
                mediaController.db = null;
                const result = await mediaController.persistSeedFile('f1', new Blob(), {}, 's1');
                expect(result).toBe(false);
            });

            it('returns false without seedFiles store', async () => {
                mediaController.db = { objectStoreNames: { contains: () => false } };
                const result = await mediaController.persistSeedFile('f1', new Blob(), {}, 's1');
                expect(result).toBe(false);
            });

            it('returns false without owner address', async () => {
                mediaController.db = makeDbMock();
                mediaController.currentOwnerAddress = null;
                const result = await mediaController.persistSeedFile('f1', new Blob(), {}, 's1');
                expect(result).toBe(false);
            });

            it('returns false for private channel when PERSIST_PRIVATE_CHANNELS is false', async () => {
                mediaController.db = makeDbMock();
                mediaController.currentOwnerAddress = '0xowner';
                const result = await mediaController.persistSeedFile('f1', new Blob(), { fileSize: 10 }, 's1', true);
                expect(result).toBe(false);
            });

            it('saves seed file when conditions met', async () => {
                const saveSpy = vi.spyOn(mediaController, 'saveSeedFile').mockResolvedValue(undefined);
                mediaController.db = makeDbMock();
                mediaController.currentOwnerAddress = '0xowner';
                mediaController.persistedStorageSize = 0;

                const blob = new Blob(['testdata']);
                const metadata = { fileSize: 8, fileName: 'test.mp4' };

                const result = await mediaController.persistSeedFile('f1', blob, metadata, 's1', false);

                expect(result).toBe(true);
                expect(mediaController.persistedStorageSize).toBe(8);
                expect(saveSpy).toHaveBeenCalled();
                saveSpy.mockRestore();
            });

            it('evicts old files when over quota', async () => {
                const evictSpy = vi.spyOn(mediaController, 'evictOldestSeedFiles').mockResolvedValue(100);
                const saveSpy = vi.spyOn(mediaController, 'saveSeedFile').mockResolvedValue(undefined);
                mediaController.db = makeDbMock();
                mediaController.currentOwnerAddress = '0xowner';
                mediaController.persistedStorageSize = MEDIA_CONFIG.MAX_SEED_STORAGE; // at max

                const blob = new Blob(['data']);
                const metadata = { fileSize: 50, fileName: 'test.mp4' };
                await mediaController.persistSeedFile('f1', blob, metadata, 's1');

                expect(evictSpy).toHaveBeenCalledWith(50);
                evictSpy.mockRestore();
                saveSpy.mockRestore();
            });
        });

        describe('loadPersistedSeedFiles', () => {
            it('returns early without db', async () => {
                mediaController.db = null;
                await expect(mediaController.loadPersistedSeedFiles()).resolves.not.toThrow();
            });

            it('returns early without owner address', async () => {
                mediaController.db = { objectStoreNames: { contains: () => true } };
                mediaController.currentOwnerAddress = null;
                await expect(mediaController.loadPersistedSeedFiles()).resolves.not.toThrow();
            });

            it('loads files owned by current user', async () => {
                const now = Date.now();
                const seedFiles = [
                    { fileId: 'f1', ownerAddress: '0xowner', timestamp: now, fileData: new ArrayBuffer(4), metadata: { fileSize: 4, fileType: 'video/mp4', fileName: 'a.mp4' }, streamId: 's1' },
                    { fileId: 'f2', ownerAddress: '0xother', timestamp: now, fileData: new ArrayBuffer(4), metadata: { fileSize: 4, fileType: 'video/mp4', fileName: 'b.mp4' }, streamId: 's2' }
                ];
                vi.spyOn(mediaController, 'getAllSeedFiles').mockResolvedValue(seedFiles);
                mediaController.db = { objectStoreNames: { contains: () => true } };
                mediaController.currentOwnerAddress = '0xowner';

                await mediaController.loadPersistedSeedFiles();

                // Should only load f1 (owned by current user)
                expect(mediaController.localFiles.has('f1')).toBe(true);
                expect(mediaController.localFiles.has('f2')).toBe(false);
            });

            it('removes expired seed files', async () => {
                const expired = Date.now() - (MEDIA_CONFIG.SEED_FILES_EXPIRE_DAYS + 1) * 24 * 60 * 60 * 1000;
                const seedFiles = [
                    { fileId: 'f1', ownerAddress: '0xowner', timestamp: expired, fileData: new ArrayBuffer(4), metadata: { fileSize: 4, fileType: 'video/mp4', fileName: 'old.mp4' }, streamId: 's1' }
                ];
                vi.spyOn(mediaController, 'getAllSeedFiles').mockResolvedValue(seedFiles);
                const removeSpy = vi.spyOn(mediaController, 'removeSeedFile').mockResolvedValue(undefined);
                mediaController.db = { objectStoreNames: { contains: () => true } };
                mediaController.currentOwnerAddress = '0xowner';

                await mediaController.loadPersistedSeedFiles();

                expect(removeSpy).toHaveBeenCalledWith('f1');
                expect(mediaController.localFiles.has('f1')).toBe(false);
                removeSpy.mockRestore();
            });
        });

        describe('getStorageStats', () => {
            it('returns current storage metrics', () => {
                mediaController.persistedStorageSize = 5 * 1024 * 1024; // 5MB
                mediaController.localFiles.set('f1', {});
                mediaController.localFiles.set('f2', {});

                const stats = mediaController.getStorageStats();

                expect(stats.usedBytes).toBe(5 * 1024 * 1024);
                expect(stats.maxBytes).toBe(MEDIA_CONFIG.MAX_SEED_STORAGE);
                expect(stats.usedMB).toBe('5.00');
                expect(stats.fileCount).toBe(2);
                expect(stats.percentUsed).toBeGreaterThan(0);
            });
        });

        describe('reannounceForChannel', () => {
            it('re-announces seeded files for matching channel', async () => {
                const announceSpy = vi.spyOn(mediaController, 'announceFileSource').mockResolvedValue(undefined);
                mediaController.localFiles.set('f1', { streamId: 'stream-1' });
                mediaController.localFiles.set('f2', { streamId: 'stream-2' });
                mediaController.localFiles.set('f3', { streamId: 'stream-1' });

                await mediaController.reannounceForChannel('stream-1');

                expect(announceSpy).toHaveBeenCalledTimes(2);
                expect(announceSpy).toHaveBeenCalledWith('stream-1', 'f1', null);
                expect(announceSpy).toHaveBeenCalledWith('stream-1', 'f3', null);
                announceSpy.mockRestore();
            });

            it('passes password for encrypted channels', async () => {
                const announceSpy = vi.spyOn(mediaController, 'announceFileSource').mockResolvedValue(undefined);
                mediaController.localFiles.set('f1', { streamId: 'stream-1' });

                await mediaController.reannounceForChannel('stream-1', 'secret');

                expect(announceSpy).toHaveBeenCalledWith('stream-1', 'f1', 'secret');
                announceSpy.mockRestore();
            });

            it('does nothing when no matching files', async () => {
                const announceSpy = vi.spyOn(mediaController, 'announceFileSource').mockResolvedValue(undefined);
                mediaController.localFiles.set('f1', { streamId: 'other-stream' });

                await mediaController.reannounceForChannel('stream-1');

                expect(announceSpy).not.toHaveBeenCalled();
                announceSpy.mockRestore();
            });
        });

        describe('clearAllSeedFiles', () => {
            it('removes all seed files', async () => {
                vi.spyOn(mediaController, 'getAllSeedFiles').mockResolvedValue([
                    { fileId: 'f1' }, { fileId: 'f2' }
                ]);
                const removeSpy = vi.spyOn(mediaController, 'removeSeedFile').mockResolvedValue(undefined);
                mediaController.db = {};

                await mediaController.clearAllSeedFiles();

                expect(removeSpy).toHaveBeenCalledWith('f1');
                expect(removeSpy).toHaveBeenCalledWith('f2');
                expect(mediaController.persistedStorageSize).toBe(0);
                removeSpy.mockRestore();
            });

            it('does nothing without db', async () => {
                mediaController.db = null;
                await expect(mediaController.clearAllSeedFiles()).resolves.not.toThrow();
            });
        });

        describe('clearSeedFilesForOwner', () => {
            it('clears files for specific owner', async () => {
                vi.spyOn(mediaController, 'getAllSeedFiles').mockResolvedValue([
                    { fileId: 'f1', ownerAddress: '0xTarget' },
                    { fileId: 'f2', ownerAddress: '0xOther' },
                    { fileId: 'f3', ownerAddress: null } // legacy - should also be cleared
                ]);
                const removeSpy = vi.spyOn(mediaController, 'removeSeedFile').mockResolvedValue(undefined);
                mediaController.db = {};

                await mediaController.clearSeedFilesForOwner('0xTarget');

                expect(removeSpy).toHaveBeenCalledWith('f1');
                expect(removeSpy).toHaveBeenCalledWith('f3'); // legacy
                expect(removeSpy).not.toHaveBeenCalledWith('f2');
                removeSpy.mockRestore();
            });

            it('does nothing without db', async () => {
                mediaController.db = null;
                await expect(mediaController.clearSeedFilesForOwner('0xaddr')).resolves.not.toThrow();
            });

            it('does nothing with null address', async () => {
                mediaController.db = {};
                await expect(mediaController.clearSeedFilesForOwner(null)).resolves.not.toThrow();
            });
        });

        describe('evictOldestSeedFiles', () => {
            it('returns 0 without db', async () => {
                mediaController.db = null;
                const result = await mediaController.evictOldestSeedFiles(1000);
                expect(result).toBe(0);
            });

            it('evicts oldest files first', async () => {
                mediaController.db = {};
                const getAllSpy = vi.spyOn(mediaController, 'getAllSeedFiles').mockResolvedValue([
                    { fileId: 'f2', timestamp: 200, metadata: { fileSize: 50 } },
                    { fileId: 'f1', timestamp: 100, metadata: { fileSize: 50 } },
                    { fileId: 'f3', timestamp: 300, metadata: { fileSize: 50 } }
                ]);
                const removeSpy = vi.spyOn(mediaController, 'removeSeedFile').mockResolvedValue(undefined);

                const freed = await mediaController.evictOldestSeedFiles(60);

                // Should evict f1 (oldest, timestamp=100) first then f2 (200)
                expect(removeSpy).toHaveBeenCalledWith('f1');
                expect(freed).toBeGreaterThanOrEqual(60);
                getAllSpy.mockRestore();
                removeSpy.mockRestore();
            });
        });
    });

    // ==================== sendImage (full flow) ====================
    describe('sendImage full flow', () => {
        it('holds the image back while the channel owes a key rotation', async () => {
            channelManager.rotationRetry = {
                settle: vi.fn().mockRejectedValue(new Error('Waiting to rotate the channel key.'))
            };
            channelManager.getChannel.mockReturnValue({ type: 'gated', messages: [], password: null });
            const published = streamrController.publishMessage.mock.calls.length;
            try {
                const file = new File(['img'], 'photo.jpg', { type: 'image/jpeg' });
                await expect(mediaController.sendImage('stream-1', file)).rejects.toThrow('Waiting to rotate');
                expect(channelManager.rotationRetry.settle).toHaveBeenCalledWith('stream-1');
                expect(streamrController.publishMessage.mock.calls.length).toBe(published);
            } finally {
                delete channelManager.rotationRetry;
            }
        });

        it('throws for invalid image type', async () => {
            const file = new File(['test'], 'test.txt', { type: 'text/plain' });
            await expect(mediaController.sendImage('stream-1', file)).rejects.toThrow('Invalid image type');
        });

        it('sends image to regular channel', async () => {
            // Mock resizeImage to skip canvas
            vi.spyOn(mediaController, 'resizeImage').mockResolvedValue('data:image/jpeg;base64,abc');
            channelManager.getChannel.mockReturnValue({ type: 'public', messages: [], password: null });
            // createSignedMessage returns fresh copy each call
            identityManager.createSignedMessage.mockResolvedValue({
                id: 'msg-img-1',
                sender: '0xmyaddress',
                timestamp: Date.now()
            });

            const file = new File(['img'], 'photo.jpg', { type: 'image/jpeg' });
            const result = await mediaController.sendImage('stream-1', file);

            expect(result.imageId).toBeDefined();
            expect(result.data).toBe('data:image/jpeg;base64,aW1n');
            expect(streamrController.publishMessage).toHaveBeenCalled();
            // Verify cache by checking imageCache size increased
            expect(mediaController.imageCache.size).toBeGreaterThan(0);
        });

        it('sends image with password encryption', async () => {
            vi.spyOn(mediaController, 'resizeImage').mockResolvedValue('data:base64');
            channelManager.getChannel.mockReturnValue({ type: 'password', messages: [], password: 'pwd' });

            const file = new File(['img'], 'photo.png', { type: 'image/png' });
            await mediaController.sendImage('stream-1', file, 'pwd');

            expect(streamrController.publishMessage).toHaveBeenCalledWith('stream-1', expect.any(Object), 'pwd');
        });

        it('seals the DM image announcement under a throwaway publisher', async () => {
            vi.spyOn(mediaController, 'resizeImage').mockResolvedValue('data:base64');
            channelManager.getChannel.mockReturnValue({
                type: 'dm',
                peerAddress: '0xpeer',
                messages: []
            });

            const file = new File(['img'], 'photo.jpg', { type: 'image/jpeg' });
            await mediaController.sendImage('stream-1', file);

            // Chunks and manifest are sealed for the peer, then published under
            // the ephemeral key each seal generates — never under our account.
            expect(dmManager.sealFor).toHaveBeenCalledWith('0xpeer', expect.any(Object));
            expect(dmManager.publishSealed).toHaveBeenCalledWith(
                'stream-1',
                expect.objectContaining({
                    envelope: expect.objectContaining({ v: 2 }),
                    ephemeralPrivateKey: expect.any(String)
                })
            );
            expect(streamrController.publishMessage).not.toHaveBeenCalled();
            expect(secureStorage.addSentMessage).toHaveBeenCalled();
        });

        it('persists for write-only channels', async () => {
            vi.spyOn(mediaController, 'resizeImage').mockResolvedValue('data:base64');
            channelManager.getChannel.mockReturnValue({
                type: 'public',
                writeOnly: true,
                messages: []
            });

            const file = new File(['img'], 'photo.jpg', { type: 'image/jpeg' });
            await mediaController.sendImage('stream-1', file);

            expect(secureStorage.addSentMessage).toHaveBeenCalledWith('stream-1', expect.any(Object));
        });

        it('propagates sealing failures instead of sending in the clear', async () => {
            // sealFor raises when the wallet key or the peer public key is
            // missing. sendImage must surface that, never fall back to an
            // unsealed publish.
            vi.spyOn(mediaController, 'resizeImage').mockResolvedValue('data:base64');
            dmManager.sealFor.mockRejectedValueOnce(
                new Error('Cannot send DM: peer public key not available')
            );
            channelManager.getChannel.mockReturnValue({
                type: 'dm',
                peerAddress: '0xpeer',
                messages: []
            });

            const file = new File(['img'], 'photo.jpg', { type: 'image/jpeg' });
            await expect(mediaController.sendImage('stream-1', file))
                .rejects.toThrow('peer public key not available');

            expect(streamrController.publishMessage).not.toHaveBeenCalled();
        });
    });

    // ==================== sendVideo (full flow) ====================
    describe('sendVideo', () => {
        it('throws for invalid video type', async () => {
            const file = new File(['test'], 'test.txt', { type: 'text/plain' });
            await expect(mediaController.sendVideo('stream-1', file)).rejects.toThrow('Invalid video type');
        });

        it('throws for oversized file', async () => {
            const file = { type: 'video/mp4', size: 600 * 1024 * 1024, name: 'big.mp4' };
            await expect(mediaController.sendVideo('stream-1', file)).rejects.toThrow('File too large');
        });

        // sendFile is the general path; only sendVideo restricts the type
        it('sendFile accepts a non-video type that sendVideo rejects', async () => {
            mediaController.fileWorker = { postMessage: vi.fn() };
            const file = new File(['%PDF-1.4'], 'doc.pdf', { type: 'application/pdf' });

            await expect(mediaController.sendVideo('stream-1', file)).rejects.toThrow('Invalid video type');

            const promise = mediaController.sendFile('stream-1', file);
            expect(Array.from(mediaController.localFiles.keys()).some(k => k.startsWith('temp-'))).toBe(true);
            promise.catch(() => {});
        });

        it('sendFile rejects an empty file', async () => {
            const file = { type: 'application/pdf', size: 0, name: 'empty.pdf' };
            await expect(mediaController.sendFile('stream-1', file)).rejects.toThrow('File is empty');
        });

        it('sendFile still enforces the size ceiling', async () => {
            const file = { type: 'application/zip', size: 600 * 1024 * 1024, name: 'big.zip' };
            await expect(mediaController.sendFile('stream-1', file)).rejects.toThrow('File too large');
        });

        it('stores temp reference with callback', async () => {
            // Mock fileWorker since we can't create real workers in test
            mediaController.fileWorker = { postMessage: vi.fn() };

            const file = new File(['videodata'], 'clip.mp4', { type: 'video/mp4' });
            // Don't await - the promise resolves when worker calls back
            const promise = mediaController.sendVideo('stream-1', file);

            // Should have stored a temp reference
            const tempKey = Array.from(mediaController.localFiles.keys()).find(k => k.startsWith('temp-'));
            expect(tempKey).toBeDefined();
            const tempRef = mediaController.localFiles.get(tempKey);
            expect(tempRef.file).toBe(file);
            expect(tempRef.streamId).toBe('stream-1');
            expect(typeof tempRef.callback).toBe('function');

            // Clean up (resolve the hanging promise)
            promise.catch(() => {}); // suppress unhandled rejection
        });

        // The announcement carries pieceHashes, so it must be signed as a manifest
        // rather than signed empty and have the metadata bolted on afterwards.
        it('signs the manifest itself and publishes the announcement', async () => {
            mediaController.fileWorker = { postMessage: vi.fn() };
            const metadata = {
                fileId: 'f-1', fileName: 'clip.mp4', fileSize: 10,
                fileType: 'video/mp4', pieceCount: 1, pieceHashes: ['h0']
            };
            identityManager.createSignedFileManifest.mockResolvedValue({
                type: 'file_announce',
                id: 'm1',
                sender: '0xmyaddress',
                timestamp: Date.now(),
                channelId: 'stream-1',
                metadata,
                signature: '0xsig'
            });
            channelManager.getChannel.mockReturnValue({ messages: [] });

            const file = new File(['videodata'], 'clip.mp4', { type: 'video/mp4' });
            const promise = mediaController.sendVideo('stream-1', file);

            const tempKey = Array.from(mediaController.localFiles.keys()).find(k => k.startsWith('temp-'));
            await mediaController.localFiles.get(tempKey).callback(metadata);
            await promise;

            expect(identityManager.createSignedFileManifest).toHaveBeenCalledWith({
                channelId: 'stream-1',
                metadata
            });
            expect(streamrController.publishMessage).toHaveBeenCalled();
        });

        // A DM cannot be replayed from the peer's inbox, so the announcement is lost on
        // the next timeline load. We persist a lean copy: enough naming to re-render the
        // real bubble while this device still holds the file, without the piece hashes,
        // which would put ~160KB into one sync message for a large file.
        it('persists a DM announcement without its piece hashes', async () => {
            mediaController.fileWorker = { postMessage: vi.fn() };
            const metadata = {
                fileId: 'f-1', fileName: 'clip.mp4', fileSize: 10,
                fileType: 'video/mp4', pieceCount: 1, pieceHashes: ['h0', 'h1']
            };
            identityManager.createSignedFileManifest.mockResolvedValue({
                type: 'file_announce', id: 'm1', sender: '0xmyaddress',
                timestamp: Date.now(), channelId: 'stream-1', metadata, signature: '0xsig'
            });
            channelManager.getChannel.mockReturnValue({ messages: [], type: 'dm' });

            const file = new File(['videodata'], 'clip.mp4', { type: 'video/mp4' });
            const promise = mediaController.sendVideo('stream-1', file);
            const tempKey = Array.from(mediaController.localFiles.keys()).find(k => k.startsWith('temp-'));
            await mediaController.localFiles.get(tempKey).callback(metadata);
            await promise;

            const stored = secureStorage.addSentMessage.mock.calls.map(call => call[1]);
            expect(stored).toHaveLength(1);
            expect(stored[0].type).toBe('file_announce');

            // Naming survives — it is what re-renders the bubble / placeholder
            expect(stored[0].metadata.fileId).toBe('f-1');
            expect(stored[0].metadata.fileName).toBe('clip.mp4');
            expect(stored[0].metadata.fileSize).toBe(10);
            expect(stored[0].metadata.fileType).toBe('video/mp4');

            // The hashes must not reach the sync payload, and the signature covers
            // them, so keeping it would store one that can never verify
            expect(stored[0].metadata.pieceHashes).toBeUndefined();
            expect(stored[0].signature).toBeNull();

            // The announcement published to the network keeps its hashes
            expect(metadata.pieceHashes).toEqual(['h0', 'h1']);
        });

        it('leaves no marker in a regular channel', async () => {
            mediaController.fileWorker = { postMessage: vi.fn() };
            const metadata = {
                fileId: 'f-2', fileName: 'clip.mp4', fileSize: 10,
                fileType: 'video/mp4', pieceCount: 1, pieceHashes: ['h0']
            };
            identityManager.createSignedFileManifest.mockResolvedValue({
                type: 'file_announce', id: 'm2', sender: '0xmyaddress',
                timestamp: Date.now(), channelId: 'stream-1', metadata, signature: '0xsig'
            });
            channelManager.getChannel.mockReturnValue({ messages: [], type: 'public' });

            const file = new File(['videodata'], 'clip.mp4', { type: 'video/mp4' });
            const promise = mediaController.sendVideo('stream-1', file);
            const tempKey = Array.from(mediaController.localFiles.keys()).find(k => k.startsWith('temp-'));
            await mediaController.localFiles.get(tempKey).callback(metadata);
            await promise;

            // The channel stream replays the announcement on its own
            expect(secureStorage.addSentMessage).not.toHaveBeenCalled();
        });
    });


    // ==================== handleWorkerMessage ====================
    describe('handleWorkerMessage', () => {
        it('moves file from temp to final on complete', async () => {
            const mockCallback = vi.fn().mockResolvedValue(undefined);
            mediaController.localFiles.set('temp-123', {
                file: new Blob(['data']),
                streamId: 'stream-1',
                isPrivateChannel: false,
                callback: mockCallback
            });
            vi.spyOn(mediaController, 'persistSeedFile').mockResolvedValue(false);

            const metadata = { fileId: 'final-id', fileName: 'test.mp4', fileSize: 4 };
            await mediaController.handleWorkerMessage({ status: 'complete', metadata, tempId: 'temp-123' });

            expect(mediaController.localFiles.has('temp-123')).toBe(false);
            expect(mediaController.localFiles.has('final-id')).toBe(true);
            expect(mockCallback).toHaveBeenCalledWith(metadata);
        });

        it('persists seed file after callback', async () => {
            mediaController.localFiles.set('temp-456', {
                file: new Blob(['data']),
                streamId: 'stream-1',
                isPrivateChannel: false,
                callback: vi.fn().mockResolvedValue(undefined)
            });
            const persistSpy = vi.spyOn(mediaController, 'persistSeedFile').mockResolvedValue(true);

            const metadata = { fileId: 'final-456', fileName: 'v.mp4', fileSize: 4 };
            await mediaController.handleWorkerMessage({ status: 'complete', metadata, tempId: 'temp-456' });

            expect(persistSpy).toHaveBeenCalledWith('final-456', expect.any(Blob), metadata, 'stream-1', false);
            // Should mark as persisted
            expect(mediaController.localFiles.get('final-456').persisted).toBe(true);
            persistSpy.mockRestore();
        });

        it('handles missing temp reference', async () => {
            const metadata = { fileId: 'final-id' };
            await expect(
                mediaController.handleWorkerMessage({ status: 'complete', metadata, tempId: 'nonexistent' })
            ).resolves.not.toThrow();
        });
    });

    // ==================== getFileUrl ====================
    describe('getFileUrl', () => {
        it('returns downloaded URL if available', () => {
            mediaController.downloadedUrls.set('file-1', 'blob:downloaded');
            const result = mediaController.getFileUrl('file-1');
            expect(result).toBe('blob:downloaded');
        });

        it('returns local file URL as fallback', () => {
            mediaController.localFiles.set('file-1', { file: new Blob(['test']) });
            const result = mediaController.getFileUrl('file-1');
            expect(result).toBeTruthy();
        });

        it('returns null if not available anywhere', () => {
            expect(mediaController.getFileUrl('nonexistent')).toBeNull();
        });
    });

    // ==================== getLocalFileUrl ====================
    describe('getLocalFileUrl', () => {
        it('creates and caches blob URL', () => {
            mediaController.localFiles.set('file-1', { file: new Blob(['test']) });
            const url = mediaController.getLocalFileUrl('file-1');
            expect(url).toBeTruthy();
            // Should cache it
            expect(mediaController.downloadedUrls.has('file-1')).toBe(true);
            // Second call returns same URL
            expect(mediaController.getLocalFileUrl('file-1')).toBe(url);
        });

        it('returns null for missing file', () => {
            expect(mediaController.getLocalFileUrl('nonexistent')).toBeNull();
        });

        it('returns null if localFile has no file property', () => {
            mediaController.localFiles.set('file-1', { metadata: {} });
            expect(mediaController.getLocalFileUrl('file-1')).toBeNull();
        });
    });

    // ==================== removeSeedFile ====================
    describe('removeSeedFile', () => {
        // removeSeedFile returns early if !this.db, so we need a mock db
        const makeMockDb = () => {
            const mockRequest = { onsuccess: null, onerror: null };
            const mockStore = {
                delete: vi.fn(() => {
                    // Simulate async success
                    setTimeout(() => mockRequest.onsuccess?.(), 0);
                    return mockRequest;
                })
            };
            const mockTx = { objectStore: vi.fn(() => mockStore) };
            return { transaction: vi.fn(() => mockTx) };
        };

        it('returns early without db', async () => {
            mediaController.db = null;
            mediaController.localFiles.set('f1', { metadata: { fileSize: 1000 } });
            mediaController.persistedStorageSize = 5000;

            await mediaController.removeSeedFile('f1');

            // Should NOT have modified anything since it returns early
            expect(mediaController.persistedStorageSize).toBe(5000);
        });

        it('updates persistedStorageSize', async () => {
            mediaController.db = makeMockDb();
            mediaController.localFiles.set('f1', { metadata: { fileSize: 1000 } });
            mediaController.persistedStorageSize = 5000;

            await mediaController.removeSeedFile('f1');

            expect(mediaController.persistedStorageSize).toBe(4000);
        });

        it('revokes blob URL', async () => {
            const revokeSpy = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
            mediaController.db = makeMockDb();
            mediaController.downloadedUrls.set('f1', 'blob:url');

            await mediaController.removeSeedFile('f1');

            expect(revokeSpy).toHaveBeenCalledWith('blob:url');
            expect(mediaController.downloadedUrls.has('f1')).toBe(false);
            revokeSpy.mockRestore();
        });

        it('removes from localFiles', async () => {
            mediaController.db = makeMockDb();
            mediaController.localFiles.set('f1', {});

            await mediaController.removeSeedFile('f1');

            expect(mediaController.localFiles.has('f1')).toBe(false);
        });
    });
});
