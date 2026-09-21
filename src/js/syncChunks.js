/**
 * Wire framing for a state snapshot too big to travel as one message: a run of
 * chunks closed by a manifest, the same shape image blobs use. The network
 * drops an oversized message WITHOUT an error the publisher can see.
 *
 * Android parity: core/SyncChunks.kt, locked by tests/vectors/sync-chunks.json.
 */

/**
 * Characters of cleartext per wire message. Sealing JSON-escapes the slice and
 * base64s the ciphertext, so the envelope lands well over this: measured, a
 * 150 KB slice reaches the wire at ~227 KB. Raising it is not free.
 */
export const SYNC_CHUNK_CHARS = 150 * 1024;

/**
 * Frame a payload for the wire.
 *
 * @param {Object} payload - The whole `{ type:'sync', v, ts, data }` snapshot
 * @param {string} syncId - Run id, tying the chunks to their manifest
 * @param {number} [limit] - Characters per chunk
 * @returns {Object[]} - The payload itself when it fits, else chunks + manifest
 */
export function splitSyncPayload(payload, syncId, limit = SYNC_CHUNK_CHARS) {
    const serialised = JSON.stringify(payload);
    if (serialised.length <= limit) return [payload];

    const chunkCount = Math.ceil(serialised.length / limit);
    const out = [];
    for (let i = 0; i < chunkCount; i++) {
        out.push({
            type: 'sync_chunk', v: 1, ts: payload.ts, syncId,
            chunkIndex: i, chunkCount,
            data: serialised.slice(i * limit, (i + 1) * limit)
        });
    }
    // Last, so a reader holding the manifest knows the run is complete rather
    // than still arriving.
    out.push({ type: 'sync_manifest', v: 1, ts: payload.ts, syncId, chunkCount });
    return out;
}

/**
 * Put the wire back together. An incomplete run is dropped whole, never
 * applied in part: a truncated snapshot would merge garbage into the account.
 *
 * @param {Object[]} messages - Opened payloads, in any order
 * @param {(reason: Object) => void} [onDropped] - Told about each dropped run
 * @returns {Object[]} - Whole `sync` payloads
 */
export function reassembleSyncPayloads(messages, onDropped) {
    const whole = [];
    const parts = new Map();     // syncId -> Map(index, slice)
    const expected = new Map();  // syncId -> chunkCount

    for (const m of messages || []) {
        if (!m || m.v !== 1) continue;
        if (m.type === 'sync') {
            whole.push(m);
        } else if (m.type === 'sync_chunk'
                && typeof m.syncId === 'string' && m.syncId
                && typeof m.data === 'string'
                && Number.isInteger(m.chunkIndex) && m.chunkIndex >= 0) {
            if (!parts.has(m.syncId)) parts.set(m.syncId, new Map());
            parts.get(m.syncId).set(m.chunkIndex, m.data);
        } else if (m.type === 'sync_manifest'
                && typeof m.syncId === 'string' && m.syncId) {
            expected.set(m.syncId, m.chunkCount);
        }
    }

    for (const [syncId, chunkCount] of expected) {
        const got = parts.get(syncId);
        if (!Number.isInteger(chunkCount) || chunkCount <= 0
                || !got || got.size !== chunkCount) {
            onDropped?.({ syncId, have: got?.size ?? 0, want: chunkCount, reason: 'incomplete' });
            continue;
        }
        let joined = '';
        for (let i = 0; i < chunkCount; i++) joined += got.get(i) ?? '';
        let payload;
        try {
            payload = JSON.parse(joined);
        } catch (e) {
            onDropped?.({ syncId, reason: 'unparseable', error: e.message });
            continue;
        }
        if (payload?.type === 'sync' && payload.v === 1) whole.push(payload);
        else onDropped?.({ syncId, reason: 'not a snapshot' });
    }
    return whole;
}
