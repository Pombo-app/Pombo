/**
 * Tests for storageMedia.js — Persistent File Sharing engine (pure helpers)
 * and the storage chunk partition mapping in streamConstants.js.
 */

import { describe, it, expect, vi } from 'vitest';

// Mock the heavy app modules the engine imports — only the pure helpers are
// under test here; the controller paths need a live network.
vi.mock('../../src/js/logger.js', () => ({
    Logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }
}));
vi.mock('../../src/js/auth.js', () => ({
    authManager: { getAddress: vi.fn(() => '0xTestUser'), wallet: null }
}));
vi.mock('../../src/js/identity.js', () => ({
    identityManager: { generateMessageId: vi.fn(() => 'mock-id'), getTrustLevel: vi.fn(() => Promise.resolve(0)), username: null }
}));
vi.mock('../../src/js/secureStorage.js', () => ({
    secureStorage: { addSentMessage: vi.fn() }
}));
vi.mock('../../src/js/streamr.js', () => ({
    streamrController: { client: null },
    isWebSafeStorageNodeUrl: (u) => typeof u === 'string' && u.startsWith('https://')
}));
vi.mock('../../src/js/storageEndpoints.js', () => ({
    storageEndpoints: {
        resolve: vi.fn(), rotation: vi.fn(() => Promise.resolve([])),
        noteFailure: vi.fn(), noteSuccess: vi.fn(),
        supportsMetaFormat: vi.fn(), setMetaFormatSupport: vi.fn()
    }
}));
vi.mock('../../src/js/channels.js', () => ({
    channelManager: { getChannel: vi.fn(), notifyHandlers: vi.fn() }
}));
vi.mock('../../src/js/dm.js', () => ({
    dmManager: { getPeerPublicKey: vi.fn() }
}));

import {
    packChunkPayload,
    unpackChunkPayload,
    hexToU8,
    mergeWindows,
    chunkWindowsFor,
    buildMissingWindows,
    partitionOfChunk,
    makeFaststartSource
} from '../../src/js/storageMedia.js';
import { STORAGE_FILE, MESSAGE_STREAM, storageChunkPartition } from '../../src/js/streamConstants.js';

describe('stream constants (storage file layout)', () => {
    it('regular channels have 12 partitions, DM inboxes 13', () => {
        expect(MESSAGE_STREAM.PARTITIONS).toBe(12);
        expect(MESSAGE_STREAM.DM_PARTITIONS).toBe(13);
    });

    it('chunk layout fits inside the stream partition counts', () => {
        expect(STORAGE_FILE.FIRST_CHUNK_PARTITION + STORAGE_FILE.CHUNK_PARTITIONS).toBe(MESSAGE_STREAM.PARTITIONS);
        expect(STORAGE_FILE.DM_FIRST_CHUNK_PARTITION + STORAGE_FILE.CHUNK_PARTITIONS).toBe(MESSAGE_STREAM.DM_PARTITIONS);
    });

    it('maps chunk i to first + (i % 9)', () => {
        expect(storageChunkPartition(0, 2)).toBe(2);
        expect(storageChunkPartition(8, 2)).toBe(10);
        expect(storageChunkPartition(9, 2)).toBe(2);
        expect(storageChunkPartition(0, 4)).toBe(4);
        expect(storageChunkPartition(12, 4)).toBe(4 + (12 % 9));
    });

    it('never maps a chunk onto the message/control/moderation partitions', () => {
        for (let i = 0; i < 100; i++) {
            expect(storageChunkPartition(i, STORAGE_FILE.FIRST_CHUNK_PARTITION)).toBeGreaterThanOrEqual(3);
            expect(storageChunkPartition(i, STORAGE_FILE.FIRST_CHUNK_PARTITION)).toBeLessThan(12);
            expect(storageChunkPartition(i, STORAGE_FILE.DM_FIRST_CHUNK_PARTITION)).toBeGreaterThanOrEqual(4);
            expect(storageChunkPartition(i, STORAGE_FILE.DM_FIRST_CHUNK_PARTITION)).toBeLessThan(13);
        }
    });
});

describe('packChunkPayload / unpackChunkPayload', () => {
    const meta = {
        type: 'binary_file_chunked', version: 2,
        fileName: 'x.bin', fileType: 'application/octet-stream',
        originalSize: 1000, compressedSize: 900,
        compression: 'none', transferId: 'ab'.repeat(16), timestamp: 1753200000000
    };
    const metaBytes = new TextEncoder().encode(JSON.stringify(meta));

    it('round-trips a payload byte-for-byte', () => {
        const data = new Uint8Array([1, 2, 3, 250, 251, 252]);
        const packed = packChunkPayload(metaBytes, 42, 7, data);
        const u = unpackChunkPayload(packed);
        expect(u).not.toBeNull();
        expect(u.meta).toEqual(meta);
        expect(u.totalChunks).toBe(42);
        expect(u.chunkIndex).toBe(7);
        expect(u.chunkData).toEqual(data);
    });

    it('uses big-endian 32-bit fields (POC wire format)', () => {
        const packed = packChunkPayload(metaBytes, 0x01020304, 0x0a0b0c0d, new Uint8Array(0));
        const v = new DataView(packed.buffer);
        expect(v.getUint32(0, false)).toBe(metaBytes.length);
        expect(v.getUint32(4 + metaBytes.length, false)).toBe(0x01020304);
        expect(v.getUint32(4 + metaBytes.length + 4, false)).toBe(0x0a0b0c0d);
    });

    it('rejects warm-up pings and garbage', () => {
        expect(unpackChunkPayload(new Uint8Array([0]))).toBeNull();
        expect(unpackChunkPayload(new Uint8Array(0))).toBeNull();
        expect(unpackChunkPayload(new Uint8Array(64).fill(255))).toBeNull();
    });

    it('rejects other message types', () => {
        const other = new TextEncoder().encode(JSON.stringify({ type: 'binary_file_poc' }));
        const packed = packChunkPayload(other, 1, 0, new Uint8Array([1]));
        expect(unpackChunkPayload(packed)).toBeNull();
    });

    it('handles empty chunk data', () => {
        const u = unpackChunkPayload(packChunkPayload(metaBytes, 1, 0, new Uint8Array(0)));
        expect(u.chunkData.length).toBe(0);
    });
});

describe('hexToU8', () => {
    it('decodes lowercase and uppercase hex', () => {
        expect(hexToU8('00ff10')).toEqual(new Uint8Array([0, 255, 16]));
        expect(hexToU8('DEADBEEF')).toEqual(new Uint8Array([0xde, 0xad, 0xbe, 0xef]));
        expect(hexToU8('DeAdBeEf')).toEqual(new Uint8Array([0xde, 0xad, 0xbe, 0xef]));
    });

    it('handles empty input', () => {
        expect(hexToU8('')).toEqual(new Uint8Array(0));
    });
});

describe('window builders', () => {
    const meta = {
        transferId: 't1',
        totalChunks: 100,
        chunkPartitions: 9,
        firstChunkPartition: 2,
        firstChunkTs: 1000000,
        lastChunkTs: 1099000 // ~1s per chunk
    };

    it('chunkWindowsFor covers exactly the announced partitions', () => {
        const wins = chunkWindowsFor(meta, 10, 20);
        expect(wins).toHaveLength(9);
        expect(wins[0]).toEqual({ partition: 2, from: 10, to: 20 });
        expect(wins[8]).toEqual({ partition: 10, from: 10, to: 20 });
    });

    it('chunkWindowsFor follows the announce, not local constants', () => {
        const dmMeta = { ...meta, firstChunkPartition: 4 };
        const wins = chunkWindowsFor(dmMeta, 0, 1);
        expect(wins[0].partition).toBe(4);
        expect(wins[8].partition).toBe(12);
    });

    it('mergeWindows merges overlapping same-partition windows only', () => {
        const merged = mergeWindows([
            { partition: 2, from: 0, to: 10 },
            { partition: 2, from: 5, to: 20 },
            { partition: 3, from: 0, to: 10 },
            { partition: 2, from: 30, to: 40 }
        ]);
        expect(merged).toEqual([
            { partition: 2, from: 0, to: 20 },
            { partition: 2, from: 30, to: 40 },
            { partition: 3, from: 0, to: 10 }
        ]);
    });

    it('buildMissingWindows estimates narrow windows for few missing chunks', () => {
        const wins = buildMissingWindows(meta, [50], 0, 2000000);
        // one estimated window on chunk 50's partition + a tail window
        const p = partitionOfChunk(meta, 50);
        expect(wins.every(w => w.partition === p)).toBe(true);
        const est = meta.firstChunkTs + 50 * ((meta.lastChunkTs - meta.firstChunkTs) / 99);
        expect(wins[0].from).toBeLessThanOrEqual(est);
        expect(wins[0].to).toBeGreaterThanOrEqual(est);
        // tail window ends at toT
        expect(wins[wins.length - 1].to).toBe(2000000);
    });

    it('buildMissingWindows falls back to full ranges when too much is missing', () => {
        const missing = Array.from({ length: 40 }, (_, i) => i); // >30%
        const wins = buildMissingWindows(meta, missing, 5, 6);
        expect(wins).toHaveLength(9);
        expect(wins[0]).toEqual({ partition: 2, from: 5, to: 6 });
    });

    it('buildMissingWindows falls back without chunk timestamps', () => {
        const noTs = { ...meta, firstChunkTs: null, lastChunkTs: null };
        const wins = buildMissingWindows(noTs, [1], 5, 6);
        expect(wins).toHaveLength(9);
    });
});

describe('makeFaststartSource', () => {
    // Minimal MP4 box builder: [4B size BE][4B type][payload]
    const box = (type, payload) => {
        const out = new Uint8Array(8 + payload.length);
        new DataView(out.buffer).setUint32(0, out.length, false);
        for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
        out.set(payload, 8);
        return out;
    };
    const concat = (...parts) => {
        const total = parts.reduce((s, p) => s + p.length, 0);
        const out = new Uint8Array(total);
        let o = 0; for (const p of parts) { out.set(p, o); o += p.length; }
        return out;
    };
    // stco payload: [4B version+flags][4B entryCount][4B offsets…]
    const stcoPayload = (offsets) => {
        const out = new Uint8Array(8 + offsets.length * 4);
        const v = new DataView(out.buffer);
        v.setUint32(4, offsets.length, false);
        offsets.forEach((off, i) => v.setUint32(8 + i * 4, off, false));
        return out;
    };
    const blobSupported = typeof new Blob([new Uint8Array(1)]).arrayBuffer === 'function';

    it.skipIf(!blobSupported)('moves moov before mdat and patches stco by moov.size', async () => {
        const ftyp = box('ftyp', new Uint8Array([0x69, 0x73, 0x6f, 0x6d, 0, 0, 0, 1]));
        const mdatData = new Uint8Array(32).fill(7);
        const mdat = box('mdat', mdatData);
        const mdatDataStart = ftyp.length + 8; // first media byte
        const stco = box('stco', stcoPayload([mdatDataStart, mdatDataStart + 16]));
        const moov = box('moov', stco);
        const file = new Blob([concat(ftyp, mdat, moov)], { type: 'video/mp4' });

        const res = await makeFaststartSource(file);
        expect(res.changed).toBe(true);
        expect(res.blob.size).toBe(file.size); // boxes reordered, nothing added

        const out = new Uint8Array(await res.blob.arrayBuffer());
        const typeAt = (pos) => String.fromCharCode(out[pos + 4], out[pos + 5], out[pos + 6], out[pos + 7]);
        expect(typeAt(0)).toBe('ftyp');
        expect(typeAt(ftyp.length)).toBe('moov');
        expect(typeAt(ftyp.length + moov.length)).toBe('mdat');

        // stco offsets shifted by moov.size (mdat moved that far right)
        const v = new DataView(out.buffer);
        const stcoEntriesAt = ftyp.length + 8 /*moov hdr*/ + 8 /*stco hdr*/ + 8 /*ver+count*/;
        expect(v.getUint32(stcoEntriesAt, false)).toBe(mdatDataStart + moov.length);
        expect(v.getUint32(stcoEntriesAt + 4, false)).toBe(mdatDataStart + 16 + moov.length);
    });

    it.skipIf(!blobSupported)('leaves an already-faststart file untouched', async () => {
        const ftyp = box('ftyp', new Uint8Array(8));
        const moov = box('moov', box('stco', stcoPayload([100])));
        const mdat = box('mdat', new Uint8Array(16));
        const file = new Blob([concat(ftyp, moov, mdat)], { type: 'video/mp4' });

        const res = await makeFaststartSource(file);
        expect(res.changed).toBe(false);
        expect(res.reason).toMatch(/already faststart/);
        expect(res.blob).toBe(file);
    });

    it.skipIf(!blobSupported)('bails on non-MP4 garbage without throwing', async () => {
        const file = new Blob([new Uint8Array(64).fill(0xab)]);
        const res = await makeFaststartSource(file);
        expect(res.changed).toBe(false);
        expect(res.blob).toBe(file);
    });
});

describe('crypto binary round-trip (per-file key)', () => {
    const subtleIsReal = typeof globalThis.crypto?.subtle?.importKey === 'function'
        && !globalThis.crypto.subtle.importKey.mock;

    it.skipIf(!subtleIsReal)('encryptBinaryWithKey/decryptBinaryWithKey round-trips', async () => {
        const { cryptoManager } = await import('../../src/js/crypto.js');
        const raw = globalThis.crypto.getRandomValues(new Uint8Array(32));
        const key = await globalThis.crypto.subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
        const data = globalThis.crypto.getRandomValues(new Uint8Array(1024));

        const sealed = await cryptoManager.encryptBinaryWithKey(data, key);
        // [12B iv][ct + 16B tag]
        expect(sealed.length).toBe(12 + data.length + 16);
        const opened = await cryptoManager.decryptBinaryWithKey(sealed, key);
        expect(opened).toEqual(data);
    });

    it.skipIf(!subtleIsReal)('sealed chunk payload round-trips through pack/seal/open/unpack', async () => {
        const { cryptoManager } = await import('../../src/js/crypto.js');
        const raw = globalThis.crypto.getRandomValues(new Uint8Array(32));
        const key = await globalThis.crypto.subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);

        const meta = { type: 'binary_file_chunked', version: 2, transferId: 'cd'.repeat(16) };
        const mb = new TextEncoder().encode(JSON.stringify(meta));
        const data = globalThis.crypto.getRandomValues(new Uint8Array(512));
        const packed = packChunkPayload(mb, 3, 1, data);

        const sealed = await cryptoManager.encryptBinaryWithKey(packed, key);
        const u = unpackChunkPayload(await cryptoManager.decryptBinaryWithKey(sealed, key));
        expect(u.meta.transferId).toBe(meta.transferId);
        expect(u.chunkIndex).toBe(1);
        expect(u.chunkData).toEqual(data);
    });

    it.skipIf(!subtleIsReal)('rejects tampered ciphertext (GCM auth)', async () => {
        const { cryptoManager } = await import('../../src/js/crypto.js');
        const raw = globalThis.crypto.getRandomValues(new Uint8Array(32));
        const key = await globalThis.crypto.subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
        const sealed = await cryptoManager.encryptBinaryWithKey(new Uint8Array([1, 2, 3]), key);
        sealed[sealed.length - 1] ^= 0xff;
        await expect(cryptoManager.decryptBinaryWithKey(sealed, key)).rejects.toThrow();
    });
});
