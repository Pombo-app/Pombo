/**
 * Purge — removing specific messages from Pombo storage nodes.
 *
 * A vanilla storage node keeps every message until retention ends; hiding
 * is a client-side promise. The Pombo storage node fork adds an endpoint
 * that deletes one message at a time, addressed by the envelope
 * `(timestamp, sequenceNumber)`, for whoever proves authority with an
 * EIP-191 `personal_sign` signature (POMBO.md, "Purge" and "Signed
 * requests"):
 *
 *   POST /streams/{id}/data/partitions/{p}/purge
 *   { user, issuedAt, nonce, signature, targets: [{ timestamp, sequenceNumber }] }
 *
 * Message signed, one field per line:
 *   pombo-storage-node / purge / streamId / partition / issuedAt / nonce /
 *   `timestamp:sequenceNumber` per target, in the order sent.
 *
 * The node authorises the stream owner, the gate owner and moderators, and
 * in Visible channels the message's author. It answers per target with
 * `deleted`, `forbidden` or `not_found`.
 *
 * A purge is per PROVIDER (one on-chain storage node address, possibly a
 * cluster behind several URLs sharing one database): one request to one of
 * its URLs, the others being retries, and a fan-out across every provider
 * that announces `purge`. Providers that do not announce it keep their copy;
 * the caller reports "erased on k of n" rather than pretending.
 *
 * Purge never replaces the client-side hide: a client holding the message
 * in memory keeps showing it until an ADMIN_STATE or delta hides it. The
 * moderation flow hides first and purges second.
 */

import { Logger } from './logger.js';
import { storageEndpoints } from './storageEndpoints.js';
import { randomNonce } from './storageReadSigner.js';
import { STORAGE_FILE } from './streamConstants.js';

export const PURGE_MAX_TARGETS = 100;
const PURGE_TIMEOUT_MS = 30000;
const LOOKUP_WINDOW_MS = 10000;
const LOOKUP_TIE_MS = 1000;
const CHUNK_WINDOW_PAD_MS = 60000;

/**
 * The exact string the client signs for a purge.
 * @param {Object} fields
 * @param {string} fields.streamId
 * @param {number|string} fields.partition
 * @param {number|string} fields.issuedAt
 * @param {string} fields.nonce
 * @param {Array<{timestamp: number, sequenceNumber: number}>} fields.targets
 * @returns {string}
 */
export function buildPurgeMessage({ streamId, partition, issuedAt, nonce, targets }) {
    return [
        'pombo-storage-node',
        'purge',
        streamId,
        String(partition),
        String(issuedAt),
        nonce,
        ...targets.map((t) => `${t.timestamp}:${t.sequenceNumber}`)
    ].join('\n');
}

/**
 * The signed request body.
 * @param {string} streamId
 * @param {number} partition
 * @param {Array<{timestamp: number, sequenceNumber: number}>} targets
 * @param {{address: string, sign: (message: string) => Promise<string>}} signer
 * @param {Object} [options]
 * @param {number} [options.issuedAt=Date.now()]
 * @param {string} [options.nonce=randomNonce()]
 */
export async function signedPurgeBody(streamId, partition, targets, signer, { issuedAt = Date.now(), nonce = randomNonce() } = {}) {
    if (!Array.isArray(targets) || targets.length === 0) throw new Error('No purge targets');
    if (targets.length > PURGE_MAX_TARGETS) throw new Error(`At most ${PURGE_MAX_TARGETS} targets per purge`);
    const clean = targets.map((t) => ({ timestamp: Number(t.timestamp), sequenceNumber: Number(t.sequenceNumber) }));
    const message = buildPurgeMessage({ streamId, partition, issuedAt, nonce, targets: clean });
    const signature = await signer.sign(message);
    return { user: signer.address, issuedAt, nonce, signature, targets: clean };
}

/**
 * Purge on one provider: the first URL that answers decides; a URL that
 * cannot be reached is skipped for the next one. Every attempt signs afresh,
 * because the node accepts a nonce once.
 * @returns {Promise<{provider: string, url: string|null, status: number, results: Array, error?: string}>}
 */
export async function purgeOnProvider(provider, streamId, partition, targets, signer, fetchImpl = fetch) {
    let lastError = null;
    for (const url of provider.urls) {
        const ctrl = new AbortController();
        const t = setTimeout(() => ctrl.abort(), PURGE_TIMEOUT_MS);
        try {
            const body = await signedPurgeBody(streamId, partition, targets, signer);
            const resp = await fetchImpl(`${url}/streams/${encodeURIComponent(streamId)}/data/partitions/${partition}/purge`, {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify(body),
                signal: ctrl.signal
            });
            if (!resp.ok) {
                Logger.warn(`Purge on ${url}: HTTP ${resp.status}`);
                return { provider: provider.nodeAddress, url, status: resp.status, results: [] };
            }
            const json = await resp.json().catch(() => ({}));
            return { provider: provider.nodeAddress, url, status: resp.status, results: Array.isArray(json?.results) ? json.results : [] };
        } catch (e) {
            lastError = e;
            Logger.warn(`Purge on ${url} failed: ${e.message}`);
        } finally {
            clearTimeout(t);
        }
    }
    return { provider: provider.nodeAddress, url: null, status: 0, results: [], error: lastError?.message || 'unreachable' };
}

/**
 * Fan the purge out to every provider of the stream that announces it: one
 * request per partition and per batch of PURGE_MAX_TARGETS targets.
 * @param {string} streamId
 * @param {Array<{partition: number, targets: Array<{timestamp: number, sequenceNumber: number}>}>} groups
 * @param {{address: string, sign: (message: string) => Promise<string>}} signer
 * @returns {Promise<{providers: number, erasedOn: number, forbiddenOn: number, unreachable: number, targets: number, outcomes: Array}>}
 *   `erasedOn` counts providers where every target is now gone (`deleted` or
 *   `not_found`); `forbiddenOn` those that refused at least one target.
 */
export async function purgeGroups(streamId, groups, signer, fetchImpl = fetch) {
    const providers = await storageEndpoints.providersWith(streamId, 'purge');
    const batches = [];
    for (const g of groups) {
        for (let i = 0; i < g.targets.length; i += PURGE_MAX_TARGETS) {
            batches.push({ partition: g.partition, targets: g.targets.slice(i, i + PURGE_MAX_TARGETS) });
        }
    }
    const onProvider = async (p) => {
        const outcomes = [];
        for (const b of batches) {
            const o = await purgeOnProvider(p, streamId, b.partition, b.targets, signer, fetchImpl);
            outcomes.push({ ...o, partition: b.partition, targets: b.targets });
            if (o.status === 0) break;
        }
        return outcomes;
    };
    const all = await Promise.all(providers.map(onProvider));
    const gone = (o) => o.status === 200 && o.targets.every((t) => {
        const r = o.results.find((x) => Number(x.timestamp) === t.timestamp && Number(x.sequenceNumber) === t.sequenceNumber);
        return r && (r.result === 'deleted' || r.result === 'not_found');
    });
    return {
        providers: providers.length,
        erasedOn: all.filter((os) => os.length === batches.length && os.every(gone)).length,
        forbiddenOn: all.filter((os) => os.some((o) => o.status === 200 && o.results.some((r) => r.result === 'forbidden'))).length,
        unreachable: all.filter((os) => os.some((o) => o.status === 0)).length,
        targets: batches.reduce((n, b) => n + b.targets.length, 0),
        outcomes: all.flat()
    };
}

/**
 * One partition, one target list.
 * @param {string} streamId
 * @param {number} partition
 * @param {Array<{timestamp: number, sequenceNumber: number}>} targets
 * @param {{address: string, sign: (message: string) => Promise<string>}} signer
 */
export async function purgeMessages(streamId, partition, targets, signer, fetchImpl = fetch) {
    return purgeGroups(streamId, [{ partition, targets }], signer, fetchImpl);
}

/**
 * The transfer a stored chunk belongs to, read off its header
 * (`[4B metaLen][meta JSON]…`, the storageMedia chunk payload) without
 * touching the data behind it. Null for anything that is not a v2 chunk.
 * @param {string} hex - Row content, as the node serves binary rows
 * @returns {string|null}
 */
export function chunkTransferId(input) {
    const d = typeof input === 'string' ? hexToBytes(input) : input;
    if (!(d instanceof Uint8Array) || d.length < 8) return null;
    const metaLen = ((d[0] << 24) | (d[1] << 16) | (d[2] << 8) | d[3]) >>> 0;
    if (!(metaLen > 0) || d.length < 4 + metaLen) return null;
    try {
        const meta = JSON.parse(new TextDecoder().decode(d.subarray(4, 4 + metaLen)));
        return meta?.type === 'binary_file_chunked' && meta.version === 2 && meta.transferId ? String(meta.transferId) : null;
    } catch {
        return null;
    }
}

function hexToBytes(hex) {
    if (typeof hex !== 'string' || hex.length % 2 !== 0) return null;
    const out = new Uint8Array(hex.length / 2);
    for (let i = 0; i < out.length; i++) {
        const b = parseInt(hex.substr(i * 2, 2), 16);
        if (Number.isNaN(b)) return null;
        out[i] = b;
    }
    return out;
}

const asIs = async (bytes) => bytes;

/**
 * The chunk rows of a storage-shared file: every row on the announce's chunk
 * partitions, over the window it declares, whose header names its transfer.
 * Exact by content, at the price of reading the file once more. Rows are
 * sealed the way the channel seals media (epoch key, password key), so the
 * caller hands in the same opener a download uses; a row that does not open
 * is not this file's.
 * @param {string} streamId
 * @param {Object} meta - storage_file_announce metadata
 * @param {typeof fetch} [fetchImpl]
 * @param {(bytes: Uint8Array, timestamp: number) => Promise<Uint8Array>} [openChunk]
 * @returns {Promise<Array<{partition: number, targets: Array<{timestamp: number, sequenceNumber: number}>}>>}
 */
export async function fileChunkGroups(streamId, meta, fetchImpl = fetch, openChunk = asIs) {
    if (!meta?.transferId || !meta.firstChunkTs || !meta.lastChunkTs) throw new Error('The file announce does not say where its chunks are');
    const first = meta.firstChunkPartition ?? STORAGE_FILE.FIRST_CHUNK_PARTITION;
    const count = meta.chunkPartitions ?? STORAGE_FILE.CHUNK_PARTITIONS;
    const from = Number(meta.firstChunkTs) - CHUNK_WINDOW_PAD_MS;
    const to = Number(meta.lastChunkTs) + CHUNK_WINDOW_PAD_MS;
    const urls = (await storageEndpoints.providersWith(streamId, 'purge')).flatMap((p) => p.urls);
    if (urls.length === 0) throw new Error('No storage provider can identify the chunks');
    const groups = [];
    for (let k = 0; k < count; k++) {
        const partition = first + k;
        let rows = null;
        for (const url of urls) {
            try {
                const resp = await fetchImpl(`${url}/streams/${encodeURIComponent(streamId)}/data/partitions/${partition}/range?fromTimestamp=${from}&toTimestamp=${to}`);
                if (!resp.ok) continue;
                const body = await resp.json();
                if (Array.isArray(body)) { rows = body; break; }
            } catch (e) {
                Logger.debug(`Chunk lookup on ${url} P${partition} failed: ${e.message}`);
            }
        }
        if (!rows) throw new Error(`Could not read the chunks on partition ${partition}`);
        const targets = [];
        for (const r of rows) {
            if (Number(r.contentType) !== 1) continue;
            const sealed = hexToBytes(r.content);
            if (!sealed) continue;
            let plain = null;
            try { plain = await openChunk(sealed, Number(r.timestamp)); } catch { continue; }
            if (chunkTransferId(plain) === String(meta.transferId)) {
                targets.push({ timestamp: Number(r.timestamp), sequenceNumber: Number(r.sequenceNumber ?? 0) });
            }
        }
        if (targets.length) groups.push({ partition, targets });
    }
    return groups;
}

/**
 * The envelope coordinates of a message on the storage node. Messages read
 * from storage or live carry `_timestamp` and `_seq`; anything else is
 * looked up by its envelope time on a provider's metadata read (the fetch
 * wrapper signs it when the channel is gated).
 * @param {string} streamId
 * @param {number} partition
 * @param {Object} msg - Channel message
 * @param {typeof fetch} [fetchImpl]
 * @returns {Promise<{timestamp: number, sequenceNumber: number}>}
 */
export async function resolveTarget(streamId, partition, msg, fetchImpl = fetch) {
    const envelopeTs = Number(msg?._timestamp);
    const payloadTs = Number(msg?.timestamp);
    const anchor = Number.isFinite(envelopeTs) ? envelopeTs : payloadTs;
    if (!Number.isFinite(anchor)) throw new Error('Message has no timestamp');
    if (Number.isFinite(envelopeTs) && Number.isFinite(msg?._seq)) return { timestamp: envelopeTs, sequenceNumber: Number(msg._seq) };

    // Without the envelope time (an own message added locally before its
    // echo) the payload time is the publisher's clock a few ms before the
    // envelope's, so the lookup takes a window and keeps the closest row.
    const exact = Number.isFinite(envelopeTs);
    const from = exact ? anchor : anchor - LOOKUP_WINDOW_MS;
    const to = exact ? anchor : anchor + LOOKUP_WINDOW_MS;
    const providers = await storageEndpoints.providersWith(streamId, 'metadata');
    const urls = providers.flatMap((p) => p.urls);
    if (urls.length === 0) throw new Error('No storage provider can identify this message');
    let rows = null;
    for (const url of urls) {
        try {
            const resp = await fetchImpl(`${url}/streams/${encodeURIComponent(streamId)}/data/partitions/${partition}/range?fromTimestamp=${from}&toTimestamp=${to}&format=metadata`);
            if (!resp.ok) continue;
            const body = await resp.json();
            if (Array.isArray(body)) { rows = body; break; }
        } catch (e) {
            Logger.debug(`Target lookup on ${url} failed: ${e.message}`);
        }
    }
    if (!rows) throw new Error('Could not look the message up on storage');
    const candidates = rows
        .filter((r) => Number.isFinite(Number(r.timestamp)))
        .map((r) => ({ timestamp: Number(r.timestamp), sequenceNumber: Number(r.sequenceNumber ?? 0), distance: Math.abs(Number(r.timestamp) - anchor) }))
        .sort((a, b) => a.distance - b.distance);
    if (candidates.length === 0) throw new Error('The message is not on storage');
    if (candidates.length > 1 && candidates[1].distance - candidates[0].distance < LOOKUP_TIE_MS) {
        throw new Error('Several messages share this instant; cannot tell which to erase');
    }
    return { timestamp: candidates[0].timestamp, sequenceNumber: candidates[0].sequenceNumber };
}

/**
 * Erase one channel message from every provider that can. The caller hides
 * it first; this only removes the bytes.
 * @param {Object} channel - Channel record (messageStreamId, purgeProviders)
 * @param {Object} msg - The message
 * @param {{address: string, sign: (message: string) => Promise<string>}} signer
 * @param {Object} [options]
 * @param {number} [options.partition=0]
 */
export async function eraseMessage(channel, msg, signer, { partition = 0, fetchImpl = fetch, openerFor = null } = {}) {
    const streamId = channel.messageStreamId || channel.streamId;
    return purgeGroups(streamId, await messageGroups(streamId, partition, msg, fetchImpl, openerFor), signer, fetchImpl);
}

/**
 * The storage rows a message occupies: its own, plus the chunks of a
 * storage-shared file.
 * @param {string} streamId
 * @param {number} partition
 * @param {Object} msg
 * @param {typeof fetch} [fetchImpl]
 * @param {(meta: Object) => Promise<Function>} [openerFor] - The chunk opener for a file's announce
 * @returns {Promise<Array<{partition: number, targets: Array}>>}
 */
export async function messageGroups(streamId, partition, msg, fetchImpl = fetch, openerFor = null) {
    const groups = [{ partition, targets: [await resolveTarget(streamId, partition, msg, fetchImpl)] }];
    if (msg?.type === 'storage_file_announce' && msg.metadata) {
        const openChunk = openerFor ? await openerFor(msg.metadata) : asIs;
        groups.push(...await fileChunkGroups(streamId, msg.metadata, fetchImpl, openChunk));
    }
    return groups;
}

/**
 * Erase everything one author wrote that this client holds: their messages
 * and the chunks of their files. A message whose rows cannot be located is
 * skipped and counted, never guessed at.
 * @param {Object} channel - Channel record (messages, messageStreamId)
 * @param {string} address - The author
 * @param {{address: string, sign: (message: string) => Promise<string>}} signer
 * @returns {Promise<Object>} purgeGroups outcome plus `messages` (located) and `skipped`
 */
export async function eraseAuthorMessages(channel, address, signer, { partition = 0, fetchImpl = fetch, openerFor = null } = {}) {
    const streamId = channel.messageStreamId || channel.streamId;
    const lower = String(address).toLowerCase();
    const theirs = (channel.messages || []).filter((m) => String(m?.sender || '').toLowerCase() === lower);
    const byPartition = new Map();
    let skipped = 0;
    for (const msg of theirs) {
        try {
            for (const g of await messageGroups(streamId, partition, msg, fetchImpl, openerFor)) {
                byPartition.set(g.partition, [...(byPartition.get(g.partition) || []), ...g.targets]);
            }
        } catch (e) {
            skipped++;
            Logger.warn(`Erase of ${msg.id} skipped: ${e.message}`);
        }
    }
    const groups = [...byPartition].map(([p, targets]) => ({ partition: p, targets }));
    const outcome = await purgeGroups(streamId, groups, signer, fetchImpl);
    return { ...outcome, messages: theirs.length - skipped, skipped };
}
