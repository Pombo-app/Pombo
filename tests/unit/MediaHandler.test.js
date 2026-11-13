/**
 * MediaHandler.js Tests
 * Covers: registerMedia, getMedia, openLightbox, closeLightbox, openLightboxById,
 * attachLightboxListeners, initLightboxModal, handleFileDownload, resetDownloadUI, clearCache
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('../../src/js/logger.js', () => ({
    Logger: { info: vi.fn(), debug: vi.fn(), error: vi.fn(), warn: vi.fn() }
}));

vi.mock('../../src/js/ui/utils.js', async () => {
    const actual = await vi.importActual('../../src/js/ui/utils.js');
    return { ...actual, isValidMediaUrl: vi.fn(() => true) };
});

import { mediaHandler } from '../../src/js/ui/MediaHandler.js';
import { isValidMediaUrl } from '../../src/js/ui/utils.js';
import { Logger } from '../../src/js/logger.js';

describe('MediaHandler', () => {
    let pushStateSpy, backSpy, addEventSpy, removeEventSpy;

    beforeEach(() => {
        vi.clearAllMocks();
        mediaHandler.clearCache();
        mediaHandler.deps = {};
        mediaHandler._lightboxOpen = false;
        isValidMediaUrl.mockReturnValue(true);
        document.body.innerHTML = '';
        document.body.style.touchAction = '';

        // Mock history and event listener APIs
        pushStateSpy = vi.spyOn(window.history, 'pushState').mockImplementation(() => {});
        backSpy = vi.spyOn(window.history, 'back').mockImplementation(() => {});
        addEventSpy = vi.spyOn(window, 'addEventListener');
        removeEventSpy = vi.spyOn(window, 'removeEventListener');
    });

    afterEach(() => {
        // Ensure popstate listener is cleaned up between tests
        window.removeEventListener('popstate', mediaHandler._popstateHandler, true);
        vi.restoreAllMocks();
    });

    // ==================== registerMedia ====================
    describe('registerMedia()', () => {
        it('should register media and return an ID', () => {
            const id = mediaHandler.registerMedia('https://example.com/img.png', 'image');
            expect(id).toMatch(/^media_\d+$/);
        });

        it('should increment ID counter', () => {
            const id1 = mediaHandler.registerMedia('https://a.com/1.png');
            const id2 = mediaHandler.registerMedia('https://a.com/2.png');
            expect(id1).not.toBe(id2);
        });

        it('should store url and type in cache', () => {
            const id = mediaHandler.registerMedia('blob:http://x/abc', 'video');
            const entry = mediaHandler.mediaCache.get(id);
            expect(entry).toEqual({ url: 'blob:http://x/abc', type: 'video' });
        });

        it('should default type to image', () => {
            const id = mediaHandler.registerMedia('https://a.com/img.png');
            expect(mediaHandler.mediaCache.get(id).type).toBe('image');
        });

        it('should return null for invalid URL', () => {
            isValidMediaUrl.mockReturnValue(false);
            const id = mediaHandler.registerMedia('javascript:alert(1)');
            expect(id).toBeNull();
            expect(Logger.warn).toHaveBeenCalled();
        });

        it('should not cache invalid URLs', () => {
            isValidMediaUrl.mockReturnValue(false);
            const sizeBefore = mediaHandler.mediaCache.size;
            mediaHandler.registerMedia('bad');
            expect(mediaHandler.mediaCache.size).toBe(sizeBefore);
        });
    });

    // ==================== getMedia ====================
    describe('getMedia()', () => {
        it('should return registered media', () => {
            const id = mediaHandler.registerMedia('https://x.com/a.png', 'image');
            expect(mediaHandler.getMedia(id)).toEqual({ url: 'https://x.com/a.png', type: 'image' });
        });

        it('should return undefined for unknown ID', () => {
            expect(mediaHandler.getMedia('media_999')).toBeUndefined();
        });
    });

    // ==================== clearCache ====================
    describe('clearCache()', () => {
        it('should clear all entries and reset counter', () => {
            mediaHandler.registerMedia('https://x.com/1.png');
            mediaHandler.registerMedia('https://x.com/2.png');
            expect(mediaHandler.mediaCache.size).toBe(2);

            mediaHandler.clearCache();
            expect(mediaHandler.mediaCache.size).toBe(0);
            expect(mediaHandler.mediaIdCounter).toBe(0);
        });
    });

    // ==================== setDependencies ====================
    describe('setDependencies()', () => {
        it('should merge dependencies', () => {
            const notif = vi.fn();
            mediaHandler.setDependencies({ showNotification: notif });
            expect(mediaHandler.deps.showNotification).toBe(notif);
        });

        it('should preserve existing deps', () => {
            mediaHandler.setDependencies({ a: 1 });
            mediaHandler.setDependencies({ b: 2 });
            expect(mediaHandler.deps.a).toBe(1);
            expect(mediaHandler.deps.b).toBe(2);
        });
    });

    // ==================== openLightbox ====================
    describe('openLightbox()', () => {
        function setupLightboxDOM() {
            document.body.innerHTML = `
                <div id="media-lightbox-modal" class="hidden">
                    <img id="lightbox-image" class="hidden" src="">
                    <video id="lightbox-video" class="hidden" src=""></video>
                </div>
            `;
            // jsdom doesn't have video.pause
            document.getElementById('lightbox-video').pause = vi.fn();
        }

        it('should return early if modal not found', () => {
            mediaHandler.openLightbox('https://x.com/a.png');
            // No error
        });

        it('should show image and hide video for image type', () => {
            setupLightboxDOM();
            mediaHandler.openLightbox('https://x.com/img.png', 'image');

            const img = document.getElementById('lightbox-image');
            const vid = document.getElementById('lightbox-video');
            const modal = document.getElementById('media-lightbox-modal');

            expect(img.classList.contains('hidden')).toBe(false);
            expect(img.src).toContain('img.png');
            expect(vid.classList.contains('hidden')).toBe(true);
            expect(modal.classList.contains('hidden')).toBe(false);
        });

        it('should show video and hide image for video type', () => {
            setupLightboxDOM();
            mediaHandler.openLightbox('https://x.com/vid.mp4', 'video');

            const img = document.getElementById('lightbox-image');
            const vid = document.getElementById('lightbox-video');

            expect(vid.classList.contains('hidden')).toBe(false);
            expect(vid.src).toContain('vid.mp4');
            expect(img.classList.contains('hidden')).toBe(true);
        });

        it('should pause and clear video src when resetting', () => {
            setupLightboxDOM();
            const vid = document.getElementById('lightbox-video');
            vid.src = 'old.mp4';

            mediaHandler.openLightbox('https://x.com/img.png', 'image');
            expect(vid.pause).toHaveBeenCalled();
            // jsdom resolves empty src to base URL, so just check it doesn't keep old value
            expect(vid.src).not.toContain('old.mp4');
        });

        it('should default type to image', () => {
            setupLightboxDOM();
            mediaHandler.openLightbox('https://x.com/img.png');
            expect(document.getElementById('lightbox-image').classList.contains('hidden')).toBe(false);
        });

        it('should set _lightboxOpen to true', () => {
            setupLightboxDOM();
            mediaHandler.openLightbox('https://x.com/img.png', 'image');
            expect(mediaHandler._lightboxOpen).toBe(true);
        });

        it('should push history state with modal+lightbox flags', () => {
            setupLightboxDOM();
            mediaHandler.openLightbox('https://x.com/img.png', 'image');
            expect(pushStateSpy).toHaveBeenCalledWith({ modal: true, lightbox: true }, '');
        });

        it('should set _historyEntryPending so the global popstate handler activates', () => {
            setupLightboxDOM();
            mediaHandler.openLightbox('https://x.com/img.png', 'image');
            expect(mediaHandler._historyEntryPending).toBe(true);
        });

        it('should unlock touch-action on body', () => {
            setupLightboxDOM();
            document.body.style.touchAction = 'pan-y';
            mediaHandler.openLightbox('https://x.com/img.png', 'image');
            expect(document.body.style.touchAction).toBe('manipulation');
        });

        it('should not double-push history if already open', () => {
            setupLightboxDOM();
            mediaHandler.openLightbox('https://x.com/a.png', 'image');
            mediaHandler.openLightbox('https://x.com/b.png', 'image');
            expect(pushStateSpy).toHaveBeenCalledTimes(1);
        });
    });

    // ==================== closeLightbox ====================
    describe('closeLightbox()', () => {
        function setupCloseLightboxDOM() {
            document.body.innerHTML = `
                <meta name="viewport" content="width=device-width, initial-scale=1.0">
                <div id="media-lightbox-modal">
                    <video id="lightbox-video" src="v.mp4"></video>
                </div>
            `;
            document.getElementById('lightbox-video').pause = vi.fn();
        }

        it('should hide modal and pause video', () => {
            setupCloseLightboxDOM();
            mediaHandler.closeLightbox();

            expect(document.getElementById('lightbox-video').pause).toHaveBeenCalled();
            expect(document.getElementById('media-lightbox-modal').classList.contains('hidden')).toBe(true);
        });

        it('should handle missing elements gracefully', () => {
            mediaHandler.closeLightbox();
            // No error
        });

        it('should restore body touch-action', () => {
            setupCloseLightboxDOM();
            document.body.style.touchAction = 'manipulation';
            mediaHandler.closeLightbox();
            expect(document.body.style.touchAction).toBe('');
        });

        it('should set _lightboxOpen to false', () => {
            setupCloseLightboxDOM();
            mediaHandler._lightboxOpen = true;
            mediaHandler.closeLightbox();
            expect(mediaHandler._lightboxOpen).toBe(false);
        });

        it('should call history.back when lightbox was open', () => {
            setupCloseLightboxDOM();
            mediaHandler._lightboxOpen = true;
            mediaHandler.closeLightbox();
            expect(backSpy).toHaveBeenCalledTimes(1);
        });

        it('should NOT call history.back with skipHistory option', () => {
            setupCloseLightboxDOM();
            mediaHandler._lightboxOpen = true;
            mediaHandler.closeLightbox({ skipHistory: true });
            expect(backSpy).not.toHaveBeenCalled();
        });

        it('should NOT call history.back if lightbox was not open', () => {
            setupCloseLightboxDOM();
            mediaHandler._lightboxOpen = false;
            mediaHandler.closeLightbox();
            expect(backSpy).not.toHaveBeenCalled();
        });

        it('should clear _historyEntryPending on close', () => {
            setupCloseLightboxDOM();
            mediaHandler._lightboxOpen = true;
            mediaHandler._historyEntryPending = true;
            mediaHandler.closeLightbox({ skipHistory: true });
            expect(mediaHandler._historyEntryPending).toBe(false);
        });

        it('should reset viewport zoom on close', () => {
            setupCloseLightboxDOM();
            const vp = document.querySelector('meta[name="viewport"]');
            const original = vp.getAttribute('content');

            mediaHandler.closeLightbox();

            // After requestAnimationFrame, viewport should be restored
            // Synchronously, it should have maximum-scale=1 appended
            expect(vp.getAttribute('content')).toContain('maximum-scale=1');
        });
    });

    // ==================== _onPopState (back button) ====================
    describe('_onPopState()', () => {
        it('should close lightbox with skipHistory on popstate when entry is pending', () => {
            const closeSpy = vi.spyOn(mediaHandler, 'closeLightbox');
            mediaHandler._lightboxOpen = true;
            mediaHandler._historyEntryPending = true;

            const event = new Event('popstate');
            event.stopImmediatePropagation = vi.fn();
            mediaHandler._onPopState(event);

            expect(closeSpy).toHaveBeenCalledWith({ skipHistory: true });
            expect(event.stopImmediatePropagation).toHaveBeenCalled();
        });

        it('should do nothing if no history entry is pending', () => {
            const closeSpy = vi.spyOn(mediaHandler, 'closeLightbox');
            mediaHandler._lightboxOpen = false;
            mediaHandler._historyEntryPending = false;

            const event = new Event('popstate');
            event.stopImmediatePropagation = vi.fn();
            mediaHandler._onPopState(event);

            expect(closeSpy).not.toHaveBeenCalled();
            expect(event.stopImmediatePropagation).not.toHaveBeenCalled();
        });
    });

    // ==================== openLightboxById ====================
    describe('openLightboxById()', () => {
        it('should open lightbox for registered media', () => {
            document.body.innerHTML = `
                <div id="media-lightbox-modal" class="hidden">
                    <img id="lightbox-image" class="hidden">
                    <video id="lightbox-video" class="hidden"></video>
                </div>
            `;
            document.getElementById('lightbox-video').pause = vi.fn();

            const id = mediaHandler.registerMedia('https://x.com/pic.png', 'image');
            mediaHandler.openLightboxById(id);

            expect(document.getElementById('lightbox-image').src).toContain('pic.png');
        });

        it('should do nothing for unknown ID', () => {
            const spy = vi.spyOn(mediaHandler, 'openLightbox');
            mediaHandler.openLightboxById('media_999');
            expect(spy).not.toHaveBeenCalled();
        });
    });

    // ==================== attachLightboxListeners ====================
    describe('attachLightboxListeners()', () => {
        it('should attach click listeners to trigger elements', () => {
            const id = mediaHandler.registerMedia('https://x.com/a.png', 'image');
            document.body.innerHTML = `
                <div id="media-lightbox-modal" class="hidden">
                    <img id="lightbox-image" class="hidden">
                    <video id="lightbox-video" class="hidden"></video>
                </div>
                <div class="lightbox-trigger" data-media-id="${id}"></div>
            `;
            document.getElementById('lightbox-video').pause = vi.fn();

            mediaHandler.attachLightboxListeners();

            const trigger = document.querySelector('.lightbox-trigger');
            expect(trigger.dataset.lightboxBound).toBe('true');

            trigger.click();
            expect(document.getElementById('lightbox-image').src).toContain('a.png');
        });

        it('should skip already-bound elements', () => {
            document.body.innerHTML = `
                <div class="lightbox-trigger" data-media-id="media_1" data-lightbox-bound="true"></div>
            `;
            const spy = vi.spyOn(mediaHandler, 'openLightboxById');

            mediaHandler.attachLightboxListeners();

            document.querySelector('.lightbox-trigger').click();
            // Should not have attached a new listener, so spy shouldn't be called
            expect(spy).not.toHaveBeenCalled();
        });

        it('should handle trigger without mediaId gracefully', () => {
            document.body.innerHTML = `<div class="lightbox-trigger" data-media-id=""></div>`;
            const spy = vi.spyOn(mediaHandler, 'openLightboxById');

            mediaHandler.attachLightboxListeners();
            document.querySelector('.lightbox-trigger').click();

            expect(spy).not.toHaveBeenCalled();
        });
    });

    // ==================== initLightboxModal ====================
    describe('initLightboxModal()', () => {
        it('should set up close on overlay click', () => {
            document.body.innerHTML = `
                <div id="media-lightbox-modal">
                    <button id="lightbox-close-btn"></button>
                    <img id="lightbox-image">
                    <video id="lightbox-video"></video>
                </div>
            `;
            document.getElementById('lightbox-video').pause = vi.fn();
            const closeSpy = vi.spyOn(mediaHandler, 'closeLightbox');

            mediaHandler.initLightboxModal();

            document.getElementById('media-lightbox-modal').click();
            expect(closeSpy).toHaveBeenCalled();
        });

        it('should set up close button with stopPropagation', () => {
            document.body.innerHTML = `
                <div id="media-lightbox-modal">
                    <button id="lightbox-close-btn"></button>
                    <img id="lightbox-image">
                    <video id="lightbox-video"></video>
                </div>
            `;
            document.getElementById('lightbox-video').pause = vi.fn();
            const closeSpy = vi.spyOn(mediaHandler, 'closeLightbox');

            mediaHandler.initLightboxModal();

            const event = new MouseEvent('click', { bubbles: true });
            const stopSpy = vi.spyOn(event, 'stopPropagation');
            document.getElementById('lightbox-close-btn').dispatchEvent(event);

            expect(stopSpy).toHaveBeenCalled();
            expect(closeSpy).toHaveBeenCalled();
        });

        it('should prevent close on image click', () => {
            document.body.innerHTML = `
                <div id="media-lightbox-modal">
                    <img id="lightbox-image">
                    <video id="lightbox-video"></video>
                </div>
            `;
            document.getElementById('lightbox-video').pause = vi.fn();
            mediaHandler.initLightboxModal();

            const event = new MouseEvent('click', { bubbles: true });
            const stopSpy = vi.spyOn(event, 'stopPropagation');
            document.getElementById('lightbox-image').dispatchEvent(event);
            expect(stopSpy).toHaveBeenCalled();
        });

        it('should prevent close on video click', () => {
            document.body.innerHTML = `
                <div id="media-lightbox-modal">
                    <img id="lightbox-image">
                    <video id="lightbox-video"></video>
                </div>
            `;
            document.getElementById('lightbox-video').pause = vi.fn();
            mediaHandler.initLightboxModal();

            const event = new MouseEvent('click', { bubbles: true });
            const stopSpy = vi.spyOn(event, 'stopPropagation');
            document.getElementById('lightbox-video').dispatchEvent(event);
            expect(stopSpy).toHaveBeenCalled();
        });

        it('should handle missing elements gracefully', () => {
            mediaHandler.initLightboxModal();
            // No error
        });

        it('should close lightbox on Escape key when open', () => {
            document.body.innerHTML = `
                <div id="media-lightbox-modal">
                    <img id="lightbox-image">
                    <video id="lightbox-video"></video>
                </div>
            `;
            document.getElementById('lightbox-video').pause = vi.fn();
            const closeSpy = vi.spyOn(mediaHandler, 'closeLightbox');

            mediaHandler.initLightboxModal();
            mediaHandler._lightboxOpen = true;

            document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
            expect(closeSpy).toHaveBeenCalled();
        });

        it('should NOT close on Escape key when lightbox is not open', () => {
            document.body.innerHTML = `
                <div id="media-lightbox-modal">
                    <img id="lightbox-image">
                    <video id="lightbox-video"></video>
                </div>
            `;
            document.getElementById('lightbox-video').pause = vi.fn();
            const closeSpy = vi.spyOn(mediaHandler, 'closeLightbox');

            mediaHandler.initLightboxModal();
            mediaHandler._lightboxOpen = false;

            document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
            expect(closeSpy).not.toHaveBeenCalled();
        });

        describe('zoomable channel images', () => {
            const SRC = 'data:image/jpeg;base64,AAAA';
            let openSpy;

            beforeEach(() => {
                document.body.innerHTML = `
                    <div id="media-lightbox-modal" class="hidden"><img id="lightbox-image"></div>
                    <img id="zoomable" src="${SRC}" data-zoom-image>
                    <img id="plain" src="${SRC}">`;
                openSpy = vi.spyOn(mediaHandler, 'openLightbox').mockImplementation(() => {});
                mediaHandler.initLightboxModal();
            });

            it('opens a marked image in the lightbox on click', () => {
                document.getElementById('zoomable').click();
                expect(openSpy).toHaveBeenCalledWith(SRC, 'image');
            });

            it('opens a marked image from the keyboard', () => {
                const event = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });
                document.getElementById('zoomable').dispatchEvent(event);
                expect(openSpy).toHaveBeenCalledWith(SRC, 'image');
                expect(event.defaultPrevented).toBe(true);
            });

            it('ignores images without the marker', () => {
                document.getElementById('plain').click();
                expect(openSpy).not.toHaveBeenCalled();
            });

            it('refuses a marked image whose src is not a media URL', () => {
                isValidMediaUrl.mockReturnValue(false);
                document.getElementById('zoomable').click();
                expect(openSpy).not.toHaveBeenCalled();
            });
        });
    });

    // ==================== handleFileDownload ====================
    describe('handleFileDownload()', () => {
        it('should return early if no channel', async () => {
            const mc = { startDownload: vi.fn() };
            await mediaHandler.handleFileDownload('f1', null, mc);
            expect(mc.startDownload).not.toHaveBeenCalled();
        });

        it('should notify if message not found', async () => {
            const notif = vi.fn();
            mediaHandler.setDependencies({ showNotification: notif });

            const channel = { messages: [], streamId: 's1' };
            await mediaHandler.handleFileDownload('f1', channel, {});

            expect(notif).toHaveBeenCalledWith('File not found', 'error');
        });

        it('should notify if message has no metadata', async () => {
            const notif = vi.fn();
            mediaHandler.setDependencies({ showNotification: notif });

            const channel = { messages: [{ id: 1 }], streamId: 's1' };
            await mediaHandler.handleFileDownload('f1', channel, {});

            expect(notif).toHaveBeenCalledWith('File not found', 'error');
        });

        it('should not notify if showNotification not set and message missing', async () => {
            const channel = { messages: [], streamId: 's1' };
            await mediaHandler.handleFileDownload('f1', channel, {});
            // No error — deps.showNotification is undefined
        });

        it('should call startDownload with correct args', async () => {
            const mc = { startDownload: vi.fn().mockResolvedValue(undefined) };
            const meta = { fileId: 'f1', fileName: 'test.bin' };
            const channel = {
                messages: [{ metadata: meta }],
                streamId: 'stream-1',
                password: 'pass'
            };

            await mediaHandler.handleFileDownload('f1', channel, mc);

            expect(mc.startDownload).toHaveBeenCalledWith('stream-1', meta, 'pass');
        });

        it('should show progress overlay and update text', async () => {
            document.body.innerHTML = `
                <div data-progress-overlay="f1" class="hidden"></div>
                <div data-progress-text="f1">idle</div>
                <button class="download-file-btn" data-file-id="f1">
                    <span class="download-play-icon"></span>
                    <span class="download-loading-icon hidden"></span>
                </button>
            `;

            const mc = { startDownload: vi.fn().mockResolvedValue(undefined) };
            const channel = {
                messages: [{ metadata: { fileId: 'f1' } }],
                streamId: 's1', password: null
            };

            await mediaHandler.handleFileDownload('f1', channel, mc);

            expect(document.querySelector('[data-progress-overlay="f1"]').classList.contains('hidden')).toBe(false);
            expect(document.querySelector('[data-progress-text="f1"]').textContent).toBe('Starting...');

            const btn = document.querySelector('.download-file-btn');
            expect(btn.disabled).toBe(true);
            expect(btn.classList.contains('cursor-not-allowed')).toBe(true);
            expect(btn.querySelector('.download-play-icon').classList.contains('hidden')).toBe(true);
            expect(btn.querySelector('.download-loading-icon').classList.contains('hidden')).toBe(false);
        });

        it('should notify and reset UI on download error', async () => {
            document.body.innerHTML = `
                <div data-progress-overlay="f2" class=""></div>
                <button class="download-file-btn" data-file-id="f2" disabled>
                    <span class="download-play-icon hidden"></span>
                    <span class="download-loading-icon"></span>
                </button>
            `;

            const notif = vi.fn();
            mediaHandler.setDependencies({ showNotification: notif });

            const mc = { startDownload: vi.fn().mockRejectedValue(new Error('net fail')) };
            const channel = {
                messages: [{ metadata: { fileId: 'f2' } }],
                streamId: 's1', password: null
            };

            await mediaHandler.handleFileDownload('f2', channel, mc);

            expect(notif).toHaveBeenCalledWith('Download failed: net fail', 'error');

            // UI should be reset
            const btn = document.querySelector('.download-file-btn');
            expect(btn.disabled).toBe(false);
        });

        it('should handle error without showNotification', async () => {
            const mc = { startDownload: vi.fn().mockRejectedValue(new Error('fail')) };
            const channel = {
                messages: [{ metadata: { fileId: 'f3' } }],
                streamId: 's1', password: null
            };

            await mediaHandler.handleFileDownload('f3', channel, mc);
            // No error — deps.showNotification is undefined
        });
    });

    // ==================== resetDownloadUI ====================
    describe('resetDownloadUI()', () => {
        it('should hide progress overlay and restore button', () => {
            document.body.innerHTML = `
                <div data-progress-overlay="f1"></div>
                <button class="download-file-btn" data-file-id="f1" disabled class="cursor-not-allowed opacity-50">
                    <span class="download-play-icon hidden"></span>
                    <span class="download-loading-icon"></span>
                </button>
            `;

            mediaHandler.resetDownloadUI('f1');

            expect(document.querySelector('[data-progress-overlay="f1"]').classList.contains('hidden')).toBe(true);

            const btn = document.querySelector('.download-file-btn');
            expect(btn.disabled).toBe(false);
            expect(btn.querySelector('.download-play-icon').classList.contains('hidden')).toBe(false);
            expect(btn.querySelector('.download-loading-icon').classList.contains('hidden')).toBe(true);
        });

        it('should handle missing DOM elements', () => {
            mediaHandler.resetDownloadUI('nonexistent');
            // No error
        });
    });
});
