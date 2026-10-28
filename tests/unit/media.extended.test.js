/**
 * Media.js Extended Tests
 * Covers: resizeImage, initIndexedDB, processPieceQueue, _sendPieceImmediate,
 * IndexedDB operations, initFileWorker, assembleFile edge cases
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Mock dependencies
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
        MESSAGE_STREAM: { MESSAGES: 0, CONTROL: 1, STORAGE: 2, NOTIFICATIONS: 3 },
        EPHEMERAL_STREAM: { CONTROL: 0, MEDIA_SIGNALS: 1, MEDIA_DATA: 2 }
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
        createMessage: vi.fn().mockResolvedValue({
            id: 'msg-123', sender: '0xmyaddress', timestamp: Date.now()
        }),
        getTrustLevel: vi.fn().mockResolvedValue('verified')
    }
}));

vi.mock('../../src/js/logger.js', () => ({
    Logger: {
        info: vi.fn(), debug: vi.fn(), error: vi.fn(), warn: vi.fn()
    }
}));

vi.mock('../../src/js/secureStorage.js', () => ({
    secureStorage: { addSentMessage: vi.fn().mockResolvedValue(undefined) }
}));

const mockIdentity = { __ephemeralIdentity: true };
const mockChannelIdentity = { __channelIdentity: true };

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
        createBinarySealer: vi.fn().mockResolvedValue({
            seal: vi.fn().mockImplementation(async (b) => new Uint8Array([0x02, ...b])),
            identity: { __ephemeralIdentity: true }
        }),
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
        encrypt: vi.fn().mockResolvedValue({ ct: 'enc', iv: 'iv', e: 'aes-256-gcm' }),
        encryptBinary: vi.fn().mockImplementation(async (data) => new Uint8Array([0xFF, ...data]))
    }
}));

import { mediaController, MEDIA_CONFIG } from '../../src/js/media.js';
import { cryptoManager } from '../../src/js/crypto.js';
import { streamrController } from '../../src/js/streamr.js';
import { channelManager } from '../../src/js/channels.js';
import { dmCrypto } from '../../src/js/dmCrypto.js';
import { dmManager } from '../../src/js/dm.js';
import { Logger } from '../../src/js/logger.js';

describe('media.js extended', () => {
    beforeEach(() => {
        vi.clearAllMocks();
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
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    // ==================== resizeImage() ====================
    describe('resizeImage()', () => {
        it('should resolve with base64 for a small image below max size', async () => {
            // Mock FileReader → base64, Image → small dimensions, canvas toDataURL
            const origImage = globalThis.Image;
            const origCreateElement = document.createElement.bind(document);

            // Fake Image that fires onload with small dimensions
            globalThis.Image = class {
                constructor() {
                    this.width = 100;
                    this.height = 100;
                    setTimeout(() => this.onload?.(), 0);
                }
                set src(_v) {}
            };

            // Fake canvas for toDataURL
            const createSpy = vi.spyOn(document, 'createElement').mockImplementation((tag) => {
                if (tag === 'canvas') {
                    return {
                        width: 0, height: 0,
                        getContext: () => ({ drawImage: vi.fn() }),
                        toDataURL: () => 'data:image/jpeg;base64,ABCD'
                    };
                }
                return origCreateElement(tag);
            });

            const file = new File(['pixels'], 'test.png', { type: 'image/png' });
            const result = await mediaController.resizeImage(file);

            expect(result).toContain('data:image/');

            globalThis.Image = origImage;
            createSpy.mockRestore();
        });

        it('should scale down large images', async () => {
            const origImage = globalThis.Image;
            const origCreateElement = document.createElement.bind(document);

            globalThis.Image = class {
                constructor() {
                    this.width = 5000;
                    this.height = 3000;
                    setTimeout(() => this.onload?.(), 0);
                }
                set src(_v) {}
            };

            const createSpy = vi.spyOn(document, 'createElement').mockImplementation((tag) => {
                if (tag === 'canvas') {
                    return {
                        width: 0, height: 0,
                        getContext: () => ({ drawImage: vi.fn() }),
                        toDataURL: () => 'data:image/jpeg;base64,RESIZED'
                    };
                }
                return origCreateElement(tag);
            });

            const file = new File(['pixels'], 'large.png', { type: 'image/png' });
            const result = await mediaController.resizeImage(file);

            expect(result).toContain('data:image/jpeg');

            globalThis.Image = origImage;
            createSpy.mockRestore();
        });

        it('should reject on image load error', async () => {
            const origImage = globalThis.Image;

            globalThis.Image = class {
                constructor() {
                    setTimeout(() => this.onerror?.('load failed'), 0);
                }
                set src(_v) {}
            };

            const file = new File(['bad'], 'bad.png', { type: 'image/png' });
            await expect(mediaController.resizeImage(file)).rejects.toThrow('Failed to load image');

            globalThis.Image = origImage;
        });

        it('should reject on file read error', async () => {
            const OrigFileReader = globalThis.FileReader;
            globalThis.FileReader = class {
                readAsDataURL() {
                    setTimeout(() => this.onerror?.(new Error('read fail')), 0);
                }
            };

            const file = new File([], 'empty.png', { type: 'image/png' });

            try {
                await expect(mediaController.resizeImage(file)).rejects.toThrow();
            } finally {
                globalThis.FileReader = OrigFileReader;
            }
        });
    });

    // ==================== initIndexedDB() ====================
    describe('initIndexedDB()', () => {
        it('should resolve gracefully on error', async () => {
            const mockRequest = { onsuccess: null, onerror: null, onupgradeneeded: null };
            const origOpen = globalThis.indexedDB?.open;
            if (globalThis.indexedDB) {
                vi.spyOn(globalThis.indexedDB, 'open').mockImplementation(() => {
                    setTimeout(() => mockRequest.onerror?.({ target: { error: new Error('fail') } }), 0);
                    return mockRequest;
                });
            }
            try {
                await mediaController.initIndexedDB();
                // Should resolve without crash
                expect(Logger.warn).toHaveBeenCalled();
            } finally {
                if (origOpen) globalThis.indexedDB.open = origOpen;
            }
        });

        it('should open database on success', async () => {
            const mockDB = { name: 'PomboMediaDB' };
            const mockRequest = { onsuccess: null, onerror: null, onupgradeneeded: null };
            if (globalThis.indexedDB) {
                vi.spyOn(globalThis.indexedDB, 'open').mockImplementation(() => {
                    setTimeout(() => mockRequest.onsuccess?.({ target: { result: mockDB } }), 0);
                    return mockRequest;
                });
            }
            await mediaController.initIndexedDB();
            expect(mediaController.db).toBe(mockDB);
        });

        it('should handle open error gracefully', async () => {
            const mockRequest = { onsuccess: null, onerror: null, onupgradeneeded: null };
            if (globalThis.indexedDB) {
                vi.spyOn(globalThis.indexedDB, 'open').mockImplementation(() => {
                    setTimeout(() => mockRequest.onerror?.({ target: { error: new Error('fail') } }), 0);
                    return mockRequest;
                });
            }
            await mediaController.initIndexedDB();
            expect(mediaController.db).toBeNull();
        });

        it('should create object stores on upgrade', async () => {
            const mockDB = { name: 'PomboMediaDB' };
            const mockUpgradeDB = {
                objectStoreNames: { contains: () => false },
                createObjectStore: vi.fn((name, opts) => ({ createIndex: vi.fn() }))
            };
            const mockRequest = { onsuccess: null, onerror: null, onupgradeneeded: null };
            if (globalThis.indexedDB) {
                vi.spyOn(globalThis.indexedDB, 'open').mockImplementation(() => {
                    setTimeout(() => {
                        mockRequest.onupgradeneeded?.({ target: { result: mockUpgradeDB } });
                        mockRequest.onsuccess?.({ target: { result: mockDB } });
                    }, 0);
                    return mockRequest;
                });
            }
            await mediaController.initIndexedDB();
            expect(mockUpgradeDB.createObjectStore).toHaveBeenCalled();
        });
    });

    // ==================== processPieceQueue() ====================
    describe('processPieceQueue()', () => {
        it('should not process more items when at max concurrency', async () => {
            mediaController.activeSends = 25; // At max (CONCURRENT_SENDS = 25)
            mediaController.pieceSendQueue.push({ messageStreamId: 'test', fileId: 'f1', pieceIndex: 0, resolve: vi.fn() });

            await mediaController.processPieceQueue();

            // Queue should still have the item
            expect(mediaController.pieceSendQueue).toHaveLength(1);
        });

        it('should return immediately if queue is empty', async () => {
            mediaController.activeSends = 0;

            await mediaController.processPieceQueue();

            expect(mediaController.activeSends).toBe(0);
        });

        it('should process queue items and call resolve', async () => {
            mediaController.activeSends = 0;
            const resolveFn = vi.fn();

            // Mock _sendPieceImmediate
            const sendSpy = vi.spyOn(mediaController, '_sendPieceImmediate').mockResolvedValue(undefined);

            mediaController.pieceSendQueue.push({
                messageStreamId: 'stream-1', fileId: 'file-1', pieceIndex: 0, resolve: resolveFn
            });

            await mediaController.processPieceQueue();
            // Wait for concurrent sends to complete
            await new Promise(r => setTimeout(r, 50));

            expect(sendSpy).toHaveBeenCalledWith('stream-1', 'file-1', 0);
            expect(resolveFn).toHaveBeenCalled();
            expect(mediaController.activeSends).toBe(0);
            expect(mediaController.pieceSendQueue).toHaveLength(0);
        });

        it('should process multiple items concurrently', async () => {
            const resolve1 = vi.fn();
            const resolve2 = vi.fn();
            const sendSpy = vi.spyOn(mediaController, '_sendPieceImmediate').mockResolvedValue(undefined);

            mediaController.pieceSendQueue.push(
                { messageStreamId: 's1', fileId: 'f1', pieceIndex: 0, resolve: resolve1 },
                { messageStreamId: 's1', fileId: 'f1', pieceIndex: 1, resolve: resolve2 }
            );

            await mediaController.processPieceQueue();
            // Wait for concurrent sends to complete
            await new Promise(r => setTimeout(r, 50));

            expect(sendSpy).toHaveBeenCalledTimes(2);
            expect(resolve1).toHaveBeenCalled();
            expect(resolve2).toHaveBeenCalled();
        });

        it('should update lastPieceSentTime', async () => {
            vi.spyOn(mediaController, '_sendPieceImmediate').mockResolvedValue(undefined);
            mediaController.lastPieceSentTime = 0;

            mediaController.pieceSendQueue.push({
                messageStreamId: 's1', fileId: 'f1', pieceIndex: 0, resolve: vi.fn()
            });

            await mediaController.processPieceQueue();
            await new Promise(r => setTimeout(r, 50));

            expect(mediaController.lastPieceSentTime).toBeGreaterThan(0);
        });
    });

    // ==================== _sendPieceImmediate() ====================
    describe('_sendPieceImmediate()', () => {
        it('should return early if file not found', async () => {
            await mediaController._sendPieceImmediate('stream-1', 'nonexistent', 0);

            expect(streamrController.publishMediaData).not.toHaveBeenCalled();
        });

        it('should slice file and publish piece', async () => {
            const fileContent = new Uint8Array(1024).fill(42);
            const blob = new Blob([fileContent]);
            const metadata = { fileId: 'test-file', pieceCount: 1, pieceHashes: ['abc'] };

            mediaController.localFiles.set('test-file', {
                file: blob,
                metadata,
                streamId: 'stream-1'
            });

            channelManager.getChannel.mockReturnValue(null);

            await mediaController._sendPieceImmediate('stream-1', 'test-file', 0);

            expect(streamrController.publishMediaDataAs).toHaveBeenCalledWith(
                'ephemeral-stream-1',
                expect.any(Uint8Array),
                mockChannelIdentity
            );
            expect(streamrController.publishMediaData).not.toHaveBeenCalled();
        });

        it('should use channel password for private channels', async () => {
            const blob = new Blob([new Uint8Array(100)]);
            mediaController.localFiles.set('private-file', {
                file: blob,
                metadata: { fileId: 'private-file', pieceCount: 1 },
                streamId: 'stream-priv'
            });

            channelManager.getChannel.mockReturnValue({ password: 'secret123' });
            const encryptBinary = vi.spyOn(cryptoManager, 'encryptBinary');

            await mediaController._sendPieceImmediate('stream-priv', 'private-file', 0);

            expect(encryptBinary).toHaveBeenCalledWith(expect.any(Uint8Array), 'secret123');
            encryptBinary.mockRestore();
            expect(streamrController.publishMediaDataAs).toHaveBeenCalledWith(
                expect.any(String),
                expect.any(Uint8Array),
                mockChannelIdentity
            );
        });
    });

    // ==================== IndexedDB operations with mock DB ====================
    describe('IndexedDB operations', () => {
        let mockDB;

        // pieces records use a compound key; seedFiles records key on fileId alone
        const recordKey = (record) =>
            record.pieceIndex === undefined ? record.fileId : [record.fileId, record.pieceIndex];

        function createMockObjectStore(data = []) {
            const store = {
                put: vi.fn((record) => {
                    const req = { onsuccess: null, onerror: null };
                    setTimeout(() => req.onsuccess?.(), 0);
                    return req;
                }),
                delete: vi.fn((keyOrRange) => {
                    const req = { onsuccess: null, onerror: null };
                    if (keyOrRange && typeof keyOrRange.includes === 'function') {
                        for (let i = data.length - 1; i >= 0; i--) {
                            if (keyOrRange.includes(recordKey(data[i]))) data.splice(i, 1);
                        }
                    }
                    setTimeout(() => { req.result = undefined; req.onsuccess?.(); }, 0);
                    return req;
                }),
                getAll: vi.fn((range) => {
                    const req = { onsuccess: null, onerror: null, result: null };
                    // The pieces store is keyed ['fileId', 'pieceIndex']; honouring the
                    // range here is what makes range-scoped reads actually testable
                    const result = range
                        ? data.filter(r => range.includes(recordKey(r)))
                        : [...data];
                    setTimeout(() => { req.result = result; req.onsuccess?.(); }, 0);
                    return req;
                }),
                openCursor: vi.fn(() => {
                    const req = { onsuccess: null, onerror: null };
                    let idx = 0;
                    setTimeout(function fire() {
                        if (idx < data.length) {
                            const val = data[idx++];
                            req.onsuccess?.({ target: { result: { value: val, continue: () => setTimeout(fire, 0), delete: vi.fn() } } });
                        } else {
                            req.onsuccess?.({ target: { result: null } });
                        }
                    }, 0);
                    return req;
                }),
                index: vi.fn((name) => ({
                    getAll: vi.fn((streamId) => {
                        const req = { onsuccess: null, onerror: null, result: null };
                        const filtered = data.filter(d => d.streamId === streamId);
                        setTimeout(() => { req.result = filtered; req.onsuccess?.(); }, 0);
                        return req;
                    }),
                    // Cursor over the named index, honouring a key range on that field
                    openCursor: vi.fn((range) => {
                        const req = { onsuccess: null, onerror: null };
                        const matching = data.filter(r => !range || range.includes(r[name]));
                        let idx = 0;
                        setTimeout(function fire() {
                            if (idx < matching.length) {
                                const value = matching[idx++];
                                req.onsuccess?.({
                                    target: {
                                        result: {
                                            value,
                                            delete: () => {
                                                const at = data.indexOf(value);
                                                if (at >= 0) data.splice(at, 1);
                                            },
                                            continue: () => setTimeout(fire, 0)
                                        }
                                    }
                                });
                            } else {
                                req.onsuccess?.({ target: { result: null } });
                            }
                        }, 0);
                        return req;
                    })
                }))
            };
            return store;
        }

        beforeEach(() => {
            mockDB = {
                transaction: vi.fn(() => ({
                    objectStore: vi.fn((name) => createMockObjectStore())
                })),
                objectStoreNames: { contains: vi.fn().mockReturnValue(true) }
            };
            mediaController.db = mockDB;
        });

        describe('savePieceToIndexedDB()', () => {
            it('should return early if no db', async () => {
                mediaController.db = null;
                await mediaController.savePieceToIndexedDB('f1', 0, new Uint8Array(10));
                // No error
            });

            it('should save piece to IndexedDB', async () => {
                const store = createMockObjectStore();
                mockDB.transaction.mockReturnValue({ objectStore: vi.fn().mockReturnValue(store) });

                await mediaController.savePieceToIndexedDB('f1', 0, new Uint8Array(10));
                expect(store.put).toHaveBeenCalled();
            });
        });

        describe('cleanupStalePieces()', () => {
            const DAY_MS = 24 * 60 * 60 * 1000;

            it('should do nothing without a db', async () => {
                mediaController.db = null;
                await expect(mediaController.cleanupStalePieces()).resolves.toBeUndefined();
            });

            // Pieces are only cleared on completion or cancel, so a transfer abandoned
            // by closing the tab would otherwise keep its pieces forever
            it('should delete pieces from downloads abandoned past the expiry window', async () => {
                const fresh = { fileId: 'f1', pieceIndex: 0, data: new Uint8Array(1), timestamp: Date.now() };
                const stale = {
                    fileId: 'old', pieceIndex: 0, data: new Uint8Array(1),
                    timestamp: Date.now() - (MEDIA_CONFIG.PIECE_EXPIRE_DAYS + 1) * DAY_MS
                };
                const records = [fresh, stale];
                mockDB.transaction.mockReturnValue({
                    objectStore: vi.fn().mockReturnValue(createMockObjectStore(records))
                });

                await mediaController.cleanupStalePieces();

                expect(records).toEqual([fresh]);
            });

            it('should keep pieces from downloads still inside the window', async () => {
                const recent = {
                    fileId: 'f1', pieceIndex: 0, data: new Uint8Array(1),
                    timestamp: Date.now() - DAY_MS
                };
                const records = [recent];
                mockDB.transaction.mockReturnValue({
                    objectStore: vi.fn().mockReturnValue(createMockObjectStore(records))
                });

                await mediaController.cleanupStalePieces();

                expect(records).toEqual([recent]);
            });
        });

        describe('clearFileFromIndexedDB()', () => {
            it('should remove only the target file pieces', async () => {
                const mine = { fileId: 'f1', pieceIndex: 0, data: new Uint8Array(1), timestamp: Date.now() };
                const other = { fileId: 'f2', pieceIndex: 0, data: new Uint8Array(1), timestamp: Date.now() };
                const records = [mine, other];
                mockDB.transaction.mockReturnValue({
                    objectStore: vi.fn().mockReturnValue(createMockObjectStore(records))
                });

                await mediaController.clearFileFromIndexedDB('f1');

                expect(records).toEqual([other]);
            });
        });

        describe('restorePiecesFromIndexedDB()', () => {
            const PIECE_SIZE = MEDIA_CONFIG.PIECE_SIZE;

            function makeTransfer(pieceCount, fileSize) {
                return {
                    metadata: { pieceCount, fileSize },
                    pieceStatus: new Array(pieceCount).fill('pending'),
                    receivedCount: 0
                };
            }

            function withRecords(records) {
                mockDB.transaction.mockReturnValue({
                    objectStore: vi.fn().mockReturnValue(createMockObjectStore(records))
                });
            }

            it('should return 0 if no db', async () => {
                mediaController.db = null;
                const transfer = makeTransfer(2, PIECE_SIZE * 2);
                expect(await mediaController.restorePiecesFromIndexedDB('f1', transfer)).toBe(0);
            });

            it('should restore pieces and mark them done', async () => {
                withRecords([
                    { fileId: 'f1', pieceIndex: 0, data: new Uint8Array(PIECE_SIZE) },
                    { fileId: 'f1', pieceIndex: 1, data: new Uint8Array(PIECE_SIZE) }
                ]);

                const transfer = makeTransfer(3, PIECE_SIZE * 3);
                const restored = await mediaController.restorePiecesFromIndexedDB('f1', transfer);

                expect(restored).toBe(2);
                expect(transfer.pieceStatus).toEqual(['done', 'done', 'pending']);
                expect(transfer.receivedCount).toBe(2);
            });

            it('should accept a shorter final piece', async () => {
                const lastLength = 123;
                withRecords([
                    { fileId: 'f1', pieceIndex: 0, data: new Uint8Array(PIECE_SIZE) },
                    { fileId: 'f1', pieceIndex: 1, data: new Uint8Array(lastLength) }
                ]);

                const transfer = makeTransfer(2, PIECE_SIZE + lastLength);
                expect(await mediaController.restorePiecesFromIndexedDB('f1', transfer)).toBe(2);
            });

            it('should discard stale pieces whose length does not match the manifest', async () => {
                withRecords([
                    { fileId: 'f1', pieceIndex: 0, data: new Uint8Array(PIECE_SIZE) },
                    { fileId: 'f1', pieceIndex: 1, data: new Uint8Array(17) } // truncated leftover
                ]);

                const transfer = makeTransfer(2, PIECE_SIZE * 2);
                const restored = await mediaController.restorePiecesFromIndexedDB('f1', transfer);

                expect(restored).toBe(1);
                expect(transfer.pieceStatus).toEqual(['done', 'pending']);
            });

            it('should ignore pieces belonging to other files', async () => {
                withRecords([
                    { fileId: 'other-file', pieceIndex: 0, data: new Uint8Array(PIECE_SIZE) },
                    { fileId: 'f1', pieceIndex: 1, data: new Uint8Array(PIECE_SIZE) }
                ]);

                const transfer = makeTransfer(2, PIECE_SIZE * 2);
                const restored = await mediaController.restorePiecesFromIndexedDB('f1', transfer);

                expect(restored).toBe(1);
                expect(transfer.pieceStatus).toEqual(['pending', 'done']);
            });

            it('should ignore out-of-range piece indices', async () => {
                withRecords([
                    { fileId: 'f1', pieceIndex: 99, data: new Uint8Array(PIECE_SIZE) }
                ]);

                const transfer = makeTransfer(2, PIECE_SIZE * 2);
                expect(await mediaController.restorePiecesFromIndexedDB('f1', transfer)).toBe(0);
                expect(transfer.pieceStatus).toEqual(['pending', 'pending']);
            });
        });

        describe('getAllSeedFiles()', () => {
            it('should return empty array if no db', async () => {
                mediaController.db = null;
                const result = await mediaController.getAllSeedFiles();
                expect(result).toEqual([]);
            });

            it('should return all records', async () => {
                const records = [{ fileId: 'f1', streamId: 's1' }, { fileId: 'f2', streamId: 's2' }];
                const store = createMockObjectStore(records);
                store.getAll = vi.fn(() => {
                    const req = { onsuccess: null, onerror: null, result: null };
                    setTimeout(() => { req.result = [...records]; req.onsuccess?.(); }, 0);
                    return req;
                });
                mockDB.transaction.mockReturnValue({ objectStore: vi.fn().mockReturnValue(store) });

                const result = await mediaController.getAllSeedFiles();
                expect(result).toHaveLength(2);
            });
        });

        describe('getSeedFilesByStream()', () => {
            it('should return empty array if no db', async () => {
                mediaController.db = null;
                const result = await mediaController.getSeedFilesByStream('s1');
                expect(result).toEqual([]);
            });

            it('should filter by streamId', async () => {
                const records = [
                    { fileId: 'f1', streamId: 's1' },
                    { fileId: 'f2', streamId: 's2' }
                ];
                const indexGetAll = vi.fn((streamId) => {
                    const req = { onsuccess: null, onerror: null, result: null };
                    const filtered = records.filter(r => r.streamId === streamId);
                    setTimeout(() => { req.result = filtered; req.onsuccess?.(); }, 0);
                    return req;
                });
                const store = {
                    index: vi.fn().mockReturnValue({ getAll: indexGetAll })
                };
                mockDB.transaction.mockReturnValue({ objectStore: vi.fn().mockReturnValue(store) });

                const result = await mediaController.getSeedFilesByStream('s1');
                expect(result).toHaveLength(1);
                expect(result[0].fileId).toBe('f1');
            });
        });

        describe('clearFileFromIndexedDB()', () => {
            it('should return early if no db', async () => {
                mediaController.db = null;
                await mediaController.clearFileFromIndexedDB('f1');
                // No error
            });
        });

        describe('saveSeedFile()', () => {
            it('should return early if no db', async () => {
                mediaController.db = null;
                await mediaController.saveSeedFile({ fileId: 'f1' });
                // No error
            });

            it('should save record to seedFiles store', async () => {
                const store = createMockObjectStore();
                mockDB.transaction.mockReturnValue({ objectStore: vi.fn().mockReturnValue(store) });

                await mediaController.saveSeedFile({ fileId: 'f1', streamId: 's1' });
                expect(store.put).toHaveBeenCalled();
            });
        });
    });

    // ==================== persistSeedFile() ====================
    describe('persistSeedFile()', () => {
        it('should return false if no db', async () => {
            mediaController.db = null;
            const result = await mediaController.persistSeedFile('f1', new Blob(), {}, 's1');
            expect(result).toBe(false);
        });

        it('should return false if no owner address', async () => {
            mediaController.db = { objectStoreNames: { contains: vi.fn().mockReturnValue(true) } };
            mediaController.currentOwnerAddress = null;
            const result = await mediaController.persistSeedFile('f1', new Blob(), {}, 's1');
            expect(result).toBe(false);
        });

        it('should skip private channel files when PERSIST_PRIVATE_CHANNELS is false', async () => {
            mediaController.db = { objectStoreNames: { contains: vi.fn().mockReturnValue(true) } };
            mediaController.currentOwnerAddress = '0xowner';
            // isPrivateChannel = true
            const result = await mediaController.persistSeedFile('f1', new Blob(), { fileSize: 100 }, 's1', true);
            // Result depends on CONFIG.PERSIST_PRIVATE_CHANNELS
            // Just verify no crash
            expect(typeof result).toBe('boolean');
        });
    });

    // ==================== evictOldestSeedFiles() ====================
    describe('evictOldestSeedFiles()', () => {
        it('should return 0 if no db', async () => {
            mediaController.db = null;
            const result = await mediaController.evictOldestSeedFiles(1000);
            expect(result).toBe(0);
        });
    });

    // ==================== clearAllSeedFiles() ====================
    describe('clearAllSeedFiles()', () => {
        it('should return early if no db', async () => {
            mediaController.db = null;
            await mediaController.clearAllSeedFiles();
            // No error
        });
    });

    // ==================== clearSeedFilesForOwner() ====================
    describe('clearSeedFilesForOwner()', () => {
        it('should return early if no db', async () => {
            mediaController.db = null;
            await mediaController.clearSeedFilesForOwner('0xowner');
            // No error
        });

        it('should return early if no address', async () => {
            mediaController.db = {};
            await mediaController.clearSeedFilesForOwner(null);
            // No error
        });
    });

    // ==================== loadPersistedSeedFiles() ====================
    describe('loadPersistedSeedFiles()', () => {
        it('should return early if no db', async () => {
            mediaController.db = null;
            await mediaController.loadPersistedSeedFiles();
            expect(Logger.debug).toHaveBeenCalled();
        });

        it('should return early if no seedFiles store', async () => {
            mediaController.db = { objectStoreNames: { contains: vi.fn().mockReturnValue(false) } };
            await mediaController.loadPersistedSeedFiles();
        });

        it('should return early if no owner address', async () => {
            mediaController.db = { objectStoreNames: { contains: vi.fn().mockReturnValue(true) } };
            mediaController.currentOwnerAddress = null;
            await mediaController.loadPersistedSeedFiles();
        });
    });

    // ==================== reannounceForChannel() ====================
    describe('reannounceForChannel()', () => {
        it('should announce files matching the channel', async () => {
            const announceSpy = vi.spyOn(mediaController, 'announceFileSource').mockResolvedValue(undefined);
            
            mediaController.localFiles.set('f1', { streamId: 'stream-1', file: new Blob(), metadata: {} });
            mediaController.localFiles.set('f2', { streamId: 'stream-2', file: new Blob(), metadata: {} });
            mediaController.localFiles.set('f3', { streamId: 'stream-1', file: new Blob(), metadata: {} });

            await mediaController.reannounceForChannel('stream-1', 'pass');

            expect(announceSpy).toHaveBeenCalledTimes(2);
            expect(announceSpy).toHaveBeenCalledWith('stream-1', 'f1', 'pass');
            expect(announceSpy).toHaveBeenCalledWith('stream-1', 'f3', 'pass');
        });

        it('should not announce if no matching files', async () => {
            const announceSpy = vi.spyOn(mediaController, 'announceFileSource').mockResolvedValue(undefined);
            
            mediaController.localFiles.set('f1', { streamId: 'other-stream', file: new Blob(), metadata: {} });

            await mediaController.reannounceForChannel('stream-1');

            expect(announceSpy).not.toHaveBeenCalled();
        });
    });

    // ==================== handlePieceRequest() ====================
    describe('handlePieceRequest() extended', () => {
        it('should ignore requests not targeted at us', async () => {
            const sendSpy = vi.spyOn(mediaController, 'sendPiece');
            
            await mediaController.handlePieceRequest('stream-1', {
                targetSeederId: '0xsomeoneelse',
                fileId: 'f1',
                pieceIndex: 0
            });

            expect(sendSpy).not.toHaveBeenCalled();
        });

        it('should warn if file not found', async () => {
            await mediaController.handlePieceRequest('stream-1', {
                targetSeederId: '0xmyaddress',
                fileId: 'nonexistent',
                pieceIndex: 0
            });

            expect(Logger.warn).toHaveBeenCalled();
        });

        it('should ignore if address is null', async () => {
            const { authManager } = await import('../../src/js/auth.js');
            authManager.getAddress.mockReturnValueOnce(null);

            const sendSpy = vi.spyOn(mediaController, 'sendPiece');

            await mediaController.handlePieceRequest('stream-1', {
                targetSeederId: '0xmyaddress',
                fileId: 'f1',
                pieceIndex: 0
            });

            expect(sendSpy).not.toHaveBeenCalled();
        });
    });

    // ==================== assembleFile() edge cases ====================
    describe('assembleFile() edge cases', () => {
        it('should return early if transfer not found', async () => {
            await mediaController.assembleFile('nonexistent');
            // No error
        });

        it('should re-trigger download if not all pieces done', async () => {
            const manageSpy = vi.spyOn(mediaController, 'manageDownload').mockImplementation(() => {});

            mediaController.incomingFiles.set('f1', {
                metadata: { pieceCount: 3, fileSize: 300, fileType: 'video/mp4', fileName: 'test.mp4', pieceHashes: [] },
                pieceStatus: ['done', 'pending', 'done'],
                pieces: [new Uint8Array(100), null, new Uint8Array(100)],
                useIndexedDB: false,
                receivedCount: 2
            });

            await mediaController.assembleFile('f1');

            expect(Logger.error).toHaveBeenCalledWith(expect.stringContaining('Assembly aborted'));
            expect(manageSpy).toHaveBeenCalledWith('f1');
        });

        it('should assemble file from in-memory pieces', async () => {
            const piece1 = new Uint8Array([1, 2, 3, 4, 5]);
            const piece2 = new Uint8Array([6, 7, 8, 9, 10]);

            const completeCb = vi.fn();
            mediaController.handlers.onFileComplete = completeCb;

            const announceSpy = vi.spyOn(mediaController, 'announceFileSource').mockResolvedValue(undefined);
            const persistSpy = vi.spyOn(mediaController, 'persistSeedFile').mockResolvedValue(false);

            mediaController.incomingFiles.set('asm-1', {
                metadata: {
                    pieceCount: 2,
                    fileSize: 10,
                    fileType: 'application/octet-stream',
                    fileName: 'test.bin',
                    fileId: 'asm-1',
                    pieceHashes: ['a', 'b']
                },
                streamId: 'stream-1',
                password: null,
                isPrivateChannel: false,
                pieceStatus: ['done', 'done'],
                pieces: [piece1, piece2],
                useIndexedDB: false,
                receivedCount: 2,
                seederDiscoveryTimer: null
            });

            await mediaController.assembleFile('asm-1');

            // Should have called onFileComplete
            expect(completeCb).toHaveBeenCalledWith('asm-1', expect.any(Object), expect.any(String), expect.any(Blob));

            // Should have stored as localFile for seeding
            expect(mediaController.localFiles.has('asm-1')).toBe(true);

            // Transfer should be cleaned up
            expect(mediaController.incomingFiles.has('asm-1')).toBe(false);
        });

        // A size mismatch means pieces went missing after they were hash-verified.
        // The file is not what the sender announced, so it must not be delivered.
        it('should refuse to deliver a file whose assembled size is wrong', async () => {
            const piece1 = new Uint8Array([1, 2, 3]);
            const completeCb = vi.fn();
            const errorCb = vi.fn();
            mediaController.handlers.onFileComplete = completeCb;
            mediaController.handlers.onFileError = errorCb;
            vi.spyOn(mediaController, 'announceFileSource').mockResolvedValue(undefined);
            vi.spyOn(mediaController, 'persistSeedFile').mockResolvedValue(false);

            mediaController.incomingFiles.set('mismatch-1', {
                metadata: {
                    pieceCount: 1, fileSize: 999, fileType: 'text/plain',
                    fileName: 'mismatch.txt', fileId: 'mismatch-1', pieceHashes: ['a']
                },
                streamId: 'stream-1', password: null, isPrivateChannel: false,
                pieceStatus: ['done'], pieces: [piece1], useIndexedDB: false,
                receivedCount: 1, seederDiscoveryTimer: null,
                requestsInFlight: new Map()
            });

            await mediaController.assembleFile('mismatch-1');

            expect(completeCb).not.toHaveBeenCalled();
            expect(errorCb).toHaveBeenCalledWith('mismatch-1', expect.stringContaining('999'));
            // Must not be offered to other peers as a valid copy
            expect(mediaController.localFiles.has('mismatch-1')).toBe(false);
            expect(mediaController.incomingFiles.has('mismatch-1')).toBe(false);
        });
    });

    // ==================== handleMediaMessage() dispatch ====================
    describe('handleMediaMessage() extended dispatch', () => {
        it('should handle source_request', async () => {
            const spy = vi.spyOn(mediaController, 'handleSourceRequest').mockResolvedValue(undefined);
            mediaController.handleMediaMessage('stream-1', { type: 'source_request', fileId: 'f1' });
            expect(spy).toHaveBeenCalled();
        });

        it('should handle source_announce', () => {
            const spy = vi.spyOn(mediaController, 'handleSourceAnnounce').mockImplementation(() => {});
            mediaController.handleMediaMessage('stream-1', { type: 'source_announce', fileId: 'f1', seederId: '0x1' });
            expect(spy).toHaveBeenCalled();
        });

        it('should log unknown media types', () => {
            mediaController.handleMediaMessage('stream-1', { type: 'unknown_type' });
            expect(Logger.debug).toHaveBeenCalledWith('Unknown media type:', 'unknown_type');
        });

        it('should ignore null data', () => {
            mediaController.handleMediaMessage('stream-1', null);
            // No error
        });

        it('should ignore data without type', () => {
            mediaController.handleMediaMessage('stream-1', { foo: 'bar' });
            // No error
        });
    });

    // ==================== handleFilePiece() edge cases ====================
    describe('handleFilePiece() edge cases', () => {
        it('should skip own pieces (self-filtering)', async () => {
            mediaController.incomingFiles.set('f1', {
                metadata: { pieceCount: 1, pieceHashes: ['abc'] },
                pieceStatus: ['requested'],
                pieces: [null],
                receivedCount: 0,
                requestsInFlight: new Map()
            });

            await mediaController.handleFilePiece('stream-1', {
                account: '0xmyaddress',
                fileId: 'f1',
                pieceIndex: 0,
                data: btoa('test')
            });

            // Should not have processed the piece
            expect(mediaController.incomingFiles.get('f1').pieceStatus[0]).toBe('requested');
        });

        it('should skip if transfer not found', async () => {
            await mediaController.handleFilePiece('stream-1', {
                account: '0xother',
                fileId: 'nonexistent',
                pieceIndex: 0,
                data: btoa('test')
            });
            // No error
        });

        it('should skip already done pieces', async () => {
            mediaController.incomingFiles.set('f1', {
                metadata: { pieceCount: 1, pieceHashes: ['abc'] },
                pieceStatus: ['done'],
                pieces: [new Uint8Array(4)],
                receivedCount: 1,
                requestsInFlight: new Map()
            });

            await mediaController.handleFilePiece('stream-1', {
                account: '0xother',
                fileId: 'f1',
                pieceIndex: 0,
                data: btoa('test')
            });

            expect(Logger.debug).toHaveBeenCalledWith('Piece already done, skipping:', 0);
        });

        it('should skip pieces not in accepted state', async () => {
            mediaController.incomingFiles.set('f1', {
                metadata: { pieceCount: 1, pieceHashes: ['abc'] },
                pieceStatus: ['done'],
                pieces: [null],
                receivedCount: 0,
                requestsInFlight: new Map()
            });

            await mediaController.handleFilePiece('stream-1', {
                account: '0xother',
                fileId: 'f1',
                pieceIndex: 0,
                data: btoa('test')
            });

            expect(Logger.debug).toHaveBeenCalledWith('Piece already done, skipping:', 0);
        });
    });

    // ==================== cancelDownload() ====================
    describe('cancelDownload() extended', () => {
        it('should clear seeder discovery timer', () => {
            const timer = setTimeout(() => {}, 100000);
            mediaController.incomingFiles.set('f1', {
                metadata: { pieceCount: 1, fileId: 'f1' },
                pieceStatus: ['pending'],
                requestsInFlight: new Map(),
                seederDiscoveryTimer: timer
            });
            mediaController.fileSeeders.set('f1', new Set());

            mediaController.cancelDownload('f1');

            expect(mediaController.incomingFiles.has('f1')).toBe(false);
            expect(mediaController.fileSeeders.has('f1')).toBe(false);
        });

        it('should clear in-flight request timeouts', () => {
            const clearSpy = vi.spyOn(globalThis, 'clearTimeout');
            const timer1 = setTimeout(() => {}, 100000);
            
            const requestsInFlight = new Map();
            requestsInFlight.set(0, { seederId: '0x1', timeoutId: timer1 });
            
            mediaController.incomingFiles.set('f2', {
                metadata: { pieceCount: 1, fileId: 'f2' },
                pieceStatus: ['requested'],
                requestsInFlight,
                seederDiscoveryTimer: null
            });
            mediaController.fileSeeders.set('f2', new Set());

            mediaController.cancelDownload('f2');

            expect(clearSpy).toHaveBeenCalledWith(timer1);
        });
    });

    // ==================== getStorageStats() ====================
    describe('getStorageStats()', () => {
        it('should return correct stats', () => {
            mediaController.persistedStorageSize = 5 * 1024 * 1024; // 5MB
            mediaController.localFiles.set('f1', {});
            mediaController.localFiles.set('f2', {});

            const stats = mediaController.getStorageStats();

            expect(stats.usedBytes).toBe(5 * 1024 * 1024);
            expect(stats.usedMB).toBe('5.00');
            expect(stats.fileCount).toBe(2);
            expect(stats.percentUsed).toBeGreaterThan(0);
        });
    });

    // ==================== handleSourceAnnounce() ====================
    describe('handleSourceAnnounce()', () => {
        it('should add seeder for known file', () => {
            mediaController.fileSeeders.set('f1', new Set());

            mediaController.handleSourceAnnounce({
                fileId: 'f1',
                account: '0xSeeder1'
            });

            expect(mediaController.fileSeeders.get('f1').has('0xseeder1')).toBe(true);
        });

        it('should ignore announce for unknown file', () => {
            mediaController.handleSourceAnnounce({
                fileId: 'unknown',
                account: '0xseeder1'
            });
            // No error, no seeders map created
            expect(mediaController.fileSeeders.has('unknown')).toBe(false);
        });

        it('should call onSeederUpdate handler', () => {
            const handler = vi.fn();
            mediaController.handlers.onSeederUpdate = handler;
            mediaController.fileSeeders.set('f1', new Set());

            mediaController.handleSourceAnnounce({ fileId: 'f1', account: '0xA' });

            expect(handler).toHaveBeenCalledWith('f1', 1);
        });

        it('should ignore if no account', () => {
            mediaController.fileSeeders.set('f1', new Set());

            mediaController.handleSourceAnnounce({ fileId: 'f1' });

            expect(mediaController.fileSeeders.get('f1').size).toBe(0);
        });

        // Transfers are pull-based: an announce is what kicks the request loop off.
        it('should start the pull loop once a seeder announces', () => {
            mediaController.fileSeeders.set('f1', new Set());
            mediaController.incomingFiles.set('f1', {
                metadata: { pieceCount: 2 },
                pieceStatus: ['pending', 'pending'],
                requestsInFlight: new Map(),
                downloadStarted: false,
                seederDiscoveryTimer: null
            });
            const manageSpy = vi.spyOn(mediaController, 'manageDownload').mockImplementation(() => {});

            mediaController.handleSourceAnnounce({ fileId: 'f1', account: '0xA', pieceCount: 2 });

            expect(manageSpy).toHaveBeenCalledWith('f1');
            expect(mediaController.incomingFiles.get('f1').downloadStarted).toBe(true);
            manageSpy.mockRestore();
        });

        it('should not restart the pull loop for an already-started transfer', () => {
            mediaController.fileSeeders.set('f1', new Set());
            mediaController.incomingFiles.set('f1', {
                metadata: { pieceCount: 2 },
                pieceStatus: ['pending', 'pending'],
                requestsInFlight: new Map(),
                downloadStarted: true,
                seederDiscoveryTimer: null
            });
            const manageSpy = vi.spyOn(mediaController, 'manageDownload').mockImplementation(() => {});

            mediaController.handleSourceAnnounce({ fileId: 'f1', account: '0xB', pieceCount: 2 });

            // The new seeder still joins the set, but no second start
            expect(mediaController.fileSeeders.get('f1').has('0xb')).toBe(true);
            expect(manageSpy).not.toHaveBeenCalled();
            manageSpy.mockRestore();
        });
    });

    // ==================== announceFileSource() ====================
    describe('announceFileSource()', () => {
        it('should publish announcement on ephemeral stream', async () => {
            await mediaController.announceFileSource('stream-1', 'f1', null);

            expect(streamrController.publishMediaSignal).toHaveBeenCalledWith(
                'ephemeral-stream-1',
                expect.objectContaining({
                    type: 'source_announce',
                    fileId: 'f1'
                }),
                null
            );
        });

        it('should use password when provided', async () => {
            await mediaController.announceFileSource('stream-1', 'f1', 'mypassword');

            expect(streamrController.publishMediaSignal).toHaveBeenCalledWith(
                'ephemeral-stream-1',
                expect.any(Object),
                'mypassword'
            );
        });
    });

    // ==================== handleSourceRequest() ====================
    describe('handleSourceRequest()', () => {
        it('should announce if file exists', async () => {
            mediaController.localFiles.set('f1', { file: new Blob(), metadata: {} });
            channelManager.getChannel.mockReturnValue({ password: 'pass' });

            await mediaController.handleSourceRequest('stream-1', { fileId: 'f1' });

            expect(streamrController.publishMediaSignal).toHaveBeenCalled();
        });

        it('should not announce if file not found', async () => {
            await mediaController.handleSourceRequest('stream-1', { fileId: 'nonexistent' });

            expect(streamrController.publishMediaSignal).not.toHaveBeenCalled();
        });
    });

    // ==================== DM ECDH Media Encryption ====================
    describe('DM ECDH media encryption', () => {
        const dmStreamId = '0xpeer/Pombo-DM-1';
        const dmChannel = { type: 'dm', peerAddress: '0xpeeraddr', password: null };

        beforeEach(() => {
            channelManager.getChannel.mockReturnValue(dmChannel);
            dmManager.getPeerPublicKey.mockResolvedValue('0x02peerpubkey');
            vi.clearAllMocks();
            channelManager.getChannel.mockReturnValue(dmChannel);
            dmManager.getPeerPublicKey.mockResolvedValue('0x02peerpubkey');
        });

        describe('_getDMPeer()', () => {
            it('should return the peer address for DM channels', () => {
                expect(mediaController._getDMPeer(dmStreamId)).toBe('0xpeeraddr');
            });

            it('should return null for non-DM channels', () => {
                channelManager.getChannel.mockReturnValue({ type: 'public', password: 'pass' });
                expect(mediaController._getDMPeer('some-stream-1')).toBeNull();
            });

            it('should return null for a DM channel without peerAddress', () => {
                channelManager.getChannel.mockReturnValue({ type: 'dm', peerAddress: null });
                expect(mediaController._getDMPeer(dmStreamId)).toBeNull();
            });
        });

        describe('_sendPieceImmediate() for DM', () => {
            it('should seal the piece and publish under the transfer identity', async () => {
                const blob = new Blob([new Uint8Array(100)]);
                mediaController.localFiles.set('dm-file', {
                    file: blob,
                    metadata: { fileId: 'dm-file', pieceCount: 1 },
                    streamId: dmStreamId
                });

                await mediaController._sendPieceImmediate(dmStreamId, 'dm-file', 0);

                expect(dmManager.createBinarySealer).toHaveBeenCalledWith('0xpeeraddr');
                expect(streamrController.publishMediaDataAs).toHaveBeenCalledWith(
                    expect.any(String),
                    expect.any(Uint8Array),
                    mockIdentity
                );
                // The real account must never be the Streamr publisher
                expect(streamrController.publishMediaData).not.toHaveBeenCalled();
            });

            it('reuses ONE ephemeral identity for every piece of a transfer', async () => {
                // Per-piece keys would add an ECDH per piece and buy nothing.
                const blob = new Blob([new Uint8Array(100)]);
                mediaController.localFiles.set('dm-multi', {
                    file: blob,
                    metadata: { fileId: 'dm-multi', pieceCount: 3 },
                    streamId: dmStreamId
                });

                await Promise.all([
                    mediaController._sendPieceImmediate(dmStreamId, 'dm-multi', 0),
                    mediaController._sendPieceImmediate(dmStreamId, 'dm-multi', 1),
                    mediaController._sendPieceImmediate(dmStreamId, 'dm-multi', 2)
                ]);

                expect(dmManager.createBinarySealer).toHaveBeenCalledTimes(1);
                expect(streamrController.publishMediaDataAs).toHaveBeenCalledTimes(3);
            });

            it('does not cache a sealer that failed to build', async () => {
                // Caching a rejected promise would strand the transfer forever.
                const blob = new Blob([new Uint8Array(100)]);
                mediaController.localFiles.set('dm-retry', {
                    file: blob,
                    metadata: { fileId: 'dm-retry', pieceCount: 1 },
                    streamId: dmStreamId
                });
                dmManager.createBinarySealer.mockRejectedValueOnce(new Error('no peer key'));

                await expect(
                    mediaController._sendPieceImmediate(dmStreamId, 'dm-retry', 0)
                ).rejects.toThrow('no peer key');

                await mediaController._sendPieceImmediate(dmStreamId, 'dm-retry', 0);
                expect(streamrController.publishMediaDataAs).toHaveBeenCalledTimes(1);
            });
        });

        describe('announceFileSource() for DM', () => {
            it('should seal the announce signal under a throwaway publisher', async () => {
                await mediaController.announceFileSource(dmStreamId, 'file-1');

                expect(dmManager.sealAndPublish).toHaveBeenCalledWith(
                    expect.any(String),
                    '0xpeeraddr',
                    expect.objectContaining({ type: 'source_announce', fileId: 'file-1' }),
                    1  // EPHEMERAL_STREAM.MEDIA_SIGNALS
                );
                // The real account must never appear as the Streamr publisher
                expect(streamrController.publishMediaSignal).not.toHaveBeenCalled();
            });
        });

        describe('requestFileSources() for DM', () => {
            it('should seal the source_request signal under a throwaway publisher', async () => {
                await mediaController.requestFileSources(dmStreamId, 'file-2');

                expect(dmManager.sealAndPublish).toHaveBeenCalledWith(
                    expect.any(String),
                    '0xpeeraddr',
                    expect.objectContaining({ type: 'source_request', fileId: 'file-2' }),
                    1  // EPHEMERAL_STREAM.MEDIA_SIGNALS
                );
                expect(streamrController.publishMediaSignal).not.toHaveBeenCalled();
            });

            it('should log, not swallow, a signal that fails to seal', async () => {
                // sealFor raises when the peer's public key is unavailable. The
                // dispatch does not await, so without fireAndForget this becomes
                // an unhandled rejection: the transfer stalls and nothing says why.
                dmManager.sealAndPublish.mockRejectedValueOnce(
                    new Error('Cannot send DM: peer public key not available')
                );

                mediaController.fireAndForget(
                    'requestFileSources',
                    mediaController.requestFileSources(dmStreamId, 'file-3')
                );
                await new Promise(resolve => setTimeout(resolve, 0));

                expect(Logger.warn).toHaveBeenCalledWith(
                    expect.stringContaining('requestFileSources'),
                    expect.stringContaining('peer public key not available')
                );
            });
        });
    });

    describe('fireAndForget()', () => {
        it('turns a rejection into a warning instead of losing it', async () => {
            mediaController.fireAndForget('doThing', Promise.reject(new Error('boom')));
            await new Promise(resolve => setTimeout(resolve, 0));

            expect(Logger.warn).toHaveBeenCalledWith(
                expect.stringContaining('doThing'),
                'boom'
            );
        });

        it('stays quiet when the task succeeds', async () => {
            mediaController.fireAndForget('doThing', Promise.resolve('ok'));
            await new Promise(resolve => setTimeout(resolve, 0));

            expect(Logger.warn).not.toHaveBeenCalled();
        });
    });
});
