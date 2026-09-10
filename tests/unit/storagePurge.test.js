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
    resolveTarget,
    eraseMessage,
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
        expect(out).toMatchObject({ providers: 1, erasedOn: 1 });
        expect(fetchMock.mock.calls[0][0]).toBe(purgeUrl('https://a.example', 0));
    });
});
