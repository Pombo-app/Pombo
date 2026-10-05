/**
 * Which of the user's chosen RPC endpoints answer a real read right now.
 *
 * Each chosen endpoint is probed with the block number and the contract read
 * the SDK makes most (the storage node registry's getNode for Pombo's node);
 * the chain readers get only the ones that passed, in the user's order. The
 * saved selection is never changed by this.
 */

import { CONFIG, getRpcEndpoints } from './config.js';
import { Logger } from './logger.js';

const H = CONFIG.network.rpcHealth;

// The SDK's storageNodeRegistryChainAddress on Polygon.
const NODE_REGISTRY = '0x080f34fec2bc33928999ea9e39adc798bef3e0d6';
const GET_NODE = '0x9d209048';
/** Pombo's storage node, STREAM_CONFIG.NODE_ADDRESS (kept apart from that module's imports). */
export const PROBE_NODE = '0xae340e799e8151f6a4999d245e466197aa217667';

/** How often a deferred rebuild looks again. */
export const REBUILD_RETRY_MS = 3000;

function getNodeCall() {
    return {
        to: NODE_REGISTRY,
        data: GET_NODE + PROBE_NODE.slice(2).padStart(64, '0')
    };
}

async function rpcCall(fetchImpl, url, method, params, timeoutMs) {
    const isTimeout = (e) => e?.name === 'TimeoutError' || e?.name === 'AbortError';
    let response;
    try {
        response = await fetchImpl(url, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
            signal: AbortSignal.timeout(timeoutMs)
        });
    } catch (e) {
        return { kind: isTimeout(e) ? 'timeout' : 'network' };
    }
    if (!response.ok) return { kind: 'http', status: response.status };
    let data;
    try {
        data = await response.json();
    } catch (e) {
        return { kind: isTimeout(e) ? 'timeout' : 'bad' };
    }
    if (data?.error) return { kind: 'rpc', code: data.error.code };
    return { kind: 'ok', result: data?.result };
}

function failureOf(outcome) {
    switch (outcome.kind) {
        case 'ok': return null;
        case 'timeout': return { reason: 'timeout' };
        case 'network': return { reason: 'unreachable' };
        case 'http':
            if (outcome.status === 429) return { reason: 'limited' };
            if (outcome.status === 529 || outcome.status === 503) return { reason: 'overloaded', status: outcome.status };
            return { reason: 'http', status: outcome.status };
        case 'rpc':
            // What the public gateways send once a plan or a rate window runs out.
            if (outcome.code === -32005 || outcome.code === -32001) return { reason: 'limited' };
            return { reason: 'refused', code: outcome.code };
        default: return { reason: 'badresult' };
    }
}

/** Probe one endpoint: { ok: true, block } or { ok: false, reason, ... }. */
export async function probeEndpoint(fetchImpl, url, timeoutMs = H.probeTimeoutMs) {
    const [blockOutcome, callOutcome] = await Promise.all([
        rpcCall(fetchImpl, url, 'eth_blockNumber', [], timeoutMs),
        rpcCall(fetchImpl, url, 'eth_call', [getNodeCall(), 'latest'], timeoutMs)
    ]);
    const failed = failureOf(blockOutcome) || failureOf(callOutcome);
    if (failed) return { ok: false, ...failed };
    const block = typeof blockOutcome.result === 'string' ? Number.parseInt(blockOutcome.result, 16) : NaN;
    if (!Number.isSafeInteger(block) || block <= 0) return { ok: false, reason: 'badresult' };
    if (typeof callOutcome.result !== 'string' || !/^0x[0-9a-f]{64,}$/i.test(callOutcome.result)) {
        return { ok: false, reason: 'badresult' };
    }
    return { ok: true, block };
}

/** Fails the endpoints further behind the best block than allowed. */
export function judge(verdicts) {
    const blocks = [...verdicts.values()].filter((v) => v.ok).map((v) => v.block);
    const best = blocks.length ? Math.max(...blocks) : 0;
    const out = new Map();
    for (const [url, v] of verdicts) {
        const behind = v.ok ? best - v.block : 0;
        out.set(url, behind > H.maxBlockLag ? { ok: false, reason: 'lagging', behind, block: v.block } : v);
    }
    return out;
}

/**
 * The chosen endpoints minus the failed ones, in the user's order. Never
 * empty: when every one failed it is all of them, flagged.
 */
export function usableUrls(selected, verdicts) {
    const urls = selected.filter((url) => verdicts.get(url)?.ok !== false);
    if (urls.length) return { urls, fallback: false };
    return { urls: [...selected], fallback: selected.length > 0 };
}

const sameSet = (a, b) => a.length === b.length && a.every((url) => b.includes(url));

export function shouldRebuild({ applied, usable, lastRebuildAt, now, writing }) {
    if (sameSet(applied, usable)) return false;
    if (writing) return false;
    return now - lastRebuildAt >= H.minRebuildIntervalMs;
}

export function describeVerdict(v) {
    switch (v?.reason) {
        case 'overloaded': return `overloaded (HTTP ${v.status})`;
        case 'limited': return 'rate limited';
        case 'http': return `HTTP ${v.status}`;
        case 'refused': return `refused the call (${v.code})`;
        case 'timeout': return `no answer in ${H.probeTimeoutMs / 1000} s`;
        case 'unreachable': return 'unreachable (network or CORS)';
        case 'lagging': return `${v.behind} blocks behind`;
        default: return 'wrong answer to a contract read';
    }
}

export class RpcHealth {
    constructor({
        fetchImpl = (...args) => fetch(...args),
        selected = () => getRpcEndpoints().map((e) => e.url)
    } = {}) {
        this._fetch = fetchImpl;
        this._selected = selected;
        this._verdicts = new Map();   // url -> verdict + at
        this._probing = null;
        this._failures = [];          // timestamps of read failures since the last success
        this._lastFailureProbeAt = -Infinity;
        this._listeners = new Set();
        this._timer = null;
        this._client = null;          // { writing(), rebuild() }
        this._applied = null;         // the urls the current SDK client was built with
        this._appliedAt = 0;
        this._rebuildTimer = null;
    }

    /** Probe the chosen endpoints; concurrent calls share one run. */
    probe(urls = this._selected()) {
        if (this._probing) return this._probing;
        const run = Promise.all(urls.map((url) => probeEndpoint(this._fetch, url))).then((raw) => {
            const at = Date.now();
            const judged = judge(new Map(urls.map((url, i) => [url, raw[i]])));
            for (const [url, v] of judged) this._verdicts.set(url, { ...v, at });
            const { urls: usable, fallback } = this.usable();
            const left = urls.filter((url) => !usable.includes(url));
            if (fallback) Logger.warn('RPC health: no chosen endpoint passed the check, using all of them');
            else if (left.length) Logger.info('RPC health: leaving out', left.map((url) => `${url} (${describeVerdict(judged.get(url))})`).join(', '));
            this._listeners.forEach((cb) => { try { cb(); } catch { /* a listener must not stop the rest */ } });
            this._maybeRebuild();
            return this.usable();
        }).finally(() => { this._probing = null; });
        this._probing = run;
        return run;
    }

    /** Probes when a chosen endpoint has no verdict yet (first start, a new pick). */
    async ensureProbed() {
        const urls = this._selected();
        if (urls.some((url) => !this._verdicts.has(url))) await this.probe(urls);
        else if (this._probing) await this._probing;
        return this.usable();
    }

    usable() {
        return usableUrls(this._selected(), this._verdicts);
    }

    verdict(url) {
        return this._verdicts.get(url) || null;
    }

    onChange(cb) {
        this._listeners.add(cb);
        return () => this._listeners.delete(cb);
    }

    /** Probe again every reprobeIntervalMs; the first probe is ensureProbed's. */
    start() {
        if (this._timer) return;
        this._timer = setInterval(() => this.probe(), H.reprobeIntervalMs);
    }

    stop() {
        clearInterval(this._timer);
        clearTimeout(this._rebuildTimer);
        this._timer = null;
    }

    /** A chain read failed with an RPC-side error. */
    noteReadFailure() {
        const now = Date.now();
        this._failures = this._failures.filter((t) => now - t <= H.failureWindowMs);
        this._failures.push(now);
        if (this._failures.length < H.failuresBeforeReprobe) return;
        if (now - this._lastFailureProbeAt < H.failureWindowMs) return;
        this._failures = [];
        this._lastFailureProbeAt = now;
        this.probe();
    }

    noteReadSuccess() {
        this._failures = [];
    }

    /** The SDK client owner: whether a chain write is in flight, and how to rebuild. */
    attachClient(client) {
        this._client = client;
    }

    /** A client was just built with these urls. */
    noteApplied(urls) {
        this._applied = [...urls];
        this._appliedAt = Date.now();
        clearTimeout(this._rebuildTimer);
    }

    _maybeRebuild() {
        clearTimeout(this._rebuildTimer);
        if (!this._client || !this._applied) return;
        const usable = this.usable().urls;
        const now = Date.now();
        const writing = !!this._client.writing();
        if (shouldRebuild({ applied: this._applied, usable, lastRebuildAt: this._appliedAt, now, writing })) {
            Logger.info('RPC health: rebuilding the Streamr client for', usable.join(', '));
            this._client.rebuild().catch((e) => Logger.warn('RPC health: rebuild failed:', e?.message || e));
            return;
        }
        if (sameSet(this._applied, usable)) return;
        const wait = writing
            ? REBUILD_RETRY_MS
            : Math.max(REBUILD_RETRY_MS, this._appliedAt + H.minRebuildIntervalMs - now);
        this._rebuildTimer = setTimeout(() => this._maybeRebuild(), wait);
    }
}

export const rpcHealth = new RpcHealth();

/** The SDK-shaped ({ url }) list the chain readers use. */
export function getUsableRpcEndpoints() {
    return rpcHealth.usable().urls.map((url) => ({ url }));
}
