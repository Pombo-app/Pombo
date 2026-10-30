/**
 * Voice wave: three lines, one per voice band, drawn in a 100×24 SVG box.
 * Shared by the voice message bubble and the recording bar.
 */

// Low, mid and high band: each line's origin slides inside its span (0–100) with the band's pitch.
export const AUDIO_WAVE_LINES = [
    { cycles: 1.2, opacity: 0.75, span: [5, 35], speed: 0.08 },
    { cycles: 1.8, opacity: 0.45, span: [35, 65], speed: 0.11 },
    { cycles: 2.5, opacity: 0.3, span: [65, 95], speed: 0.15 }
];
export const AUDIO_WAVE_IDLE = 1;
const WAVE_MAX = 10;
const WAVE_BANDS_HZ = [[80, 500], [500, 2000], [2000, 6000]];

export function audioWaveRestCentre(index) {
    const [from, to] = AUDIO_WAVE_LINES[index].span;
    return (from + to) / 2;
}

export function audioWavePath(index, amplitude, phase, centre = audioWaveRestCentre(index)) {
    const { cycles } = AUDIO_WAVE_LINES[index];
    const reach = 70;
    let d = '';
    for (let x = 0; x <= 100; x += 2) {
        const fromCentre = Math.min(1, Math.abs(x - centre) / reach);
        const edge = Math.sin(Math.PI * x / 100);
        const taper = Math.cos(fromCentre * Math.PI / 2) * edge;
        const y = 12 + amplitude * taper * Math.sin(2 * Math.PI * cycles * fromCentre - phase);
        d += `${x === 0 ? 'M' : 'L'}${x} ${y.toFixed(2)}`;
    }
    return d;
}

export function audioWaveSvg(cls) {
    const lines = AUDIO_WAVE_LINES.map((line, i) =>
        `<path class="audio-wave-line" d="${audioWavePath(i, AUDIO_WAVE_IDLE, 0)}" stroke="currentColor" stroke-opacity="${line.opacity}" stroke-width="1.5" fill="none" stroke-linecap="round" vector-effect="non-scaling-stroke"/>`
    ).join('');
    return `<svg class="audio-wave ${cls}" viewBox="0 0 100 24" preserveAspectRatio="none" aria-hidden="true">${lines}</svg>`;
}

// Per band: energy (0–1) and where in the band it sits (0 = bottom edge, 1 = top edge).
export function readVoiceBands(analyser, bins) {
    if (!analyser || !bins) return WAVE_BANDS_HZ.map(() => ({ level: 0, pitch: 0.5 }));
    analyser.getByteFrequencyData(bins);
    const hzPerBin = analyser.context.sampleRate / analyser.fftSize;
    return WAVE_BANDS_HZ.map(([lo, hi]) => {
        const from = Math.max(1, Math.floor(lo / hzPerBin));
        const to = Math.min(bins.length - 1, Math.ceil(hi / hzPerBin));
        let sum = 0;
        let weighted = 0;
        for (let b = from; b <= to; b++) {
            sum += bins[b];
            weighted += bins[b] * (b - from);
        }
        return {
            level: sum / ((to - from + 1) * 255),
            pitch: sum > 0 ? weighted / sum / Math.max(1, to - from) : 0.5
        };
    });
}

export class WaveMotion {
    constructor() {
        this.reset();
    }

    reset() {
        this.levels = [0, 0, 0];
        this.phases = [0, 0, 0];
        this.centres = AUDIO_WAVE_LINES.map((_, i) => audioWaveRestCentre(i));
    }

    step(readings) {
        readings.forEach(({ level, pitch }, i) => {
            const { span: [from, to], speed } = AUDIO_WAVE_LINES[i];
            this.levels[i] += (level - this.levels[i]) * 0.35;
            this.centres[i] += (from + (to - from) * pitch - this.centres[i]) * 0.15;
            this.phases[i] += speed * (1 + this.levels[i] * 2);
        });
    }

    paint(root, { idle = false } = {}) {
        root?.querySelectorAll('.audio-wave-line').forEach((path, i) => {
            const amplitude = idle ? AUDIO_WAVE_IDLE : AUDIO_WAVE_IDLE + this.levels[i] * WAVE_MAX;
            path.setAttribute('d', audioWavePath(i, amplitude, this.phases[i], this.centres[i]));
        });
    }
}

export function createVoiceAnalyser(ctx) {
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 512;
    analyser.smoothingTimeConstant = 0.6;
    return { analyser, bins: new Uint8Array(analyser.frequencyBinCount) };
}
