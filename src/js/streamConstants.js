/**
 * Stream Architecture Constants (TRIPLE-STREAM)
 *
 * These are *protocol* constants, not tunable configuration — changing them
 * breaks interoperability with already-published messages. They live in a
 * dedicated module (separate from `config.js`) to make that distinction
 * explicit and prevent accidental edits.
 *
 * ARCHITECTURE:
 *   Each regular channel uses up to 4 streams, derived from a base ID by appending:
 *     -1  → Message stream   (WITH storage) — content (text, reactions, media announces, edit/delete overrides)
 *     -2  → Ephemeral stream (NO storage)   — presence, typing, P2P media coordination
 *     -3  → Admin stream     (WITH storage) — admin-only writes (moderation state)
 *     -4  → Keys stream      (WITH storage) — epoch-key distribution (gated channels only)
 *
 * MESSAGE STREAM (-1):
 *   Regular channels use 11 partitions:
 *     P0 content, P1 control overrides, P2-P10 storage-file chunks.
 *   DM inboxes use 13 partitions:
 *     P0 messages, P1 sync, P2 sync_blobs, P3 notifications, P4-P12 storage-file chunks.
 *
 *   The 9 chunk partitions carry Persistent File Sharing payloads (uploaded to the
 *   channel's storage nodes, downloaded via storage resend/HTTP — never subscribed
 *   live). Chunk i goes to partition first + (i % 9). Nine partitions exist for
 *   storage-node resend efficiency (small buckets, parallel per-partition reads),
 *   NOT for throughput — a single partition already saturates the publish path.
 *
 * EPHEMERAL STREAM (-2):
 *   3 partitions: control (presence/typing), media signals, media data.
 *
 * ADMIN STREAM (-3):
 *   3 partitions reserved by protocol; only P0 used in initial scope.
 *     P0: ADMIN_STATE  (moderation: bannedMembers, hiddenMessageIds, pins) — IMPLEMENTED
 *     P1: CHANNEL_IMAGE                                                    — RESERVED
 *     P2: PASSWORD_CHALLENGE                                               — RESERVED
 *   Permissions: only owner publishes; readers vary by channel type
 *   (public/password: public subscribe; gated: clone subscribe).
 *
 * KEYS STREAM (-4) — gated channels only:
 *   P0 carries the epoch-key protocol (KEY_ANNOUNCE / KEY_REQUEST / KEY_WRAP).
 *   Content on -1 is encrypted with a channel-wide epoch key versioned by
 *   `kid`; this stream is how members obtain those keys.
 *   P1 carries the member roster (MEMBER_HELLO): one hello per member per
 *   epoch, ALWAYS sealed with that epoch's key — the -4 resend is publicly
 *   readable over HTTP, so a cleartext roster would be the worst membership
 *   leak in the system. Channels created before P1 existed have a
 *   single-partition -4 (capability = on-chain partition count).
 *   Permissions: members publish AND subscribe (any member may answer a request
 *   with a KEY_WRAP — k-of-n distribution). KEY_ANNOUNCE authority is app-layer:
 *   accepted only from the admin set (v1: channel owner), never inferred from
 *   stream permissions. This is why -4 cannot fold into -3, which must stay
 *   owner-only publish.
 */

export const STREAM_SUFFIX = Object.freeze({
    MESSAGE: '-1',
    EPHEMERAL: '-2',
    ADMIN: '-3',
    KEYS: '-4',
    INTERACTIONS: '-5'
});

export const MESSAGE_STREAM = Object.freeze({
    SUFFIX: STREAM_SUFFIX.MESSAGE,
    PARTITIONS: 12,       // Regular channels: content + control + moderation + 9 storage-file chunk partitions
    DM_PARTITIONS: 13,    // DM inboxes: messages + sync + sync_blobs + notifications + 9 chunk partitions

    // Partition indexes
    MESSAGES: 0,          // Text, images, video/file announcements (reactions live on -5)
    CONTROL: 1,           // Edit/Delete overrides (regular channels)
    MODERATION: 2,        // MOD_ACTION deltas signed by a moderator (gated channels)
    SYNC: 1,              // Cross-device sync payloads (self → self, DM inbox only)
    SYNC_BLOBS: 2,        // Image blobs sync (DM inbox only)
    NOTIFICATIONS: 3      // Channel invites / notifications (DM inbox only)
});

/**
 * Persistent File Sharing over storage nodes (message stream -1, chunk partitions).
 *
 * Chunks are round-robined over 9 partitions starting right after the last
 * "classic" partition of the stream flavor: P2 on regular channels, P4 on DM
 * inboxes. The announcement is a normal signed chat message on P0
 * (type 'storage_file_announce') and carries firstChunkPartition/chunkPartitions,
 * so readers follow the announce, not these local constants.
 */
export const STORAGE_FILE = Object.freeze({
    CHUNK_PARTITIONS: 9,
    FIRST_CHUNK_PARTITION: 3,     // Regular channels (after P0 messages + P1 control + P2 moderation)
    DM_FIRST_CHUNK_PARTITION: 4   // DM inboxes (after P0-P3)
});

/**
 * Partition for storage-file chunk i.
 * @param {number} i - Chunk index
 * @param {number} firstPartition - First chunk partition (2 regular / 4 DM, or from announce)
 * @param {number} [count] - Number of chunk partitions (default 9, or from announce)
 * @returns {number}
 */
export function storageChunkPartition(i, firstPartition, count = STORAGE_FILE.CHUNK_PARTITIONS) {
    return firstPartition + (i % count);
}

export const EPHEMERAL_STREAM = Object.freeze({
    SUFFIX: STREAM_SUFFIX.EPHEMERAL,
    PARTITIONS: 3,

    // Partition indexes
    CONTROL: 0,           // Presence, typing (JSON)
    MEDIA_SIGNALS: 1,     // P2P coordination: piece_request, source_request/announce (JSON)
    MEDIA_DATA: 2         // P2P heavy payloads: file_piece (Binary - Uint8Array)
});

export const ADMIN_STREAM = Object.freeze({
    SUFFIX: STREAM_SUFFIX.ADMIN,
    PARTITIONS: 3,        // P0 implemented; P1 (channel image) and P2 (password challenge) reserved

    // Partition indexes
    MODERATION: 0,        // ADMIN_STATE: bannedMembers, hiddenMessageIds, pins
    CHANNEL_IMAGE: 1,     // CHANNEL_IMAGE: channel image / profile metadata
    PASSWORD_CHALLENGE: 2 // PASSWORD_CHALLENGE: encrypted magic-plaintext blob for password verification
});

/**
 * Keys stream (-4), partitioned BY CADENCE rather than by key type: announces
 * are all read together on open, so splitting them per key would cost one
 * resend per type; a new key kind tomorrow just gets a new `t` on P0.
 */
export const KEYS_STREAM = Object.freeze({
    SUFFIX: STREAM_SUFFIX.KEYS,
    PARTITIONS: 4,

    // Partition indexes
    KEY_EXCHANGE: 0,      // Announces of every key kind — one per rotation, resend on open
    REQUESTS: 1,          // KEY_REQUEST / KEY_WRAP — one per member per rotation, subscribed
    ROSTER: 2,            // MEMBER_HELLO (epoch-sealed) — one per member per epoch, resend on demand
    RESERVED: 3
});

/**
 * Interactions stream (-5): where members PARTICIPATE, as opposed to the -1
 * where they publish. Reactions live here so a read-only channel can offer
 * them, and so the -1 stops carrying emoji noise that the preview scanners
 * had to skip. In Sealed it travels under the interactions key (handed to
 * every member, read-only included); in Visible under the clone, like
 * everything else in that mode.
 */
export const INTERACTIONS_STREAM = Object.freeze({
    SUFFIX: STREAM_SUFFIX.INTERACTIONS,
    PARTITIONS: 3,

    // Partition indexes
    REACTIONS: 0,
    RESERVED_1: 1,
    RESERVED_2: 2
});

/**
 * Message types on the keys stream (-4). Protocol constants — changing them
 * orphans every already-published announce/wrap.
 *
 *   KEY_ANNOUNCE  admin only (app-layer check against the admin set):
 *                 { epoch, keyId, keyHash, validFrom }
 *   KEY_REQUEST   any member: { pubkey, fromEpoch, requestId, spk? } —
 *                 `pubkey` is an ephemeral per-request key (D12); `spk` is the
 *                 requester's STATIC account pubkey (the DM key), anchored to
 *                 the account by the request's envelope signature; responders
 *                 verify computeAddress(spk) === envelope signer before using it
 *   KEY_WRAP      any member holding the key. Two formats:
 *                 v1 (no `v`): { keyId, epoch, tag, requestId, epk, iv, ct }
 *                 addressed to the request's ephemeral pubkey,
 *                 tag = sha256(POMBO_WRAP_TAG_V1|requestPubkey|keyId) — dies
 *                 with the requester's session (D12).
 *                 v2 ({ v: 2 }): same fields, ECIES to the request's `spk`,
 *                 tag = sha256(POMBO_WRAP_TAG_V2|requestId|keyId) — NEVER
 *                 derived from the static key (that is the dictionary attack
 *                 D12 killed); opens in any session of any device holding the
 *                 account key, so retained requests answer asynchronously.
 *                 Receivers verify sha256(unwrapped) === announced keyHash
 *                 before adopting, both formats.
 *   MEMBER_HELLO  roster entry on P1 (never P0), sealed with the epoch key:
 *                 { account, spk, ts } — published on first adoption of each
 *                 CURRENT epoch's key; readers require the envelope signer to
 *                 equal `account` (no planting hellos for someone else)
 *   PUB_ANNOUNCE  admin only (Members-only channels): the SHARED publish key
 *                 anchor { keyId, keyHash, addr, rev }. Static — never
 *                 rotates by routine; a re-key (admin escape valve against
 *                 ex-key-holder abuse) bumps `rev`. Conflict rule: higher
 *                 rev wins; same rev falls back to the announce rule (older
 *                 timestamp, then lower publisher).
 *   PUB_WRAP      the publish PRIVATE key sealed to a requester — exactly a
 *                 KEY_WRAP (v1 ephemeral / v2 static addressing, same tags)
 *                 verified against the PUB_ANNOUNCE keyHash AND against the
 *                 announced address (computeAddress of the unwrapped key)
 */
export const KEYS_MSG_TYPE = Object.freeze({
    KEY_ANNOUNCE: 'key_announce',
    KEY_REQUEST: 'key_request',
    KEY_WRAP: 'key_wrap',
    MEMBER_HELLO: 'member_hello',
    PUB_ANNOUNCE: 'pub_announce',
    PUB_WRAP: 'pub_wrap'
});

/**
 * Magic plaintext encrypted with the channel password and published to
 * ADMIN_STREAM partition 2 (PASSWORD_CHALLENGE). Successful decryption of the
 * payload's `magic` field with a candidate password proves that password is
 * correct, without revealing it on the network.
 *
 * Treated as an immutable, single-shot challenge per channel (published once
 * at channel creation; no rotation in this scope).
 */
export const PASSWORD_CHALLENGE_MAGIC = 'POMBO_PWD_CHALLENGE_V1';

// ================================================
// ID DERIVATION HELPERS
// ================================================

/**
 * Derive ephemeral stream ID from message stream ID.
 * @param {string} messageStreamId - Message stream ID (ends with -1)
 * @returns {string|null} Ephemeral stream ID (ends with -2) or null
 */
export function deriveEphemeralId(messageStreamId) {
    if (!messageStreamId) return null;
    return messageStreamId.replace(/-1$/, STREAM_SUFFIX.EPHEMERAL);
}

/**
 * Derive message stream ID from ephemeral stream ID.
 * @param {string} ephemeralStreamId - Ephemeral stream ID (ends with -2)
 * @returns {string|null} Message stream ID (ends with -1) or null
 */
export function deriveMessageId(ephemeralStreamId) {
    if (!ephemeralStreamId) return null;
    return ephemeralStreamId.replace(/-2$/, STREAM_SUFFIX.MESSAGE);
}

/**
 * Derive admin stream ID from a message stream ID.
 * @param {string} messageStreamId - Message stream ID (ends with -1)
 * @returns {string|null} Admin stream ID (ends with -3) or null
 */
export function deriveAdminId(messageStreamId) {
    if (!messageStreamId) return null;
    return messageStreamId.replace(/-1$/, STREAM_SUFFIX.ADMIN);
}

/**
 * Derive keys stream ID from a message stream ID.
 * @param {string} messageStreamId - Message stream ID (ends with -1)
 * @returns {string|null} Keys stream ID (ends with -4) or null
 */
export function deriveKeysId(messageStreamId) {
    if (!messageStreamId) return null;
    return messageStreamId.replace(/-1$/, STREAM_SUFFIX.KEYS);
}

/**
 * Derive interactions stream ID from a message stream ID.
 * @param {string} messageStreamId - Message stream ID (ends with -1)
 * @returns {string|null} Interactions stream ID (ends with -5) or null
 */
export function deriveInteractionsId(messageStreamId) {
    if (!messageStreamId) return null;
    return messageStreamId.replace(/-1$/, STREAM_SUFFIX.INTERACTIONS);
}

/**
 * @param {string} streamId
 * @returns {boolean} true if streamId ends with the interactions-stream suffix
 */
export function isInteractionsStream(streamId) {
    return !!streamId && streamId.endsWith(STREAM_SUFFIX.INTERACTIONS);
}

/**
 * @param {string} streamId
 * @returns {boolean} true if streamId ends with the message-stream suffix
 */
export function isMessageStream(streamId) {
    return !!streamId && streamId.endsWith(STREAM_SUFFIX.MESSAGE);
}

/**
 * @param {string} streamId
 * @returns {boolean} true if streamId ends with the keys-stream suffix
 */
export function isKeysStream(streamId) {
    return !!streamId && streamId.endsWith(STREAM_SUFFIX.KEYS);
}

/**
 * @param {string} streamId
 * @returns {boolean} true if streamId ends with the ephemeral-stream suffix
 */
export function isEphemeralStream(streamId) {
    return !!streamId && streamId.endsWith(STREAM_SUFFIX.EPHEMERAL);
}

/**
 * @param {string} streamId
 * @returns {boolean} true if streamId ends with the admin-stream suffix
 */
export function isAdminStream(streamId) {
    return !!streamId && streamId.endsWith(STREAM_SUFFIX.ADMIN);
}
