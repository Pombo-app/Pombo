/**
 * MOD_ACTION: the signed moderation delta a moderator publishes on -1/P2.
 *
 * Self-contained by design. The signature is over a domain-tagged digest of
 * the fields in a fixed order — never over serialized JSON, whose key order
 * and whitespace no two clients would reproduce identically — so a delta read
 * from a raw resend verifies on its own, with no dependence on transport
 * validation. Membership of the moderator set is checked separately, and
 * only while the delta is unabsorbed (see modComposition).
 *
 * This is deliberately NOT the override path: an override says "the author
 * edits their own message", while a delta says "someone who is not the author
 * hides it". Same wire shape, opposite authority rule.
 */
export const MOD_ACTION_TYPE = 'MOD_ACTION';
const DOMAIN = 'POMBO_MOD_V1';

/** Ops a delta may carry. */
export const MOD_OPS = Object.freeze(['hide', 'unhide', 'ban', 'unban']);

/**
 * The digest a delta signs. `sinceEpoch` participates only for `ban` (and is
 * empty there when the ban means "hide everything").
 */
export function modActionDigest({ streamId, op, target, sinceEpoch, ts }) {
    const epochPart = op === 'ban' && Number.isInteger(sinceEpoch) ? String(sinceEpoch) : '';
    return ethers.keccak256(ethers.toUtf8Bytes(
        `${DOMAIN}|${String(streamId).toLowerCase()}|${op}|${String(target).toLowerCase()}|${epochPart}|${ts}`));
}

/**
 * Build a signed delta.
 * @param {Object} params
 * @param {string} params.streamId - the channel's message stream (-1)
 * @param {string} params.op - one of MOD_OPS
 * @param {string} params.target - message id (hide/unhide) or address (ban/unban)
 * @param {number|null} [params.sinceEpoch] - ban only; null hides everything
 * @param {string} params.privateKey - the moderator's ACCOUNT key
 * @returns {Object} the MOD_ACTION payload
 */
export function buildModAction({ streamId, op, target, sinceEpoch = null, privateKey, ts = Date.now() }) {
    if (!MOD_OPS.includes(op)) throw new Error(`unknown moderation op: ${op}`);
    const digest = modActionDigest({ streamId, op, target, sinceEpoch, ts });
    const key = new ethers.SigningKey(privateKey);
    const payload = {
        t: MOD_ACTION_TYPE,
        op,
        target: String(target).toLowerCase(),
        ts,
        mod: ethers.computeAddress(key.publicKey).toLowerCase(),
        sig: key.sign(digest).serialized
    };
    if (op === 'ban' && Number.isInteger(sinceEpoch)) payload.sinceEpoch = sinceEpoch;
    return payload;
}

/**
 * Verify a delta's signature and recover its author.
 * @returns {string|null} the signer address, or null when it does not verify
 */
export function verifyModAction(streamId, payload) {
    try {
        if (!payload || payload.t !== MOD_ACTION_TYPE) return null;
        if (!MOD_OPS.includes(payload.op)) return null;
        if (typeof payload.target !== 'string' || typeof payload.sig !== 'string') return null;
        if (!Number.isFinite(payload.ts)) return null;
        const digest = modActionDigest({
            streamId,
            op: payload.op,
            target: payload.target,
            sinceEpoch: payload.sinceEpoch,
            ts: payload.ts
        });
        const signer = ethers.recoverAddress(digest, payload.sig).toLowerCase();
        // `mod` is a convenience field; the signature is the authority, so a
        // mismatch means the payload was tampered with in transit.
        if (typeof payload.mod === 'string' && payload.mod.toLowerCase() !== signer) return null;
        return signer;
    } catch {
        return null;
    }
}
