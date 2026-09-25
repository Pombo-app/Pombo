/**
 * Wire framing for a state snapshot too big to travel as one message: a run of
 * chunks closed by a manifest, the same shape image blobs use. The network
 * drops an oversized message WITHOUT an error the publisher can see.
 *
 * Android parity: core/SyncChunks.kt, locked by docs/SYNC-chunk-vectors.json
 * and docs/ADMIN-chunk-vectors.json.
 */

/**
 * Characters of cleartext per wire message. Sealing JSON-escapes the slice and
 * base64s the ciphertext, so the envelope lands well over this: measured, a
 * 150 KB slice reaches the wire at ~227 KB. Raising it is not free.
 */
export const SYNC_CHUNK_CHARS = 150 * 1024;

/**
 * The row types and fields of one framed protocol. `carry` names the payload
 * fields every row repeats; `keepPairs` never cuts between the two halves of
 * a surrogate pair, which a UTF-8 encoder downstream would turn into '?'.
 */
const SYNC_FRAME = Object.freeze({
    chunk: 'sync_chunk', manifest: 'sync_manifest', id: 'syncId', carry: ['ts'], keepPairs: true
});

/**
 * An ADMIN_STATE too big for one message. Its own row types, so a reader that
 * predates the split skips the rows instead of misreading them; `rev` rides
 * every row so a run can be ranked before it is assembled.
 */
export const ADMIN_FRAME = Object.freeze({
    chunk: 'admin_chunk', manifest: 'admin_manifest', id: 'runId', carry: ['rev', 'ts'], keepPairs: true
});

/**
 * Frame a payload for the wire.
 *
 * @param {Object} payload - The whole snapshot
 * @param {string} runId - Ties the chunks to their manifest
 * @param {Object} frame - Row types and fields (SYNC_FRAME, ADMIN_FRAME)
 * @param {number} limit - Characters per chunk
 * @returns {Object[]} - The payload itself when it fits, else chunks + manifest
 */
export function splitFramed(payload, runId, frame, limit) {
    const serialised = JSON.stringify(payload);
    if (serialised.length <= limit) return [payload];

    const slices = [];
    for (let start = 0; start < serialised.length;) {
        let end = Math.min(start + limit, serialised.length);
        if (frame.keepPairs && end < serialised.length && end - 1 > start
                && isHighSurrogate(serialised.charCodeAt(end - 1))) {
            end -= 1;
        }
        slices.push(serialised.slice(start, end));
        start = end;
    }

    const header = {};
    for (const field of frame.carry) header[field] = payload[field];
    const chunkCount = slices.length;
    const out = slices.map((data, chunkIndex) => ({
        type: frame.chunk, v: 1, ...header, [frame.id]: runId, chunkIndex, chunkCount, data
    }));
    // Last, so a reader holding the manifest knows the run is complete rather
    // than still arriving.
    out.push({ type: frame.manifest, v: 1, ...header, [frame.id]: runId, chunkCount });
    return out;
}

/**
 * Put the runs back together. An incomplete run is dropped whole, never
 * applied in part: a truncated snapshot would merge garbage into the state.
 * Rows of any other type are ignored; what the joined payload must be is the
 * caller's to check.
 *
 * @param {Object[]} messages - Opened payloads, in any order
 * @param {Object} frame - Row types and fields
 * @param {(reason: Object) => void} [onDropped] - Told about each dropped run
 * @returns {Array<{runId: string, manifest: Object, payload: Object}>}
 */
export function joinFramed(messages, frame, onDropped) {
    const parts = new Map();     // runId -> Map(index, slice)
    const manifests = new Map(); // runId -> manifest row

    for (const m of messages || []) {
        if (!m || m.v !== 1) continue;
        const runId = m[frame.id];
        if (typeof runId !== 'string' || !runId) continue;
        if (m.type === frame.chunk
                && typeof m.data === 'string'
                && Number.isInteger(m.chunkIndex) && m.chunkIndex >= 0) {
            if (!parts.has(runId)) parts.set(runId, new Map());
            parts.get(runId).set(m.chunkIndex, m.data);
        } else if (m.type === frame.manifest) {
            manifests.set(runId, m);
        }
    }

    const out = [];
    for (const [runId, manifest] of manifests) {
        const chunkCount = manifest.chunkCount;
        const got = parts.get(runId);
        if (!Number.isInteger(chunkCount) || chunkCount <= 0
                || !got || got.size !== chunkCount) {
            onDropped?.({ [frame.id]: runId, have: got?.size ?? 0, want: chunkCount, reason: 'incomplete' });
            continue;
        }
        let joined = '';
        for (let i = 0; i < chunkCount; i++) joined += got.get(i) ?? '';
        try {
            out.push({ runId, manifest, payload: JSON.parse(joined) });
        } catch (e) {
            onDropped?.({ [frame.id]: runId, reason: 'unparseable', error: e.message });
        }
    }
    return out;
}

function isHighSurrogate(code) {
    return code >= 0xD800 && code <= 0xDBFF;
}

/**
 * Frame a sync snapshot for the wire.
 *
 * @param {Object} payload - The whole `{ type:'sync', v, ts, data }` snapshot
 * @param {string} syncId - Run id, tying the chunks to their manifest
 * @param {number} [limit] - Characters per chunk
 * @returns {Object[]} - The payload itself when it fits, else chunks + manifest
 */
export function splitSyncPayload(payload, syncId, limit = SYNC_CHUNK_CHARS) {
    return splitFramed(payload, syncId, SYNC_FRAME, limit);
}

/**
 * Put the sync wire back together.
 *
 * @param {Object[]} messages - Opened payloads, in any order
 * @param {(reason: Object) => void} [onDropped] - Told about each dropped run
 * @returns {Object[]} - Whole `sync` payloads
 */
export function reassembleSyncPayloads(messages, onDropped) {
    const whole = (messages || []).filter(m => m && m.v === 1 && m.type === 'sync');
    for (const { runId, payload } of joinFramed(messages, SYNC_FRAME, onDropped)) {
        if (payload?.type === 'sync' && payload.v === 1) whole.push(payload);
        else onDropped?.({ syncId: runId, reason: 'not a snapshot' });
    }
    return whole;
}
