/**
 * Signed storage reads — the request half of the Pombo storage node's
 * "signed requests" protocol (POMBO.md of Pombo-app/pombo-storage-node).
 *
 * A node with `signedReads` on answers 401 to unsigned history reads of a
 * gated channel's streams (the `-3` stays open). The request authenticates
 * with an EIP-191 `personal_sign` signature over a message built from the
 * request itself, one field per line:
 *
 *   pombo-storage-node
 *   read
 *   <streamId>
 *   <partition>
 *   <issuedAt>          ms, within ±5 min of the node's clock
 *   <nonce>             accepted once per user
 *   <resendType>        last | from | range — the path segment
 *   <canonicalQuery>    parameters sorted by name, `name=value` joined by
 *                       `&`, values unencoded, repeats in received order
 *
 * The canonical query must match what the node parses from the URL byte for
 * byte, so it is derived from the URL that is actually sent, never rebuilt.
 *
 * Pure functions only: the fetch wrapper (storageFetch.js) decides WHEN to
 * sign, and the signer is injected. The Android bridge page mirrors this
 * module; parity is locked by docs/STORAGE-signed-read-vectors.json.
 */

const DATA_PATH_RE = /^(.*)\/streams\/([^/]+)\/data\/partitions\/(\d+)\/(last|from|range)$/;

/**
 * Split a storage node data URL into the parts the signature covers.
 * @param {string} url
 * @returns {{base: string, streamId: string, partition: number,
 *   resendType: string, canonicalQuery: string, url: string}|null}
 *   null when the URL is not a storage data read
 */
export function parseStorageDataUrl(url) {
    let u;
    try {
        u = new URL(String(url));
    } catch {
        return null;
    }
    const m = DATA_PATH_RE.exec(u.pathname);
    if (!m) return null;
    let streamId;
    try {
        streamId = decodeURIComponent(m[2]);
    } catch {
        return null;
    }
    return {
        base: `${u.origin}${m[1]}`,
        streamId,
        partition: Number(m[3]),
        resendType: m[4],
        canonicalQuery: canonicalQuery(u.searchParams),
        url: u.toString()
    };
}

/**
 * Canonical form of a query string: parameters sorted by name (stable, so
 * repeats keep their received order), `name=value` with decoded values,
 * joined by `&`.
 * @param {URLSearchParams|string} params
 * @returns {string}
 */
export function canonicalQuery(params) {
    const sp = params instanceof URLSearchParams ? params : new URLSearchParams(String(params));
    return [...sp.entries()]
        .map(([name, value], index) => ({ name, value, index }))
        .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : a.index - b.index))
        .map(({ name, value }) => `${name}=${value}`)
        .join('&');
}

/**
 * The exact string the client signs for a read.
 * @param {Object} fields
 * @param {string} fields.streamId
 * @param {number|string} fields.partition
 * @param {number|string} fields.issuedAt
 * @param {string} fields.nonce
 * @param {string} fields.resendType
 * @param {string} fields.canonicalQuery
 * @returns {string}
 */
export function buildReadMessage({ streamId, partition, issuedAt, nonce, resendType, canonicalQuery: query }) {
    return [
        'pombo-storage-node',
        'read',
        streamId,
        String(partition),
        String(issuedAt),
        nonce,
        resendType,
        query
    ].join('\n');
}

/** 16 random bytes as lowercase hex. */
export function randomNonce() {
    const bytes = new Uint8Array(16);
    crypto.getRandomValues(bytes);
    return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Build the four `x-pombo-*` headers for a parsed read.
 * @param {ReturnType<typeof parseStorageDataUrl>} parsed
 * @param {{address: string, sign: (message: string) => Promise<string>}} signer
 *   `sign` is EIP-191 personal_sign over the UTF-8 message
 * @param {Object} [options]
 * @param {number} [options.issuedAt=Date.now()]
 * @param {string} [options.nonce=randomNonce()]
 * @returns {Promise<Record<string, string>>}
 */
export async function signedReadHeaders(parsed, signer, { issuedAt = Date.now(), nonce = randomNonce() } = {}) {
    const message = buildReadMessage({
        streamId: parsed.streamId,
        partition: parsed.partition,
        issuedAt,
        nonce,
        resendType: parsed.resendType,
        canonicalQuery: parsed.canonicalQuery
    });
    const signature = await signer.sign(message);
    return {
        'x-pombo-user': signer.address,
        'x-pombo-issued-at': String(issuedAt),
        'x-pombo-nonce': nonce,
        'x-pombo-signature': signature
    };
}
