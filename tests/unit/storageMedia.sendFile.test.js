/**
 * Tests for storageMedia.js sendFile — the upload path that moves user files
 * onto the storage nodes. Collaborators are mocked; what is under test is the
 * branching: guards, publisher selection, chunking, sealing, verify & repair,
 * the announce and the failure unwind.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const H = vi.hoisted(() => {
    const state = {
        publishes: [],          // every publishStorageChunk call
        messages: [],           // every streamrController.publishMessage call
        dmPublishes: [],        // every dmManager.sealAndPublish call
        sentLocally: [],        // every secureStorage.addSentMessage call
        rows: [],               // what the storage nodes hand back
        channel: null,
        P0: 0,
        accountAddress: '0xaccount',
        ephemeralAddress: '0xephemeral',
        publisherOverride: null,   // stamped when the chunk carries no identity
        storeChunk: null,          // (index, rec) => bool; false keeps it off the nodes
        failPublish: null,         // (index) => bool
        announceVisible: true,
        nextTs: 1700000000000,
        bases: []
    };
    // Wire-format reader: [4B metaLen][meta][4B totalChunks][4B chunkIndex][data]
    state.indexOf = (p) => {
        if (!(p instanceof Uint8Array) || p.length < 12) return null;
        const dv = new DataView(p.buffer, p.byteOffset, p.byteLength);
        const ml = dv.getUint32(0, false);
        if (ml <= 0 || ml > p.length - 12) return null;
        return dv.getUint32(4 + ml + 4, false);
    };
    return state;
});

vi.mock('../../src/js/logger.js', () => ({
    Logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }
}));
vi.mock('../../src/js/auth.js', () => ({
    authManager: {
        getAddress: vi.fn(() => H.accountAddress),
        wallet: { privateKey: '0xprivkey' }
    }
}));
vi.mock('../../src/js/identity.js', () => ({
    identityManager: {
        username: 'tester',
        generateMessageId: vi.fn(() => 'msg-1'),
        getTrustLevel: vi.fn(async () => 0),
        createSignedStorageFileManifest: vi.fn(async ({ channelId, metadata, id }) => ({
            type: 'storage_file_announce', v: 1, id,
            sender: H.accountAddress, senderName: 'tester',
            timestamp: Date.now(), channelId, metadata,
            signature: '0xsig', replyTo: null
        }))
    }
}));
vi.mock('../../src/js/secureStorage.js', () => ({
    secureStorage: { addSentMessage: vi.fn(async (sid, msg) => { H.sentLocally.push({ sid, msg }); }) }
}));
vi.mock('../../src/js/storageEndpoints.js', () => ({
    storageEndpoints: {
        resolve: vi.fn(),
        rotation: vi.fn(async () => H.bases),
        noteFailure: vi.fn(), noteSuccess: vi.fn(),
        supportsMetaFormat: vi.fn(() => true),
        setMetaFormatSupport: vi.fn()
    }
}));
vi.mock('../../src/js/streamr.js', () => ({
    isWebSafeStorageNodeUrl: () => true,
    streamrController: {
        client: null,
        getDMInboxId: vi.fn((addr) => `inbox/${addr}`),
        publishStorageChunk: vi.fn(async (streamId, partition, payload, identity) => {
            // The warm-up ping is the 1-byte publish; a sealed chunk hides its
            // header, so index stays null there.
            const isPing = payload.length === 1;
            const index = isPing ? null : H.indexOf(payload);
            if (index !== null && H.failPublish && H.failPublish(index)) throw new Error(`publish of ${index} refused`);
            const rec = {
                streamId, partition, payload, identity, index, isPing,
                timestamp: H.nextTs++,
                publisherId: identity ? identity.__addr : (H.publisherOverride || H.accountAddress)
            };
            H.publishes.push(rec);
            if (!isPing && (!H.storeChunk || H.storeChunk(index, rec))) H.rows.push(rec);
            return { timestamp: rec.timestamp };
        }),
        publishMessage: vi.fn(async (streamId, message, password) => {
            const rec = { streamId, message, password, timestamp: H.nextTs++, partition: H.P0, publisherId: H.accountAddress };
            H.messages.push(rec);
            if (H.announceVisible) H.rows.push(rec);
            return { timestamp: rec.timestamp };
        })
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
    getChannelIdentity: vi.fn(() => ({
        identity: { __addr: H.ephemeralAddress, getUserId: async () => H.ephemeralAddress }
    }))
}));
vi.mock('../../src/js/dm.js', () => ({
    dmManager: {
        getPeerPublicKey: vi.fn(async () => '0xpeerpub'),
        sealAndPublish: vi.fn(async (streamId, peer, message) => {
            const rec = { streamId, peer, message, timestamp: H.nextTs++, partition: H.P0, publisherId: H.accountAddress };
            H.dmPublishes.push(rec);
            if (H.announceVisible) H.rows.push(rec);
            return { timestamp: rec.timestamp };
        })
    }
}));
vi.mock('../../src/js/dmCrypto.js', () => ({
    dmCrypto: {
        generateEphemeralPrivateKey: vi.fn(() => '0xthrowaway'),
        getSharedKey: vi.fn(async () => 'dm-key'),
        encryptBinary: vi.fn(async (bytes) => wrap('DM', bytes)),
        decryptBinary: vi.fn(async (bytes) => unwrap(bytes))
    }
}));
vi.mock('../../src/js/crypto.js', () => ({
    cryptoManager: {
        generateSalt: vi.fn(() => new Uint8Array([1, 2, 3, 4])),
        base64ToArrayBuffer: vi.fn(() => new Uint8Array([1, 2, 3, 4])),
        arrayBufferToBase64: vi.fn(() => 'c2FsdA=='),
        deriveKey: vi.fn(async () => 'pw-key'),
        encryptBinaryWithKey: vi.fn(async (bytes) => wrap('PW', bytes)),
        decryptBinaryWithKey: vi.fn(async (bytes) => unwrap(bytes))
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
        sealBinaryWithEpochKey: vi.fn(async (bytes) => wrap('EP', bytes)),
        parseBinaryEpochEnvelope: vi.fn(() => ({ kid: 'kid-1' })),
        decryptBinaryWithEpochKey: vi.fn(async () => new Uint8Array())
    }
}));

// Test sealers: a readable 2-byte tag so a test can tell a sealed chunk from a
// plaintext one without decrypting anything.
function wrap(tag, bytes) {
    const out = new Uint8Array(bytes.length + 2);
    out[0] = tag.charCodeAt(0); out[1] = tag.charCodeAt(1);
    out.set(bytes, 2);
    return out;
}
function unwrap(bytes) { return bytes.subarray(2); }

import { storageMediaController, unpackChunkPayload } from '../../src/js/storageMedia.js';
import { STORAGE_FILE, MESSAGE_STREAM } from '../../src/js/streamConstants.js';
import { CONFIG } from '../../src/js/config.js';
import { channelManager } from '../../src/js/channels.js';
import { streamrController } from '../../src/js/streamr.js';
import { identityManager } from '../../src/js/identity.js';
import { dmManager } from '../../src/js/dm.js';
import { secureStorage } from '../../src/js/secureStorage.js';
import { usesEpochKeys, epochKeyManager } from '../../src/js/epochKeyManager.js';

const SID = '0xowner/channel-1';
const NODE = 'https://node-a.example';
const SM = CONFIG.storageMedia;

let cfgSnapshot, realSetTimeout;

// image/* with a binary extension keeps shouldCompress() off: the deflate
// pipeline is a separate branch with its own test.
function fileOfSize(n, name = 'photo.png', type = 'image/png') {
    const data = new Uint8Array(n);
    for (let i = 0; i < n; i++) data[i] = i % 251;
    return new File([data], name, { type });
}
function chunkPublishes() { return H.publishes.filter(p => !p.isPing); }
function warmUpPings() { return H.publishes.filter(p => p.isPing); }
function dmIdentityClass() {
    return { fromPrivateKey: vi.fn(() => ({ __addr: '0xthrowaway-addr', getUserId: async () => '0xthrowaway-addr' })) };
}

beforeEach(() => {
    cfgSnapshot = { ...SM };
    Object.assign(SM, {
        chunkKB: 1, throttleMs: 0, parallel: 1, autotune: false,
        verify: false, secondChance: false, warmUpWaitMs: 0, faststart: true
    });
    H.publishes = []; H.messages = []; H.dmPublishes = []; H.sentLocally = []; H.rows = [];
    H.channel = { messageStreamId: SID, type: 'public', messages: [] };
    H.P0 = MESSAGE_STREAM.MESSAGES;
    H.publisherOverride = null;
    H.storeChunk = null;
    H.failPublish = null;
    H.announceVisible = true;
    H.bases = [NODE];
    H.nextTs = 1700000000000;
    usesEpochKeys.mockReturnValue(false);
    channelManager.usesAccountPublish.mockReturnValue(false);
    channelManager.getChannel.mockImplementation(() => H.channel);
    storageMediaController.clear();

    // Real sleeps would add ~60s of announce-confirmation waits per test; the
    // ordering the code depends on is preserved, only the delay shrinks.
    realSetTimeout = globalThis.setTimeout;
    globalThis.setTimeout = (fn, ms, ...rest) => realSetTimeout(fn, ms > 1 ? 1 : ms, ...rest);

    globalThis.fetch = vi.fn(async (url) => {
        const u = new URL(url);
        const m = u.pathname.match(/partitions\/(\d+)\/range/);
        const partition = m ? Number(m[1]) : -1;
        const from = Number(u.searchParams.get('fromTimestamp'));
        const to = Number(u.searchParams.get('toTimestamp'));
        const rows = H.rows.filter(r => r.partition === partition && r.timestamp >= from && r.timestamp <= to);
        return { ok: true, status: 200, json: async () => rows.map(r => ({ timestamp: r.timestamp, publisherId: r.publisherId })) };
    });
});

afterEach(() => {
    Object.assign(SM, cfgSnapshot);
    globalThis.setTimeout = realSetTimeout;
    delete globalThis.EthereumKeyPairIdentity;
    if (typeof window !== 'undefined') delete window.EthereumKeyPairIdentity;
});

describe('sendFile — guards', () => {
    it('refuses an empty file before touching the network', async () => {
        await expect(storageMediaController.sendFile(SID, new File([], 'empty.png', { type: 'image/png' })))
            .rejects.toThrow('File is empty');
        expect(H.publishes).toHaveLength(0);
    });

    it('refuses a DM upload with no reachable storage endpoint', async () => {
        H.channel = { messageStreamId: SID, type: 'dm', peerAddress: '0xpeer', messages: [] };
        H.bases = [];
        await expect(storageMediaController.sendFile(SID, fileOfSize(100)))
            .rejects.toThrow(/No reachable storage endpoint/);
        expect(H.publishes).toHaveLength(0);
    });

    it('keeps going on a channel with no endpoint (verify falls back to resend)', async () => {
        H.bases = [];
        H.announceVisible = false;
        const res = await storageMediaController.sendFile(SID, fileOfSize(500));
        expect(res.messageId).toBe('msg-1');
        expect(chunkPublishes().length).toBeGreaterThan(0);
    }, 20000);

    it('refuses a chunk budget smaller than the metadata overhead', async () => {
        SM.chunkKB = 0.1;
        await expect(storageMediaController.sendFile(SID, fileOfSize(500)))
            .rejects.toThrow('Chunk size too small for metadata overhead');
    });
});

describe('sendFile — chunking', () => {
    it('spreads chunks over the 9 chunk partitions and the payloads rebuild the file', async () => {
        const file = fileOfSize(4000);
        const original = new Uint8Array(await file.arrayBuffer());
        const { metadata } = await storageMediaController.sendFile(SID, file);

        const chunks = chunkPublishes();
        expect(chunks.length).toBe(metadata.totalChunks);
        expect(metadata.totalChunks).toBeGreaterThan(1);

        const rebuilt = new Uint8Array(metadata.originalSize);
        let seen = 0;
        for (const c of chunks) {
            const u = unpackChunkPayload(c.payload);
            expect(u.meta.transferId).toBe(metadata.transferId);
            expect(u.totalChunks).toBe(metadata.totalChunks);
            expect(c.partition).toBe(STORAGE_FILE.FIRST_CHUNK_PARTITION + (u.chunkIndex % STORAGE_FILE.CHUNK_PARTITIONS));
            rebuilt.set(u.chunkData, u.chunkIndex * metadata.chunkDataSize);
            seen += u.chunkData.length;
        }
        expect(seen).toBe(original.length);
        expect(rebuilt).toEqual(original);
    });

    it('pings every chunk partition once before the first real publish', async () => {
        await storageMediaController.sendFile(SID, fileOfSize(500));
        const pings = warmUpPings();
        expect(pings).toHaveLength(STORAGE_FILE.CHUNK_PARTITIONS);
        expect(new Set(pings.map(p => p.partition)).size).toBe(STORAGE_FILE.CHUNK_PARTITIONS);
        expect(H.publishes.indexOf(pings[pings.length - 1]))
            .toBeLessThan(H.publishes.indexOf(chunkPublishes()[0]));
    });

    it('puts DM chunks on the DM partition band, never the channel band', async () => {
        H.channel = { messageStreamId: SID, type: 'dm', peerAddress: '0xpeer', messages: [] };
        globalThis.EthereumKeyPairIdentity = window.EthereumKeyPairIdentity = dmIdentityClass();
        await storageMediaController.sendFile(SID, fileOfSize(2000));
        expect(chunkPublishes().length).toBeGreaterThan(1);
        for (const c of H.publishes) {
            expect(c.partition).toBeGreaterThanOrEqual(STORAGE_FILE.DM_FIRST_CHUNK_PARTITION);
            expect(c.partition).toBeLessThan(STORAGE_FILE.DM_FIRST_CHUNK_PARTITION + STORAGE_FILE.CHUNK_PARTITIONS);
        }
    });

    it('deflates a compressible file and chunks the compressed bytes', async () => {
        // Copied into this realm: jsdom's TextEncoder hands back a foreign
        // Uint8Array that toEqual reports as different with no visible diff.
        const raw = new Uint8Array(new TextEncoder().encode('pombo '.repeat(2000)));
        const file = new File([raw], 'notes.txt', { type: 'text/plain' });

        const { metadata } = await storageMediaController.sendFile(SID, file);

        expect(metadata.compression).toBe('deflate');
        expect(metadata.originalSize).toBe(raw.length);
        expect(metadata.compressedSize).toBeLessThan(raw.length);
        expect(metadata.totalChunks).toBe(Math.ceil(metadata.compressedSize / metadata.chunkDataSize));

        const wire = new Uint8Array(metadata.compressedSize);
        for (const c of chunkPublishes()) {
            const u = unpackChunkPayload(c.payload);
            expect(u.meta.compression).toBe('deflate');
            wire.set(u.chunkData, u.chunkIndex * metadata.chunkDataSize);
        }
        const ds = new DecompressionStream('deflate');
        const writer = ds.writable.getWriter();
        writer.write(wire);
        writer.close();
        const parts = [];
        const reader = ds.readable.getReader();
        for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            if (value && value.length) parts.push(value);
        }
        const out = new Uint8Array(parts.reduce((s, p) => s + p.length, 0));
        let o = 0;
        for (const p of parts) { out.set(p, o); o += p.length; }
        expect(out).toEqual(raw);
    }, 20000);

    it('fails the transfer when compression fails, without announcing anything', async () => {
        const realCS = globalThis.CompressionStream;
        globalThis.CompressionStream = function () { throw new Error('deflate unavailable'); };
        try {
            const file = new File([new TextEncoder().encode('x'.repeat(4000))], 'notes.txt', { type: 'text/plain' });
            await expect(storageMediaController.sendFile(SID, file)).rejects.toThrow('deflate unavailable');
            expect(H.messages).toHaveLength(0);
            expect(H.channel.messages).toHaveLength(0);
        } finally {
            globalThis.CompressionStream = realCS;
        }
    });

    it('retries a chunk whose publish keeps failing and still finishes the transfer', async () => {
        H.failPublish = (i) => i === 1;
        const { metadata } = await storageMediaController.sendFile(SID, fileOfSize(3000));
        expect(chunkPublishes()).toHaveLength(metadata.totalChunks - 1);
        expect(streamrController.publishStorageChunk.mock.calls
            .filter(([, , payload]) => H.indexOf(payload) === 1)).toHaveLength(6); // 3 attempts, twice
        expect(H.messages).toHaveLength(1); // the announce still goes out
    }, 20000);
});

describe('sendFile — who publishes the chunks', () => {
    it('rides the channel ephemeral identity on a normal channel', async () => {
        await storageMediaController.sendFile(SID, fileOfSize(500));
        expect(H.publishes.length).toBeGreaterThan(0);
        for (const c of H.publishes) expect(c.identity && c.identity.__addr).toBe(H.ephemeralAddress);
    });

    it('rides the account when the channel publishes as the account', async () => {
        channelManager.usesAccountPublish.mockReturnValue(true);
        await storageMediaController.sendFile(SID, fileOfSize(500));
        expect(H.publishes.length).toBeGreaterThan(0);
        for (const c of H.publishes) expect(c.identity).toBeNull();
    });

    it('leaves gated chunks to the clone and verifies against the gate address', async () => {
        H.channel = { messageStreamId: SID, type: 'public', gate: { address: '0xGATE' }, messages: [] };
        H.publisherOverride = '0xgate';
        SM.verify = true;
        const { metadata } = await storageMediaController.sendFile(SID, fileOfSize(2000));
        for (const c of H.publishes) expect(c.identity).toBeNull();
        expect(metadata.storedChunks).toBe(metadata.totalChunks);
    }, 20000);

    it('verifies a members-only upload against the shared publish key', async () => {
        H.channel = { messageStreamId: SID, type: 'public', wireIdentity: 'sealed', messages: [] };
        H.publisherOverride = '0xpublishkey';
        SM.verify = true;
        const { metadata } = await storageMediaController.sendFile(SID, fileOfSize(2000));
        expect(epochKeyManager.ensurePublishKey).toHaveBeenCalled();
        expect(metadata.storedChunks).toBe(metadata.totalChunks);
    }, 20000);

    it('refuses a members-only upload with no publish key', async () => {
        H.channel = { messageStreamId: SID, type: 'public', wireIdentity: 'sealed', messages: [] };
        epochKeyManager.ensurePublishKey.mockResolvedValueOnce(null);
        await expect(storageMediaController.sendFile(SID, fileOfSize(500)))
            .rejects.toThrow(/No publish key/);
    });

    it('gives a DM transfer a throwaway identity, and refuses without the SDK class', async () => {
        H.channel = { messageStreamId: SID, type: 'dm', peerAddress: '0xpeer', messages: [] };
        await expect(storageMediaController.sendFile(SID, fileOfSize(500)))
            .rejects.toThrow(/EthereumKeyPairIdentity not exposed/);

        const klass = dmIdentityClass();
        globalThis.EthereumKeyPairIdentity = window.EthereumKeyPairIdentity = klass;
        await storageMediaController.sendFile(SID, fileOfSize(500));
        expect(H.publishes.length).toBeGreaterThan(0);
        for (const c of H.publishes) expect(c.identity.__addr).toBe('0xthrowaway-addr');
        expect(klass.fromPrivateKey).toHaveBeenCalledTimes(1);
    }, 20000);
});

describe('sendFile — sealing', () => {
    it('leaves public channel chunks in the clear', async () => {
        const { metadata } = await storageMediaController.sendFile(SID, fileOfSize(2000));
        expect(metadata.encSalt).toBeNull();
        for (const c of chunkPublishes()) expect(unpackChunkPayload(c.payload)).not.toBeNull();
    });

    it('seals password channel chunks and carries the salt in the announce', async () => {
        const { metadata } = await storageMediaController.sendFile(SID, fileOfSize(2000), 'hunter2');
        expect(metadata.encSalt).toBe('c2FsdA==');
        const chunks = chunkPublishes();
        expect(chunks.length).toBeGreaterThan(1);
        for (const c of chunks) {
            expect(String.fromCharCode(c.payload[0], c.payload[1])).toBe('PW');
            expect(unpackChunkPayload(c.payload)).toBeNull();
        }
    });

    it('seals epoch channel chunks with the epoch key captured at the start', async () => {
        usesEpochKeys.mockReturnValue(true);
        await storageMediaController.sendFile(SID, fileOfSize(2000));
        expect(epochKeyManager.getCurrentKey).toHaveBeenCalledTimes(1);
        const chunks = chunkPublishes();
        expect(chunks.length).toBeGreaterThan(1);
        for (const c of chunks) expect(String.fromCharCode(c.payload[0], c.payload[1])).toBe('EP');
    });

    it('seals DM chunks with the pair key', async () => {
        H.channel = { messageStreamId: SID, type: 'dm', peerAddress: '0xpeer', messages: [] };
        globalThis.EthereumKeyPairIdentity = window.EthereumKeyPairIdentity = dmIdentityClass();
        await storageMediaController.sendFile(SID, fileOfSize(2000));
        const chunks = chunkPublishes();
        expect(chunks.length).toBeGreaterThan(1);
        for (const c of chunks) expect(String.fromCharCode(c.payload[0], c.payload[1])).toBe('DM');
    });
});

describe('sendFile — verify and repair', () => {
    it('announces every chunk as stored when the nodes show them all', async () => {
        SM.verify = true;
        const { metadata } = await storageMediaController.sendFile(SID, fileOfSize(3000));
        expect(metadata.storedChunks).toBe(metadata.totalChunks);
    }, 20000);

    it('republishes a chunk the nodes never showed, then confirms it', async () => {
        SM.verify = true;
        let attemptsOfTwo = 0;
        H.storeChunk = (index) => (index !== 2 ? true : ++attemptsOfTwo > 1);
        const { metadata } = await storageMediaController.sendFile(SID, fileOfSize(3000));
        expect(metadata.storedChunks).toBe(metadata.totalChunks);
        expect(chunkPublishes().filter(c => c.index === 2)).toHaveLength(2);
    }, 30000);

    it('never counts rows published by somebody else', async () => {
        SM.verify = true;
        channelManager.usesAccountPublish.mockReturnValue(true);
        H.publisherOverride = '0xsomebodyelse';
        const { metadata } = await storageMediaController.sendFile(SID, fileOfSize(2000));
        expect(metadata.storedChunks).toBe(0);
        expect(chunkPublishes().length).toBeGreaterThan(metadata.totalChunks); // repair kept trying
    }, 60000);
});

describe('sendFile — announce', () => {
    it('publishes the signed announce with the final metadata', async () => {
        const file = fileOfSize(3000);
        const { metadata, messageId } = await storageMediaController.sendFile(SID, file);
        expect(H.messages).toHaveLength(1);
        const announced = H.messages[0].message;
        expect(announced.type).toBe('storage_file_announce');
        expect(announced.id).toBe(messageId);
        expect(announced.metadata).toEqual(metadata);
        expect(metadata.originalSize).toBe(file.size);
        expect(metadata.compression).toBe('none');
        expect(metadata.compressedSize).toBe(file.size);
        expect(metadata.chunkDataSize).toBeGreaterThan(0);
        expect(metadata.firstChunkTs).toBeLessThanOrEqual(metadata.lastChunkTs);
        expect(metadata.firstChunkPartition).toBe(STORAGE_FILE.FIRST_CHUNK_PARTITION);
    });

    it('seals a DM announce through the DM path and persists it locally', async () => {
        H.channel = { messageStreamId: SID, type: 'dm', peerAddress: '0xpeer', messages: [] };
        globalThis.EthereumKeyPairIdentity = window.EthereumKeyPairIdentity = dmIdentityClass();
        await storageMediaController.sendFile(SID, fileOfSize(1000));
        expect(streamrController.publishMessage).not.toHaveBeenCalled();
        expect(dmManager.sealAndPublish).toHaveBeenCalledTimes(1);
        const [, peer, sealed] = dmManager.sealAndPublish.mock.calls[0];
        expect(peer).toBe('0xpeer');
        expect(sealed.verified).toBeUndefined();
        expect(sealed.pending).toBeUndefined();
        expect(H.sentLocally).toHaveLength(1);
    });

    it('persists the announce locally on a write-only channel', async () => {
        H.channel = { messageStreamId: SID, type: 'public', writeOnly: true, messages: [] };
        await storageMediaController.sendFile(SID, fileOfSize(500));
        expect(secureStorage.addSentMessage).toHaveBeenCalledTimes(1);
    });

    it('republishes the announce once when it never becomes visible', async () => {
        H.announceVisible = false;
        await storageMediaController.sendFile(SID, fileOfSize(500));
        expect(H.messages).toHaveLength(2);
    }, 20000);

    it('does not republish an announce the nodes confirm', async () => {
        await storageMediaController.sendFile(SID, fileOfSize(500));
        expect(H.messages).toHaveLength(1);
    });
});

describe('sendFile — the optimistic bubble', () => {
    it('shows a pending bubble and replaces it in place when the announce is signed', async () => {
        const complete = vi.fn();
        storageMediaController.onUploadComplete(complete);
        const seenAtPush = [];
        channelManager.notifyHandlers.mockImplementation((evt, payload) => {
            seenAtPush.push({ evt, pending: payload.message.pending, id: payload.message.id });
        });

        await storageMediaController.sendFile(SID, fileOfSize(500));

        expect(seenAtPush).toEqual([{ evt: 'message', pending: true, id: 'msg-1' }]);
        expect(H.channel.messages).toHaveLength(1);
        const bubble = H.channel.messages[0];
        expect(bubble.pending).toBeUndefined();
        expect(bubble.signature).toBe('0xsig');
        expect(bubble.metadata.totalChunks).toBeGreaterThan(0);
        expect(complete).toHaveBeenCalledWith(expect.any(String), bubble);
        storageMediaController.onUploadComplete(null);
        channelManager.notifyHandlers.mockReset();
    });

    it('drops the bubble and reports the error when the transfer fails', async () => {
        const onError = vi.fn();
        storageMediaController.onFileError(onError);
        identityManager.createSignedStorageFileManifest.mockRejectedValueOnce(new Error('signing failed'));

        await expect(storageMediaController.sendFile(SID, fileOfSize(500))).rejects.toThrow('signing failed');

        expect(H.channel.messages).toHaveLength(0);
        expect(onError).toHaveBeenCalledWith(expect.any(String), 'signing failed');
        expect(storageMediaController.uploads.size).toBe(0);
        storageMediaController.onFileError(null);
    });
});
