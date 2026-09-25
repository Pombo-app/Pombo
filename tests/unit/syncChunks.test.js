/**
 * Framing for a snapshot too big for one wire message.
 *
 * The failure this guards against is silent on both ends: the network drops an
 * oversized message without telling the publisher, and a reader that accepted a
 * partial run would merge truncated JSON into the account's state.
 */

import { describe, it, expect } from 'vitest';
import { splitSyncPayload, reassembleSyncPayloads, SYNC_CHUNK_CHARS } from '../../src/js/syncChunks.js';

const snapshot = (fill, ts = 1700000000000) => ({
    type: 'sync', v: 1, ts,
    data: { channels: [{ messageStreamId: '0xowner/chan-1', name: fill }] }
});

describe('splitting', () => {
    it('leaves a snapshot that fits as one message', () => {
        const payload = snapshot('small');
        const out = splitSyncPayload(payload, 'run1');
        expect(out).toHaveLength(1);
        expect(out[0]).toBe(payload);
    });

    it('closes a long run with its manifest', () => {
        const payload = snapshot('x'.repeat(1000));
        const out = splitSyncPayload(payload, 'run1', 200);

        expect(out.length).toBeGreaterThan(2);
        expect(out.at(-1)).toMatchObject({ type: 'sync_manifest', syncId: 'run1' });
        expect(out.at(-1).chunkCount).toBe(out.length - 1);
        expect(out.slice(0, -1).every(m => m.type === 'sync_chunk')).toBe(true);
    });

    it('numbers the chunks from zero and carries the payload timestamp', () => {
        const out = splitSyncPayload(snapshot('y'.repeat(900), 42), 'run1', 200);
        const chunks = out.filter(m => m.type === 'sync_chunk');
        expect(chunks.map(c => c.chunkIndex)).toEqual(chunks.map((_, i) => i));
        expect(out.every(m => m.ts === 42)).toBe(true);
    });

    it('never cuts an emoji in half, which a UTF-8 encoder would turn into ?', () => {
        const payload = snapshot('🐦'.repeat(3000));
        const out = splitSyncPayload(payload, 'run1', 301);
        for (const chunk of out.filter(m => m.type === 'sync_chunk')) {
            expect(chunk.data).toBe(chunk.data.toWellFormed());
        }
        expect(reassembleSyncPayloads(out)[0]).toEqual(payload);
    });

    it('never puts more than the budget in one message', () => {
        const out = splitSyncPayload(snapshot('z'.repeat(5000)), 'run1', 300);
        for (const chunk of out.filter(m => m.type === 'sync_chunk')) {
            expect(chunk.data.length).toBeLessThanOrEqual(300);
        }
    });
});

describe('reassembling', () => {
    it('rebuilds the snapshot byte for byte', () => {
        const payload = snapshot('w'.repeat(2000));
        const out = reassembleSyncPayloads(splitSyncPayload(payload, 'run1', 250));
        expect(out).toHaveLength(1);
        expect(out[0]).toEqual(payload);
    });

    it('does not care what order the run arrives in', () => {
        const payload = snapshot('q'.repeat(2000));
        const shuffled = [...splitSyncPayload(payload, 'run1', 250)].reverse();
        expect(reassembleSyncPayloads(shuffled)[0]).toEqual(payload);
    });

    it('keeps whole snapshots and runs apart in the same window', () => {
        const small = snapshot('small', 1);
        const big = snapshot('b'.repeat(2000), 2);
        const window = [...splitSyncPayload(big, 'run1', 250), small];
        const out = reassembleSyncPayloads(window);
        expect(out.map(p => p.ts).sort()).toEqual([1, 2]);
    });

    it('separates two runs that overlap in the window', () => {
        const a = snapshot('a'.repeat(2000), 1);
        const b = snapshot('b'.repeat(2000), 2);
        const mixed = [...splitSyncPayload(a, 'runA', 250), ...splitSyncPayload(b, 'runB', 250)];
        const out = reassembleSyncPayloads(mixed);
        expect(out).toHaveLength(2);
        expect(out.find(p => p.ts === 1)).toEqual(a);
        expect(out.find(p => p.ts === 2)).toEqual(b);
    });

    it('drops a run whose head fell out of the window', () => {
        const payload = snapshot('p'.repeat(2000));
        const run = splitSyncPayload(payload, 'run1', 250);
        const dropped = [];
        const out = reassembleSyncPayloads(run.slice(1), d => dropped.push(d));
        expect(out).toHaveLength(0);
        expect(dropped[0]).toMatchObject({ syncId: 'run1', reason: 'incomplete' });
    });

    it('drops a run with no manifest rather than guessing it is complete', () => {
        const run = splitSyncPayload(snapshot('m'.repeat(2000)), 'run1', 250);
        expect(reassembleSyncPayloads(run.filter(m => m.type !== 'sync_manifest'))).toHaveLength(0);
    });

    it('drops a run whose chunks do not form JSON', () => {
        const dropped = [];
        const out = reassembleSyncPayloads([
            { type: 'sync_chunk', v: 1, ts: 1, syncId: 'run1', chunkIndex: 0, chunkCount: 1, data: '{oops' },
            { type: 'sync_manifest', v: 1, ts: 1, syncId: 'run1', chunkCount: 1 }
        ], d => dropped.push(d));
        expect(out).toHaveLength(0);
        expect(dropped[0]).toMatchObject({ reason: 'unparseable' });
    });

    it('ignores anything that is not this protocol version', () => {
        expect(reassembleSyncPayloads([
            { type: 'sync', v: 2, ts: 1 },
            { type: 'presence', v: 1 },
            null
        ])).toHaveLength(0);
    });
});

describe('the budget', () => {
    it('is the measured one — a 150 KB slice reaches the wire near 227 KB', () => {
        expect(SYNC_CHUNK_CHARS).toBe(150 * 1024);
    });
});
