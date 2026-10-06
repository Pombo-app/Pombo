// @vitest-environment node
//
// patches/@streamr+sdk+103.3.1.patch caches the storage node registry read the
// SDK makes on every resend. These tests run against the installed SDK, so a
// postinstall that did not run, or a patch that applied in the wrong place,
// fails here rather than in production.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'http';
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { StreamrClient } = require('@streamr/sdk');
const { AbiCoder } = require('ethers');

const NODE = '0xae340e799e8151f6a4999d245e466197aa217667';
const GET_NODE = '0x9d209048';
// The package exports no subpaths; its main entry lives in dist/ too.
const dist = (file) => readFileSync(join(dirname(require.resolve('@streamr/sdk')), file), 'utf8');

describe('the SDK storage node metadata cache (patch-package)', () => {
    describe.each(['exports-browser.js', 'exports-browser.cjs'])('the bundled build %s', (file) => {
        const src = dist(file);

        it('reads node metadata through the cache', () => {
            expect(src).toContain(
                '    async getStorageNodeMetadata(nodeAddress) {\n        return this.nodeMetadataCache.get(nodeAddress);\n    }');
            expect(src).toContain('valueFactory: (nodeAddress) => this.getStorageNodeMetadata_nonCached(nodeAddress)');
        });

        it('drops a node entry when a resend from it fails without an answer', () => {
            const resend = src.slice(src.indexOf('async fetchStream('), src.indexOf('Resends = __decorate'));
            expect(resend).toContain('this.storageNodeRegistry.invalidateStorageNodeMetadata(nodeAddress)');
            expect(resend).toContain('(err.response.status < 500)');
        });
    });

    describe('the installed client', () => {
        let server;
        let url;
        let getNodeCalls = 0;
        let client;

        beforeAll(async () => {
            const node = AbiCoder.defaultAbiCoder().encode(
                ['tuple(address,string,uint256)'],
                [[NODE, JSON.stringify({ urls: ['https://storage.example'] }), 0]]
            );
            const answer = (r) => {
                if (r.method === 'eth_chainId') return { result: '0x89' };
                if (r.method === 'net_version') return { result: '137' };
                if (r.method === 'eth_blockNumber') return { result: '0x10' };
                if (r.method === 'eth_call' && String(r.params?.[0]?.data).startsWith(GET_NODE)) {
                    getNodeCalls++;
                    return { result: node };
                }
                return { error: { code: -32601, message: 'not here' } };
            };
            server = http.createServer((req, res) => {
                let body = '';
                req.on('data', (c) => { body += c; });
                req.on('end', () => {
                    const json = JSON.parse(body);
                    const reply = (r) => ({ jsonrpc: '2.0', id: r.id, ...answer(r) });
                    res.writeHead(200, { 'content-type': 'application/json' });
                    res.end(JSON.stringify(Array.isArray(json) ? json.map(reply) : reply(json)));
                });
            });
            await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
            url = `http://127.0.0.1:${server.address().port}`;
            client = new StreamrClient({
                metrics: false,
                contracts: { rpcs: [{ url }], rpcQuorum: 1 }
            });
        });

        afterAll(async () => {
            await client?.destroy();
            await new Promise((resolve) => server.close(resolve));
        });

        it('reads the chain once for repeated lookups of the same node', async () => {
            const first = await client.getStorageNodeMetadata(NODE);
            const second = await client.getStorageNodeMetadata(NODE);
            expect(first.urls).toEqual(['https://storage.example']);
            expect(second).toEqual(first);
            expect(getNodeCalls).toBe(1);
        });

        it('reads it again once the entry is dropped', async () => {
            const before = getNodeCalls;
            client.storageNodeRegistry.invalidateStorageNodeMetadata(NODE);
            await client.getStorageNodeMetadata(NODE);
            expect(getNodeCalls).toBe(before + 1);
        });
    });
});
