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
const BASE2 = 'https://2.storage.example';
const STREAM = '0xaaaabbbbccccddddeeeeffff0000111122223333/deadbeef01-1';
const KEYS = '0xaaaabbbbccccddddeeeeffff0000111122223333/deadbeef01-4';
const ADMIN = '0xaaaabbbbccccddddeeeeffff0000111122223333/deadbeef01-3';
const enc = encodeURIComponent;
const readUrl = (stream, partition = 0, type = 'last', query = 'count=50&format=raw') =>
    `${BASE}/streams/${enc(stream)}/data/partitions/${partition}/${type}?${query}`;
const HEADERS_TIMEOUT_MS = CONFIG.storageMedia.readHeadersTimeoutMs;

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
    let rotationUrls;
    let ejected;
    const endpoints = {
        probeCapabilities: vi.fn(async () => features),
        rotation: vi.fn(async () => rotationUrls),
        isEjected: vi.fn((url) => ejected.has(url)),
        noteFailure: vi.fn(),
        noteSuccess: vi.fn(),
        probeRecovery: vi.fn()
    };

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
        rotationUrls = [BASE];
        ejected = new Set();
        storageFetch.retryDelays = [0, 0];
        install();
    });

    afterEach(() => {
        storageFetch.uninstall();
        CONFIG.storageMedia.readHeadersTimeoutMs = HEADERS_TIMEOUT_MS;
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

    it('reads a non-gated stream unsigned, with its storedAt, and leaves vanilla nodes alone', async () => {
        gated = new Set();
        await globalThis.fetch(readUrl(STREAM));
        expect(fetchMock).toHaveBeenCalledTimes(2);
        expect(headersOf(callsTo('format=raw')[0]).has('x-pombo-user')).toBe(false);
        expect(headersOf(callsTo('format=metadata')[0]).has('x-pombo-user')).toBe(false);

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

    it('refuses a page whose storedAt the node did not supply, after a second try', async () => {
        fetchMock.mockImplementation(async (url) => {
            if (String(url).includes('format=metadata')) throw new Error('timed out');
            return ok('frames');
        });
        const resp = await globalThis.fetch(readUrl(STREAM));
        expect(resp.status).toBe(503);
        expect(callsTo('format=metadata')).toHaveLength(2);
        expect(callsTo('format=raw')).toHaveLength(1);
        expect(storageFetch.lastReadError(STREAM)).toMatchObject({ status: 503, signed: true, reason: 'storedAt' });
    });

    it('asks for storedAt on a public stream too, unsigned, and refuses the page without it', async () => {
        gated = new Set();
        fetchMock.mockImplementation(async (url) => String(url).includes('format=metadata') ? ok([]) : ok('frames'));
        expect((await globalThis.fetch(readUrl(STREAM))).status).toBe(200);
        expect(callsTo('format=metadata')).toHaveLength(1);
        expect(headersOf(callsTo('format=metadata')[0]).has('x-pombo-user')).toBe(false);

        vi.clearAllMocks();
        fetchMock.mockImplementation(async (url) => String(url).includes('format=metadata') ? ok('', 500) : ok('frames'));
        expect((await globalThis.fetch(readUrl(STREAM))).status).toBe(503);
        expect(storageFetch.lastReadError(STREAM)).toMatchObject({ reason: 'storedAt' });
    });

    it('signs the reads of the own DM inbox, storedAt included, and not those of another inbox', async () => {
        const own = `${identity.address.toLowerCase()}/Pombo-DM-1`;
        await globalThis.fetch(readUrl(own));
        expect(headersOf(callsTo('format=raw')[0]).get('x-pombo-user')).toBe(identity.address);
        expect(headersOf(callsTo('format=metadata')[0]).get('x-pombo-user')).toBe(identity.address);

        vi.clearAllMocks();
        await globalThis.fetch(readUrl('0xabc0000000000000000000000000000000000002/Pombo-DM-1'));
        expect(headersOf(callsTo('format=raw')[0]).has('x-pombo-user')).toBe(false);
        expect(callsTo('format=metadata')).toHaveLength(1);
    });

    it('refuses the page at once when the node answers the storedAt read with an error', async () => {
        fetchMock.mockImplementation(async (url) => String(url).includes('format=metadata') ? ok('', 503) : ok('frames'));
        const resp = await globalThis.fetch(readUrl(STREAM));
        expect(resp.status).toBe(503);
        expect(callsTo('format=metadata')).toHaveLength(1);
        expect(storageFetch.lastReadError(STREAM)).toMatchObject({ status: 503, reason: 'storedAt' });
    });

    it('stops asking for storedAt once the raw read was abandoned', async () => {
        const ctrl = new AbortController();
        fetchMock.mockImplementation(async (url, init) => {
            if (String(url).includes('format=metadata')) {
                if (init.signal.aborted) throw new Error('aborted');
                return new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(new Error('aborted'))));
            }
            ctrl.abort();
            return ok('frames');
        });
        const resp = await globalThis.fetch(readUrl(STREAM), { signal: ctrl.signal });
        expect(resp.status).toBe(503);
        expect(callsTo('format=metadata')).toHaveLength(1);
        expect(storageFetch.lastReadError(STREAM)).toMatchObject({ reason: 'storedAt' });
    });

    it('signs once after a 401 even when the capabilities probe failed, and demands storedAt from then on', async () => {
        endpoints.probeCapabilities.mockResolvedValueOnce(undefined);
        let rawCalls = 0;
        fetchMock.mockImplementation(async (url, init) => {
            if (String(url).includes('format=metadata')) return ok([]);
            rawCalls++;
            return new Headers(init.headers).has('x-pombo-user') ? ok('frames') : ok('', 401);
        });
        const resp = await globalThis.fetch(readUrl(STREAM));
        expect(resp.status).toBe(200);
        expect(rawCalls).toBe(2);
        expect(callsTo('format=metadata')).toHaveLength(1);
        expect(storageFetch.lastReadError(STREAM)).toBeUndefined();
    });

    it('refuses the page of a node that asked for a signature but gave no storedAt, probe or no probe', async () => {
        endpoints.probeCapabilities.mockResolvedValueOnce(undefined);
        fetchMock.mockImplementation(async (url, init) => {
            if (String(url).includes('format=metadata')) return ok('', 500);
            return new Headers(init.headers).has('x-pombo-user') ? ok('frames') : ok('', 401);
        });
        const resp = await globalThis.fetch(readUrl(STREAM));
        expect(resp.status).toBe(503);
        expect(storageFetch.lastReadError(STREAM)).toMatchObject({ status: 503, signed: true, reason: 'storedAt' });
    });

    it('records a 403 as refused access, signed', async () => {
        fetchMock.mockImplementation(async () => ok('', 403));
        const resp = await globalThis.fetch(readUrl(STREAM));
        expect(resp.status).toBe(403);
        expect(callsTo('format=raw')).toHaveLength(1);
        expect(storageFetch.lastReadError(STREAM)).toMatchObject({ status: 403, signed: true });
        expect(storageFetch.lastReadError(STREAM, 0)).toMatchObject({ status: 403, signed: true });
        expect(storageFetch.lastReadError(STREAM, 1)).toBeUndefined();
        expect(storageFetch.lastReadError(KEYS)).toBeUndefined();
    });

    it('keeps a partition refusal when another partition of the stream succeeds', async () => {
        fetchMock.mockImplementation(async (url) => String(url).includes('/partitions/0/') ? ok('', 403) : ok([]));
        await globalThis.fetch(readUrl(STREAM, 0));
        await globalThis.fetch(readUrl(STREAM, 1));
        expect(storageFetch.lastReadError(STREAM, 0)).toMatchObject({ status: 403 });
        expect(storageFetch.lastReadError(STREAM, 1)).toBeUndefined();
        expect(storageFetch.lastReadError(STREAM)).toMatchObject({ status: 403 });
        storageFetch.clearReadError(STREAM);
        expect(storageFetch.lastReadError(STREAM)).toBeUndefined();
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

    it('keeps the page on a node that does not announce storedAt, without asking for it', async () => {
        features = new Set(['metadata', 'purge', 'signedReads']);
        fetchMock.mockImplementation(async (url) => String(url).includes('format=metadata')
            ? Promise.reject(new Error('boom'))
            : ok('frames'));
        const resp = await globalThis.fetch(readUrl(STREAM));
        expect(resp.status).toBe(200);
        expect(callsTo('format=metadata')).toHaveLength(0);
        expect(storageFetch.storedAtFor(STREAM, 0, 1000, 0)).toBeUndefined();
        expect(storageFetch.lastReadError(STREAM)).toBeUndefined();
    });

    it('preserves caller headers and options on the signed request', async () => {
        await globalThis.fetch(readUrl(STREAM), { headers: { 'x-custom': '1' }, signal: null, cache: 'no-store' });
        const call = callsTo('format=raw')[0];
        expect(headersOf(call).get('x-custom')).toBe('1');
        expect(call[1].cache).toBe('no-store');
    });

    describe('failover between node URLs', () => {
        const rawAt = (base) => callsTo('format=raw').filter((c) => String(c[0]).startsWith(base));
        const metaAt = (base) => callsTo('format=metadata').filter((c) => String(c[0]).startsWith(base));
        const dead = () => { throw new TypeError('Failed to fetch'); };
        const serving = async (url) => (String(url).includes('format=metadata') ? ok([]) : ok('frames'));

        beforeEach(() => {
            rotationUrls = [BASE, BASE2];
            gated = new Set();
        });

        it('reads from the next URL when the node gives no answer, with the storedAt read paired to it', async () => {
            fetchMock.mockImplementation(async (url) => {
                if (String(url).startsWith(BASE)) dead();
                return String(url).includes('format=metadata') ? ok([{ timestamp: 1, sequenceNumber: 0, storedAt: 2 }]) : ok('frames');
            });
            const resp = await globalThis.fetch(readUrl(STREAM));
            expect(resp.status).toBe(200);
            expect(rawAt(BASE)).toHaveLength(1);
            expect(rawAt(BASE2)).toHaveLength(1);
            expect(metaAt(BASE2)).toHaveLength(1);
            expect(endpoints.rotation).toHaveBeenCalledWith(STREAM);
            expect(endpoints.noteFailure).toHaveBeenCalledWith(BASE);
            expect(endpoints.noteSuccess).toHaveBeenCalledWith(BASE2);
            expect(storageFetch.storedAtFor(STREAM, 0, 1, 0)).toBe(2);
            expect(storageFetch.lastReadError(STREAM)).toBeUndefined();
        });

        it('costs nothing when the first node answers: the rotation is never consulted', async () => {
            fetchMock.mockImplementation(serving);
            expect((await globalThis.fetch(readUrl(STREAM))).status).toBe(200);
            expect(endpoints.rotation).not.toHaveBeenCalled();
            expect(endpoints.noteFailure).not.toHaveBeenCalled();
            expect(endpoints.noteSuccess).toHaveBeenCalledWith(BASE);
        });

        it('signs the read afresh for the next URL', async () => {
            gated = new Set([STREAM.replace(/-1$/, '')]);
            fetchMock.mockImplementation(async (url) => {
                if (String(url).startsWith(BASE)) dead();
                return serving(url);
            });
            await globalThis.fetch(readUrl(STREAM));
            const [first] = rawAt(BASE);
            const [second] = rawAt(BASE2);
            expect(headersOf(first).get('x-pombo-user')).toBe(identity.address);
            expect(headersOf(second).get('x-pombo-user')).toBe(identity.address);
            expect(headersOf(second).get('x-pombo-nonce')).not.toBe(headersOf(first).get('x-pombo-nonce'));
        });

        it('asks the next URL at the first 503 and backs off only on the last one', async () => {
            fetchMock.mockImplementation(async (url) => (String(url).includes('format=metadata') ? ok([]) : ok('', 503)));
            const resp = await globalThis.fetch(readUrl(STREAM));
            expect(resp.status).toBe(503);
            expect(rawAt(BASE)).toHaveLength(1);
            expect(rawAt(BASE2)).toHaveLength(3);
            expect(endpoints.noteFailure).toHaveBeenCalledWith(BASE);
            expect(endpoints.noteFailure).toHaveBeenCalledWith(BASE2);
            expect(storageFetch.lastReadError(STREAM)).toMatchObject({ status: 503, url: BASE2 });
        });

        it('never fails over on a 4xx: the node answered about the request', async () => {
            fetchMock.mockImplementation(async (url) => (String(url).includes('format=metadata') ? ok([]) : ok('', 403)));
            const resp = await globalThis.fetch(readUrl(STREAM));
            expect(resp.status).toBe(403);
            expect(rawAt(BASE)).toHaveLength(1);
            expect(rawAt(BASE2)).toHaveLength(0);
            expect(endpoints.noteFailure).not.toHaveBeenCalled();
            expect(endpoints.rotation).not.toHaveBeenCalled();
        });

        it('moves on when the node does not start answering within the headers timeout', async () => {
            CONFIG.storageMedia.readHeadersTimeoutMs = 20;
            fetchMock.mockImplementation((url, init) => {
                if (String(url).startsWith(BASE)) {
                    return new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(new Error('aborted'))));
                }
                return serving(url);
            });
            const resp = await globalThis.fetch(readUrl(STREAM));
            expect(resp.status).toBe(200);
            expect(rawAt(BASE)).toHaveLength(1);
            expect(rawAt(BASE2)).toHaveLength(1);
            expect(endpoints.noteFailure).toHaveBeenCalledWith(BASE);
        });

        it('skips a URL already out of the rotation and has it probed out of band', async () => {
            ejected = new Set([BASE]);
            fetchMock.mockImplementation(serving);
            const resp = await globalThis.fetch(readUrl(STREAM));
            expect(resp.status).toBe(200);
            expect(rawAt(BASE)).toHaveLength(0);
            expect(rawAt(BASE2)).toHaveLength(1);
            expect(endpoints.probeRecovery).toHaveBeenCalledWith(BASE);
            expect(endpoints.noteFailure).not.toHaveBeenCalled();
        });

        it('still reads from an ejected URL when it is the only one', async () => {
            ejected = new Set([BASE]);
            rotationUrls = [];
            fetchMock.mockImplementation(serving);
            const resp = await globalThis.fetch(readUrl(STREAM));
            expect(resp.status).toBe(200);
            expect(rawAt(BASE)).toHaveLength(1);
            expect(endpoints.probeRecovery).not.toHaveBeenCalled();
        });

        it('does not fail over when the caller gave up', async () => {
            const ctrl = new AbortController();
            fetchMock.mockImplementation(async (url) => {
                if (String(url).includes('format=metadata')) return ok([]);
                ctrl.abort();
                throw new Error('aborted');
            });
            await expect(globalThis.fetch(readUrl(STREAM), { signal: ctrl.signal })).rejects.toThrow('aborted');
            expect(rawAt(BASE2)).toHaveLength(0);
            expect(endpoints.noteFailure).not.toHaveBeenCalled();
        });

        it('throws the last error once every URL failed', async () => {
            fetchMock.mockImplementation(async () => dead());
            await expect(globalThis.fetch(readUrl(STREAM))).rejects.toThrow('Failed to fetch');
            expect(rawAt(BASE)).toHaveLength(1);
            expect(rawAt(BASE2)).toHaveLength(1);
            expect(endpoints.noteFailure).toHaveBeenCalledTimes(2);
        });

        it('takes a page served without its storedAt to the next URL and counts it against the node', async () => {
            fetchMock.mockImplementation(async (url) => {
                if (String(url).includes('format=metadata')) return String(url).startsWith(BASE) ? ok('', 500) : ok([]);
                return ok('frames');
            });
            const resp = await globalThis.fetch(readUrl(STREAM));
            expect(resp.status).toBe(200);
            expect(rawAt(BASE)).toHaveLength(1);
            expect(rawAt(BASE2)).toHaveLength(1);
            expect(endpoints.noteFailure).toHaveBeenCalledWith(BASE);
            expect(storageFetch.lastReadError(STREAM)).toBeUndefined();
        });

        it('leaves the direct reads to their callers: nothing fails over without format=raw', async () => {
            fetchMock.mockImplementation(async () => dead());
            await expect(globalThis.fetch(readUrl(STREAM, 0, 'range', 'fromTimestamp=1&toTimestamp=2&format=metadata')))
                .rejects.toThrow('Failed to fetch');
            expect(endpoints.rotation).not.toHaveBeenCalled();
            expect(endpoints.noteFailure).not.toHaveBeenCalled();
            expect(fetchMock.mock.calls.every((c) => String(c[0]).startsWith(BASE))).toBe(true);
        });
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
