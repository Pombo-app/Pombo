/**
 * The storage rows this session published in channels under a channel
 * pseudonym, each with the key that signed it: what an own delete can erase.
 *
 * Memory only, never persisted, and kept past the pseudonym's rotation, so a
 * message stays erasable by its author for as long as the session that wrote
 * it lasts and never after. A chunked image's chunks carry no id of their own:
 * they are filed under their imageId and join the manifest that names it.
 */

import { MESSAGE_STREAM } from './streamConstants.js';

const MAX_MESSAGES = 2000;
const rows = new Map();

const keyOf = (streamId, id) => `${String(streamId).toLowerCase()}|${id}`;

function remember(streamId, id, row) {
    const key = keyOf(streamId, id);
    const list = rows.get(key) || [];
    list.push(row);
    rows.delete(key);
    rows.set(key, list);
    if (rows.size > MAX_MESSAGES) rows.delete(rows.keys().next().value);
}

/**
 * Files a published payload under its message id (or its image's id).
 * @param {string} streamId - The message stream it went to
 * @param {Object} payload - What was published
 * @param {Object} published - The published StreamMessage
 * @param {number} partition
 * @param {{address: string, sign: (message: string) => Promise<string>}} signer - The key that signed it
 */
export function rememberPublished(streamId, payload, published, partition, signer) {
    const id = typeof payload?.id === 'string' ? payload.id
        : (payload?.type === 'image_chunk' && typeof payload.imageId === 'string') ? `image:${payload.imageId}` : null;
    const timestamp = published?.messageId?.timestamp ?? published?.timestamp;
    if (!id || !Number.isFinite(timestamp)) return;
    remember(streamId, id, { partition, timestamp, sequenceNumber: published?.messageId?.sequenceNumber ?? 0, signer });
}

/** Files a stored file's chunk rows under its announce, all written under one key. */
export function rememberFileRows(streamId, messageId, fileRows, signer) {
    for (const r of fileRows) remember(streamId, messageId, { partition: r.partition, timestamp: r.timestamp, sequenceNumber: r.sequenceNumber ?? 0, signer });
}

function rowsOf(streamId, msg) {
    return [
        ...(rows.get(keyOf(streamId, msg?.id)) || []),
        ...(msg?.imageId ? rows.get(keyOf(streamId, `image:${msg.imageId}`)) || [] : [])
    ];
}

/** Whether this session wrote the message, so its author can erase it. */
export function canErase(streamId, msg) {
    return rowsOf(streamId, msg).length > 0;
}

/**
 * The purge groups of an own message, each signed by the key that wrote its
 * rows; the message's own row last, so a pass that fails on the parts leaves
 * the message in place, never parts nobody can address any more.
 */
export function purgeGroupsOf(streamId, msg) {
    const groups = new Map();
    for (const r of rowsOf(streamId, msg)) {
        const key = `${r.partition}|${r.signer.address}`;
        if (!groups.has(key)) groups.set(key, { partition: r.partition, targets: [], signer: r.signer });
        groups.get(key).targets.push({ timestamp: r.timestamp, sequenceNumber: r.sequenceNumber });
    }
    const own = (g) => (g.partition === MESSAGE_STREAM.MESSAGES ? 1 : 0);
    return [...groups.values()].sort((a, b) => own(a) - own(b));
}

export function forget(streamId, msg) {
    rows.delete(keyOf(streamId, msg?.id));
    if (msg?.imageId) rows.delete(keyOf(streamId, `image:${msg.imageId}`));
}

/** Drops everything on logout or account switch: the keys belong to the session that ends. */
export function clearChannelSentRows() {
    rows.clear();
}
