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

export const PURGE_MAX_TARGETS = 100;
const PURGE_TIMEOUT_MS = 30000;
const LOOKUP_WINDOW_MS = 10000;
const LOOKUP_TIE_MS = 1000;

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
 * Fan the purge out to every provider of the stream that announces it.
 * @param {string} streamId
 * @param {number} partition
 * @param {Array<{timestamp: number, sequenceNumber: number}>} targets
 * @param {{address: string, sign: (message: string) => Promise<string>}} signer
 * @returns {Promise<{providers: number, erasedOn: number, forbiddenOn: number, unreachable: number, outcomes: Array}>}
 *   `erasedOn` counts providers where every target is now gone (`deleted` or
 *   `not_found`); `forbiddenOn` those that refused at least one target.
 */
export async function purgeMessages(streamId, partition, targets, signer, fetchImpl = fetch) {
    const providers = await storageEndpoints.providersWith(streamId, 'purge');
    const outcomes = await Promise.all(providers.map((p) => purgeOnProvider(p, streamId, partition, targets, signer, fetchImpl)));
    const gone = (o) => o.status === 200 && targets.every((t) => {
        const r = o.results.find((x) => Number(x.timestamp) === t.timestamp && Number(x.sequenceNumber) === t.sequenceNumber);
        return r && (r.result === 'deleted' || r.result === 'not_found');
    });
    const forbidden = (o) => o.status === 200 && o.results.some((r) => r.result === 'forbidden');
    return {
        providers: providers.length,
        erasedOn: outcomes.filter(gone).length,
        forbiddenOn: outcomes.filter(forbidden).length,
        unreachable: outcomes.filter((o) => o.status === 0).length,
        outcomes
    };
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
export async function eraseMessage(channel, msg, signer, { partition = 0, fetchImpl = fetch } = {}) {
    const streamId = channel.messageStreamId || channel.streamId;
    const target = await resolveTarget(streamId, partition, msg, fetchImpl);
    return purgeMessages(streamId, partition, [target], signer, fetchImpl);
}
