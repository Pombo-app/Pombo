import { CONFIG } from './config.js';

const editedAt = (message) => (typeof message?._editedAt === 'number' ? message._editedAt : 0);

/**
 * Union of sent messages by id. A copy edited later than the other replaces
 * it, and any message the deletion map names is left out, whichever side
 * still holds it.
 *
 * @param {Object} local - { streamId: [...messages] }
 * @param {Object} remote - Same shape
 * @param {number} [maxSentMessages] - Kept per conversation, newest last
 * @param {Object} [deleted] - { streamId: { messageId: deletedAt } }
 * @returns {Object}
 */
export function mergeSentMessages(local, remote, maxSentMessages = CONFIG.dm.maxSentMessages, deleted = {}) {
    const result = {};

    for (const [streamId, messages] of Object.entries(local || {})) {
        result[streamId] = messages.map(message => ({ ...message }));
    }

    for (const [streamId, remoteMessages] of Object.entries(remote || {})) {
        if (!result[streamId]) {
            result[streamId] = remoteMessages.map(message => ({ ...message }));
            continue;
        }

        const localById = new Map(result[streamId].map(message => [message.id, message]));
        for (const message of remoteMessages) {
            const existing = localById.get(message.id);
            if (!existing) {
                result[streamId].push({ ...message });
            } else if (editedAt(message) > editedAt(existing)) {
                const { imageData } = existing;
                Object.assign(existing, message);
                if (imageData && !message.imageData) existing.imageData = imageData;
            } else if (message.type === 'image' && message.imageData && !existing.imageData) {
                existing.imageData = message.imageData;
            }
        }

        result[streamId].sort((a, b) => a.timestamp - b.timestamp);
        if (result[streamId].length > maxSentMessages) {
            result[streamId] = result[streamId].slice(-maxSentMessages);
        }
    }

    return withoutDeleted(result, deleted);
}

/**
 * Union of two sent-message deletion maps ({ streamId: { messageId:
 * deletedAt } }), the latest time per message. A message id is never reused,
 * so an entry is never retracted and never pruned.
 */
export function mergeSentDeletedAt(base, incoming) {
    const result = {};
    for (const source of [base || {}, incoming || {}]) {
        for (const [streamId, ids] of Object.entries(source)) {
            if (!ids || typeof ids !== 'object') continue;
            const out = result[streamId] || (result[streamId] = {});
            for (const [messageId, ts] of Object.entries(ids)) {
                if (typeof ts !== 'number') continue;
                if (!(messageId in out) || ts > out[messageId]) out[messageId] = ts;
            }
        }
    }
    return result;
}

/** The sent messages without every one the deletion map names. */
export function withoutDeleted(sentMessages, deleted) {
    const out = {};
    for (const [streamId, messages] of Object.entries(sentMessages || {})) {
        const gone = deleted?.[streamId];
        out[streamId] = gone ? messages.filter(message => !Object.hasOwn(gone, message.id)) : messages;
    }
    return out;
}

export function mergeSentReactions(local, remote) {
    const result = {};
    const allStreamIds = new Set([...Object.keys(local || {}), ...Object.keys(remote || {})]);

    for (const streamId of allStreamIds) {
        const localStream = local?.[streamId] || {};
        const remoteStream = remote?.[streamId] || {};
        result[streamId] = {};

        const allMessageIds = new Set([...Object.keys(localStream), ...Object.keys(remoteStream)]);
        for (const messageId of allMessageIds) {
            if (messageId in remoteStream) {
                const remoteReactions = remoteStream[messageId];
                if (Object.keys(remoteReactions).length > 0) {
                    result[streamId][messageId] = remoteReactions;
                }
            } else {
                result[streamId][messageId] = localStream[messageId];
            }
        }

        if (Object.keys(result[streamId]).length === 0) {
            delete result[streamId];
        }
    }

    return result;
}

const fieldStamp = (record, key) => {
    const ts = record?.fieldTs?.[key];
    return typeof ts === 'number' ? ts : 0;
};

/**
 * A channel record's field stamps after a local save: each field that differs
 * from the copy last persisted or imported is stamped `now`. A record with no
 * such copy (created here) keeps the stamps it has.
 *
 * @param {Object|undefined} previous - The copy last persisted or imported
 * @param {Object} record - The record about to be persisted
 * @param {number} now
 * @returns {Object|undefined} `record.fieldTs` itself when nothing changed
 */
export function stampChangedFields(previous, record, now) {
    if (!previous) return record.fieldTs;
    let stamps = record.fieldTs;
    for (const key of new Set([...Object.keys(record), ...Object.keys(previous)])) {
        if (key === 'fieldTs' || JSON.stringify(record[key]) === JSON.stringify(previous[key])) continue;
        if (stamps === record.fieldTs) stamps = { ...(record.fieldTs || {}) };
        stamps[key] = now;
    }
    return stamps;
}

/**
 * One channel record from two copies of it. Each field comes from the copy
 * whose `fieldTs` stamped it later; a field neither copy stamped, or both
 * stamped at the same time, comes from `preferred`, and a field only one copy
 * carries is kept. The stamps join, the latest per field, so a client that
 * drops them cannot take them from the others.
 *
 * @param {Object} preferred - The copy the join-time rule picks
 * @param {Object} other - The other copy
 * @returns {Object} `preferred` itself when nothing comes from `other`
 */
export function mergeChannelRecord(preferred, other) {
    const merged = {};
    let tookOther = false;
    for (const key of new Set([...Object.keys(preferred), ...Object.keys(other)])) {
        if (key === 'fieldTs') continue;
        const fromOther = key in other
            && (!(key in preferred) || fieldStamp(other, key) > fieldStamp(preferred, key));
        merged[key] = fromOther ? other[key] : preferred[key];
        if (fromOther) tookOther = true;
    }
    if (!tookOther) return preferred;
    if (preferred.fieldTs || other.fieldTs) {
        merged.fieldTs = {};
        for (const source of [preferred.fieldTs || {}, other.fieldTs || {}]) {
            for (const [key, ts] of Object.entries(source)) {
                if (typeof ts === 'number' && ts > (merged.fieldTs[key] || 0)) merged.fieldTs[key] = ts;
            }
        }
    }
    return merged;
}

/**
 * Merge channel lists as an LWW-element-set (per-channel latest-wins).
 *
 * A channel's membership is decided by comparing its join timestamp
 * (`joinedAt`, falling back to `createdAt`) against its leave tombstone in
 * `channelsLeftAt`. The most recent action wins; on a tie, Join wins.
 * This replaces whole-array snapshot replacement, which could delete a
 * fresh local Join when an older remote snapshot arrived (or vice versa).
 * Two copies of the same channel merge field by field (mergeChannelRecord).
 *
 * @param {Array} baseChannels - Base channel entries
 * @param {Array} incomingChannels - Incoming channel entries
 * @param {Object} baseLeftAt - Base leave tombstones { messageStreamId: ts }
 * @param {Object} incomingLeftAt - Incoming leave tombstones
 * @returns {{channels: Array, channelsLeftAt: Object}}
 */
export function mergeChannels(baseChannels, incomingChannels, baseLeftAt, incomingLeftAt) {
    const joinTs = (ch) => ch?.joinedAt || ch?.createdAt || 0;

    // Merge tombstones: max timestamp per channel wins
    const channelsLeftAt = {};
    for (const source of [baseLeftAt || {}, incomingLeftAt || {}]) {
        for (const [streamId, ts] of Object.entries(source)) {
            if (typeof ts !== 'number') continue;
            if (!(streamId in channelsLeftAt) || ts > channelsLeftAt[streamId]) {
                channelsLeftAt[streamId] = ts;
            }
        }
    }

    // Union channel entries: for the fields no stamp decides, the entry with
    // the newest join timestamp wins and incoming wins ties. An entry with
    // no joinedAt of its own is never a newer join than one that has it, but
    // its time still counts as a join against a leave tombstone.
    const replaces = (incoming, existing) => {
        if (!!incoming.joinedAt !== !!existing.joinedAt) return !!incoming.joinedAt;
        return joinTs(incoming) >= joinTs(existing);
    };
    const byId = new Map();
    const latestJoin = new Map();
    const noteJoin = (channel) => latestJoin.set(channel.messageStreamId,
        Math.max(latestJoin.get(channel.messageStreamId) || 0, joinTs(channel)));
    for (const channel of baseChannels || []) {
        if (!channel?.messageStreamId) continue;
        byId.set(channel.messageStreamId, channel);
        noteJoin(channel);
    }
    for (const channel of incomingChannels || []) {
        if (!channel?.messageStreamId) continue;
        noteJoin(channel);
        const existing = byId.get(channel.messageStreamId);
        if (!existing) {
            byId.set(channel.messageStreamId, channel);
        } else {
            byId.set(channel.messageStreamId, replaces(channel, existing)
                ? mergeChannelRecord(channel, existing)
                : mergeChannelRecord(existing, channel));
        }
    }

    // Membership: last action wins. Join persists unless a strictly newer
    // leave tombstone exists.
    const channels = [];
    for (const channel of byId.values()) {
        const leftTs = channelsLeftAt[channel.messageStreamId];
        if (leftTs !== undefined && leftTs > latestJoin.get(channel.messageStreamId)) continue;
        channels.push(channel);
        // Prune tombstones superseded by a re-join to keep the map small
        if (leftTs !== undefined) {
            delete channelsLeftAt[channel.messageStreamId];
        }
    }

    return { channels, channelsLeftAt };
}

/**
 * Union-merge the epoch-key slice ({ messageStreamId: { epochs, announces,
 * currentEpoch, pendingRequests, helloEpochs } }). Entries are
 * content-addressed (keyId → immutable key, epoch → immutable announce,
 * requestId → immutable pending id), so union is exact: base wins per entry —
 * a key this device already adopted must never regress — and currentEpoch
 * only moves forward. Pending request ids union so a wrap answered days later
 * opens on EVERY device of the account; helloEpochs union so a second device
 * does not re-hello an epoch the first already announced itself in. `keepIds`
 * (when given) drops channels the channel merge itself dropped, so a leave
 * tombstone retires the keys the same way it retires the channel.
 *
 * @param {Object} base - Base epochKeys slice
 * @param {Object} incoming - Incoming epochKeys slice
 * @param {Set<string>|null} keepIds - Channel ids that survived the merge
 * @returns {Object}
 */
export function mergeEpochKeys(base, incoming, keepIds = null) {
    const result = {};
    const streamIds = new Set([
        ...Object.keys(base || {}),
        ...Object.keys(incoming || {})
    ]);

    for (const streamId of streamIds) {
        if (keepIds && !keepIds.has(streamId)) continue;
        const b = base?.[streamId];
        const i = incoming?.[streamId];
        if (!b || !i) {
            const only = b || i;
            if (only && typeof only === 'object') result[streamId] = only;
            continue;
        }
        const epochs = { ...(i.epochs || {}), ...(b.epochs || {}) };
        const announces = { ...(i.announces || {}), ...(b.announces || {}) };
        const currentEpoch = Math.max(b.currentEpoch || 0, i.currentEpoch || 0);
        const pendingRequests = { ...(i.pendingRequests || {}), ...(b.pendingRequests || {}) };
        const helloEpochs = [...new Set([
            ...(b.helloEpochs || []), ...(i.helloEpochs || [])
        ])].filter(Number.isInteger).sort((x, y) => x - y);
        // Shared keys (publish and interactions): higher rev wins (a re-key
        // must supersede on every device); ties keep base, like the other slices.
        const higherRev = (x, y) => {
            if (!x) return y;
            if (!y) return x;
            return (y.rev || 0) > (x.rev || 0) ? y : x;
        };
        const pubKey = higherRev(b.pubKey, i.pubKey);
        const pubAnnounce = higherRev(b.pubAnnounce, i.pubAnnounce);
        const intKey = higherRev(b.intKey, i.intKey);
        const intAnnounce = higherRev(b.intAnnounce, i.intAnnounce);
        result[streamId] = {
            epochs, announces, currentEpoch, pendingRequests, helloEpochs,
            ...(pubKey ? { pubKey } : {}),
            ...(pubAnnounce ? { pubAnnounce } : {}),
            ...(intKey ? { intKey } : {}),
            ...(intAnnounce ? { intAnnounce } : {})
        };
    }

    return result;
}

/**
 * Defaults for the timestamped latest-wins slices.
 */
const SLICE_DEFAULTS = {
    blockedPeers: [],
    dmLeftAt: {},
    trustedContacts: {},
    username: null,
    graphApiKey: null
};

// Older than any real stamp, so a live edit still wins; newer than the 0 of a
// snapshot that holds nothing.
const UNSTAMPED_VALUE_TS = 1;

function isEmptySlice(value) {
    if (value == null || value === '') return true;
    if (Array.isArray(value)) return value.length === 0;
    return typeof value === 'object' && Object.keys(value).length === 0;
}

/**
 * The state's slice timestamps, with every slice that holds a value but no
 * stamp (a restored backup, an old client) stamped UNSTAMPED_VALUE_TS.
 * @param {Object} state - Sync/backup-shaped state
 * @returns {Object} A new sliceTs object
 */
export function stampedSliceTs(state) {
    const sliceTs = { ...(state?.sliceTs || {}) };
    for (const key of Object.keys(SLICE_DEFAULTS)) {
        if (!sliceTs[key] && !isEmptySlice(state?.[key])) sliceTs[key] = UNSTAMPED_VALUE_TS;
    }
    return sliceTs;
}

export function mergeState(base, incoming, maxSentMessages = CONFIG.dm.maxSentMessages) {
    const { channels, channelsLeftAt } = mergeChannels(
        base?.channels,
        incoming?.channels,
        base?.channelsLeftAt,
        incoming?.channelsLeftAt
    );

    // Timestamped latest-wins slices: the side whose slice was mutated most
    // recently (sliceTs) wins. This stops a pull from clobbering local
    // changes that haven't been pushed yet. Payloads from older clients have
    // no sliceTs (treated as 0) and on ties the incoming snapshot wins —
    // preserving the previous chronological latest-wins behavior — except that
    // an unstamped empty slice never replaces one that holds a value: a device
    // that has read nothing yet publishes exactly that.
    const sliceTs = {};
    const pickSlice = (key) => {
        const baseHas = base?.[key] !== undefined;
        const incomingHas = incoming?.[key] !== undefined;
        const baseTs = base?.sliceTs?.[key] || 0;
        const incomingTs = incoming?.sliceTs?.[key] || 0;
        const emptyOverValue = incomingTs === 0
            && isEmptySlice(incoming?.[key]) && !isEmptySlice(base?.[key]);

        if (incomingHas && !emptyOverValue && (!baseHas || incomingTs >= baseTs)) {
            sliceTs[key] = incomingTs;
            return incoming[key];
        }
        if (baseHas) {
            sliceTs[key] = baseTs;
            return base[key];
        }
        sliceTs[key] = 0;
        return SLICE_DEFAULTS[key];
    };

    // graphApiKey legacy behavior: when neither side has a slice timestamp
    // (pre-sliceTs snapshots), a null incoming key must not delete a locally
    // configured key (truthy fallback, as before).
    let graphApiKey;
    if (!(base?.sliceTs?.graphApiKey) && !(incoming?.sliceTs?.graphApiKey)) {
        graphApiKey = incoming?.graphApiKey || base?.graphApiKey || null;
        sliceTs.graphApiKey = 0;
    } else {
        graphApiKey = pickSlice('graphApiKey') || null;
    }

    const sentDeletedAt = mergeSentDeletedAt(base?.sentDeletedAt, incoming?.sentDeletedAt);

    return {
        sentMessages: mergeSentMessages(
            base?.sentMessages || {},
            incoming?.sentMessages || {},
            maxSentMessages,
            sentDeletedAt
        ),
        sentDeletedAt,
        sentReactions: mergeSentReactions(
            base?.sentReactions || {},
            incoming?.sentReactions || {}
        ),
        channels,
        channelsLeftAt,
        epochKeys: mergeEpochKeys(
            base?.epochKeys,
            incoming?.epochKeys,
            new Set(channels.map(c => c.messageStreamId))
        ),
        blockedPeers: pickSlice('blockedPeers'),
        dmLeftAt: pickSlice('dmLeftAt'),
        trustedContacts: pickSlice('trustedContacts'),
        ensCache: {
            ...(base?.ensCache || {}),
            ...(incoming?.ensCache || {})
        },
        username: pickSlice('username') || null,
        graphApiKey,
        sliceTs
    };
}

export function mergePayloadSeries(base, payloads, maxSentMessages = CONFIG.dm.maxSentMessages) {
    let merged = base;
    for (const payload of payloads) {
        merged = mergeState(merged, payload, maxSentMessages);
    }
    return merged;
}