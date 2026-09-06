/**
 * The dynamic half of the stream configuration: the storage node and provider
 * catalogue, the history window sizes, and the publish warm-up thresholds.
 *
 * It lives here rather than in `streamr.js` so the transport's collaborators
 * can read it without importing their own host back.
 */

import { CONFIG } from './config.js';
import {
    MESSAGE_STREAM as MESSAGE_STREAM_CONSTANTS,
    EPHEMERAL_STREAM as EPHEMERAL_STREAM_CONSTANTS,
    ADMIN_STREAM as ADMIN_STREAM_CONSTANTS,
    KEYS_STREAM as KEYS_STREAM_CONSTANTS,
    INTERACTIONS_STREAM as INTERACTIONS_STREAM_CONSTANTS
} from './streamConstants.js';

// Protocol constants live in streamConstants.js; this object adds the
// dynamic/environment bits (storage node address, provider catalog).
export const STREAM_CONFIG = {
    // Pombo's official storage node address
    NODE_ADDRESS: '0xae340e799e8151f6a4999d245e466197aa217667',

    // Storage Providers Configuration
    STORAGE_PROVIDERS: {
        STREAMR: {
            id: 'streamr',
            name: 'Pombo',
            description: 'Official Pombo storage cluster with configurable retention',
            supportsTTL: true,
            defaultDays: CONFIG.storage.defaultRetentionDays,
            getNodeAddress: () => STREAM_CONFIG.NODE_ADDRESS
        },
        CUSTOM: {
            id: 'custom',
            name: 'Custom Storage Node',
            description: 'User-supplied Streamr-compatible storage node',
            supportsTTL: true,
            defaultDays: CONFIG.storage.defaultRetentionDays,
            getNodeAddress: (address) => address
        }
    },

    // Default storage provider
    DEFAULT_STORAGE_PROVIDER: CONFIG.storage.defaultProvider,

    // Number of messages to load on join (higher to account for reactions)
    INITIAL_MESSAGES: CONFIG.stream.initialMessages,

    // Number of messages to load on scroll (pagination)
    LOAD_MORE_COUNT: CONFIG.stream.loadMoreCount,

    // Message Stream (with storage) — see streamConstants.js
    MESSAGE_STREAM: MESSAGE_STREAM_CONSTANTS,

    // Ephemeral Stream (no storage) — see streamConstants.js
    EPHEMERAL_STREAM: EPHEMERAL_STREAM_CONSTANTS,

    ADMIN_STREAM: ADMIN_STREAM_CONSTANTS,

    KEYS_STREAM: KEYS_STREAM_CONSTANTS,

    INTERACTIONS_STREAM: INTERACTIONS_STREAM_CONSTANTS,

    // History count to fetch when bootstrapping admin state on channel open.
    // Snapshot is `latest-wins`; a small window is sufficient.
    ADMIN_HISTORY_COUNT: 10,

    // Moderator deltas on -1/P2. Unlike the snapshot these accumulate one
    // entry per action, and only those the owner has not absorbed still
    // count — a wide window costs a single resend and keeps a moderator's
    // work visible across a long owner absence.
    MODERATION_HISTORY_COUNT: 300,

    // publishAs(): how long to wait for the stream partition topology before
    // broadcasting. Joining registers interest but does not imply anyone is
    // connected yet — the smoke test caught a message published from a cold
    // node never reaching a live subscriber (it did reach storage).
    PUBLISH_MIN_NEIGHBORS: 1,
    PUBLISH_NEIGHBOR_TIMEOUT_MS: 5000
};
