/**
 * Storage read interceptor.
 *
 * Every history read of a Pombo client ends in a plain `fetch` of
 * `.../streams/{id}/data/partitions/{p}/{last|from|range}` — the SDK's own
 * resend does it, and so do the direct file reads in storageMedia.js. This
 * module wraps the global `fetch` once so those reads, and only those, gain
 * what the Pombo storage node fork offers and vanilla nodes ignore:
 *
 *  - **Signed reads.** On a node announcing `signedReads`, reads of a gated
 *    channel's streams (never the `-3`) carry the `x-pombo-*` headers built by
 *    storageReadSigner.js. A 401 on an unsigned read (a channel not yet known
 *    as gated) is answered by signing and retrying once.
 *  - **storedAt.** On a node announcing `storedAt`, the same read is paired
 *    with a `format=metadata` request to the same node, and the per-message
 *    `storedAt` is kept in a side table keyed by (stream, partition,
 *    timestamp, sequenceNumber). `storedAtFor` serves it to the history
 *    readers: it is the only instant the publisher did not choose.
 *  - **503 = the node cannot consult the chain.** Retried with backoff before
 *    the SDK sees it.
 *
 * The last error per stream is kept so a history reader can tell the UI
 * whether the read failed for lack of access (403), lack of a valid
 * signature (401) or a node outage (503).
 *
 * Nothing here knows the SDK: the URL alone says what the request is.
 */

import { CONFIG } from './config.js';
import { Logger } from './logger.js';
import { parseStorageDataUrl, signedReadHeaders } from './storageReadSigner.js';

const SIGNED_READS = 'signedReads';
const STORED_AT = 'storedAt';
const RETRY_503_DELAYS_MS = [1000, 3000, 7000];
const METADATA_TIMEOUT_MS = 30000;
const STORED_AT_MAX_ENTRIES = 50000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const storedAtKey = (streamId, partition, timestamp, sequenceNumber) =>
    `${streamId}|${partition}|${timestamp}|${sequenceNumber}`;

class StorageFetch {
    constructor() {
        this.deps = null;
        this.original = null;
        this.storedAt = new Map();
        this.lastErrors = new Map();
        this.retryDelays = RETRY_503_DELAYS_MS;
    }

    /**
     * Wrap the global fetch. Idempotent.
     * @param {Object} deps
     * @param {Object} deps.endpoints - storageEndpoints (capabilities per node URL)
     * @param {() => ({address: string, sign: (message: string) => Promise<string>}|null)} deps.signer
     *   The current identity, or null when there is nothing to sign with (guest)
     * @param {(streamId: string) => Promise<boolean>} deps.isGated
     * @param {typeof fetch} [deps.fetchImpl=globalThis.fetch]
     */
    install({ endpoints, signer, isGated, fetchImpl = null }) {
        this.deps = { endpoints, signer, isGated };
        if (!this.original) {
            this.original = fetchImpl || globalThis.fetch.bind(globalThis);
            globalThis.fetch = (input, init) => this.fetch(input, init);
        }
    }

    /** Restore the wrapped fetch (tests). */
    uninstall() {
        if (this.original) {
            globalThis.fetch = this.original;
            this.original = null;
        }
        this.deps = null;
        this.storedAt.clear();
        this.lastErrors.clear();
    }

    async fetch(input, init) {
        const url = typeof input === 'string' ? input : input?.url;
        const parsed = url && this.deps ? parseStorageDataUrl(url) : null;
        if (!parsed) return this.original(input, init);
        return this.storageRead(parsed, init || {});
    }

    async storageRead(parsed, init) {
        const { endpoints, signer, isGated } = this.deps;
        const { streamId } = parsed;
        const features = (await endpoints.probeCapabilities(parsed.base)) || new Set();
        const gated = await isGated(streamId);
        const identity = signer();
        const canSign = !!identity?.address && features.has(SIGNED_READS);
        let sign = canSign && gated && !/-3$/.test(streamId);
        const wantStoredAt = gated && features.has(STORED_AT);

        let attempt = 0;
        let signedUnprompted = false;
        for (;;) {
            const headers = new Headers(init.headers || undefined);
            if (sign) {
                for (const [k, v] of Object.entries(await signedReadHeaders(parsed, identity))) headers.set(k, v);
            }
            const metadata = wantStoredAt ? this.collectStoredAt(parsed, sign ? identity : null, init) : null;
            const resp = await this.original(parsed.url, { ...init, headers });
            if (resp.status === 401 && !sign && canSign && !signedUnprompted) {
                sign = true;
                signedUnprompted = true;
                if (metadata) await metadata;
                continue;
            }
            if (resp.status === 503 && attempt < this.retryDelays.length) {
                Logger.warn(`Storage node ${parsed.base} cannot consult the chain (503), retrying`);
                await sleep(this.retryDelays[attempt++]);
                if (metadata) await metadata;
                continue;
            }
            if (resp.ok) {
                this.lastErrors.delete(streamId);
            } else {
                this.lastErrors.set(streamId, { status: resp.status, signed: sign, at: Date.now() });
                Logger.warn(`Storage read ${parsed.resendType} ${streamId.slice(-24)} P${parsed.partition}: HTTP ${resp.status}${sign ? ' (signed)' : ''}`);
            }
            if (metadata) await metadata;
            return resp;
        }
    }

    /**
     * The paired `format=metadata` read. Best-effort: a failure only means
     * the messages of this page carry no storedAt.
     */
    async collectStoredAt(parsed, identity, init) {
        const u = new URL(parsed.url);
        u.searchParams.set('format', 'metadata');
        const metaParsed = parseStorageDataUrl(u.toString());
        const ctrl = new AbortController();
        const t = setTimeout(() => ctrl.abort(), METADATA_TIMEOUT_MS);
        try {
            const headers = new Headers();
            if (identity) {
                for (const [k, v] of Object.entries(await signedReadHeaders(metaParsed, identity))) headers.set(k, v);
            }
            const resp = await this.original(metaParsed.url, { ...init, headers, signal: ctrl.signal });
            if (!resp.ok) {
                Logger.debug(`storedAt read ${parsed.streamId.slice(-24)} P${parsed.partition}: HTTP ${resp.status}`);
                return;
            }
            const rows = await resp.json();
            if (!Array.isArray(rows)) return;
            for (const row of rows) {
                if (!row || !Number.isFinite(row.storedAt)) continue;
                this.remember(parsed.streamId, parsed.partition, row.timestamp, row.sequenceNumber, row.storedAt);
            }
        } catch (e) {
            Logger.debug(`storedAt read failed: ${e.message}`);
        } finally {
            clearTimeout(t);
        }
    }

    remember(streamId, partition, timestamp, sequenceNumber, storedAt) {
        const key = storedAtKey(streamId, partition, timestamp, sequenceNumber);
        this.storedAt.delete(key);
        this.storedAt.set(key, storedAt);
        if (this.storedAt.size > STORED_AT_MAX_ENTRIES) {
            this.storedAt.delete(this.storedAt.keys().next().value);
        }
    }

    /**
     * The node's receive time of a stored message, when a fork node served it.
     * @returns {number|undefined}
     */
    storedAtFor(streamId, partition, timestamp, sequenceNumber) {
        return this.storedAt.get(storedAtKey(streamId, partition, timestamp, sequenceNumber));
    }

    /**
     * The instant to judge a stored message by: the node's receive time when
     * known, else the timestamp the publisher declared.
     */
    judgeTimeFor(streamId, partition, timestamp, sequenceNumber) {
        return this.storedAtFor(streamId, partition, timestamp, sequenceNumber) ?? timestamp;
    }

    /**
     * A message whose declared timestamp lies further in the future than the
     * node's receive time allows was planted to sit above the conversation.
     */
    isForwardDated(timestamp, storedAt) {
        if (!Number.isFinite(storedAt) || !Number.isFinite(timestamp)) return false;
        return timestamp - storedAt > CONFIG.storageMedia.storedAtToleranceMs;
    }

    /**
     * Judge a stored SDK message: the time to evaluate kid freshness by, and
     * whether the message is forward-dated and must be dropped.
     * @param {string} streamId
     * @param {number} partition
     * @param {Object} message - Raw SDK StreamMessage (or a plain {timestamp, sequenceNumber})
     * @returns {{timestamp: number, judgeTime: number, storedAt: number|undefined, forwardDated: boolean}}
     */
    judgeMessage(streamId, partition, message) {
        const timestamp = typeof message?.getTimestamp === 'function'
            ? message.getTimestamp()
            : message?.timestamp;
        const sequenceNumber = typeof message?.getSequenceNumber === 'function'
            ? message.getSequenceNumber()
            : (message?.sequenceNumber ?? message?.messageId?.sequenceNumber ?? 0);
        const storedAt = this.storedAtFor(streamId, partition, timestamp, sequenceNumber);
        return {
            timestamp,
            storedAt,
            judgeTime: storedAt ?? timestamp,
            forwardDated: this.isForwardDated(timestamp, storedAt)
        };
    }

    /**
     * Last failed read of a stream since its last success.
     * @returns {{status: number, signed: boolean, at: number}|undefined}
     */
    lastReadError(streamId) {
        return this.lastErrors.get(streamId);
    }

    clearReadError(streamId) {
        this.lastErrors.delete(streamId);
    }
}

export const storageFetch = new StorageFetch();
