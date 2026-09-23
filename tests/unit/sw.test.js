/**
 * Service worker push verification.
 *
 * sw.js is a classic worker script, not a module, so it is loaded into a vm
 * context with the worker globals stubbed; every top-level function is then
 * reachable on that context. What is pinned here is the part that decides
 * whether anything is shown: which reads carry a signature, which answers are
 * worth asking a second node about, and what a notification may say.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import vm from 'vm';

const SW_PATH = join(dirname(fileURLToPath(import.meta.url)), '../../sw.js');

function loadWorker({ windows = [], fetchImpl = vi.fn() } = {}) {
    const listeners = {};
    const context = {
        console: { log: vi.fn(), warn: vi.fn(), error: vi.fn() },
        setTimeout,
        clearTimeout,
        fetch: fetchImpl,
        AbortController,
        Headers,
        URL,
        indexedDB: { open: vi.fn() },
        MessageChannel,
        caches: { open: vi.fn() },
        Response,
        self: {
            addEventListener: (name, fn) => { listeners[name] = fn; },
            clients: { matchAll: vi.fn().mockResolvedValue(windows) },
            registration: { showNotification: vi.fn() },
            skipWaiting: vi.fn()
        }
    };
    context.self.self = context.self;
    vm.createContext(context);
    new vm.Script(readFileSync(SW_PATH, 'utf8')).runInContext(context);
    return { context, listeners };
}

/** A page that answers a signature request, or ignores it. */
const windowThatSigns = (headers) => ({
    postMessage: (_data, ports) => {
        if (headers === undefined) return;   // never answers
        ports[0].postMessage({ headers });
    }
});

const okResponse = (body) => ({
    ok: true,
    status: 200,
    json: async () => body
});

describe('service worker verification', () => {
    let fetchImpl;

    beforeEach(() => {
        fetchImpl = vi.fn();
    });

    const row = [{ timestamp: 2000, publisherId: '0xabc', content: { type: 'text', text: 'hi' } }];

    it('signs the read of a stream the node will not serve unsigned', async () => {
        fetchImpl.mockResolvedValue(okResponse(row));
        const { context } = loadWorker({
            windows: [windowThatSigns({ 'x-pombo-user': '0xme' })],
            fetchImpl
        });

        const result = await context.verifyChannel({
            streamId: '0xowner/gated-1',
            lastTimestamp: 1000,
            storageEndpoints: ['https://a.test'],
            needsSignature: true
        });

        expect(result.hasNew).toBe(true);
        expect(fetchImpl).toHaveBeenCalledTimes(1);
        expect(fetchImpl.mock.calls[0][1].headers['x-pombo-user']).toBe('0xme');
    });

    it('reads a public stream without asking anyone to sign', async () => {
        fetchImpl.mockResolvedValue(okResponse(row));
        const signer = vi.fn();
        const { context } = loadWorker({
            windows: [{ postMessage: signer }],
            fetchImpl
        });

        const result = await context.verifyChannel({
            streamId: '0xowner/public-1',
            lastTimestamp: 0,
            storageEndpoints: ['https://a.test'],
            needsSignature: false
        });

        expect(result.hasNew).toBe(true);
        expect(signer).not.toHaveBeenCalled();
        expect(fetchImpl.mock.calls[0][1].headers['x-pombo-user']).toBeUndefined();
    });

    it('stays silent when no window is open to sign', async () => {
        const { context } = loadWorker({ windows: [], fetchImpl });

        const result = await context.verifyChannel({
            streamId: '0xowner/gated-1',
            lastTimestamp: 0,
            storageEndpoints: ['https://a.test', 'https://b.test'],
            needsSignature: true
        });

        expect(result.hasNew).toBe(false);
        expect(fetchImpl).not.toHaveBeenCalled();
    });

    it('stays silent when the open window refuses to sign', async () => {
        const { context } = loadWorker({ windows: [windowThatSigns(null)], fetchImpl });

        const result = await context.verifyChannel({
            streamId: '0xowner/gated-1',
            lastTimestamp: 0,
            storageEndpoints: ['https://a.test'],
            needsSignature: true
        });

        expect(result.hasNew).toBe(false);
        expect(fetchImpl).not.toHaveBeenCalled();
    });

    it('does not ask a second node about a refusal', async () => {
        fetchImpl.mockResolvedValue({ ok: false, status: 403, json: async () => ({}) });
        const { context } = loadWorker({
            windows: [windowThatSigns({ 'x-pombo-user': '0xme' })],
            fetchImpl
        });

        const result = await context.verifyChannel({
            streamId: '0xowner/gated-1',
            lastTimestamp: 0,
            storageEndpoints: ['https://a.test', 'https://b.test'],
            needsSignature: true
        });

        expect(result.hasNew).toBe(false);
        expect(fetchImpl).toHaveBeenCalledTimes(1);
    });

    it('asks the next node when one fails as a node', async () => {
        fetchImpl
            .mockResolvedValueOnce({ ok: false, status: 503, json: async () => ({}) })
            .mockResolvedValueOnce(okResponse(row));
        const { context } = loadWorker({ windows: [], fetchImpl });

        const result = await context.verifyChannel({
            streamId: '0xowner/public-1',
            lastTimestamp: 0,
            storageEndpoints: ['https://a.test', 'https://b.test'],
            needsSignature: false
        });

        expect(result.hasNew).toBe(true);
        expect(fetchImpl).toHaveBeenCalledTimes(2);
        expect(fetchImpl.mock.calls[1][0]).toContain('b.test');
    });

    describe('a channel whose storage moved', () => {
        const STREAM = '0xowner/public-1';
        const older = [{ timestamp: 1000, publisherId: '0xabc', content: { type: 'text', text: 'old' } }];
        const graph = (urls) => okResponse({
            data: { stream: { storageNodes: urls.map((u) => ({ metadata: JSON.stringify({ urls: [u] }) })) } }
        });

        /** A worker whose fetches are answered by URL prefix, with The Graph configured. */
        function worker(routes, windows = []) {
            fetchImpl.mockImplementation(async (url) => {
                const route = routes.find(([prefix]) => url.startsWith(prefix));
                if (!route) throw new Error(`unexpected fetch ${url}`);
                return route[1];
            });
            const { context } = loadWorker({ windows, fetchImpl });
            context.getConfig = async (key) => (key === 'graphUrl' ? 'https://graph.test/q' : null);
            context.rememberProviders = vi.fn(async () => {});
            return context;
        }
        const graphCalls = () => fetchImpl.mock.calls.filter(([url]) => url.startsWith('https://graph.test'));

        it('asks the providers the chain has now when the registered ones have nothing new', async () => {
            const context = worker([
                ['https://old.test', okResponse(older)],
                ['https://graph.test', graph(['https://new.test/'])],
                ['https://new.test', okResponse(row)]
            ]);

            const result = await context.verifyChannel({
                streamId: STREAM, lastTimestamp: 1500, storageEndpoints: ['https://old.test'], needsSignature: false
            });

            expect(result.hasNew).toBe(true);
            expect(context.rememberProviders).toHaveBeenCalledWith(STREAM, ['https://new.test']);
        });

        it('asks the chain when a registration has no providers at all', async () => {
            const context = worker([
                ['https://graph.test', graph(['https://new.test'])],
                ['https://new.test', okResponse(row)]
            ]);

            const result = await context.verifyChannel({
                streamId: STREAM, lastTimestamp: 0, storageEndpoints: [], needsSignature: false
            });

            expect(result.hasNew).toBe(true);
        });

        it('does not ask the chain again within the refresh window', async () => {
            const context = worker([['https://old.test', okResponse(older)]]);

            const result = await context.verifyChannel({
                streamId: STREAM, lastTimestamp: 1500, storageEndpoints: ['https://old.test'],
                needsSignature: false, providersCheckedAt: Date.now()
            });

            expect(result.hasNew).toBe(false);
            expect(graphCalls()).toHaveLength(0);
        });

        it('keeps its answer when the providers have not changed', async () => {
            const context = worker([
                ['https://old.test', okResponse(older)],
                ['https://graph.test', graph(['https://old.test'])]
            ]);

            const result = await context.verifyChannel({
                streamId: STREAM, lastTimestamp: 1500, storageEndpoints: ['https://old.test'], needsSignature: false
            });

            expect(result.hasNew).toBe(false);
            expect(fetchImpl.mock.calls.filter(([url]) => url.startsWith('https://old.test'))).toHaveLength(1);
            expect(context.rememberProviders).toHaveBeenCalledWith(STREAM, ['https://old.test']);
        });

        it('never keeps a provider URL a page could not reach', async () => {
            const context = worker([
                ['https://old.test', okResponse(older)],
                ['https://graph.test', graph(['http://plain.test', 'https://10.0.0.1', 'https://ok.test'])],
                ['https://ok.test', okResponse(older)]
            ]);

            await context.verifyChannel({
                streamId: STREAM, lastTimestamp: 1500, storageEndpoints: ['https://old.test'], needsSignature: false
            });

            expect(context.rememberProviders).toHaveBeenCalledWith(STREAM, ['https://ok.test']);
        });

        it('asks the chain nothing while no window is open to sign', async () => {
            const context = worker([]);

            const result = await context.verifyChannel({
                streamId: STREAM, lastTimestamp: 0, storageEndpoints: ['https://old.test'], needsSignature: true
            });

            expect(result.hasNew).toBe(false);
            expect(graphCalls()).toHaveLength(0);
        });

        it('stays silent when The Graph cannot be asked', async () => {
            const context = worker([['https://old.test', okResponse(older)]]);
            context.getConfig = async () => null;

            const result = await context.verifyChannel({
                streamId: STREAM, lastTimestamp: 1500, storageEndpoints: ['https://old.test'], needsSignature: false
            });

            expect(result.hasNew).toBe(false);
            expect(graphCalls()).toHaveLength(0);
        });
    });

    it('treats nothing newer than the watermark as a false positive', async () => {
        fetchImpl.mockResolvedValue(okResponse(row));
        const { context } = loadWorker({ windows: [], fetchImpl });

        const result = await context.verifyChannel({
            streamId: '0xowner/public-1',
            lastTimestamp: 2000,
            storageEndpoints: ['https://a.test'],
            needsSignature: false
        });

        expect(result.hasNew).toBe(false);
        expect(result.content).toBe(null);
    });

    describe('what a notification may say', () => {
        it('never repeats what was said in a channel it cannot read', () => {
            const { context } = loadWorker();
            const content = { type: 'text', text: 'secret' };
            expect(context.getMessagePreview({ type: 'gated', content })).toBe('New message');
            // Labels older installs may still be registered under.
            expect(context.getMessagePreview({ type: 'native', content })).toBe('New message');
            expect(context.getMessagePreview({ type: 'private', content })).toBe('New message');
        });

        it('says only that a direct message arrived', () => {
            const { context } = loadWorker();
            expect(context.getMessagePreview({ type: 'dm', content: null }))
                .toBe('You have a new message');
        });

        it('shows what was said in a public channel', () => {
            const { context } = loadWorker();
            expect(context.getMessagePreview({ type: 'public', content: { type: 'text', text: 'hello' } }))
                .toBe('hello');
            expect(context.getMessagePreview({ type: 'public', content: { type: 'image' } }))
                .toBe('📷 Image');
        });
    });
});
