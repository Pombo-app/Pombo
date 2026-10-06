import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
    RpcHealth,
    probeEndpoint,
    judge,
    usableUrls,
    shouldRebuild,
    describeVerdict,
    REBUILD_RETRY_MS,
    PROBE_NODE
} from '../../src/js/rpcHealth.js';
import { CONFIG } from '../../src/js/config.js';
import { STREAM_CONFIG } from '../../src/js/streamConfig.js';

const NODE = '0x' + '00'.repeat(31) + '20' + 'ab'.repeat(96);
const A = 'https://a.example';
const B = 'https://b.example';
const C = 'https://c.example';

/** One fake endpoint per URL; a spec may differ per JSON-RPC method. */
function fakeFetch(specs) {
    return vi.fn(async (url, init) => {
        const { method } = JSON.parse(init.body);
        const spec = specs[url] || {};
        const s = spec[method] || spec;
        if (s.network) throw new TypeError('Failed to fetch');
        if (s.timeout) {
            const e = new Error('signal timed out');
            e.name = 'TimeoutError';
            throw e;
        }
        if (s.http) return { ok: false, status: s.http, json: async () => ({}) };
        if (s.rpc) return { ok: true, status: 200, json: async () => ({ jsonrpc: '2.0', id: 1, error: { code: s.rpc, message: 'no' } }) };
        const result = method === 'eth_blockNumber' ? (s.block ?? '0x1000') : (s.call ?? NODE);
        return { ok: true, status: 200, json: async () => ({ jsonrpc: '2.0', id: 1, result }) };
    });
}

const verdictFor = (spec) => probeEndpoint(fakeFetch({ [A]: spec }), A, 3000);

describe('rpcHealth', () => {
    describe('one endpoint', () => {
        it('is healthy when it answers both the block number and the contract read', async () => {
            expect(await verdictFor({})).toEqual({ ok: true, block: 0x1000 });
        });

        it('is overloaded on HTTP 529 or 503', async () => {
            expect(await verdictFor({ http: 529 })).toMatchObject({ ok: false, reason: 'overloaded', status: 529 });
            expect(await verdictFor({ http: 503 })).toMatchObject({ ok: false, reason: 'overloaded', status: 503 });
        });

        it('is rate limited on HTTP 429 and on the rate-window JSON-RPC errors', async () => {
            expect(await verdictFor({ http: 429 })).toMatchObject({ ok: false, reason: 'limited' });
            expect(await verdictFor({ rpc: -32005 })).toMatchObject({ ok: false, reason: 'limited' });
            expect(await verdictFor({ rpc: -32001 })).toMatchObject({ ok: false, reason: 'limited' });
        });

        it('keeps the status of any other HTTP failure', async () => {
            expect(await verdictFor({ http: 403 })).toMatchObject({ ok: false, reason: 'http', status: 403 });
        });

        it('refuses on any other JSON-RPC error, even when only the contract read fails', async () => {
            expect(await verdictFor({ eth_call: { rpc: -32603 } })).toMatchObject({ ok: false, reason: 'refused', code: -32603 });
        });

        it('tells a timeout apart from an endpoint that cannot be reached', async () => {
            expect(await verdictFor({ timeout: true })).toMatchObject({ ok: false, reason: 'timeout' });
            expect(await verdictFor({ network: true })).toMatchObject({ ok: false, reason: 'unreachable' });
        });

        it('reads the node the SDK reads most', async () => {
            const fetchImpl = fakeFetch({});
            await probeEndpoint(fetchImpl, A, 3000);
            const call = fetchImpl.mock.calls.map(([, init]) => JSON.parse(init.body)).find((b) => b.method === 'eth_call');
            expect(PROBE_NODE).toBe(STREAM_CONFIG.NODE_ADDRESS);
            expect(call.params[0].data.endsWith(PROBE_NODE.slice(2))).toBe(true);
        });

        it('fails an empty answer to the contract read', async () => {
            expect(await verdictFor({ eth_call: { call: '0x' } })).toMatchObject({ ok: false, reason: 'badresult' });
        });
    });

    describe('blocks behind', () => {
        const lag = CONFIG.network.rpcHealth.maxBlockLag;

        it('leaves out an endpoint more blocks behind the best one than allowed', () => {
            const judged = judge(new Map([
                [A, { ok: true, block: 1000 }],
                [B, { ok: true, block: 1000 - lag }],
                [C, { ok: true, block: 1000 - lag - 1 }]
            ]));
            expect(judged.get(B).ok).toBe(true);
            expect(judged.get(C)).toMatchObject({ ok: false, reason: 'lagging', behind: lag + 1 });
        });
    });

    describe('the list the chain readers get', () => {
        it('keeps the user\'s order and leaves out the failed endpoints', () => {
            const verdicts = new Map([[A, { ok: false, reason: 'timeout' }], [B, { ok: true }], [C, { ok: true }]]);
            expect(usableUrls([C, A, B], verdicts)).toEqual({ urls: [C, B], fallback: false });
        });

        it('counts an endpoint not probed yet as usable', () => {
            expect(usableUrls([A, B], new Map([[A, { ok: false }]]))).toEqual({ urls: [B], fallback: false });
        });

        it('never hands out an empty list: when every endpoint fails it is all of them, flagged', () => {
            const verdicts = new Map([[A, { ok: false }], [B, { ok: false }]]);
            expect(usableUrls([A, B], verdicts)).toEqual({ urls: [A, B], fallback: true });
        });
    });

    describe('what Settings says', () => {
        it('names the reason a user can act on', () => {
            expect(describeVerdict({ ok: false, reason: 'overloaded', status: 529 })).toBe('overloaded (HTTP 529)');
            expect(describeVerdict({ ok: false, reason: 'limited' })).toBe('rate limited');
            expect(describeVerdict({ ok: false, reason: 'http', status: 403 })).toBe('HTTP 403');
            expect(describeVerdict({ ok: false, reason: 'refused', code: -32603 })).toBe('refused the call (-32603)');
            expect(describeVerdict({ ok: false, reason: 'timeout' })).toBe('no answer in 3 s');
            expect(describeVerdict({ ok: false, reason: 'unreachable' })).toBe('unreachable (network or CORS)');
            expect(describeVerdict({ ok: false, reason: 'lagging', behind: 42 })).toBe('42 blocks behind');
            expect(describeVerdict({ ok: false, reason: 'badresult' })).toBe('wrong answer to a contract read');
        });
    });

    describe('probing', () => {
        beforeEach(() => vi.useFakeTimers());
        afterEach(() => vi.useRealTimers());

        const make = (specs, selected = [A, B, C]) => {
            const fetchImpl = fakeFetch(specs);
            return { health: new RpcHealth({ fetchImpl, selected: () => selected }), fetchImpl };
        };

        it('probes every chosen endpoint and hands out only the healthy ones', async () => {
            const { health } = make({ [B]: { http: 529 } });
            await health.probe();
            expect(health.usable()).toEqual({ urls: [A, C], fallback: false });
            expect(health.verdict(B)).toMatchObject({ ok: false, reason: 'overloaded' });
        });

        it('runs one probe at a time', async () => {
            const { health, fetchImpl } = make({});
            await Promise.all([health.probe(), health.probe()]);
            expect(fetchImpl).toHaveBeenCalledTimes(6);
        });

        it('probes again after three read failures, and only once for a burst', async () => {
            const { health, fetchImpl } = make({});
            const probe = vi.spyOn(health, 'probe');
            health.noteReadFailure();
            health.noteReadFailure();
            expect(probe).not.toHaveBeenCalled();
            health.noteReadFailure();
            health.noteReadFailure();
            expect(probe).toHaveBeenCalledTimes(1);
            await vi.runOnlyPendingTimersAsync();
            expect(fetchImpl).toHaveBeenCalledTimes(6);
        });

        it('does not count failures a read success came after, nor old ones', () => {
            const { health } = make({});
            const probe = vi.spyOn(health, 'probe');
            health.noteReadFailure();
            health.noteReadFailure();
            health.noteReadSuccess();
            health.noteReadFailure();
            expect(probe).not.toHaveBeenCalled();
            health.noteReadFailure();
            vi.advanceTimersByTime(CONFIG.network.rpcHealth.failureWindowMs + 1);
            health.noteReadFailure();
            expect(probe).not.toHaveBeenCalled();
        });

        it('probes again on its own every fifteen minutes', async () => {
            const { health } = make({});
            const probe = vi.spyOn(health, 'probe');
            health.start();
            expect(probe).not.toHaveBeenCalled();
            await vi.advanceTimersByTimeAsync(CONFIG.network.rpcHealth.reprobeIntervalMs);
            expect(probe).toHaveBeenCalledTimes(1);
            health.stop();
        });

        it('probes before the first client, and again only for an endpoint with no verdict', async () => {
            let selected = [A, B];
            const fetchImpl = fakeFetch({});
            const health = new RpcHealth({ fetchImpl, selected: () => selected });
            await health.ensureProbed();
            await health.ensureProbed();
            expect(fetchImpl).toHaveBeenCalledTimes(4);
            selected = [A, B, C];
            expect(await health.ensureProbed()).toEqual({ urls: [A, B, C], fallback: false });
            expect(fetchImpl).toHaveBeenCalledTimes(10);
        });
    });

    describe('rebuilding the client', () => {
        const minGap = CONFIG.network.rpcHealth.minRebuildIntervalMs;
        const base = { applied: [A, B], usable: [A], lastRebuildAt: 0, now: minGap, writing: false };

        it('rebuilds when the usable set changed', () => {
            expect(shouldRebuild(base)).toBe(true);
        });

        it('does not rebuild for the same set in another order', () => {
            expect(shouldRebuild({ ...base, usable: [B, A] })).toBe(false);
        });

        it('waits the minimum gap after the last rebuild', () => {
            expect(shouldRebuild({ ...base, now: minGap - 1 })).toBe(false);
        });

        it('never rebuilds while a chain write is in flight', () => {
            expect(shouldRebuild({ ...base, writing: true })).toBe(false);
        });

        describe('when the set changes', () => {
            beforeEach(() => vi.useFakeTimers());
            afterEach(() => vi.useRealTimers());

            it('rebuilds once the write in flight ends', async () => {
                const health = new RpcHealth({ fetchImpl: fakeFetch({ [B]: { network: true } }), selected: () => [A, B] });
                let writing = true;
                const rebuild = vi.fn(async () => {});
                health.attachClient({ writing: () => writing, rebuild });
                health.noteApplied([A, B]);
                vi.advanceTimersByTime(minGap);

                await health.probe();
                expect(rebuild).not.toHaveBeenCalled();

                writing = false;
                await vi.advanceTimersByTimeAsync(REBUILD_RETRY_MS);
                expect(rebuild).toHaveBeenCalledTimes(1);
            });
        });
    });
});
