/**
 * Voice message playback: one shared player for every audio bubble.
 */

import { mediaController } from '../../media.js';
import { Logger } from '../../logger.js';
import { formatAudioTime } from '../MessageRenderer.js';
import { WaveMotion, readVoiceBands, createVoiceAnalyser } from '../audioWave.js';

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
    let voice = null;
    let frameId = 0;
    const motion = new WaveMotion();

    const findPlayers = (imageId) =>
        document.querySelectorAll(`[data-audio-player-id="${CSS.escape(imageId)}"]`);

    const durationOf = (el) => {
        const fromManifest = Number(el?.dataset.duration);
        if (Number.isFinite(fromManifest) && fromManifest > 0) return fromManifest;
        return Number.isFinite(player.duration) ? player.duration * 1000 : 0;
    };

    const paint = (imageId, { playing, positionMs }) => {
        const active = imageId === currentId && (playing || positionMs > 0);
        for (const el of findPlayers(imageId)) {
            const total = durationOf(el);
            const pct = total > 0 ? Math.min(100, (positionMs / total) * 100) : 0;
            el.querySelector('.audio-icon-play')?.classList.toggle('hidden', playing);
            el.querySelector('.audio-icon-pause')?.classList.toggle('hidden', !playing);
            el.querySelector('.audio-play')?.setAttribute('aria-label', playing ? 'Pause voice message' : 'Play voice message');
            const bar = el.querySelector('.audio-progress');
            if (bar) bar.style.width = `${pct}%`;
            const knob = el.querySelector('.audio-knob');
            if (knob) {
                knob.classList.toggle('hidden', !active);
                knob.style.left = `${pct}%`;
            }
            el.querySelector('.audio-track')?.setAttribute('aria-valuenow', String(Math.round(pct)));
            const time = el.querySelector('.audio-time');
            if (time) time.textContent = formatAudioTime(playing || positionMs > 0 ? positionMs : total);
        }
    };

    // Created on the first play: the AudioContext must start inside a user gesture.
    const ensureAnalyser = () => {
        if (voice) return;
        try {
            const ctx = new (window.AudioContext || window.webkitAudioContext)();
            const source = ctx.createMediaElementSource(player);
            voice = createVoiceAnalyser(ctx);
            source.connect(voice.analyser);
            voice.analyser.connect(ctx.destination);
            ctx.resume().catch(() => {});
        } catch (err) {
            Logger.debug('Voice wave analyser unavailable:', err?.message || err);
            voice = null;
        }
    };

    const animate = () => {
        frameId = 0;
        if (!currentId || player.paused) return;
        motion.step(readVoiceBands(voice?.analyser, voice?.bins));
        for (const el of findPlayers(currentId)) motion.paint(el);
        frameId = requestAnimationFrame(animate);
    };

    const rest = (imageId) => {
        if (frameId) cancelAnimationFrame(frameId);
        frameId = 0;
        motion.reset();
        for (const el of findPlayers(imageId)) motion.paint(el, { idle: true });
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
        currentId = null;
        paint(id, { playing: false, positionMs: 0 });
        rest(id);
    };

    const toggle = async (el) => {
        ensureAnalyser();
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
        const track = el.querySelector('.audio-track');
        const rect = track.getBoundingClientRect();
        const ratio = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
        player.currentTime = (durationOf(el) / 1000) * ratio;
        paint(currentId, { playing: !player.paused, positionMs: player.currentTime * 1000 });
    };

    player.addEventListener('play', () => {
        if (!currentId) return;
        paint(currentId, { playing: true, positionMs: player.currentTime * 1000 });
        if (!frameId) frameId = requestAnimationFrame(animate);
    });
    player.addEventListener('pause', () => {
        if (!currentId) return;
        paint(currentId, { playing: false, positionMs: player.currentTime * 1000 });
        rest(currentId);
    });
    player.addEventListener('timeupdate', () => currentId && paint(currentId, { playing: !player.paused, positionMs: player.currentTime * 1000 }));
    player.addEventListener('ended', stopCurrent);
    player.addEventListener('error', () => {
        Logger.warn('Voice message playback failed:', player.error?.code);
        stopCurrent();
    });

    document.addEventListener('click', (e) => {
        const playBtn = e.target.closest?.('.audio-play');
        if (!playBtn) return;
        const el = playBtn.closest('[data-audio-player-id]');
        if (!el) return;
        e.preventDefault();
        e.stopPropagation();
        toggle(el).catch(err => Logger.warn('Voice message play failed:', err?.message || err));
    });

    // The timeline only seeks the message that is playing or paused mid-way.
    document.addEventListener('pointerdown', (e) => {
        const track = e.target.closest?.('.audio-track');
        const el = track?.closest('[data-audio-player-id]');
        if (!el || el.dataset.audioPlayerId !== currentId) return;
        e.preventDefault();
        track.setPointerCapture?.(e.pointerId);
        seek(el, e.clientX);
        const move = (ev) => seek(el, ev.clientX);
        const end = () => {
            track.removeEventListener('pointermove', move);
            track.removeEventListener('pointerup', end);
            track.removeEventListener('pointercancel', end);
        };
        track.addEventListener('pointermove', move);
        track.addEventListener('pointerup', end);
        track.addEventListener('pointercancel', end);
    });
}
