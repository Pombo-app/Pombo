/**
 * Tests for media.js pure functions and utilities
 * Focus: utility functions, config accessors, validation logic
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

// Mock dependencies before importing
vi.mock('../../src/js/streamr.js', () => ({
    streamrController: {
        publishMessage: vi.fn(),
        publishMediaSignal: vi.fn(),
        publishMediaData: vi.fn()
    }
}));

vi.mock('../../src/js/channels.js', () => ({
    channelManager: {
        getChannel: vi.fn()
    }
}));

vi.mock('../../src/js/identity.js', () => ({
    identityManager: {
        createMessage: vi.fn(),
        getTrustLevel: vi.fn()
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

vi.mock('../../src/js/crypto.js', () => ({
    deriveEphemeralId: vi.fn((id) => `ephemeral-${id}`)
}));

vi.mock('../../src/js/dm.js', () => ({
    dmManager: {
        getPeerPublicKey: vi.fn()
    }
}));

vi.mock('../../src/js/dmCrypto.js', () => ({
    dmCrypto: {
        getSharedKey: vi.fn(),
        encrypt: vi.fn()
    }
}));

// Import after mocks
import { mediaController, MEDIA_CONFIG } from '../../src/js/media.js';

describe('media.js', () => {
    // ==================== CONFIG CONSTANTS ====================
    describe('MEDIA_CONFIG', () => {
        it('defines PIECE_SIZE', () => {
            expect(MEDIA_CONFIG.PIECE_SIZE).toBe(220 * 1024);
        });

        it('defines MAX_FILE_SIZE as 500MB', () => {
            expect(MEDIA_CONFIG.MAX_FILE_SIZE).toBe(500 * 1024 * 1024);
        });

        it('defines allowed image types', () => {
            expect(MEDIA_CONFIG.ALLOWED_IMAGE_TYPES).toContain('image/jpeg');
            expect(MEDIA_CONFIG.ALLOWED_IMAGE_TYPES).toContain('image/png');
            expect(MEDIA_CONFIG.ALLOWED_IMAGE_TYPES).toContain('image/gif');
            expect(MEDIA_CONFIG.ALLOWED_IMAGE_TYPES).toContain('image/webp');
        });

        it('defines allowed video types', () => {
            expect(MEDIA_CONFIG.ALLOWED_VIDEO_TYPES).toContain('video/mp4');
            expect(MEDIA_CONFIG.ALLOWED_VIDEO_TYPES).toContain('video/webm');
        });

        it('defines playable video types', () => {
            expect(MEDIA_CONFIG.PLAYABLE_VIDEO_TYPES).toContain('video/mp4');
            expect(MEDIA_CONFIG.PLAYABLE_VIDEO_TYPES).toContain('video/webm');
        });

        it('playable types are reasonable subset for browser compatibility', () => {
            // Core playable types should be in allowed types
            const corePlayable = ['video/mp4', 'video/webm'];
            corePlayable.forEach(type => {
                expect(MEDIA_CONFIG.ALLOWED_VIDEO_TYPES).toContain(type);
            });
        });
    });

    // ==================== CONFIG ACCESSOR METHODS ====================
    describe('Config Accessor Methods', () => {
        describe('getAllowedImageTypes', () => {
            it('returns allowed image types array', () => {
                const types = mediaController.getAllowedImageTypes();
                expect(Array.isArray(types)).toBe(true);
                expect(types).toContain('image/jpeg');
                expect(types).toContain('image/png');
            });

            it('returns same reference as MEDIA_CONFIG', () => {
                expect(mediaController.getAllowedImageTypes()).toBe(MEDIA_CONFIG.ALLOWED_IMAGE_TYPES);
            });
        });

        describe('getAllowedVideoTypes', () => {
            it('returns allowed video types array', () => {
                const types = mediaController.getAllowedVideoTypes();
                expect(Array.isArray(types)).toBe(true);
                expect(types).toContain('video/mp4');
                expect(types).toContain('video/webm');
            });

            it('returns same reference as MEDIA_CONFIG', () => {
                expect(mediaController.getAllowedVideoTypes()).toBe(MEDIA_CONFIG.ALLOWED_VIDEO_TYPES);
            });
        });

        describe('getMaxFileSize', () => {
            it('returns max file size', () => {
                const size = mediaController.getMaxFileSize();
                expect(size).toBe(500 * 1024 * 1024);
            });

            it('returns same value as MEDIA_CONFIG', () => {
                expect(mediaController.getMaxFileSize()).toBe(MEDIA_CONFIG.MAX_FILE_SIZE);
            });
        });

        describe('getPlayableVideoTypes', () => {
            it('returns playable video types array', () => {
                const types = mediaController.getPlayableVideoTypes();
                expect(Array.isArray(types)).toBe(true);
                expect(types).toContain('video/mp4');
                expect(types).toContain('video/webm');
            });

            it('returns same reference as MEDIA_CONFIG', () => {
                expect(mediaController.getPlayableVideoTypes()).toBe(MEDIA_CONFIG.PLAYABLE_VIDEO_TYPES);
            });
        });
    });

    // ==================== UTILITY FUNCTIONS ====================
    describe('Utility Functions', () => {
        describe('arrayBufferToBase64', () => {
            it('converts empty ArrayBuffer to empty string', () => {
                const buffer = new ArrayBuffer(0);
                const result = mediaController.arrayBufferToBase64(buffer);
                expect(result).toBe('');
            });

            it('converts simple ArrayBuffer to base64', () => {
                const data = new Uint8Array([72, 101, 108, 108, 111]); // "Hello"
                const result = mediaController.arrayBufferToBase64(data.buffer);
                expect(result).toBe('SGVsbG8=');
            });

            it('converts binary data correctly', () => {
                const data = new Uint8Array([0, 127, 255, 128, 1]);
                const result = mediaController.arrayBufferToBase64(data.buffer);
                // Verify roundtrip
                const decoded = atob(result);
                expect(decoded.charCodeAt(0)).toBe(0);
                expect(decoded.charCodeAt(1)).toBe(127);
                expect(decoded.charCodeAt(2)).toBe(255);
                expect(decoded.charCodeAt(3)).toBe(128);
                expect(decoded.charCodeAt(4)).toBe(1);
            });

            it('handles large buffers', () => {
                const size = 10000;
                const data = new Uint8Array(size);
                for (let i = 0; i < size; i++) {
                    data[i] = i % 256;
                }
                const result = mediaController.arrayBufferToBase64(data.buffer);
                expect(typeof result).toBe('string');
                expect(result.length).toBeGreaterThan(0);
            });
        });

        describe('base64ToArrayBuffer', () => {
            it('converts empty string to empty buffer', () => {
                const result = mediaController.base64ToArrayBuffer('');
                expect(result.byteLength).toBe(0);
            });

            it('converts base64 to ArrayBuffer', () => {
                const base64 = 'SGVsbG8='; // "Hello"
                const result = mediaController.base64ToArrayBuffer(base64);
                const view = new Uint8Array(result);
                expect(view).toEqual(new Uint8Array([72, 101, 108, 108, 111]));
            });

            it('returns null for invalid base64', () => {
                const result = mediaController.base64ToArrayBuffer('not-valid-base64!!!');
                expect(result).toBeNull();
            });

            it('roundtrip: buffer -> base64 -> buffer', () => {
                const original = new Uint8Array([1, 2, 3, 4, 5, 100, 200, 255]);
                const base64 = mediaController.arrayBufferToBase64(original.buffer);
                const result = mediaController.base64ToArrayBuffer(base64);
                const view = new Uint8Array(result);
                expect(view).toEqual(original);
            });
        });

        describe('sha256', () => {
            it('calculates SHA-256 hash of buffer', async () => {
                const data = new TextEncoder().encode('hello');
                const hash = await mediaController.sha256(data.buffer);
                // SHA-256 of "hello" is known
                expect(hash).toBe('2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824');
            });

            it('calculates hash of numeric string', async () => {
                const data = new TextEncoder().encode('0');
                const hash = await mediaController.sha256(data.buffer);
                // SHA-256 of "0"
                expect(hash).toBe('5feceb66ffc86f38d952786c6d696c79c2dbc239dd4e91b46729d73a27fb57e9');
            });

            it('produces 64 character hex string', async () => {
                const data = new TextEncoder().encode('test');
                const hash = await mediaController.sha256(data.buffer);
                expect(hash).toMatch(/^[0-9a-f]{64}$/);
            });

            it('different inputs produce different hashes', async () => {
                const data1 = new TextEncoder().encode('test1');
                const data2 = new TextEncoder().encode('test2');
                const hash1 = await mediaController.sha256(data1.buffer);
                const hash2 = await mediaController.sha256(data2.buffer);
                expect(hash1).not.toBe(hash2);
            });

            it('same input produces same hash', async () => {
                const data = new TextEncoder().encode('consistent');
                const hash1 = await mediaController.sha256(data.buffer);
                const hash2 = await mediaController.sha256(data.buffer);
                expect(hash1).toBe(hash2);
            });
        });
    });

    // ==================== VIDEO PLAYABILITY ====================
    describe('isVideoPlayable', () => {
        it('returns true for video/mp4', () => {
            expect(mediaController.isVideoPlayable('video/mp4')).toBe(true);
        });

        it('returns true for video/webm', () => {
            expect(mediaController.isVideoPlayable('video/webm')).toBe(true);
        });

        it('handles uppercase mime type', () => {
            expect(mediaController.isVideoPlayable('VIDEO/MP4')).toBe(true);
        });

        it('handles mime type with spaces', () => {
            expect(mediaController.isVideoPlayable('  video/mp4  ')).toBe(true);
        });

        it('returns true for mp4 variants', () => {
            expect(mediaController.isVideoPlayable('video/x-m4v')).toBe(true);
            expect(mediaController.isVideoPlayable('video/m4v')).toBe(true);
        });

        it('returns true for empty/null mime type (defaults to playable)', () => {
            expect(mediaController.isVideoPlayable('')).toBe(true);
            expect(mediaController.isVideoPlayable(null)).toBe(true);
            expect(mediaController.isVideoPlayable(undefined)).toBe(true);
        });

        it('returns false for QuickTime/mov', () => {
            expect(mediaController.isVideoPlayable('video/quicktime')).toBe(false);
        });

        it('returns true for webm variants', () => {
            expect(mediaController.isVideoPlayable('video/webm')).toBe(true);
            expect(mediaController.isVideoPlayable('video/x-webm')).toBe(true);
        });
    });

    // ==================== VALIDATION ====================
    describe('Validation', () => {
        describe('sendImage validation', () => {
            it('throws error for invalid image type', async () => {
                const file = new File(['test'], 'test.txt', { type: 'text/plain' });
                await expect(mediaController.sendImage('stream-123', file))
                    .rejects.toThrow('Invalid image type');
            });

            it('throws error for video file as image', async () => {
                const file = new File(['test'], 'test.mp4', { type: 'video/mp4' });
                await expect(mediaController.sendImage('stream-123', file))
                    .rejects.toThrow('Invalid image type');
            });

            it('includes allowed types in error message', async () => {
                const file = new File(['test'], 'test.txt', { type: 'application/pdf' });
                try {
                    await mediaController.sendImage('stream-123', file);
                } catch (e) {
                    expect(e.message).toContain('image/jpeg');
                    expect(e.message).toContain('image/png');
                }
            });
        });

        describe('sendVideo validation', () => {
            it('throws error for invalid video type', async () => {
                const file = new File(['test'], 'test.txt', { type: 'text/plain' });
                await expect(mediaController.sendVideo('stream-123', file))
                    .rejects.toThrow('Invalid video type');
            });

            it('throws error for image file as video', async () => {
                const file = new File(['test'], 'test.jpg', { type: 'image/jpeg' });
                await expect(mediaController.sendVideo('stream-123', file))
                    .rejects.toThrow('Invalid video type');
            });

            it('throws error for file exceeding max size', async () => {
                // Create a mock file object with large size
                const largeFile = {
                    type: 'video/mp4',
                    size: 600 * 1024 * 1024, // 600MB > 500MB limit
                    name: 'large.mp4'
                };
                await expect(mediaController.sendVideo('stream-123', largeFile))
                    .rejects.toThrow('File too large');
            });

            it('includes max size in error message', async () => {
                const largeFile = {
                    type: 'video/mp4',
                    size: 600 * 1024 * 1024,
                    name: 'large.mp4'
                };
                try {
                    await mediaController.sendVideo('stream-123', largeFile);
                } catch (e) {
                    expect(e.message).toContain('500');
                    expect(e.message).toContain('MB');
                }
            });

            it('includes allowed types in error message for type error', async () => {
                const file = new File(['test'], 'test.txt', { type: 'application/pdf' });
                try {
                    await mediaController.sendVideo('stream-123', file);
                } catch (e) {
                    expect(e.message).toContain('video/mp4');
                    expect(e.message).toContain('video/webm');
                }
            });
        });
    });

    // ==================== CACHE MANAGEMENT ====================
    describe('Cache Management', () => {
        beforeEach(() => {
            // Clear caches
            mediaController.imageCache.clear();
            mediaController.downloadedUrls.clear();
            mediaController.localFiles.clear();
        });

        describe('imageCache', () => {
            it('is a Map instance', () => {
                expect(mediaController.imageCache instanceof Map).toBe(true);
            });

            it('can store and retrieve image data', () => {
                mediaController.imageCache.set('img-1', 'base64data');
                expect(mediaController.imageCache.get('img-1')).toBe('base64data');
            });

            it('can check for cached images', () => {
                mediaController.imageCache.set('img-1', 'data');
                expect(mediaController.imageCache.has('img-1')).toBe(true);
                expect(mediaController.imageCache.has('img-2')).toBe(false);
            });

            it('can delete cached images', () => {
                mediaController.imageCache.set('img-1', 'data');
                mediaController.imageCache.delete('img-1');
                expect(mediaController.imageCache.has('img-1')).toBe(false);
            });
        });

        describe('downloadedUrls', () => {
            it('is a Map instance', () => {
                expect(mediaController.downloadedUrls instanceof Map).toBe(true);
            });

            it('can store and retrieve download URLs', () => {
                mediaController.downloadedUrls.set('file-1', 'blob:http://...');
                expect(mediaController.downloadedUrls.get('file-1')).toBe('blob:http://...');
            });
        });

        describe('localFiles', () => {
            it('is a Map instance', () => {
                expect(mediaController.localFiles instanceof Map).toBe(true);
            });

            it('can store file metadata', () => {
                const fileData = {
                    file: new Blob(['test']),
                    metadata: { fileName: 'test.txt' },
                    streamId: 'stream-1'
                };
                mediaController.localFiles.set('file-1', fileData);
                expect(mediaController.localFiles.get('file-1')).toEqual(fileData);
            });
        });

        describe('isSeeding', () => {
            it('returns true when file exists in localFiles', () => {
                mediaController.localFiles.set('file-1', { file: new Blob(['test']) });
                expect(mediaController.isSeeding('file-1')).toBe(true);
            });

            it('returns false when file does not exist', () => {
                expect(mediaController.isSeeding('nonexistent')).toBe(false);
            });
        });

        describe('isDownloading', () => {
            it('returns true when file has active transfer', () => {
                mediaController.incomingFiles.set('file-dl-1', { metadata: {} });
                expect(mediaController.isDownloading('file-dl-1')).toBe(true);
            });

            it('returns false when no transfer exists', () => {
                expect(mediaController.isDownloading('nonexistent')).toBe(false);
            });

            it('returns false after transfer is removed', () => {
                mediaController.incomingFiles.set('file-dl-2', { metadata: {} });
                mediaController.incomingFiles.delete('file-dl-2');
                expect(mediaController.isDownloading('file-dl-2')).toBe(false);
            });
        });

        describe('getDownloadProgress', () => {
            it('returns progress for active transfer', () => {
                mediaController.incomingFiles.set('file-p-1', {
                    receivedCount: 5,
                    metadata: { pieceCount: 10, fileSize: 1024000 }
                });
                const progress = mediaController.getDownloadProgress('file-p-1');
                expect(progress).toEqual({
                    percent: 50,
                    received: 5,
                    total: 10,
                    fileSize: 1024000,
                    // No delivery samples yet, so there is nothing to measure
                    bytesPerSec: null,
                    paused: false
                });
            });

            it('returns null when no transfer exists', () => {
                expect(mediaController.getDownloadProgress('nonexistent')).toBeNull();
            });

            it('returns 0% when no pieces received', () => {
                mediaController.incomingFiles.set('file-p-2', {
                    receivedCount: 0,
                    metadata: { pieceCount: 20, fileSize: 2048000 }
                });
                const progress = mediaController.getDownloadProgress('file-p-2');
                expect(progress.percent).toBe(0);
                expect(progress.received).toBe(0);
            });

            it('returns 100% when all pieces received', () => {
                mediaController.incomingFiles.set('file-p-3', {
                    receivedCount: 8,
                    metadata: { pieceCount: 8, fileSize: 524288 }
                });
                const progress = mediaController.getDownloadProgress('file-p-3');
                expect(progress.percent).toBe(100);
            });

            it('handles pieceCount of 0 without division by zero', () => {
                mediaController.incomingFiles.set('file-p-4', {
                    receivedCount: 0,
                    metadata: { pieceCount: 0, fileSize: 0 }
                });
                const progress = mediaController.getDownloadProgress('file-p-4');
                expect(progress.percent).toBe(0);
            });
        });
    });

    // ==================== EVENT HANDLERS ====================
    describe('Event Handlers', () => {
        beforeEach(() => {
            // Reset handlers
            mediaController.handlers = {};
        });

        describe('onImageReceived', () => {
            it('sets image received handler', () => {
                const handler = vi.fn();
                mediaController.onImageReceived(handler);
                expect(mediaController.handlers.onImageReceived).toBe(handler);
            });
        });

        describe('onFileProgress', () => {
            it('sets file progress handler', () => {
                const handler = vi.fn();
                mediaController.onFileProgress(handler);
                expect(mediaController.handlers.onFileProgress).toBe(handler);
            });
        });

        describe('onFileComplete', () => {
            it('sets file complete handler', () => {
                const handler = vi.fn();
                mediaController.onFileComplete(handler);
                expect(mediaController.handlers.onFileComplete).toBe(handler);
            });
        });

        describe('onSeederUpdate', () => {
            it('sets seeder update handler', () => {
                const handler = vi.fn();
                mediaController.onSeederUpdate(handler);
                expect(mediaController.handlers.onSeederUpdate).toBe(handler);
            });
        });
    });

    // ==================== INTERNAL MAPS ====================
    describe('Internal Data Structures', () => {
        describe('fileSeeders', () => {
            beforeEach(() => {
                mediaController.fileSeeders.clear();
            });

            it('is a Map instance', () => {
                expect(mediaController.fileSeeders instanceof Map).toBe(true);
            });

            it('can track seeders per file', () => {
                const seeders = new Set(['addr1', 'addr2']);
                mediaController.fileSeeders.set('file-1', seeders);
                expect(mediaController.fileSeeders.get('file-1').size).toBe(2);
            });
        });

        describe('incomingFiles', () => {
            beforeEach(() => {
                mediaController.incomingFiles.clear();
            });

            it('is a Map instance', () => {
                expect(mediaController.incomingFiles instanceof Map).toBe(true);
            });

            it('can track incoming transfers', () => {
                mediaController.incomingFiles.set('file-1', {
                    metadata: { fileName: 'test.mp4' },
                    receivedPieces: new Map()
                });
                expect(mediaController.incomingFiles.has('file-1')).toBe(true);
            });
        });
    });

    // ==================== handleMediaMessage DISPATCH ====================
    describe('handleMediaMessage dispatch', () => {
        it('ignores null data', () => {
            // Should not throw
            expect(() => mediaController.handleMediaMessage('stream-1', null)).not.toThrow();
        });

        it('ignores data without type', () => {
            expect(() => mediaController.handleMediaMessage('stream-1', { foo: 'bar' })).not.toThrow();
        });

        it('ignores undefined data', () => {
            expect(() => mediaController.handleMediaMessage('stream-1', undefined)).not.toThrow();
        });
    });

    // ==================== handleSourceAnnounce ====================
    describe('handleSourceAnnounce', () => {
        beforeEach(() => {
            mediaController.fileSeeders.clear();
            mediaController.handlers = {};
        });

        it('adds seeder to tracked seeders set', () => {
            const seeders = new Set();
            mediaController.fileSeeders.set('file-1', seeders);
            
            mediaController.handleSourceAnnounce({
                fileId: 'file-1',
                account: '0xABC123'
            });
            
            expect(seeders.has('0xabc123')).toBe(true); // lowercase
        });

        it('normalizes sender address to lowercase', () => {
            const seeders = new Set();
            mediaController.fileSeeders.set('file-1', seeders);
            
            mediaController.handleSourceAnnounce({
                fileId: 'file-1',
                account: '0xABCDEF'
            });
            
            expect(seeders.has('0xabcdef')).toBe(true);
        });

        it('calls onSeederUpdate handler', () => {
            const handler = vi.fn();
            mediaController.handlers.onSeederUpdate = handler;
            
            const seeders = new Set();
            mediaController.fileSeeders.set('file-1', seeders);
            
            mediaController.handleSourceAnnounce({
                fileId: 'file-1',
                account: '0x123'
            });
            
            expect(handler).toHaveBeenCalledWith('file-1', 1);
        });

        it('does nothing if file not being tracked', () => {
            // Should not throw
            expect(() => {
                mediaController.handleSourceAnnounce({
                    fileId: 'unknown-file',
                    account: '0x123'
                });
            }).not.toThrow();
        });

        it('does nothing without account', () => {
            const seeders = new Set();
            mediaController.fileSeeders.set('file-1', seeders);
            
            mediaController.handleSourceAnnounce({
                fileId: 'file-1'
                // no account
            });
            
            expect(seeders.size).toBe(0);
        });
    });

    // ==================== cancelDownload ====================
    describe('cancelDownload', () => {
        beforeEach(() => {
            mediaController.incomingFiles.clear();
            mediaController.fileSeeders.clear();
        });

        it('removes transfer from incomingFiles', () => {
            mediaController.incomingFiles.set('file-1', {
                requestsInFlight: new Map()
            });
            
            mediaController.cancelDownload('file-1');
            
            expect(mediaController.incomingFiles.has('file-1')).toBe(false);
        });

        it('removes file from fileSeeders', () => {
            mediaController.incomingFiles.set('file-1', {
                requestsInFlight: new Map()
            });
            mediaController.fileSeeders.set('file-1', new Set(['seeder1']));
            
            mediaController.cancelDownload('file-1');
            
            expect(mediaController.fileSeeders.has('file-1')).toBe(false);
        });

        it('does nothing for nonexistent file', () => {
            expect(() => mediaController.cancelDownload('nonexistent')).not.toThrow();
        });

        it('clears seeder discovery timer', () => {
            const clearTimeoutSpy = vi.spyOn(global, 'clearTimeout');
            const timerId = setTimeout(() => {}, 10000);
            
            mediaController.incomingFiles.set('file-1', {
                seederDiscoveryTimer: timerId,
                requestsInFlight: new Map()
            });
            
            mediaController.cancelDownload('file-1');
            
            expect(clearTimeoutSpy).toHaveBeenCalledWith(timerId);
            clearTimeoutSpy.mockRestore();
        });

        it('clears all piece request timeouts', () => {
            const clearTimeoutSpy = vi.spyOn(global, 'clearTimeout');
            const timer1 = setTimeout(() => {}, 10000);
            const timer2 = setTimeout(() => {}, 10000);
            
            const requestsInFlight = new Map();
            requestsInFlight.set(0, { timeoutId: timer1 });
            requestsInFlight.set(1, { timeoutId: timer2 });
            
            mediaController.incomingFiles.set('file-1', {
                requestsInFlight
            });
            
            mediaController.cancelDownload('file-1');
            
            expect(clearTimeoutSpy).toHaveBeenCalledWith(timer1);
            expect(clearTimeoutSpy).toHaveBeenCalledWith(timer2);
            clearTimeoutSpy.mockRestore();
        });
    });

    // ==================== getImage (cache hit) ====================
    describe('getImage', () => {
        beforeEach(() => {
            mediaController.imageCache.clear();
        });

        it('returns cached image data if available', () => {
            mediaController.imageCache.set('img-1', 'cached-base64-data');
            const result = mediaController.getImage('img-1');
            expect(result).toBe('cached-base64-data');
        });

        it('returns null for uncached image', () => {
            const result = mediaController.getImage('nonexistent');
            expect(result).toBeNull();
        });
    });

    // ==================== getDownloadedFile ====================
    describe('getDownloadedFile', () => {
        beforeEach(() => {
            mediaController.downloadedUrls.clear();
        });

        it('returns URL for downloaded file', () => {
            mediaController.downloadedUrls.set('file-1', 'blob:http://example.com/abc');
            const result = mediaController.getDownloadedFile('file-1');
            expect(result).toBe('blob:http://example.com/abc');
        });

        it('returns null for non-downloaded file', () => {
            const result = mediaController.getDownloadedFile('nonexistent');
            expect(result).toBeNull();
        });
    });

    // ==================== getLocalFileUrl ====================
    describe('getLocalFileUrl', () => {
        beforeEach(() => {
            mediaController.localFiles.clear();
        });

        it('returns null if file not in localFiles', () => {
            const result = mediaController.getLocalFileUrl('nonexistent');
            expect(result).toBeNull();
        });

        it('returns null if localFile has no file', () => {
            mediaController.localFiles.set('file-1', { metadata: {} });
            const result = mediaController.getLocalFileUrl('file-1');
            expect(result).toBeNull();
        });
    });
});
