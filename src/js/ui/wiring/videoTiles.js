/**
 * Video tiles: a player that cannot show a picture falls back to the
 * announce thumbnail and the can't-play note.
 */

import { messageRenderer } from '../MessageRenderer.js';

/**
 * Swap a tile's player for its poster and the note; the meta row with Save
 * stays as it is.
 * @param {HTMLVideoElement} video
 */
export function fallBackToThumbnail(video) {
    const frame = video.closest('.video-tile-frame');
    if (!frame) return;
    const poster = video.getAttribute('poster');
    if (poster) {
        const img = document.createElement('img');
        img.className = 'video-tile-thumb';
        img.alt = '';
        img.src = poster;
        frame.prepend(img);
    }
    video.insertAdjacentHTML('afterend', messageRenderer.videoTileNote());
    video.remove();
}

/**
 * Covers every tile player, rendered or created on tap-to-play.
 * @param {Document|Element} root
 */
export function attachVideoTileFallback(root = document) {
    const onMedia = (e) => {
        const video = e.target;
        if (!(video instanceof HTMLVideoElement) || !video.classList.contains('video-tile-media')) return;
        if (e.type === 'loadedmetadata' && video.videoWidth > 0) return;
        fallBackToThumbnail(video);
    };
    // Media events do not bubble: only a capturing listener sees them here.
    root.addEventListener('error', onMedia, true);
    root.addEventListener('loadedmetadata', onMedia, true);
}
