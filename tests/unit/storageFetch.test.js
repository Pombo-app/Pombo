/**
 * Tests for storageFetch.js — the fetch wrapper that signs gated storage
 * reads, pairs them with a storedAt read, retries 503 and records the last
 * refusal per stream.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../../src/js/logger.js', () => ({
    Logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }
}));

import { storageFetch } from '../../src/js/storageFetch.js';
import { CONFIG } from '../../src/js/config.js';

const BASE = 'https://1.storage.example';
const STREAM = '0xaaaabbbbccccddddeeeeffff0000111122223333/deadbeef01-1';
const KEYS = '0xaaaabbbbccccddddeeeeffff0000111122223333/deadbeef01-4';
const ADMIN = '0xaaaabbbbccccddddeeeeffff0000111122223333/deadbeef01-3';
const enc = encodeURIComponent;
const readUrl = (stream, partition = 0, type = 'last', query = 'count=50&format=raw') =>
    `${BASE}/streams/${enc(stream)}/data/partitions/${partition}/${type}?${query}`;

const ok = (body = '', status = 200) => ({
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body)
});

describe('storageFetch', () => {
    let fetchMock;
    let features;
    let gated;
    let identity;
    const endpoints = { probeCapabilities: vi.fn(async () => features) };

    const install = () => storageFetch.install({
        endpoints,
        signer: () => identity,
        isGated: async (streamId) => gated.has(streamId.replace(/-[12345]$/, '')),
        fetchImpl: fetchMock
    });

    const headersOf = (call) => new Headers(call[1]?.headers);
    const callsTo = (fragment) => fetchMock.mock.calls.filter((c) => String(c[0]).includes(fragment));

    beforeEach(() => {
        fetchMock = vi.fn(async () => ok([]));
        features = new Set(['metadata', 'storedAt', 'purge', 'signedReads']);
        gated = new Set([STREAM.replace(/-1$/, '')]);
        identity = { address: '0xAbC0000000000000000000000000000000000001', sign: vi.fn(async (m) => `sig:${m.length}`) };
        storageFetch.retryDelays = [0, 0];
        install();
    });

    afterEach(() => {
        storageFetch.uninstall();
        vi.clearAllMocks();
    });

    it('passes non-storage requests straight through', async () => {
        await globalThis.fetch('https://polygon.drpc.org', { method: 'POST' });
        await globalThis.fetch(`${BASE}/capabilities`);
        expect(fetchMock).toHaveBeenCalledTimes(2);
        expect(fetchMock.mock.calls[0]).toEqual(['https://polygon.drpc.org', { method: 'POST' }]);
        expect(endpoints.probeCapabilities).not.toHaveBeenCalled();
    });

    it('signs a gated read on a node announcing signedReads and pairs it with a metadata read', async () => {
        fetchMock.mockImplementation(async (url) => String(url).includes('format=metadata')
            ? ok([{ timestamp: 1000, sequenceNumber: 0, storedAt: 1005 }, { timestamp: 2000, sequenceNumber: 1, storedAt: 2500 }])
            : ok('frames'));
        const resp = await globalThis.fetch(readUrl(STREAM), { signal: undefined });
        expect(resp.status).toBe(200);
        expect(endpoints.probeCapabilities).toHaveBeenCalledWith(BASE);

        const raw = callsTo('format=raw');
        expect(raw).toHaveLength(1);
        const h = headersOf(raw[0]);
        expect(h.get('x-pombo-user')).toBe(identity.address);
        expect(h.get('x-pombo-issued-at')).toMatch(/^\d{13}$/);
        expect(h.get('x-pombo-nonce')).toMatch(/^[0-9a-f]{32}$/);
        expect(h.get('x-pombo-signature')).toMatch(/^sig:/);

        const meta = callsTo('format=metadata');
        expect(meta).toHaveLength(1);
        expect(headersOf(meta[0]).get('x-pombo-user')).toBe(identity.address);
        expect(headersOf(meta[0]).get('x-pombo-nonce')).not.toBe(h.get('x-pombo-nonce'));
        expect(identity.sign).toHaveBeenCalledTimes(2);

        expect(storageFetch.storedAtFor(STREAM, 0, 1000, 0)).toBe(1005);
        expect(storageFetch.storedAtFor(STREAM, 0, 2000, 1)).toBe(2500);
        expect(storageFetch.storedAtFor(STREAM, 0, 3000, 0)).toBeUndefined();
        expect(storageFetch.lastReadError(STREAM)).toBeUndefined();
    });

    it('never signs the admin stream, but still collects its storedAt', async () => {
        await globalThis.fetch(readUrl(ADMIN));
        const raw = callsTo('format=raw');
        expect(headersOf(raw[0]).has('x-pombo-user')).toBe(false);
        expect(callsTo('format=metadata')).toHaveLength(1);
        expect(headersOf(callsTo('format=metadata')[0]).has('x-pombo-user')).toBe(false);
    });

    it('signs the keys stream of a gated channel', async () => {
        await globalThis.fetch(readUrl(KEYS, 1));
        expect(headersOf(callsTo('format=raw')[0]).get('x-pombo-user')).toBe(identity.address);
    });

    it('leaves non-gated reads and vanilla nodes alone', async () => {
        gated = new Set();
        await globalThis.fetch(readUrl(STREAM));
        expect(fetchMock).toHaveBeenCalledTimes(1);
        expect(headersOf(fetchMock.mock.calls[0]).has('x-pombo-user')).toBe(false);

        vi.clearAllMocks();
        gated = new Set([STREAM.replace(/-1$/, '')]);
        features = new Set();
        await globalThis.fetch(readUrl(STREAM));
        expect(fetchMock).toHaveBeenCalledTimes(1);
        expect(headersOf(fetchMock.mock.calls[0]).has('x-pombo-user')).toBe(false);
    });

    it('does not sign without an identity (guest) and records the 401', async () => {
        identity = null;
        fetchMock.mockImplementation(async (url) => String(url).includes('format=metadata') ? ok([], 401) : ok('', 401));
        const resp = await globalThis.fetch(readUrl(STREAM));
        expect(resp.status).toBe(401);
        expect(callsTo('format=raw')).toHaveLength(1);
        expect(storageFetch.lastReadError(STREAM)).toMatchObject({ status: 401, signed: false });
    });

    it('answers a 401 on a read it did not know was gated by signing once', async () => {
        gated = new Set();
        let rawCalls = 0;
        fetchMock.mockImplementation(async (url, init) => {
            if (String(url).includes('format=metadata')) return ok([]);
            rawCalls++;
            return new Headers(init.headers).has('x-pombo-user') ? ok('frames') : ok('', 401);
        });
        const resp = await globalThis.fetch(readUrl(STREAM));
        expect(resp.status).toBe(200);
        expect(rawCalls).toBe(2);
        expect(storageFetch.lastReadError(STREAM)).toBeUndefined();
    });

    it('records a 403 as refused access, signed', async () => {
        fetchMock.mockImplementation(async () => ok('', 403));
        const resp = await globalThis.fetch(readUrl(STREAM));
        expect(resp.status).toBe(403);
        expect(callsTo('format=raw')).toHaveLength(1);
        expect(storageFetch.lastReadError(STREAM)).toMatchObject({ status: 403, signed: true });
        expect(storageFetch.lastReadError(KEYS)).toBeUndefined();
    });

    it('retries a 503 with backoff and gives up after the last delay', async () => {
        fetchMock.mockImplementation(async (url) => String(url).includes('format=metadata') ? ok([]) : ok('', 503));
        const resp = await globalThis.fetch(readUrl(STREAM));
        expect(resp.status).toBe(503);
        expect(callsTo('format=raw')).toHaveLength(3);
        expect(storageFetch.lastReadError(STREAM)).toMatchObject({ status: 503 });

        vi.clearAllMocks();
        let n = 0;
        fetchMock.mockImplementation(async (url) => String(url).includes('format=metadata') ? ok([]) : (n++ === 0 ? ok('', 503) : ok('frames')));
        const again = await globalThis.fetch(readUrl(STREAM));
        expect(again.status).toBe(200);
        expect(callsTo('format=raw')).toHaveLength(2);
        expect(storageFetch.lastReadError(STREAM)).toBeUndefined();
    });

    it('a failed metadata read only costs the storedAt', async () => {
        fetchMock.mockImplementation(async (url) => String(url).includes('format=metadata')
            ? Promise.reject(new Error('boom'))
            : ok('frames'));
        const resp = await globalThis.fetch(readUrl(STREAM));
        expect(resp.status).toBe(200);
        expect(storageFetch.storedAtFor(STREAM, 0, 1000, 0)).toBeUndefined();
    });

    it('preserves caller headers and options on the signed request', async () => {
        await globalThis.fetch(readUrl(STREAM), { headers: { 'x-custom': '1' }, signal: null, cache: 'no-store' });
        const call = callsTo('format=raw')[0];
        expect(headersOf(call).get('x-custom')).toBe('1');
        expect(call[1].cache).toBe('no-store');
    });

    describe('judgeMessage', () => {
        it('prefers storedAt and flags a forward-dated message', () => {
            storageFetch.remember(STREAM, 0, 5000, 2, 5100);
            const message = { getTimestamp: () => 5000, getSequenceNumber: () => 2 };
            expect(storageFetch.judgeMessage(STREAM, 0, message)).toEqual({
                timestamp: 5000, storedAt: 5100, judgeTime: 5100, forwardDated: false
            });

            const tolerance = CONFIG.storageMedia.storedAtToleranceMs;
            storageFetch.remember(STREAM, 0, 5100 + tolerance + 1, 0, 5100);
            expect(storageFetch.judgeMessage(STREAM, 0, { timestamp: 5100 + tolerance + 1, sequenceNumber: 0 }).forwardDated).toBe(true);
            storageFetch.remember(STREAM, 0, 5100 + tolerance, 0, 5100);
            expect(storageFetch.judgeMessage(STREAM, 0, { timestamp: 5100 + tolerance, sequenceNumber: 0 }).forwardDated).toBe(false);
        });

        it('falls back to the declared timestamp when the node gave no storedAt', () => {
            expect(storageFetch.judgeMessage(STREAM, 0, { timestamp: 7000, messageId: { sequenceNumber: 3 } })).toEqual({
                timestamp: 7000, storedAt: undefined, judgeTime: 7000, forwardDated: false
            });
        });
    });
});
