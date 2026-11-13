/**
 * Video tile fallback: a player that errors, or loads with no picture, gives
 * way to the thumbnail and the can't-play note.
 */

import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { messageRenderer } from '../../src/js/ui/MessageRenderer.js';
import { attachVideoTileFallback } from '../../src/js/ui/wiring/videoTiles.js';

const THUMB = '/9j/4AAQSkZJRg==';

function renderTile({ thumbnail = THUMB } = {}) {
    messageRenderer.deps = {};
    messageRenderer.setDependencies({
        getFileUrl: () => 'blob:v',
        getCurrentAddress: () => '0x123',
        isVideoPlayable: () => true,
        registerMedia: () => 'media-1',
    });
    document.body.innerHTML = `<div id="messages-area">${messageRenderer.renderVideoContent({
        type: 'file_announce',
        metadata: { fileId: 'file-v1', fileName: 'clip.mp4', fileType: 'video/mp4', fileSize: 10, thumbnail },
    })}</div>`;
    return document.querySelector('video.video-tile-media');
}

// Media events do not bubble, as in a browser.
const fire = (el, type) => el.dispatchEvent(new Event(type, { bubbles: false }));

describe('video tile fallback', () => {
    beforeAll(() => attachVideoTileFallback());
    beforeEach(() => { document.body.innerHTML = ''; });

    it('swaps a player that errors for the thumbnail and the note, keeping Save', () => {
        fire(renderTile(), 'error');

        const tile = document.querySelector('.video-tile');
        expect(tile.querySelector('video')).toBeNull();
        expect(tile.querySelector('.video-tile-frame > img.video-tile-thumb').getAttribute('src')).toBe(`data:image/jpeg;base64,${THUMB}`);
        expect(tile.querySelector('.video-tile-note').textContent).toBe("This video format can't play here");
        expect(tile.querySelector('.video-tile-meta a[download="clip.mp4"]')).not.toBeNull();
    });

    it('falls back when the metadata loads without a picture', () => {
        fire(renderTile(), 'loadedmetadata');

        expect(document.querySelector('.video-tile video')).toBeNull();
        expect(document.querySelector('.video-tile-note')).not.toBeNull();
    });

    it('keeps a player whose metadata has a picture', () => {
        const video = renderTile();
        Object.defineProperty(video, 'videoWidth', { value: 640 });
        fire(video, 'loadedmetadata');

        expect(document.querySelector('.video-tile video')).toBe(video);
        expect(document.querySelector('.video-tile-note')).toBeNull();
    });

    it('shows only the note when the announce had no thumbnail', () => {
        fire(renderTile({ thumbnail: null }), 'error');

        expect(document.querySelector('.video-tile-thumb')).toBeNull();
        expect(document.querySelector('.video-tile-note')).not.toBeNull();
    });

    it('covers the stream player created on tap-to-play', () => {
        document.body.innerHTML = `<div data-file-id="t1" class="video-tile"><div class="video-tile-frame">
            <span class="video-tile-pill" data-progress-text="t1">12%</span></div></div>`;
        const video = document.createElement('video');
        video.className = 'video-tile-media';
        video.dataset.stream = '';
        video.poster = `data:image/jpeg;base64,${THUMB}`;
        document.querySelector('.video-tile-frame').prepend(video);

        fire(video, 'loadedmetadata');

        expect(document.querySelector('video[data-stream]')).toBeNull();
        expect(document.querySelector('.video-tile-thumb')).not.toBeNull();
        expect(document.querySelector('[data-progress-text="t1"]').textContent).toBe('12%');
    });

    it('leaves a video outside a tile alone', () => {
        document.body.innerHTML = '<video id="other-video"></video>';
        fire(document.getElementById('other-video'), 'error');

        expect(document.getElementById('other-video')).not.toBeNull();
        expect(document.querySelector('.video-tile-note')).toBeNull();
    });
});
