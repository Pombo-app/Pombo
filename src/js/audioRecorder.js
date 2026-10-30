/**
 * Voice recorder: microphone → MediaRecorder, capped by duration and by bytes.
 */

import { CONFIG } from './config.js';
import { createVoiceAnalyser, readVoiceBands } from './ui/audioWave.js';

// Always requested explicitly: left to choose, a browser may pick its own container and report none.
const MIME_PREFERENCE = ['audio/webm;codecs=opus', 'audio/ogg;codecs=opus', 'audio/mp4'];

// Stop before the next flush can cross the byte cap.
const TIMESLICE_MS = 250;
const BYTE_MARGIN = 32 * 1024;

export function pickRecordingMime() {
    if (typeof MediaRecorder === 'undefined' || !MediaRecorder.isTypeSupported) return null;
    return MIME_PREFERENCE.find(type => MediaRecorder.isTypeSupported(type)) || null;
}

export function canRecordAudio() {
    return !!(navigator.mediaDevices?.getUserMedia && pickRecordingMime());
}

export class VoiceRecorder {
    constructor({ onTick, onLimit } = {}) {
        this.onTick = onTick;
        this.onLimit = onLimit;
        this.stream = null;
        this.recorder = null;
        this.parts = [];
        this.bytes = 0;
        this.startedAt = 0;
        this.timer = null;
        this.limitHit = false;
        this.ctx = null;
        this.voice = null;
    }

    async start() {
        const requested = pickRecordingMime();
        if (!requested) throw new Error('Voice recording is not supported in this browser');
        this.mime = requested.split(';')[0];
        this.stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        this.recorder = new MediaRecorder(this.stream, {
            mimeType: requested,
            audioBitsPerSecond: CONFIG.media.audioBitsPerSecond
        });
        this.recorder.ondataavailable = (e) => {
            if (!e.data?.size) return;
            this.parts.push(e.data);
            this.bytes += e.data.size;
            if (this.bytes >= CONFIG.media.audioMaxAssembledBytes - BYTE_MARGIN) this._hitLimit();
        };
        this.recorder.start(TIMESLICE_MS);
        this.startedAt = performance.now();
        // Analysed only, never connected to the speakers: the user would hear themselves.
        try {
            this.ctx = new (window.AudioContext || window.webkitAudioContext)();
            this.voice = createVoiceAnalyser(this.ctx);
            this.ctx.createMediaStreamSource(this.stream).connect(this.voice.analyser);
        } catch {
            this.voice = null;
        }
        this.timer = setInterval(() => {
            const elapsed = this.elapsedMs();
            this.onTick?.(elapsed);
            if (elapsed >= CONFIG.media.audioMaxDurationMs) this._hitLimit();
        }, 200);
    }

    levels() {
        return readVoiceBands(this.voice?.analyser, this.voice?.bins);
    }

    elapsedMs() {
        return this.startedAt ? performance.now() - this.startedAt : 0;
    }

    _hitLimit() {
        if (this.limitHit) return;
        this.limitHit = true;
        this.onLimit?.();
    }

    async stop() {
        const durationMs = Math.min(this.elapsedMs(), CONFIG.media.audioMaxDurationMs);
        const recorder = this.recorder;
        if (recorder && recorder.state !== 'inactive') {
            await new Promise(resolve => {
                recorder.addEventListener('stop', resolve, { once: true });
                recorder.stop();
            });
        }
        this._release();
        return { blob: new Blob(this.parts, { type: this.mime }), mime: this.mime, durationMs };
    }

    cancel() {
        if (this.recorder && this.recorder.state !== 'inactive') {
            this.recorder.ondataavailable = null;
            this.recorder.stop();
        }
        this.parts = [];
        this._release();
    }

    _release() {
        clearInterval(this.timer);
        this.timer = null;
        this.stream?.getTracks().forEach(track => track.stop());
        this.stream = null;
        this.ctx?.close().catch(() => {});
        this.ctx = null;
        this.voice = null;
    }
}
