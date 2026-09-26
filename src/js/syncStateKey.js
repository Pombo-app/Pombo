/**
 * What a sync state carries that is not worth a push of its own: caches,
 * bookkeeping the network or the next real change brings back, and stream ids
 * derived from the channel's own id. Everything else is news, including a
 * slice this client does not know. Android's SyncStateKey.kt keeps the same
 * lists; the "publish" parity vectors in docs/SYNC-merge-vectors.json lock them.
 */
export const SYNC_STATE_IGNORED = Object.freeze({
    slices: Object.freeze(['ensCache', 'sliceTs']),
    epochKeyFields: Object.freeze([
        'announces', 'pendingRequests', 'helloEpochs', 'helloName', 'helloTs',
        'seenRequesters', 'pubAnnounce', 'intAnnounce'
    ]),
    channelFields: Object.freeze([
        'ephemeralStreamId', 'adminStreamId', 'keysStreamId', 'interactionsStreamId',
        'inboxStreamId', 'storageProvider'
    ])
});

const isEmpty = (value) => value === null || value === undefined || value === '' || value === false
    || (Array.isArray(value) && value.length === 0)
    || (typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === 0);

/** Sorted keys, and an empty entry (null, '', false, [], {}) dropped: it is the same state as a missing one. */
function canonical(value) {
    if (Array.isArray(value)) return value.map(canonical);
    if (value && typeof value === 'object') {
        const out = {};
        for (const key of Object.keys(value).sort()) {
            const entry = canonical(value[key]);
            if (!isEmpty(entry)) out[key] = entry;
        }
        return out;
    }
    return value;
}

function without(record, fields) {
    if (!record || typeof record !== 'object' || Array.isArray(record)) return record;
    const out = { ...record };
    for (const field of fields) delete out[field];
    return out;
}

/**
 * The news a sync state carries, as one canonical string: two states with the
 * same key need no push between them. The order of the channel list is local
 * and is not part of it.
 * @param {Object} state - A sync export (exportForSync shape)
 * @returns {string}
 */
export function syncStateKey(state) {
    const projected = {};
    for (const [slice, value] of Object.entries(state || {})) {
        if (SYNC_STATE_IGNORED.slices.includes(slice)) continue;
        if (slice === 'channels' && Array.isArray(value)) {
            projected.channels = value
                .map(channel => without(channel, SYNC_STATE_IGNORED.channelFields))
                .sort((a, b) => String(a?.messageStreamId).localeCompare(String(b?.messageStreamId)));
        } else if (slice === 'epochKeys' && value && typeof value === 'object') {
            projected.epochKeys = Object.fromEntries(Object.entries(value)
                .map(([streamId, entry]) => [streamId, without(entry, SYNC_STATE_IGNORED.epochKeyFields)]));
        } else {
            projected[slice] = value;
        }
    }
    return JSON.stringify(canonical(projected));
}
