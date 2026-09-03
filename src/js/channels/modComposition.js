/**
 * Moderation composition: the owner's snapshot plus the moderators' deltas.
 *
 * The owner moderates by publishing a whole ADMIN_STATE on -3; moderators
 * cannot publish there, so they emit signed deltas on -1/P2 instead. The
 * effective state a client renders is the snapshot with the unabsorbed
 * deltas applied on top — which is what lets moderation work while the owner
 * is offline, and what lets the owner have the last word when they return.
 *
 * The rules, in the order they matter:
 *  1. Only deltas with ts strictly greater than snapshot.absorbedThrough
 *     count; at or below it, the owner has already spoken.
 *  2. A delta whose author is not a CURRENT moderator is ignored while it is
 *     unabsorbed — dismissing a moderator dissolves what they left pending,
 *     while whatever the owner already ratified stays, because it became the
 *     owner's word.
 *  3. Deltas apply in (ts, mod, op, target) order, so two clients that
 *     received them in different orders still converge.
 *  4. A delta never overrides the snapshot: unhide/unban of an entry the
 *     snapshot asserts is a no-op. Moderators resolve among themselves.
 *  5. Among deltas, a later ban of the same address replaces the epoch stamp
 *     (null = hide everything).
 *
 * Ban entries carry `sinceEpoch` rather than a timestamp: the epoch a message
 * was written under travels in the clear as its `kid` and cannot be forged,
 * while the payload timestamp is the publisher's to choose.
 */

/** Canonical order: ts, then mod, then op, then target. */
function compare(a, b) {
    return (a.ts - b.ts)
        || String(a.mod).localeCompare(String(b.mod))
        || String(a.op).localeCompare(String(b.op))
        || String(a.target).localeCompare(String(b.target));
}

/**
 * @param {Object} snapshot - { absorbedThrough, hiddenMessageIds, bannedMembers }
 *   where bannedMembers entries are { address, sinceEpoch } (or plain strings,
 *   read as "hide everything").
 * @param {Array} deltas - MOD_ACTION payloads ({ op, target, ts, mod, sinceEpoch? })
 * @param {Array<string>} moderatorsNow - current moderator addresses (lowercase)
 * @returns {{hiddenMessageIds: string[], bannedMembers: Array<{address: string, sinceEpoch: number|null}>}}
 */
export function composeModeration(snapshot, deltas = [], moderatorsNow = []) {
    const snapHidden = new Set((snapshot?.hiddenMessageIds || []).filter(id => typeof id === 'string'));
    const snapBanned = new Map();
    for (const entry of snapshot?.bannedMembers || []) {
        if (typeof entry === 'string') {
            snapBanned.set(entry.toLowerCase(), null);
        } else if (entry && typeof entry.address === 'string') {
            snapBanned.set(entry.address.toLowerCase(),
                Number.isInteger(entry.sinceEpoch) ? entry.sinceEpoch : null);
        }
    }

    const hidden = new Set(snapHidden);
    const banned = new Map(snapBanned);

    const mods = new Set(moderatorsNow.map(a => String(a).toLowerCase()));
    const absorbedThrough = Number(snapshot?.absorbedThrough) || 0;

    const applicable = deltas
        .filter(d => d && typeof d.op === 'string' && typeof d.target === 'string')
        .filter(d => Number(d.ts) > absorbedThrough)
        .filter(d => mods.has(String(d.mod).toLowerCase()))
        .sort(compare);

    for (const d of applicable) {
        const target = d.op === 'ban' || d.op === 'unban'
            ? d.target.toLowerCase() : d.target;
        switch (d.op) {
            case 'hide':
                hidden.add(target);
                break;
            case 'unhide':
                // Never undo what the snapshot asserts.
                if (!snapHidden.has(target)) hidden.delete(target);
                break;
            case 'ban':
                banned.set(target,
                    Number.isInteger(d.sinceEpoch) ? d.sinceEpoch : null);
                break;
            case 'unban':
                if (!snapBanned.has(target)) banned.delete(target);
                break;
            default:
                break;
        }
    }

    return {
        hiddenMessageIds: Array.from(hidden).sort(),
        bannedMembers: Array.from(banned.entries())
            .map(([address, sinceEpoch]) => ({ address, sinceEpoch }))
            .sort((a, b) => a.address.localeCompare(b.address))
    };
}

/**
 * Is this message hidden by a ban? A ban with `sinceEpoch` hides only what
 * its author wrote from that epoch onward — everything they contributed
 * before stays, which is the difference between silencing someone and
 * erasing their year.
 *
 * @param {Object} entry - { address, sinceEpoch }
 * @param {number|null} messageEpoch - epoch the message was written under
 */
export function banHidesMessage(entry, messageEpoch) {
    if (!entry) return false;
    if (entry.sinceEpoch == null) return true;              // hide everything
    if (!Number.isInteger(messageEpoch)) return false;      // unknown: keep it
    return messageEpoch >= entry.sinceEpoch;
}
