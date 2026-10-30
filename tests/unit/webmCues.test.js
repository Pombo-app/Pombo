/**
 * The MediaRecorder WebM rewrite: known sizes, Duration and Cues that point at clusters.
 */

import { describe, it, expect } from 'vitest';
import { addWebmCues } from '../../src/js/webmCues.js';

const UNKNOWN = [0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff];
const el = (id, payload) => [...id, 0x80 | payload.length, ...payload];

// Shaped like Chrome's: unknown-size Segment and Clusters, no Duration, no Cues.
function streamed(clusterCount, spacingMs) {
    const header = el([0x1a, 0x45, 0xdf, 0xa3], el([0x42, 0x82], [0x77, 0x65, 0x62, 0x6d]));
    const info = el([0x15, 0x49, 0xa9, 0x66], el([0x2a, 0xd7, 0xb1], [0x0f, 0x42, 0x40]));
    const tracks = el([0x16, 0x54, 0xae, 0x6b], el([0xae], el([0xd7], [1])));
    const clusters = [];
    for (let i = 0; i < clusterCount; i++) {
        const tc = i * spacingMs;
        clusters.push(0x1f, 0x43, 0xb6, 0x75, ...UNKNOWN,
            ...el([0xe7], [tc >> 8, tc & 0xff]),
            ...el([0xa3], [0x81, 0, 0, 0x80, i, i, i]),
            ...el([0xa3], [0x81, 0, 60, 0x80, i, i, i]));
    }
    return new Uint8Array([...header, 0x18, 0x53, 0x80, 0x67, ...UNKNOWN, ...info, ...tracks, ...clusters]);
}

function vint(bytes, pos, keepMarker) {
    let len = 1;
    while (!(bytes[pos] & (0x80 >> (len - 1)))) len++;
    let v = keepMarker ? bytes[pos] : bytes[pos] & ((0x80 >> (len - 1)) - 1);
    for (let i = 1; i < len; i++) v = v * 256 + bytes[pos + i];
    return { v, len };
}

function parse(bytes, start, end) {
    const out = [];
    for (let pos = start; pos < end;) {
        const id = vint(bytes, pos, true);
        const size = vint(bytes, pos + id.len, false);
        const dataStart = pos + id.len + size.len;
        out.push({ id: id.v, start: pos, dataStart, end: dataStart + size.v });
        pos = dataStart + size.v;
    }
    return out;
}

const uint = (bytes, e) => bytes.subarray(e.dataStart, e.end).reduce((n, b) => n * 256 + b, 0);

describe('addWebmCues', () => {
    it('gives the Segment and every Cluster a known size and keeps every block', () => {
        const input = streamed(4, 300);
        const out = addWebmCues(input, 1200);
        const [, segment] = parse(out, 0, out.length);
        expect(segment.id).toBe(0x18538067);
        expect(segment.end).toBe(out.length);
        const clusters = parse(out, segment.dataStart, segment.end).filter(e => e.id === 0x1f43b675);
        expect(clusters).toHaveLength(4);
        const blocks = clusters.flatMap(c => parse(out, c.dataStart, c.end)).filter(e => e.id === 0xa3);
        expect(blocks).toHaveLength(8);
    });

    it('writes the Duration in timecode-scale units', () => {
        const out = addWebmCues(streamed(2, 300), 4980);
        const [, segment] = parse(out, 0, out.length);
        const info = parse(out, segment.dataStart, segment.end).find(e => e.id === 0x1549a966);
        const duration = parse(out, info.dataStart, info.end).find(e => e.id === 0x4489);
        expect(new DataView(out.buffer, duration.dataStart, 8).getFloat64(0)).toBe(4980);
    });

    it('puts Cues before the first Cluster, at most one a second, each pointing at its Cluster', () => {
        const out = addWebmCues(streamed(10, 300), 3000);
        const [, segment] = parse(out, 0, out.length);
        const top = parse(out, segment.dataStart, segment.end);
        const cuesIndex = top.findIndex(e => e.id === 0x1c53bb6b);
        expect(cuesIndex).toBeLessThan(top.findIndex(e => e.id === 0x1f43b675));
        const points = parse(out, top[cuesIndex].dataStart, top[cuesIndex].end);
        const cues = points.map(p => {
            const [time, positions] = parse(out, p.dataStart, p.end);
            const [track, position] = parse(out, positions.dataStart, positions.end);
            return { time: uint(out, time), track: uint(out, track), position: uint(out, position) };
        });
        expect(cues.map(c => c.time)).toEqual([0, 1200, 2400]);
        for (const cue of cues) {
            expect(cue.track).toBe(1);
            const cluster = parse(out, segment.dataStart + cue.position, segment.end)[0];
            expect(cluster.id).toBe(0x1f43b675);
            const timecode = parse(out, cluster.dataStart, cluster.end).find(e => e.id === 0xe7);
            expect(uint(out, timecode)).toBe(cue.time);
        }
    });

    it('leaves alone a file that already has Cues or a Duration, or is not WebM', () => {
        const once = addWebmCues(streamed(3, 300), 900);
        expect(addWebmCues(once, 900)).toBeNull();
        expect(addWebmCues(new Uint8Array([0, 0, 0, 0x20, 0x66, 0x74, 0x79, 0x70]), 900)).toBeNull();
        expect(addWebmCues(streamed(3, 300).subarray(0, 60), 900)).toBeNull();
        expect(addWebmCues(streamed(3, 300), 0)).toBeNull();
    });
});
