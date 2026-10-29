/**
 * Tests for storageMedia.js downloadFile — the read path that rebuilds a
 * storage-shared file from the chunk partitions, plus the pause, resume and
 * cancel controls around it. Chunks are staged as the wire format the uploader
 * writes, so what is under test is the real reassembly, not a paraphrase of it.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const H = vi.hoisted(() => ({
    rows: [],               // what the storage nodes hand back
    channel: null,
    accountAddress: '0xme',
    bases: [],
    onFetch: null,          // called with each served window
    streamBody: true,       // browsers always hand back a readable body
    resendCalls: []
}));

vi.mock('../../src/js/logger.js', () => ({
    Logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }
}));
vi.mock('../../src/js/auth.js', () => ({
    authManager: { getAddress: vi.fn(() => H.accountAddress), wallet: { privateKey: '0xprivkey' } }
}));
vi.mock('../../src/js/identity.js', () => ({
    identityManager: {
        username: 'tester',
        generateMessageId: vi.fn(() => 'msg-1'),
        getTrustLevel: vi.fn(async () => 0),
        createStorageFileManifest: vi.fn()
    }
}));
vi.mock('../../src/js/secureStorage.js', () => ({ secureStorage: { addSentMessage: vi.fn() } }));
vi.mock('../../src/js/storageEndpoints.js', () => ({
    storageEndpoints: {
        resolve: vi.fn(),
        rotation: vi.fn(async () => H.bases),
        noteFailure: vi.fn(), noteSuccess: vi.fn(),
        supportsMetaFormat: vi.fn(() => false),
        setMetaFormatSupport: vi.fn()
    }
}));
vi.mock('../../src/js/streamr.js', () => ({
    isWebSafeStorageNodeUrl: () => true,
    streamrController: {
        client: null,
        getDMInboxId: vi.fn((addr) => `${addr}/dm-inbox`),
        publishStorageChunk: vi.fn(async () => ({ timestamp: 1 })),
        publishMessage: vi.fn(async () => ({ timestamp: 1 }))
    }
}));
vi.mock('../../src/js/channels.js', () => ({
    channelManager: {
        getChannel: vi.fn(() => H.channel),
        notifyHandlers: vi.fn(),
        usesAccountPublish: vi.fn(() => false)
    }
}));
vi.mock('../../src/js/channelIdentity.js', () => ({
    getChannelIdentity: vi.fn(() => ({ identity: { getUserId: async () => '0xephemeral' } }))
}));
vi.mock('../../src/js/dm.js', () => ({
    dmManager: { getPeerPublicKey: vi.fn(async () => '0xpeerpub'), sealAndPublish: vi.fn() }
}));
vi.mock('../../src/js/dmCrypto.js', () => ({
    dmCrypto: {
        generateEphemeralPrivateKey: vi.fn(() => '0xthrowaway'),
        getSharedKey: vi.fn(async () => 'dm-key'),
        encryptBinary: vi.fn(async (b) => wrap('DM', b)),
        decryptBinary: vi.fn(async (b) => unwrap('DM', b))
    }
}));
vi.mock('../../src/js/crypto.js', () => ({
    cryptoManager: {
        generateSalt: vi.fn(() => new Uint8Array([1, 2, 3, 4])),
        base64ToArrayBuffer: vi.fn(() => new Uint8Array([1, 2, 3, 4])),
        arrayBufferToBase64: vi.fn(() => 'c2FsdA=='),
        deriveKey: vi.fn(async () => 'pw-key'),
        encryptBinaryWithKey: vi.fn(async (b) => wrap('PW', b)),
        decryptBinaryWithKey: vi.fn(async (b) => unwrap('PW', b))
    }
}));
vi.mock('../../src/js/epochKeyManager.js', () => ({
    usesEpochKeys: vi.fn(() => false),
    epochKeyManager: {
        getCurrentKey: vi.fn(async () => ({ cryptoKey: 'epoch-key', kid: 'kid-1' })),
        ensureChannelKeys: vi.fn(async () => {}),
        ensurePublishKey: vi.fn(async () => ({ address: '0xpublishkey' })),
        getKeyForKid: vi.fn(async () => 'epoch-key'),
        noteMissingKid: vi.fn()
    }
}));
vi.mock('../../src/js/epochKeyCrypto.js', () => ({
    epochKeyCrypto: {
        sealBinaryWithEpochKey: vi.fn(async (b) => wrap('EP', b)),
        parseBinaryEpochEnvelope: vi.fn(() => ({ kid: 'kid-1' })),
        decryptBinaryWithEpochKey: vi.fn(async () => new Uint8Array())
    }
}));

function wrap(tag, bytes) {
    const out = new Uint8Array(bytes.length + 2);
    out[0] = tag.charCodeAt(0); out[1] = tag.charCodeAt(1);
    out.set(bytes, 2);
    return out;
}
function unwrap(tag, bytes) {
    if (bytes[0] !== tag.charCodeAt(0) || bytes[1] !== tag.charCodeAt(1)) throw new Error('not for us');
    return bytes.subarray(2);
}

import { storageMediaController, packChunkPayload } from '../../src/js/storageMedia.js';
import { STORAGE_FILE } from '../../src/js/streamConstants.js';
import { CONFIG } from '../../src/js/config.js';
import { streamrController } from '../../src/js/streamr.js';

const SID = '0xowner/channel-1';
const NODE = 'https://node-a.example';
const SM = CONFIG.storageMedia;
const T0 = 1700000000000;
const CHUNK = 512;

let cfgSnapshot;

function bytesOfSize(n, seed = 7) {
    const data = new Uint8Array(n);
    for (let i = 0; i < n; i++) data[i] = (i * seed + seed) % 251;
    return data;
}
function toHex(u8) {
    return Array.from(u8, b => b.toString(16).padStart(2, '0')).join('');
}
async function deflate(bytes) {
    const cs = new CompressionStream('deflate');
    const writer = cs.writable.getWriter();
    writer.write(bytes);
    writer.close();
    const parts = [];
    const reader = cs.readable.getReader();
    for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value && value.length) parts.push(value);
    }
    const total = parts.reduce((s, p) => s + p.length, 0);
    const out = new Uint8Array(total);
    let o = 0;
    for (const p of parts) { out.set(p, o); o += p.length; }
    return out;
}

/**
 * Stages a transfer the way sendFile would leave it: chunk rows on the storage
 * nodes plus the announce that describes them.
 */
function stage(wireBytes, opts = {}) {
    const {
        tid = 'tid-1',
        compression = 'none',
        originalSize = wireBytes.length,
        fileName = 'doc.bin',
        fileType = 'application/octet-stream',
        chunkSize = CHUNK,
        firstChunkPartition = STORAGE_FILE.FIRST_CHUNK_PARTITION,
        seal = null,
        publisher = '0xsender',
        skip = []
    } = opts;
    const total = Math.max(1, Math.ceil(wireBytes.length / chunkSize));
    const chunkMeta = {
        type: 'binary_file_chunked', version: 2, fileName, fileType,
        originalSize, compressedSize: wireBytes.length, compression,
        transferId: tid, timestamp: T0
    };
    const mb = new TextEncoder().encode(JSON.stringify(chunkMeta));
    const rows = [];
    for (let i = 0; i < total; i++) {
        if (skip.includes(i)) continue;
        const data = wireBytes.subarray(i * chunkSize, Math.min(wireBytes.length, (i + 1) * chunkSize));
        let payload = packChunkPayload(mb, total, i, data);
        if (seal) payload = seal(payload, i);
        rows.push({
            partition: firstChunkPartition + (i % STORAGE_FILE.CHUNK_PARTITIONS),
            timestamp: T0 + i, publisherId: publisher, payload
        });
    }
    const metadata = {
        transferId: tid, fileName, fileType, originalSize,
        compressedSize: wireBytes.length, compression,
        totalChunks: total, chunkDataSize: chunkSize,
        chunkPartitions: STORAGE_FILE.CHUNK_PARTITIONS, firstChunkPartition,
        firstChunkTs: T0, lastChunkTs: T0 + total, storedChunks: total - skip.length,
        encSalt: null
    };
    const announce = {
        type: 'storage_file_announce', v: 1, id: 'ann-1', sender: '0xsender',
        timestamp: T0 + total + 10, channelId: SID, metadata, signature: '0xsig'
    };
    return { rows, metadata, announce, total };
}

/**
 * A browser fetch always exposes a body, so the engine reads it with its own
 * top-level-array scanner. Chunk sizes here are deliberately unaligned with
 * the JSON objects so the scanner has to carry state across reads.
 */
function streamingResponse(json) {
    const bytes = new TextEncoder().encode(JSON.stringify(json));
    let pos = 0;
    return {
        ok: true, status: 200,
        body: {
            getReader: () => ({
                read: async () => {
                    if (pos >= bytes.length) return { done: true, value: undefined };
                    const end = Math.min(pos + 37, bytes.length);
                    const value = bytes.slice(pos, end);
                    pos = end;
                    return { done: false, value };
                }
            })
        },
        json: async () => json
    };
}

function rowsIn(partition, from, to) {
    return H.rows.filter(r => r.partition === partition && r.timestamp >= from && r.timestamp <= to);
}

function makeSub(rows) {
    return {
        [Symbol.asyncIterator]() {
            let i = 0;
            return {
                next: async () => (i < rows.length
                    ? { done: false, value: { content: rows[i], timestamp: rows[i++].timestamp, publisherId: rows[i - 1].publisherId } }
                    : { done: true, value: undefined })
            };
        }
    };
}

beforeEach(() => {
    cfgSnapshot = { ...SM };
    Object.assign(SM, { downloadRetryPasses: 1, downloadConcurrencyDesktop: 5 });
    H.rows = [];
    H.channel = { messageStreamId: SID, type: 'public', messages: [] };
    H.bases = [NODE];
    H.onFetch = null;
    H.streamBody = true;
    H.resendCalls = [];
    streamrController.client = null;
    localStorage.clear();
    storageMediaController.clear();

    globalThis.fetch = vi.fn(async (url) => {
        const u = new URL(url);
        const m = u.pathname.match(/partitions\/(\d+)\/range/);
        const partition = m ? Number(m[1]) : -1;
        const from = Number(u.searchParams.get('fromTimestamp'));
        const to = Number(u.searchParams.get('toTimestamp'));
        const rows = rowsIn(partition, from, to);
        if (H.onFetch) await H.onFetch(partition, rows);
        const json = rows.map(r => ({
            timestamp: r.timestamp, publisherId: r.publisherId,
            contentType: 1, content: toHex(r.payload)
        }));
        return H.streamBody
            ? streamingResponse(json)
            : { ok: true, status: 200, json: async () => json };
    });
});

afterEach(() => {
    Object.assign(SM, cfgSnapshot);
    storageMediaController.onFileComplete(null);
    storageMediaController.onFileError(null);
    storageMediaController.onFileProgress(null);
});

async function blobBytes(blob) {
    return new Uint8Array(await blob.arrayBuffer());
}

describe('downloadFile — guards', () => {
    it('refuses an announce with no transfer to read', async () => {
        await expect(storageMediaController.downloadFile(SID, { metadata: {} }))
            .rejects.toThrow('Invalid storage file announce');
        await expect(storageMediaController.downloadFile(SID, { metadata: { transferId: 't' } }))
            .rejects.toThrow('Invalid storage file announce');
        expect(globalThis.fetch).not.toHaveBeenCalled();
    });

    it('ignores a second request while the first is still running', async () => {
        const { rows, announce } = stage(bytesOfSize(4096));
        H.rows = rows;
        let second = null, firstTransfer = null;
        H.onFetch = async () => {
            if (second) return;
            firstTransfer = storageMediaController.downloads.get('tid-1');
            second = storageMediaController.downloadFile(SID, announce);
        };
        await storageMediaController.downloadFile(SID, announce);
        await expect(second).resolves.toBeUndefined();

        const transfer = storageMediaController.downloads.get('tid-1');
        expect(transfer).toBe(firstTransfer);            // no second run took over
        expect(transfer.status).toBe('complete');
        expect(globalThis.fetch).toHaveBeenCalledTimes(STORAGE_FILE.CHUNK_PARTITIONS);
    });

    it('ignores a request for a file already in the session cache', async () => {
        const { rows, announce } = stage(bytesOfSize(2048));
        H.rows = rows;
        await storageMediaController.downloadFile(SID, announce);
        globalThis.fetch.mockClear();
        await storageMediaController.downloadFile(SID, announce);
        expect(globalThis.fetch).not.toHaveBeenCalled();
    });
});

describe('downloadFile — reassembly', () => {
    it('rebuilds the file from the chunk partitions and publishes the blob', async () => {
        const data = bytesOfSize(4096);
        const { rows, announce, total } = stage(data);
        H.rows = rows;
        const onComplete = vi.fn();
        storageMediaController.onFileComplete(onComplete);

        await storageMediaController.downloadFile(SID, announce);

        const transfer = storageMediaController.downloads.get('tid-1');
        expect(transfer.status).toBe('complete');
        expect(transfer.chunks.size).toBe(total);
        expect(onComplete).toHaveBeenCalledTimes(1);
        const [tid, meta, url, blob] = onComplete.mock.calls[0];
        expect(tid).toBe('tid-1');
        expect(meta.fileName).toBe('doc.bin');
        expect(url).toBe(storageMediaController.getFileUrl('tid-1'));
        expect(await blobBytes(blob)).toEqual(data);
    });

    it('reads a node that answers without a streamable body', async () => {
        H.streamBody = false;
        const data = bytesOfSize(2048);
        const { rows, announce } = stage(data);
        H.rows = rows;
        const onComplete = vi.fn();
        storageMediaController.onFileComplete(onComplete);

        await storageMediaController.downloadFile(SID, announce);

        expect(await blobBytes(onComplete.mock.calls[0][3])).toEqual(data);
    });

    it('inflates a deflate transfer back to the original bytes', async () => {
        const data = bytesOfSize(6000);
        const wire = await deflate(data);
        const { rows, announce } = stage(wire, { compression: 'deflate', originalSize: data.length });
        H.rows = rows;
        const onComplete = vi.fn();
        storageMediaController.onFileComplete(onComplete);

        await storageMediaController.downloadFile(SID, announce);

        const blob = onComplete.mock.calls[0][3];
        expect(await blobBytes(blob)).toEqual(data);
    });

    it('opens sealed chunks and skips the ones that are not ours', async () => {
        const data = bytesOfSize(2048);
        const { rows, announce } = stage(data, { seal: (p) => wrap('PW', p) });
        H.rows = [
            ...rows,
            // A neighbour's sealed chunk on the same partition: it must not
            // poison the assembly.
            { partition: STORAGE_FILE.FIRST_CHUNK_PARTITION, timestamp: T0 + 900, publisherId: '0xother', payload: wrap('XX', new Uint8Array([9, 9, 9])) }
        ];
        const onComplete = vi.fn();
        storageMediaController.onFileComplete(onComplete);

        await storageMediaController.downloadFile(SID, announce, 'hunter2');

        expect(await blobBytes(onComplete.mock.calls[0][3])).toEqual(data);
    });

    it('drops warm-up pings, other transfers, duplicates and out-of-range indices', async () => {
        const data = bytesOfSize(2048);
        const { rows, announce, total } = stage(data);
        // Another transfer's chunks sit FIRST on the same partitions: whoever
        // reads them as ours wins the index and corrupts the file.
        const foreign = stage(bytesOfSize(2048, 13), { tid: 'other-tid' }).rows
            .map(r => ({ ...r, timestamp: r.timestamp - 100 }));
        const overflow = stage(bytesOfSize(4096)).rows[6]; // index 6 of a longer run
        H.rows = [
            ...foreign,
            ...rows,
            ...rows,                                                   // duplicates
            { ...overflow, timestamp: T0 + 800 },                      // index >= totalChunks
            { partition: STORAGE_FILE.FIRST_CHUNK_PARTITION, timestamp: T0 + 801, publisherId: '0xme', payload: new Uint8Array([0]) } // warm-up ping
        ];
        const onComplete = vi.fn();
        storageMediaController.onFileComplete(onComplete);

        await storageMediaController.downloadFile(SID, announce);

        const transfer = storageMediaController.downloads.get('tid-1');
        expect(transfer.chunks.size).toBe(total);
        expect(transfer.bytesReceived).toBe(data.length);
        expect(await blobBytes(onComplete.mock.calls[0][3])).toEqual(data);
    });

    it('reads a DM transfer from my own inbox over SDK resend, never over HTTP', async () => {
        H.channel = { messageStreamId: SID, type: 'dm', peerAddress: '0xpeer', messages: [] };
        const data = bytesOfSize(2048);
        const { rows, announce } = stage(data, { seal: (p) => wrap('DM', p) });
        H.rows = rows;
        streamrController.client = {
            resend: vi.fn(async ({ streamId, partition }, range) => {
                H.resendCalls.push({ streamId, partition });
                return makeSub(rowsIn(partition, range.from.timestamp, range.to.timestamp).map(r => r.payload));
            })
        };
        const onComplete = vi.fn();
        storageMediaController.onFileComplete(onComplete);

        await storageMediaController.downloadFile(SID, announce);

        expect(globalThis.fetch).not.toHaveBeenCalled();
        expect(H.resendCalls.length).toBeGreaterThan(0);
        for (const c of H.resendCalls) expect(c.streamId).toBe(`${H.accountAddress}/dm-inbox`);
        expect(await blobBytes(onComplete.mock.calls[0][3])).toEqual(data);
    });
});

describe('downloadFile — incomplete', () => {
    it('recovers a chunk that only reaches the nodes during the retry pass', async () => {
        const data = bytesOfSize(4096);
        const full = stage(data);
        const { announce, total } = full;
        H.rows = full.rows.filter(r => r.timestamp !== T0 + 3);   // chunk 3 is late
        const onComplete = vi.fn();
        storageMediaController.onFileComplete(onComplete);
        let firstPassDone = 0;
        H.onFetch = async () => {
            if (++firstPassDone === STORAGE_FILE.CHUNK_PARTITIONS) H.rows = full.rows;
        };

        await storageMediaController.downloadFile(SID, announce);

        const transfer = storageMediaController.downloads.get('tid-1');
        expect(transfer.status).toBe('complete');
        expect(transfer.chunks.size).toBe(total);
        expect(await blobBytes(onComplete.mock.calls[0][3])).toEqual(data);
    }, 20000);


    it('retries the missing windows and then reports the transfer as incomplete', async () => {
        const data = bytesOfSize(4096);
        const { rows, announce, total } = stage(data, { skip: [3] });
        H.rows = rows;
        const onError = vi.fn();
        storageMediaController.onFileError(onError);

        await storageMediaController.downloadFile(SID, announce);

        const transfer = storageMediaController.downloads.get('tid-1');
        expect(transfer.status).toBe('error');
        expect(transfer.chunks.size).toBe(total - 1);
        expect(onError).toHaveBeenCalledWith('tid-1', `Incomplete on storage (${total - 1}/${total})`);
        expect(storageMediaController.completedFiles.has('tid-1')).toBe(false);
    }, 20000);
});

describe('downloadFile — pause, resume and cancel', () => {
    // Nine chunks, one per partition, so stopping between windows leaves a
    // provable gap.
    function nineChunks() {
        return stage(bytesOfSize(CHUNK * STORAGE_FILE.CHUNK_PARTITIONS));
    }

    it('pauses between windows without losing what already arrived', async () => {
        const { rows, announce, total } = nineChunks();
        H.rows = rows;
        const onError = vi.fn();
        storageMediaController.onFileError(onError);
        H.onFetch = async () => { storageMediaController.pauseDownload('tid-1'); };

        await storageMediaController.downloadFile(SID, announce);

        const transfer = storageMediaController.downloads.get('tid-1');
        expect(transfer.status).toBe('paused');
        expect(transfer.chunks.size).toBeGreaterThan(0);
        expect(transfer.chunks.size).toBeLessThan(total);
        expect(onError).not.toHaveBeenCalled();
        const progress = storageMediaController.getDownloadProgress('tid-1');
        expect(progress.paused).toBe(true);
        expect(progress.received).toBe(transfer.chunks.size);
    });

    it('resumes a paused transfer and finishes it', async () => {
        const { rows, announce } = nineChunks();
        H.rows = rows;
        H.onFetch = async () => { storageMediaController.pauseDownload('tid-1'); };
        await storageMediaController.downloadFile(SID, announce);
        expect(storageMediaController.downloads.get('tid-1').status).toBe('paused');

        H.onFetch = null;
        const done = new Promise(resolve => storageMediaController.onFileComplete(resolve));
        storageMediaController.resumeDownload('tid-1');
        expect(storageMediaController.isResuming('tid-1')).toBe(true);
        await done;

        expect(storageMediaController.downloads.get('tid-1').status).toBe('complete');
        expect(storageMediaController.getFileUrl('tid-1')).toBeTruthy();
    });

    it('undoes a pause the fetch loop has not acted on yet', async () => {
        const { rows, announce, total } = nineChunks();
        H.rows = rows;
        H.onFetch = async () => {
            storageMediaController.pauseDownload('tid-1');
            storageMediaController.resumeDownload('tid-1');
            H.onFetch = null;
        };
        await storageMediaController.downloadFile(SID, announce);
        const transfer = storageMediaController.downloads.get('tid-1');
        expect(transfer.status).toBe('complete');
        expect(transfer.chunks.size).toBe(total);
    });

    it('cancelling a running transfer drops it entirely', async () => {
        const { rows, announce } = nineChunks();
        H.rows = rows;
        const onError = vi.fn();
        storageMediaController.onFileError(onError);
        H.onFetch = async () => { storageMediaController.cancelDownload('tid-1'); };

        await storageMediaController.downloadFile(SID, announce);

        expect(storageMediaController.downloads.has('tid-1')).toBe(false);
        expect(storageMediaController.completedFiles.has('tid-1')).toBe(false);
        expect(onError).not.toHaveBeenCalled();
    });

    it('cancelling a paused transfer clears its resume record', async () => {
        const { rows, announce } = nineChunks();
        H.rows = rows;
        H.onFetch = async () => { storageMediaController.pauseDownload('tid-1'); };
        await storageMediaController.downloadFile(SID, announce);

        localStorage.setItem('pomboStorageResume_tid-1', JSON.stringify({
            stagingName: 'psf_dl_tid-1.z', indices: [0, 1, 2], totalChunks: 9, compressedSize: 4608
        }));
        expect(storageMediaController.hasResumeState('tid-1')).toBe(true);
        expect(storageMediaController.getResumePercent('tid-1')).toBe(33);

        storageMediaController.cancelDownload('tid-1');

        expect(storageMediaController.downloads.has('tid-1')).toBe(false);
        expect(storageMediaController.hasResumeState('tid-1')).toBe(false);
        expect(storageMediaController.getResumePercent('tid-1')).toBeNull();
    });

    it('reports no progress for a transfer that is neither running nor paused', async () => {
        const { rows, announce } = stage(bytesOfSize(1024));
        H.rows = rows;
        expect(storageMediaController.getDownloadProgress('tid-1')).toBeNull();
        await storageMediaController.downloadFile(SID, announce);
        expect(storageMediaController.isDownloading('tid-1')).toBe(false);
        expect(storageMediaController.getDownloadProgress('tid-1')).toBeNull();
    });
});
