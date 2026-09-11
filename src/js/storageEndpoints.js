/**
 * Storage Endpoint Resolution (on-chain)
 *
 * Resolves the HTTP endpoints of the storage nodes assigned to a stream from
 * the on-chain registries, replacing the hardcoded node URLs the storage POC
 * used. Two SDK calls do the work:
 *
 *   stream.getStorageNodes()             → node EVM addresses (StreamStorageRegistry)
 *   client.getStorageNodeMetadata(addr)  → { urls: [...] }    (NodeRegistry)
 *
 * Only web-safe URLs (https, hostname, non-localhost) survive filtering — the
 * browser cannot fetch from http:// or IP-literal endpoints on a https origin.
 *
 * The module also tracks per-node health for the session:
 *  - consecutive-failure ejection from the rotation (noteFailure/noteSuccess)
 *  - the features a node announces on `GET /capabilities` (Pombo storage
 *    node fork: metadata, storedAt, purge, signedReads); vanilla nodes answer
 *    404 and are remembered as announcing nothing
 *  - whether a node supports the Pombo `format=metadata` fast path (from the
 *    capabilities when announced, else probed lazily by the engine; vanilla
 *    storage nodes answer HTTP 400)
 *
 * A "provider" is one on-chain node address; its URLs may front a cluster
 * sharing one database, so a feature belongs to the provider when any of its
 * URLs announces it.
 */

import { CONFIG } from './config.js';
import { Logger } from './logger.js';
import { streamrController, isWebSafeStorageNodeUrl } from './streamr.js';

const normalizeUrl = (url) => String(url || '').trim().replace(/\/+$/, '');

const CAPABILITIES_TIMEOUT_MS = 8000;

class StorageEndpointResolver {
    constructor() {
        // streamId → { at: epochMs, nodes: [{ nodeAddress, urls }] }
        this.cache = new Map();
        // streamId → in-flight promise (dedupe concurrent resolutions)
        this.inFlight = new Map();
        // url → consecutive failure count (session-scoped)
        this.failures = new Map();
        // url → true | false (format=metadata support; unknown = not present)
        this.metaFormat = new Map();
        // url → { at: epochMs, features: Set<string> } (empty set = vanilla / 404)
        this.capabilities = new Map();
        // url → in-flight capabilities probe
        this.capabilityProbes = new Map();
    }

    /**
     * Resolve the storage nodes (and their web-safe HTTP URLs) for a stream.
     * Cached per stream with a TTL; concurrent callers share one resolution.
     *
     * @param {string} streamId - Message stream ID (ends with -1)
     * @param {Object} [options]
     * @param {boolean} [options.force=false] - Bypass the cache
     * @returns {Promise<Array<{nodeAddress: string, urls: string[]}>>} May be empty.
     */
    async resolve(streamId, { force = false } = {}) {
        const ttl = CONFIG.storageMedia.endpointCacheTtlMs;
        const cached = this.cache.get(streamId);
        if (!force && cached && Date.now() - cached.at < ttl) {
            return cached.nodes;
        }

        if (this.inFlight.has(streamId)) {
            return this.inFlight.get(streamId);
        }

        const p = this.resolveUncached(streamId)
            .then((nodes) => {
                this.cache.set(streamId, { at: Date.now(), nodes });
                return nodes;
            })
            .finally(() => this.inFlight.delete(streamId));
        this.inFlight.set(streamId, p);
        return p;
    }

    async resolveUncached(streamId) {
        const client = streamrController.client;
        if (!client) {
            throw new Error('Streamr client not initialized');
        }

        const stream = await client.getStream(streamId);

        // getStorageNodes() has returned different shapes across SDK versions —
        // defensive handling mirrors getStreamStorageInfo() in streamr.js.
        const raw = stream.getStorageNodes();
        let addresses = [];
        if (Array.isArray(raw)) {
            addresses = raw;
        } else if (raw && typeof raw.then === 'function') {
            addresses = await raw;
        } else if (raw && typeof raw[Symbol.asyncIterator] === 'function') {
            for await (const node of raw) addresses.push(node);
        } else if (raw && typeof raw[Symbol.iterator] === 'function') {
            addresses = [...raw];
        }

        const nodes = [];
        for (const address of addresses) {
            try {
                const metadata = await client.getStorageNodeMetadata(address);
                const urls = (Array.isArray(metadata?.urls) ? metadata.urls : [])
                    .filter((u) => typeof u === 'string' && isWebSafeStorageNodeUrl(u))
                    .map(normalizeUrl);
                if (urls.length) {
                    nodes.push({ nodeAddress: String(address).toLowerCase(), urls });
                } else {
                    Logger.debug('Storage node has no web-safe URLs:', address);
                }
            } catch (e) {
                Logger.warn('Storage node metadata read failed:', address, e.message);
            }
        }

        Logger.info(`Storage endpoints for ${streamId.slice(-30)}: ${nodes.length} node(s), ` +
            `${nodes.reduce((n, x) => n + x.urls.length, 0)} URL(s)`);
        return nodes;
    }

    /**
     * Flat rotation list of healthy base URLs for a stream. EVERY healthy URL
     * is a rotation slot — the Pombo cluster registers one node address with
     * two URLs, and taking only the first per node pinned all direct reads to
     * a single server (halved download throughput vs the POC, which
     * round-robined windows across every cluster URL). Slots interleave by URL
     * index so multi-URL nodes and multi-node sets both spread fairly.
     *
     * @param {string} streamId
     * @returns {Promise<string[]>} May be empty (no storage / no web-safe URL / all ejected)
     */
    async rotation(streamId) {
        const nodes = await this.resolve(streamId);
        const limit = CONFIG.storageMedia.nodeFailureLimit;
        const out = [];
        for (let i = 0; ; i++) {
            let any = false;
            for (const node of nodes) {
                const u = node.urls[i];
                if (u === undefined) continue;
                any = true;
                if ((this.failures.get(u) || 0) < limit) out.push(u);
            }
            if (!any) break;
        }
        return out;
    }

    /** Record a failed read against a node URL (ejects after nodeFailureLimit in a row). */
    noteFailure(url) {
        const u = normalizeUrl(url);
        const n = (this.failures.get(u) || 0) + 1;
        this.failures.set(u, n);
        if (n === CONFIG.storageMedia.nodeFailureLimit) {
            Logger.warn(`Storage node ejected from rotation for this session: ${u}`);
        }
    }

    /** Record a successful read (resets the consecutive-failure count). */
    noteSuccess(url) {
        this.failures.delete(normalizeUrl(url));
    }

    /**
     * Features a node URL announces on `GET /capabilities`. Cached per URL
     * with the endpoint TTL; concurrent probes share one request. A 404 is a
     * vanilla node and caches as an empty set; a network error or any other
     * status is not cached, so the next call probes again.
     *
     * @param {string} url - Node base URL
     * @param {Object} [options]
     * @param {boolean} [options.force=false] - Bypass the cache
     * @returns {Promise<Set<string>|undefined>} undefined = probe failed
     */
    async probeCapabilities(url, { force = false } = {}) {
        const u = normalizeUrl(url);
        if (!u) return undefined;
        const ttl = CONFIG.storageMedia.endpointCacheTtlMs;
        const cached = this.capabilities.get(u);
        if (!force && cached && Date.now() - cached.at < ttl) {
            return cached.features;
        }
        if (this.capabilityProbes.has(u)) {
            return this.capabilityProbes.get(u);
        }
        const p = this.fetchCapabilities(u)
            .then((features) => {
                if (features) this.capabilities.set(u, { at: Date.now(), features });
                return features;
            })
            .finally(() => this.capabilityProbes.delete(u));
        this.capabilityProbes.set(u, p);
        return p;
    }

    async fetchCapabilities(u) {
        const ctrl = new AbortController();
        const t = setTimeout(() => ctrl.abort(), CAPABILITIES_TIMEOUT_MS);
        try {
            const resp = await fetch(`${u}/capabilities`, { signal: ctrl.signal });
            if (resp.status === 404) return new Set();
            if (!resp.ok) {
                Logger.debug(`Capabilities probe ${u}: HTTP ${resp.status}`);
                return undefined;
            }
            const body = await resp.json();
            const list = Array.isArray(body?.features) ? body.features : [];
            const features = new Set(list.filter((f) => typeof f === 'string'));
            Logger.info(`Storage node ${u} announces: ${[...features].join(', ') || '(nothing)'}`);
            return features;
        } catch (e) {
            Logger.debug(`Capabilities probe ${u} failed: ${e.message}`);
            return undefined;
        } finally {
            clearTimeout(t);
        }
    }

    /**
     * Cached capabilities of a node URL, without probing.
     * @returns {Set<string>|undefined} undefined = not probed (or probe failed)
     */
    capabilitiesOf(url) {
        return this.capabilities.get(normalizeUrl(url))?.features;
    }

    /** True only when the URL has been probed and announces the feature. */
    hasFeature(url, feature) {
        return this.capabilitiesOf(url)?.has(feature) === true;
    }

    /**
     * Resolve a stream's providers and probe every URL in parallel.
     * @param {string} streamId
     * @returns {Promise<Array<{nodeAddress: string, urls: string[], features: Set<string>}>>}
     *   `features` is the union over the provider's URLs
     */
    async probeStream(streamId) {
        const nodes = await this.resolve(streamId);
        const urls = nodes.flatMap((n) => n.urls);
        await Promise.all(urls.map((u) => this.probeCapabilities(u)));
        return nodes.map((n) => {
            const features = new Set();
            for (const u of n.urls) {
                for (const f of this.capabilitiesOf(u) || []) features.add(f);
            }
            return { nodeAddress: n.nodeAddress, urls: n.urls, features };
        });
    }

    /**
     * Providers of a stream that announce a feature, each reduced to the URLs
     * that announce it (a request goes to one of them, the rest are retries).
     * @param {string} streamId
     * @param {string} feature
     * @returns {Promise<Array<{nodeAddress: string, urls: string[]}>>}
     */
    async providersWith(streamId, feature) {
        const providers = await this.probeStream(streamId);
        return providers
            .filter((p) => p.features.has(feature))
            .map((p) => ({
                nodeAddress: p.nodeAddress,
                urls: p.urls.filter((u) => this.hasFeature(u, feature))
            }));
    }

    /**
     * format=metadata support for a node URL. An explicit record from a read
     * wins; otherwise the answer comes from the announced capabilities.
     * @returns {boolean|undefined} undefined = not known yet
     */
    supportsMetaFormat(url) {
        const u = normalizeUrl(url);
        const recorded = this.metaFormat.get(u);
        if (recorded !== undefined) return recorded;
        const features = this.capabilities.get(u)?.features;
        if (features && features.has('metadata')) return true;
        return undefined;
    }

    setMetaFormatSupport(url, supported) {
        this.metaFormat.set(normalizeUrl(url), !!supported);
    }

    /** Drop the cached node set for a stream (e.g. after add/remove storage node). */
    invalidate(streamId) {
        this.cache.delete(streamId);
    }

    /** Full reset (logout / client re-init). */
    clear() {
        this.cache.clear();
        this.inFlight.clear();
        this.failures.clear();
        this.metaFormat.clear();
        this.capabilities.clear();
        this.capabilityProbes.clear();
    }
}

export const storageEndpoints = new StorageEndpointResolver();
