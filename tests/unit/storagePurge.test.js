/**
 * Tests for storagePurge.js — the signed purge request, its fan-out per
 * provider, and the lookup of a message's storage coordinates.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { Wallet, verifyMessage } from 'ethers';

vi.mock('../../src/js/logger.js', () => ({
    Logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }
}));

const providersWith = vi.fn();
vi.mock('../../src/js/storageEndpoints.js', () => ({
    storageEndpoints: { providersWith: (...args) => providersWith(...args) }
}));

import {
    buildPurgeMessage,
    signedPurgeBody,
    purgeOnProvider,
    purgeMessages,
    purgeGroups,
    chunkTransferId,
    fileChunkGroups,
    resolveTarget,
    eraseMessage,
    eraseAuthorMessages,
    PURGE_MAX_TARGETS
} from '../../src/js/storagePurge.js';

const VECTORS = JSON.parse(readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'docs', 'STORAGE-purge-vectors.json'), 'utf8'));
const STREAM = '0xaaaabbbbccccddddeeeeffff0000111122223333/deadbeef01-1';
const wallet = new Wallet(VECTORS.userPriv);
const signer = { address: wallet.address, sign: (m) => wallet.signMessage(m) };

const jsonResponse = (status, body) => ({ ok: status >= 200 && status < 300, status, json: () => Promise.resolve(body) });
const purgeUrl = (base, partition = 0) => `${base}/streams/${encodeURIComponent(STREAM)}/data/partitions/${partition}/purge`;

describe('buildPurgeMessage / signedPurgeBody', () => {
    it('joins the fields one per line with one target line each', () => {
        expect(buildPurgeMessage({
            streamId: STREAM, partition: 2, issuedAt: 1789000000000, nonce: 'abc',
            targets: [{ timestamp: 10, sequenceNumber: 0 }, { timestamp: 11, sequenceNumber: 3 }]
        })).toBe(`pombo-storage-node\npurge\n${STREAM}\n2\n1789000000000\nabc\n10:0\n11:3`);
    });

    it('signs a body whose signature recovers the user', async () => {
        const body = await signedPurgeBody(STREAM, 0, [{ timestamp: 5, sequenceNumber: 1 }], signer, { issuedAt: 1789000000000, nonce: 'ff'.repeat(16) });
        expect(body).toMatchObject({ user: wallet.address, issuedAt: 1789000000000, nonce: 'ff'.repeat(16), targets: [{ timestamp: 5, sequenceNumber: 1 }] });
        const message = buildPurgeMessage({ streamId: STREAM, partition: 0, issuedAt: 1789000000000, nonce: 'ff'.repeat(16), targets: body.targets });
        expect(verifyMessage(message, body.signature)).toBe(wallet.address);
    });

    it('refuses an empty or oversized target list', async () => {
        await expect(signedPurgeBody(STREAM, 0, [], signer)).rejects.toThrow('No purge targets');
        const many = Array.from({ length: PURGE_MAX_TARGETS + 1 }, (_, i) => ({ timestamp: i, sequenceNumber: 0 }));
        await expect(signedPurgeBody(STREAM, 0, many, signer)).rejects.toThrow(/At most/);
    });

    it('matches every parity vector', async () => {
        expect(VECTORS.vectors.length).toBeGreaterThan(0);
        for (const v of VECTORS.vectors) {
            const message = buildPurgeMessage({
                streamId: v.streamId, partition: v.partition, issuedAt: v.body.issuedAt, nonce: v.body.nonce, targets: v.body.targets
            });
            expect(message, v.name).toBe(v.message);
            const body = await signedPurgeBody(v.streamId, v.partition, v.body.targets, signer, { issuedAt: v.body.issuedAt, nonce: v.body.nonce });
            expect(body, v.name).toEqual(v.body);
        }
    });
});

describe('purgeOnProvider', () => {
    const provider = { nodeAddress: '0xprov', urls: ['https://a1.example', 'https://a2.example'] };
    const targets = [{ timestamp: 100, sequenceNumber: 0 }];

    it('posts a freshly signed body to the first URL and returns the node results', async () => {
        const fetchMock = vi.fn(async () => jsonResponse(200, { results: [{ timestamp: 100, sequenceNumber: 0, result: 'deleted' }] }));
        const out = await purgeOnProvider(provider, STREAM, 0, targets, signer, fetchMock);
        expect(out).toMatchObject({ provider: '0xprov', url: 'https://a1.example', status: 200 });
        expect(out.results[0].result).toBe('deleted');
        expect(fetchMock).toHaveBeenCalledTimes(1);
        const [url, init] = fetchMock.mock.calls[0];
        expect(url).toBe(purgeUrl('https://a1.example'));
        expect(init.method).toBe('POST');
        const body = JSON.parse(init.body);
        expect(body.user).toBe(wallet.address);
        expect(body.targets).toEqual(targets);
        expect(body.nonce).toMatch(/^[0-9a-f]{32}$/);
    });

    it('moves to the next URL when one cannot be reached, with a new signature', async () => {
        const fetchMock = vi.fn()
            .mockRejectedValueOnce(new Error('ECONNRESET'))
            .mockResolvedValueOnce(jsonResponse(200, { results: [{ timestamp: 100, sequenceNumber: 0, result: 'not_found' }] }));
        const out = await purgeOnProvider(provider, STREAM, 0, targets, signer, fetchMock);
        expect(out.url).toBe('https://a2.example');
        expect(fetchMock).toHaveBeenCalledTimes(2);
        const n1 = JSON.parse(fetchMock.mock.calls[0][1].body).nonce;
        const n2 = JSON.parse(fetchMock.mock.calls[1][1].body).nonce;
        expect(n1).not.toBe(n2);
    });

    it('reports an HTTP refusal without trying the next URL, and unreachable when all fail', async () => {
        const refused = vi.fn(async () => jsonResponse(403, {}));
        expect(await purgeOnProvider(provider, STREAM, 0, targets, signer, refused)).toMatchObject({ status: 403, url: 'https://a1.example', results: [] });
        expect(refused).toHaveBeenCalledTimes(1);

        const dead = vi.fn(async () => { throw new Error('down'); });
        expect(await purgeOnProvider(provider, STREAM, 0, targets, signer, dead)).toMatchObject({ status: 0, url: null, error: 'down' });
        expect(dead).toHaveBeenCalledTimes(2);
    });
});

describe('purgeMessages', () => {
    beforeEach(() => providersWith.mockReset());

    it('fans out to every provider announcing purge and counts where the message is gone', async () => {
        providersWith.mockResolvedValue([
            { nodeAddress: '0xa', urls: ['https://a.example'] },
            { nodeAddress: '0xb', urls: ['https://b.example'] },
            { nodeAddress: '0xc', urls: ['https://c.example'] }
        ]);
        const fetchMock = vi.fn(async (url) => {
            if (url.startsWith('https://a.example')) return jsonResponse(200, { results: [{ timestamp: 7, sequenceNumber: 0, result: 'deleted' }] });
            if (url.startsWith('https://b.example')) return jsonResponse(200, { results: [{ timestamp: 7, sequenceNumber: 0, result: 'forbidden' }] });
            throw new Error('down');
        });
        const out = await purgeMessages(STREAM, 0, [{ timestamp: 7, sequenceNumber: 0 }], signer, fetchMock);
        expect(providersWith).toHaveBeenCalledWith(STREAM, 'purge');
        expect(out).toMatchObject({ providers: 3, erasedOn: 1, forbiddenOn: 1, unreachable: 1 });
    });

    it('is a no-op with zero providers', async () => {
        providersWith.mockResolvedValue([]);
        const out = await purgeMessages(STREAM, 0, [{ timestamp: 7, sequenceNumber: 0 }], signer, vi.fn());
        expect(out).toMatchObject({ providers: 0, erasedOn: 0 });
    });
});

describe('resolveTarget / eraseMessage', () => {
    beforeEach(() => providersWith.mockReset());

    it('uses the envelope coordinates the message carries', async () => {
        const fetchMock = vi.fn();
        expect(await resolveTarget(STREAM, 0, { _timestamp: 500, _seq: 2, timestamp: 499 }, fetchMock)).toEqual({ timestamp: 500, sequenceNumber: 2 });
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it('looks a message without a sequence number up by its envelope time', async () => {
        providersWith.mockResolvedValue([{ nodeAddress: '0xa', urls: ['https://a.example'] }]);
        const fetchMock = vi.fn(async (url) => {
            expect(url).toContain('/range?fromTimestamp=500&toTimestamp=500&format=metadata');
            return jsonResponse(200, [{ timestamp: 500, sequenceNumber: 4, publisherId: '0x1' }]);
        });
        expect(await resolveTarget(STREAM, 0, { _timestamp: 500 }, fetchMock)).toEqual({ timestamp: 500, sequenceNumber: 4 });
        expect(providersWith).toHaveBeenCalledWith(STREAM, 'metadata');
    });

    it('finds an own message added locally, whose payload time precedes the envelope by a few ms', async () => {
        providersWith.mockResolvedValue([{ nodeAddress: '0xa', urls: ['https://a.example'] }]);
        const fetchMock = vi.fn(async (url) => {
            expect(url).toContain('/range?fromTimestamp=-9500&toTimestamp=10500&format=metadata');
            return jsonResponse(200, [{ timestamp: 503, sequenceNumber: 0 }, { timestamp: 9000, sequenceNumber: 0 }]);
        });
        expect(await resolveTarget(STREAM, 0, { timestamp: 500 }, fetchMock)).toEqual({ timestamp: 503, sequenceNumber: 0 });
    });

    it('refuses to guess between two messages at the same instant', async () => {
        providersWith.mockResolvedValue([{ nodeAddress: '0xa', urls: ['https://a.example'] }]);
        const fetchMock = vi.fn(async () => jsonResponse(200, [
            { timestamp: 500, sequenceNumber: 0 }, { timestamp: 500, sequenceNumber: 1 }
        ]));
        await expect(resolveTarget(STREAM, 0, { timestamp: 500 }, fetchMock)).rejects.toThrow(/Several messages/);
        const none = vi.fn(async () => jsonResponse(200, []));
        await expect(resolveTarget(STREAM, 0, { timestamp: 500 }, none)).rejects.toThrow(/not on storage/);
    });

    it('eraseMessage resolves the target and purges it on every provider', async () => {
        providersWith.mockImplementation(async (_stream, feature) => feature === 'purge'
            ? [{ nodeAddress: '0xa', urls: ['https://a.example'] }]
            : []);
        const fetchMock = vi.fn(async () => jsonResponse(200, { results: [{ timestamp: 900, sequenceNumber: 1, result: 'deleted' }] }));
        const out = await eraseMessage({ messageStreamId: STREAM }, { id: 'm', _timestamp: 900, _seq: 1 }, signer, { fetchImpl: fetchMock });
        expect(out).toMatchObject({ providers: 1, erasedOn: 1, targets: 1 });
        expect(fetchMock.mock.calls[0][0]).toBe(purgeUrl('https://a.example', 0));
    });
});

describe('purgeGroups', () => {
    beforeEach(() => providersWith.mockReset());

    it('sends one request per partition and per batch of 100, and counts the targets', async () => {
        providersWith.mockResolvedValue([{ nodeAddress: '0xa', urls: ['https://a.example'] }]);
        const targets = Array.from({ length: 150 }, (_, i) => ({ timestamp: 1000 + i, sequenceNumber: 0 }));
        const fetchMock = vi.fn(async (_url, init) => {
            const body = JSON.parse(init.body);
            return jsonResponse(200, { results: body.targets.map((t) => ({ ...t, result: 'deleted' })) });
        });
        const out = await purgeGroups(STREAM, [{ partition: 0, targets }, { partition: 3, targets: targets.slice(0, 2) }], signer, fetchMock);
        expect(fetchMock.mock.calls.map(([u]) => u)).toEqual([
            purgeUrl('https://a.example', 0), purgeUrl('https://a.example', 0), purgeUrl('https://a.example', 3)
        ]);
        expect(JSON.parse(fetchMock.mock.calls[0][1].body).targets).toHaveLength(100);
        expect(JSON.parse(fetchMock.mock.calls[1][1].body).targets).toHaveLength(50);
        expect(out).toMatchObject({ providers: 1, erasedOn: 1, forbiddenOn: 0, unreachable: 0, targets: 152 });
    });

    it('stops at the first unreachable batch of a provider and does not count it as erased', async () => {
        providersWith.mockResolvedValue([{ nodeAddress: '0xa', urls: ['https://a.example'] }]);
        const fetchMock = vi.fn(async () => { throw new Error('down'); });
        const out = await purgeGroups(STREAM, [{ partition: 0, targets: [{ timestamp: 1, sequenceNumber: 0 }] }, { partition: 3, targets: [{ timestamp: 2, sequenceNumber: 0 }] }], signer, fetchMock);
        expect(fetchMock).toHaveBeenCalledTimes(1);
        expect(out).toMatchObject({ providers: 1, erasedOn: 0, unreachable: 1, targets: 2 });
    });
});

describe('chunkTransferId / fileChunkGroups', () => {
    beforeEach(() => providersWith.mockReset());

    const chunkHex = (transferId, data = 'abcd') => {
        const meta = Buffer.from(JSON.stringify({ type: 'binary_file_chunked', version: 2, transferId }), 'utf8');
        return meta.length.toString(16).padStart(8, '0') + meta.toString('hex') + '00000003' + '00000000' + data;
    };

    it('reads the transfer off a chunk header and rejects anything else', () => {
        expect(chunkTransferId(chunkHex('t1'))).toBe('t1');
        expect(chunkTransferId(Uint8Array.from(Buffer.from(chunkHex('t1'), 'hex')))).toBe('t1');
        expect(chunkTransferId('00')).toBeNull();
        expect(chunkTransferId(chunkHex('t1').slice(0, 20))).toBeNull();
        expect(chunkTransferId('0000000a' + Buffer.from('{"x":1}   ').toString('hex'))).toBeNull();
        expect(chunkTransferId({ type: 'text' })).toBeNull();
    });

    it('opens sealed rows with the opener it is given and skips the ones that do not open', async () => {
        providersWith.mockResolvedValue([{ nodeAddress: '0xa', urls: ['https://a.example'] }]);
        const fetchMock = vi.fn(async (url) => {
            const p = Number(url.match(/partitions\/(\d+)\//)[1]);
            return jsonResponse(200, p === 3 ? [
                { timestamp: 1000, sequenceNumber: 0, contentType: 1, content: 'ff' + chunkHex('t1') },
                { timestamp: 1001, sequenceNumber: 0, contentType: 1, content: '00' + chunkHex('t1') },
                { timestamp: 1002, sequenceNumber: 0, contentType: 1, content: 'ff' + chunkHex('t2') }
            ] : []);
        });
        const openChunk = async (bytes) => {
            if (bytes[0] !== 0xff) throw new Error('not sealed by us');
            return bytes.subarray(1);
        };
        const groups = await fileChunkGroups(STREAM, { transferId: 't1', firstChunkTs: 1000000, lastChunkTs: 1010000 }, fetchMock, openChunk);
        expect(groups).toEqual([{ partition: 3, targets: [{ timestamp: 1000, sequenceNumber: 0 }] }]);
    });

    it('keeps only the rows of the announced transfer, on every chunk partition', async () => {
        providersWith.mockResolvedValue([{ nodeAddress: '0xa', urls: ['https://a.example'] }]);
        const fetchMock = vi.fn(async (url) => {
            expect(url).toContain('fromTimestamp=940000&toTimestamp=1070000');
            const p = Number(url.match(/partitions\/(\d+)\//)[1]);
            if (p === 3) return jsonResponse(200, [
                { timestamp: 1000, sequenceNumber: 0, contentType: 1, content: chunkHex('t1') },
                { timestamp: 1001, sequenceNumber: 0, contentType: 1, content: chunkHex('other') },
                { timestamp: 1002, sequenceNumber: 1, contentType: 0, content: { type: 'text' } }
            ]);
            if (p === 5) return jsonResponse(200, [{ timestamp: 1005, sequenceNumber: 2, contentType: 1, content: chunkHex('t1') }]);
            return jsonResponse(200, []);
        });
        const groups = await fileChunkGroups(STREAM, { transferId: 't1', firstChunkTs: 1000000, lastChunkTs: 1010000 }, fetchMock);
        expect(groups).toEqual([
            { partition: 3, targets: [{ timestamp: 1000, sequenceNumber: 0 }] },
            { partition: 5, targets: [{ timestamp: 1005, sequenceNumber: 2 }] }
        ]);
        expect(fetchMock).toHaveBeenCalledTimes(9);
        await expect(fileChunkGroups(STREAM, { transferId: 't1' }, fetchMock)).rejects.toThrow(/does not say/);
    });

    it('erases a storage file with its chunks, and everything one author wrote', async () => {
        providersWith.mockResolvedValue([{ nodeAddress: '0xa', urls: ['https://a.example'] }]);
        const purges = [];
        const fetchMock = vi.fn(async (url, init) => {
            const p = Number(url.match(/partitions\/(\d+)\//)[1]);
            if (url.includes('/purge')) {
                const body = JSON.parse(init.body);
                purges.push({ partition: p, n: body.targets.length });
                return jsonResponse(200, { results: body.targets.map((t) => ({ ...t, result: 'deleted' })) });
            }
            return jsonResponse(200, p === 4 ? [{ timestamp: 2000, sequenceNumber: 0, contentType: 1, content: chunkHex('t9') }] : []);
        });
        const file = { id: 'f', type: 'storage_file_announce', sender: '0xAuthor', _timestamp: 1999, _seq: 0, metadata: { transferId: 't9', firstChunkTs: 2000, lastChunkTs: 2100 } };
        const text = { id: 't', type: 'text', sender: '0xauthor', _timestamp: 1500, _seq: 1 };
        const other = { id: 'o', type: 'text', sender: '0xother', _timestamp: 1600, _seq: 0 };
        const channel = { messageStreamId: STREAM, messages: [file, text, other] };

        // Chunks go before the announce, so a failed chunk pass never orphans them.
        const one = await eraseMessage(channel, file, signer, { fetchImpl: fetchMock });
        expect(one).toMatchObject({ providers: 1, erasedOn: 1, targets: 2 });
        expect(purges).toEqual([{ partition: 4, n: 1 }, { partition: 0, n: 1 }]);

        purges.length = 0;
        const all = await eraseAuthorMessages(channel, '0xAUTHOR', signer, { fetchImpl: fetchMock });
        expect(all).toMatchObject({ providers: 1, erasedOn: 1, targets: 3, messages: 2, skipped: 0 });
        expect(purges).toEqual([{ partition: 4, n: 1 }, { partition: 0, n: 2 }]);
    });
});
