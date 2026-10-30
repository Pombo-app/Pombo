/**
 * Voice message playback: one shared player for every audio bubble.
 */

import { mediaController } from '../../media.js';
import { Logger } from '../../logger.js';
import { formatAudioTime } from '../MessageRenderer.js';

const MAX_OBJECT_URLS = 20;

/**
 * @param {Object} ui - the UI controller singleton
 */
export function attachAudioPlayback(ui) {
    if (ui._audioPlaybackBound) return;
    ui._audioPlaybackBound = true;

    const player = new Audio();
    player.preload = 'auto';
    // The CSP allows blob: media only, so cached data URLs become object URLs.
    const objectUrls = new Map();
    let currentId = null;

    const findPlayers = (imageId) =>
        document.querySelectorAll(`[data-audio-player-id="${CSS.escape(imageId)}"]`);

    const durationOf = (el) => {
        const fromManifest = Number(el?.dataset.duration);
        if (Number.isFinite(fromManifest) && fromManifest > 0) return fromManifest;
        return Number.isFinite(player.duration) ? player.duration * 1000 : 0;
    };

    const paint = (imageId, { playing, positionMs }) => {
        for (const el of findPlayers(imageId)) {
            const total = durationOf(el);
            const pct = total > 0 ? Math.min(100, (positionMs / total) * 100) : 0;
            el.querySelector('.audio-icon-play')?.classList.toggle('hidden', playing);
            el.querySelector('.audio-icon-pause')?.classList.toggle('hidden', !playing);
            el.querySelector('.audio-play')?.setAttribute('aria-label', playing ? 'Pause voice message' : 'Play voice message');
            const bar = el.querySelector('.audio-progress');
            if (bar) bar.style.width = `${pct}%`;
            el.querySelector('.audio-track')?.setAttribute('aria-valuenow', String(Math.round(pct)));
            const time = el.querySelector('.audio-time');
            if (time) time.textContent = formatAudioTime(playing || positionMs > 0 ? positionMs : total);
        }
    };

    const objectUrlFor = (imageId, mime) => {
        if (objectUrls.has(imageId)) return objectUrls.get(imageId);
        const dataUrl = mediaController.getImage(imageId);
        if (!dataUrl) return null;
        const bytes = mediaController.base64ToArrayBuffer(String(dataUrl).split(',')[1] || '');
        if (!bytes) return null;
        const url = URL.createObjectURL(new Blob([bytes], { type: mime }));
        objectUrls.set(imageId, url);
        if (objectUrls.size > MAX_OBJECT_URLS) {
            const [oldestId, oldestUrl] = objectUrls.entries().next().value;
            if (oldestId !== currentId) {
                URL.revokeObjectURL(oldestUrl);
                objectUrls.delete(oldestId);
            }
        }
        return url;
    };

    const stopCurrent = () => {
        if (!currentId) return;
        const id = currentId;
        player.pause();
        paint(id, { playing: false, positionMs: 0 });
        currentId = null;
    };

    const toggle = async (el) => {
        const imageId = el.dataset.audioPlayerId;
        if (currentId === imageId) {
            if (player.paused) {
                await player.play();
            } else {
                player.pause();
            }
            return;
        }
        stopCurrent();
        const url = objectUrlFor(imageId, el.dataset.mime);
        if (!url) return;
        currentId = imageId;
        player.src = url;
        await player.play();
    };

    const seek = (el, clientX) => {
        const imageId = el.dataset.audioPlayerId;
        if (imageId !== currentId) return;
        const track = el.querySelector('.audio-track');
        const rect = track.getBoundingClientRect();
        const ratio = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
        player.currentTime = (durationOf(el) / 1000) * ratio;
        paint(imageId, { playing: !player.paused, positionMs: player.currentTime * 1000 });
    };

    player.addEventListener('play', () => currentId && paint(currentId, { playing: true, positionMs: player.currentTime * 1000 }));
    player.addEventListener('pause', () => currentId && paint(currentId, { playing: false, positionMs: player.currentTime * 1000 }));
    player.addEventListener('timeupdate', () => currentId && paint(currentId, { playing: !player.paused, positionMs: player.currentTime * 1000 }));
    player.addEventListener('ended', stopCurrent);
    player.addEventListener('error', () => {
        Logger.warn('Voice message playback failed:', player.error?.code);
        stopCurrent();
    });

    document.addEventListener('click', (e) => {
        const playBtn = e.target.closest?.('.audio-play');
        const trackEl = e.target.closest?.('.audio-track');
        if (!playBtn && !trackEl) return;
        const el = e.target.closest('[data-audio-player-id]');
        if (!el) return;
        e.preventDefault();
        e.stopPropagation();
        if (playBtn) {
            toggle(el).catch(err => Logger.warn('Voice message play failed:', err?.message || err));
        } else {
            seek(el, e.clientX);
        }
    });
}
