/**
 * Tests for storageEndpoints.js — on-chain storage endpoint resolution,
 * caching, health rotation and format=metadata capability tracking.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../../src/js/logger.js', () => ({
    Logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }
}));

const mockClient = {
    getStream: vi.fn(),
    getStorageNodeMetadata: vi.fn()
};

vi.mock('../../src/js/streamr.js', () => ({
    streamrController: { get client() { return mockClient; } },
    isWebSafeStorageNodeUrl: (u) => typeof u === 'string' && u.startsWith('https://') && !u.includes('localhost')
}));

import { storageEndpoints } from '../../src/js/storageEndpoints.js';
import { CONFIG } from '../../src/js/config.js';

const NODE_A = '0xAAA0000000000000000000000000000000000001';
const NODE_B = '0xBBB0000000000000000000000000000000000002';

describe('storageEndpoints', () => {
    beforeEach(() => {
        storageEndpoints.clear();
        vi.clearAllMocks();
        mockClient.getStream.mockResolvedValue({
            getStorageNodes: () => Promise.resolve([NODE_A, NODE_B])
        });
        mockClient.getStorageNodeMetadata.mockImplementation((addr) => {
            if (addr === NODE_A) return Promise.resolve({ urls: ['https://node-a.example/', 'http://insecure.example'] });
            if (addr === NODE_B) return Promise.resolve({ urls: ['https://node-b.example'] });
            return Promise.reject(new Error('unknown node'));
        });
    });

    it('resolves nodes and filters non-web-safe URLs', async () => {
        const nodes = await storageEndpoints.resolve('0xchan/foo-1');
        expect(nodes).toHaveLength(2);
        expect(nodes[0]).toEqual({ nodeAddress: NODE_A.toLowerCase(), urls: ['https://node-a.example'] });
        expect(nodes[1].urls).toEqual(['https://node-b.example']);
    });

    it('drops nodes whose metadata read fails, keeps the rest', async () => {
        mockClient.getStorageNodeMetadata.mockImplementation((addr) =>
            addr === NODE_B ? Promise.resolve({ urls: ['https://node-b.example'] }) : Promise.reject(new Error('rpc down')));
        const nodes = await storageEndpoints.resolve('0xchan/foo-1');
        expect(nodes).toHaveLength(1);
        expect(nodes[0].nodeAddress).toBe(NODE_B.toLowerCase());
    });

    it('drops nodes with no web-safe URL', async () => {
        mockClient.getStorageNodeMetadata.mockResolvedValue({ urls: ['http://plain.example', 'https://localhost:8443'] });
        const nodes = await storageEndpoints.resolve('0xchan/foo-1');
        expect(nodes).toHaveLength(0);
    });

    it('caches per stream within the TTL', async () => {
        await storageEndpoints.resolve('0xchan/foo-1');
        await storageEndpoints.resolve('0xchan/foo-1');
        expect(mockClient.getStream).toHaveBeenCalledTimes(1);
    });

    it('invalidate() forces a fresh resolution', async () => {
        await storageEndpoints.resolve('0xchan/foo-1');
        storageEndpoints.invalidate('0xchan/foo-1');
        await storageEndpoints.resolve('0xchan/foo-1');
        expect(mockClient.getStream).toHaveBeenCalledTimes(2);
    });

    it('handles the array-shaped getStorageNodes return', async () => {
        mockClient.getStream.mockResolvedValue({ getStorageNodes: () => [NODE_A] });
        const nodes = await storageEndpoints.resolve('0xchan/foo-1');
        expect(nodes).toHaveLength(1);
    });

    it('rotation() lists every healthy URL as a slot', async () => {
        const rot = await storageEndpoints.rotation('0xchan/foo-1');
        expect(rot).toEqual(['https://node-a.example', 'https://node-b.example']);
    });

    it('rotation() expands ALL URLs of a multi-URL node (cluster behind one address)', async () => {
        mockClient.getStream.mockResolvedValue({ getStorageNodes: () => Promise.resolve([NODE_A]) });
        mockClient.getStorageNodeMetadata.mockResolvedValue({
            urls: ['https://blob.example', 'https://vps2.blob.example']
        });
        const rot = await storageEndpoints.rotation('0xchan/cluster-1');
        expect(rot).toEqual(['https://blob.example', 'https://vps2.blob.example']);
    });

    it('rotation() interleaves URLs across nodes by index', async () => {
        mockClient.getStream.mockResolvedValue({ getStorageNodes: () => Promise.resolve([NODE_A, NODE_B]) });
        mockClient.getStorageNodeMetadata.mockImplementation((addr) =>
            addr === NODE_A
                ? Promise.resolve({ urls: ['https://a1.example', 'https://a2.example'] })
                : Promise.resolve({ urls: ['https://b1.example'] }));
        const rot = await storageEndpoints.rotation('0xchan/multi-1');
        expect(rot).toEqual(['https://a1.example', 'https://b1.example', 'https://a2.example']);
    });

    it('rotation() ejects a single URL of a multi-URL node, keeps the rest', async () => {
        mockClient.getStream.mockResolvedValue({ getStorageNodes: () => Promise.resolve([NODE_A]) });
        mockClient.getStorageNodeMetadata.mockResolvedValue({
            urls: ['https://blob.example', 'https://vps2.blob.example']
        });
        const limit = CONFIG.storageMedia.nodeFailureLimit;
        for (let i = 0; i < limit; i++) storageEndpoints.noteFailure('https://blob.example');
        const rot = await storageEndpoints.rotation('0xchan/cluster-1');
        expect(rot).toEqual(['https://vps2.blob.example']);
    });

    it('rotation() ejects a node after consecutive failures and restores on success', async () => {
        const limit = CONFIG.storageMedia.nodeFailureLimit;
        for (let i = 0; i < limit; i++) storageEndpoints.noteFailure('https://node-a.example');
        let rot = await storageEndpoints.rotation('0xchan/foo-1');
        expect(rot).toEqual(['https://node-b.example']);

        storageEndpoints.noteSuccess('https://node-a.example');
        rot = await storageEndpoints.rotation('0xchan/foo-1');
        expect(rot).toContain('https://node-a.example');
    });

    it('a success resets the consecutive-failure count', async () => {
        const limit = CONFIG.storageMedia.nodeFailureLimit;
        for (let i = 0; i < limit - 1; i++) storageEndpoints.noteFailure('https://node-a.example');
        storageEndpoints.noteSuccess('https://node-a.example');
        for (let i = 0; i < limit - 1; i++) storageEndpoints.noteFailure('https://node-a.example');
        const rot = await storageEndpoints.rotation('0xchan/foo-1');
        expect(rot).toContain('https://node-a.example');
    });

    it('tracks format=metadata support per URL', () => {
        expect(storageEndpoints.supportsMetaFormat('https://node-a.example')).toBeUndefined();
        storageEndpoints.setMetaFormatSupport('https://node-a.example', false);
        expect(storageEndpoints.supportsMetaFormat('https://node-a.example')).toBe(false);
        // trailing-slash normalization
        expect(storageEndpoints.supportsMetaFormat('https://node-a.example/')).toBe(false);
    });

    describe('capabilities', () => {
        const FORK = ['metadata', 'storedAt', 'purge', 'signedReads'];
        const jsonResponse = (status, body) => ({
            ok: status >= 200 && status < 300,
            status,
            json: () => Promise.resolve(body)
        });
        let fetchMock;

        beforeEach(() => {
            fetchMock = vi.fn();
            vi.stubGlobal('fetch', fetchMock);
        });

        afterEach(() => {
            vi.unstubAllGlobals();
        });

        it('caches the announced features per URL and answers hasFeature', async () => {
            fetchMock.mockResolvedValue(jsonResponse(200, { name: 'pombo-storage-node', features: FORK }));
            const features = await storageEndpoints.probeCapabilities('https://node-a.example/');
            expect([...features]).toEqual(FORK);
            expect(fetchMock).toHaveBeenCalledWith('https://node-a.example/capabilities', expect.any(Object));
            expect(storageEndpoints.hasFeature('https://node-a.example', 'purge')).toBe(true);
            expect(storageEndpoints.hasFeature('https://node-a.example', 'teleport')).toBe(false);

            await storageEndpoints.probeCapabilities('https://node-a.example');
            expect(fetchMock).toHaveBeenCalledTimes(1);
        });

        it('remembers a 404 as a node announcing nothing, without touching the metadata probe', async () => {
            fetchMock.mockResolvedValue(jsonResponse(404, {}));
            const features = await storageEndpoints.probeCapabilities('https://node-b.example');
            expect(features.size).toBe(0);
            expect(storageEndpoints.hasFeature('https://node-b.example', 'metadata')).toBe(false);
            // Production nodes carry format=metadata without /capabilities:
            // the engine's own 400 probe still decides.
            expect(storageEndpoints.supportsMetaFormat('https://node-b.example')).toBeUndefined();
            await storageEndpoints.probeCapabilities('https://node-b.example');
            expect(fetchMock).toHaveBeenCalledTimes(1);
        });

        it('does not cache a failed probe', async () => {
            fetchMock.mockRejectedValueOnce(new Error('network down'));
            expect(await storageEndpoints.probeCapabilities('https://node-a.example')).toBeUndefined();
            expect(storageEndpoints.capabilitiesOf('https://node-a.example')).toBeUndefined();

            fetchMock.mockResolvedValueOnce(jsonResponse(503, {}));
            expect(await storageEndpoints.probeCapabilities('https://node-a.example')).toBeUndefined();

            fetchMock.mockResolvedValueOnce(jsonResponse(200, { features: ['purge'] }));
            expect(storageEndpoints.hasFeature('https://node-a.example', 'purge')).toBe(false);
            await storageEndpoints.probeCapabilities('https://node-a.example');
            expect(storageEndpoints.hasFeature('https://node-a.example', 'purge')).toBe(true);
            expect(fetchMock).toHaveBeenCalledTimes(3);
        });

        it('shares one in-flight probe between concurrent callers', async () => {
            let resolveFetch;
            fetchMock.mockReturnValue(new Promise((r) => { resolveFetch = r; }));
            const a = storageEndpoints.probeCapabilities('https://node-a.example');
            const b = storageEndpoints.probeCapabilities('https://node-a.example/');
            resolveFetch(jsonResponse(200, { features: ['signedReads'] }));
            const [fa, fb] = await Promise.all([a, b]);
            expect(fa).toBe(fb);
            expect(fetchMock).toHaveBeenCalledTimes(1);
        });

        it('announced metadata support feeds supportsMetaFormat, a recorded 400 wins over it', async () => {
            fetchMock.mockResolvedValue(jsonResponse(200, { features: FORK }));
            await storageEndpoints.probeCapabilities('https://node-a.example');
            expect(storageEndpoints.supportsMetaFormat('https://node-a.example')).toBe(true);
            storageEndpoints.setMetaFormatSupport('https://node-a.example', false);
            expect(storageEndpoints.supportsMetaFormat('https://node-a.example')).toBe(false);
        });

        it('ignores a malformed body', async () => {
            fetchMock.mockResolvedValue(jsonResponse(200, { features: 'purge' }));
            const features = await storageEndpoints.probeCapabilities('https://node-a.example');
            expect(features.size).toBe(0);
            fetchMock.mockResolvedValue(jsonResponse(200, { features: ['purge', 7, null] }));
            expect([...await storageEndpoints.probeCapabilities('https://node-b.example')]).toEqual(['purge']);
        });

        it('probeStream unions features per provider and providersWith keeps only announcing URLs', async () => {
            // Provider A fronts a cluster: one URL upgraded, one still vanilla.
            mockClient.getStorageNodeMetadata.mockImplementation((addr) => {
                if (addr === NODE_A) return Promise.resolve({ urls: ['https://a1.example', 'https://a2.example'] });
                if (addr === NODE_B) return Promise.resolve({ urls: ['https://node-b.example'] });
                return Promise.reject(new Error('unknown node'));
            });
            fetchMock.mockImplementation((url) => {
                if (url.startsWith('https://a1.example')) return Promise.resolve(jsonResponse(200, { features: FORK }));
                return Promise.resolve(jsonResponse(404, {}));
            });

            const providers = await storageEndpoints.probeStream('0xchan/foo-1');
            expect(providers).toHaveLength(2);
            expect([...providers[0].features]).toEqual(FORK);
            expect(providers[1].features.size).toBe(0);
            expect(fetchMock).toHaveBeenCalledTimes(3);

            const purgers = await storageEndpoints.providersWith('0xchan/foo-1', 'purge');
            expect(purgers).toEqual([{ nodeAddress: NODE_A.toLowerCase(), urls: ['https://a1.example'] }]);
            expect(await storageEndpoints.providersWith('0xchan/foo-1', 'teleport')).toEqual([]);
            // Second pass served from the cache.
            expect(fetchMock).toHaveBeenCalledTimes(3);
        });

        it('probeStream on a stream without storage is empty and probes nothing', async () => {
            mockClient.getStream.mockResolvedValue({ getStorageNodes: () => Promise.resolve([]) });
            expect(await storageEndpoints.probeStream('0xchan/none-1')).toEqual([]);
            expect(fetchMock).not.toHaveBeenCalled();
        });

        it('clear() forgets probed capabilities', async () => {
            fetchMock.mockResolvedValue(jsonResponse(200, { features: FORK }));
            await storageEndpoints.probeCapabilities('https://node-a.example');
            storageEndpoints.clear();
            expect(storageEndpoints.capabilitiesOf('https://node-a.example')).toBeUndefined();
        });
    });
});
