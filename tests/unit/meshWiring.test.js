/**
 * Mesh wiring tests.
 *
 * A handler that throws before it touches the DOM fails silently: the file
 * still arrives, but the bubble stays frozen on the progress bar until
 * something else re-renders it, and the image placeholder never offers its
 * Retry.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

const state = vi.hoisted(() => ({
    onFileComplete: null,
    seeding: true,
    playable: false,
}));

vi.mock('../../src/js/media.js', () => ({
    mediaController: {
        onFileComplete: (cb) => { state.onFileComplete = cb; },
        onImageReceived: () => {},
        isSeeding: () => state.seeding,
        isVideoPlayable: () => state.playable,
    },
}));

vi.mock('../../src/js/channels.js', () => ({
    channelManager: { recoverIncompleteImages: vi.fn() },
}));

vi.mock('../../src/js/logger.js', () => ({
    Logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
}));

vi.mock('../../src/js/ui/MediaHandler.js', () => ({
    mediaHandler: {
        autoSaveOnce: vi.fn(),
        registerMedia: () => 'media-1',
        attachLightboxListeners: () => {},
    },
}));

vi.mock('../../src/js/ui/MessageRenderer.js', () => ({
    messageRenderer: {
        formatFileSize: (n) => `${n} B`,
        renderFileBubble: () => '<div data-file-id="f1" class="rebuilt">seeding...</div>',
        renderVideoContent: () => '<div data-file-id="f1" class="video-tile"><video></video></div>',
    },
}));

const { attachMeshComplete } = await import('../../src/js/ui/wiring/meshComplete.js');
const { mediaHandler } = await import('../../src/js/ui/MediaHandler.js');
const { attachMeshImages } = await import('../../src/js/ui/wiring/meshImages.js');

const metadata = (over = {}) => ({
    fileId: 'f1',
    fileName: 'holiday "photos".bin',
    fileType: 'application/octet-stream',
    fileSize: 1024,
    ...over,
});

describe('mesh completion wiring', () => {
    beforeEach(() => {
        state.seeding = true;
        state.playable = false;
        mediaHandler.autoSaveOnce.mockClear();
        document.body.innerHTML = '<div data-file-id="f1" class="downloading">99%</div>';
        attachMeshComplete({});
    });

    it('replaces the transfer bubble when a plain file finishes', () => {
        state.onFileComplete('f1', metadata(), 'blob:file', new Blob());

        const el = document.querySelector('[data-file-id="f1"]');
        expect(el.className).toBe('rebuilt');
        expect(el.textContent).toContain('seeding');
    });

    it('saves a finished plain file', () => {
        state.onFileComplete('f1', metadata(), 'blob:file', new Blob());

        expect(mediaHandler.autoSaveOnce).toHaveBeenCalledWith('f1', 'blob:file', 'holiday "photos".bin');
    });

    it('swaps in the video tile without saving the video', () => {
        state.onFileComplete('f1', metadata({ fileType: 'video/mp4' }), 'blob:v', new Blob());

        expect(document.querySelector('video')).not.toBeNull();
        expect(mediaHandler.autoSaveOnce).not.toHaveBeenCalled();
    });
});

describe('mesh image wiring', () => {
    it('paints a retry button when image recovery gives up', () => {
        document.body.innerHTML = '<div data-image-id="img-1">loading</div>';
        attachMeshImages({ getActiveChannel: () => ({ streamId: 'stream-1' }) });

        window.dispatchEvent(new CustomEvent('pombo:imageRecoveryGaveUp', {
            detail: { imageIds: ['img-1'], streamId: 'stream-1' },
        }));

        const placeholder = document.querySelector('[data-image-id="img-1"]');
        expect(placeholder.innerHTML).toContain('Image unavailable');
        expect(placeholder.querySelector('[data-retry-image-id="img-1"]')).not.toBeNull();
    });
});
