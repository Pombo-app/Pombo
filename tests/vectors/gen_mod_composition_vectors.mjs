// One-shot generator for the moderation COMPOSITION parity vectors — not
// cryptographic: a snapshot plus a list of deltas and the effective state
// both clients must derive. This file is the executable spec of the rules;
// the JSON is what the tests replay.
//
// Rules (the canon):
//  1. Only deltas with ts strictly greater than snapshot.absorbedThrough
//     participate; anything at or below is already the owner's word.
//  2. A delta whose `mod` is not a CURRENT moderator is dropped while
//     unabsorbed — dismissing a moderator dissolves their pending deltas.
//  3. Deltas apply in (ts, mod, op, target) ascending order; the composite
//     key makes the result independent of arrival order.
//  4. hide adds a message id; unhide removes it ONLY if the snapshot itself
//     does not hide it. ban upserts {address, sinceEpoch}; unban removes it
//     ONLY if the snapshot itself does not ban it. Deltas never override the
//     snapshot: the owner has the last word, mods resolve among themselves.
//  5. Among deltas, a later ban of the same address replaces the epoch stamp
//     (sinceEpoch null = hide everything).

const MOD_A = '0x59c6995e998f97a5a0044966f0945389dc9e86da88c7a841aaaaaaaaaaaaaaaa'.slice(0, 42);
const MOD_B = '0x70997970c51812dc3a010c7d01b50e0d17dc79c8';
const USER_X = '0x3c44cdddb6a900fa2b585dd299e03d12fa4293bc';
const USER_Y = '0x90f79bf6eb2c4f870365e785982e1f101e93b906';

const d = (op, target, ts, mod, sinceEpoch = undefined) =>
    ({ t: 'MOD_ACTION', op, target, ts, mod, ...(sinceEpoch !== undefined ? { sinceEpoch } : {}) });

const SNAP = {
    rev: 7,
    ts: 1789000000000,
    absorbedThrough: 1789000000000,
    hiddenMessageIds: ['msg-owner-hid'],
    bannedMembers: [{ address: USER_Y, sinceEpoch: 3 }]
};

const cases = [
    {
        what: 'hide and epoch-stamped ban compose over the snapshot',
        snapshot: SNAP,
        modsNow: [MOD_A],
        deltas: [
            d('hide', 'msg-0002', 1789000001000, MOD_A),
            d('ban', USER_X, 1789000002000, MOD_A, 5)
        ],
        effective: {
            hiddenMessageIds: ['msg-0002', 'msg-owner-hid'],
            bannedMembers: [
                { address: USER_X, sinceEpoch: 5 },
                { address: USER_Y, sinceEpoch: 3 }
            ]
        }
    },
    {
        what: 'mods undo each other among deltas; arrival order is irrelevant',
        snapshot: SNAP,
        modsNow: [MOD_A, MOD_B],
        deltas: [
            d('unhide', 'msg-0002', 1789000003000, MOD_B),
            d('hide', 'msg-0002', 1789000001000, MOD_A)
        ],
        effective: {
            hiddenMessageIds: ['msg-owner-hid'],
            bannedMembers: [{ address: USER_Y, sinceEpoch: 3 }]
        }
    },
    {
        what: 'a delta never overrides the snapshot: unhide and unban of owner entries are no-ops',
        snapshot: SNAP,
        modsNow: [MOD_A],
        deltas: [
            d('unhide', 'msg-owner-hid', 1789000001000, MOD_A),
            d('unban', USER_Y, 1789000002000, MOD_A)
        ],
        effective: {
            hiddenMessageIds: ['msg-owner-hid'],
            bannedMembers: [{ address: USER_Y, sinceEpoch: 3 }]
        }
    },
    {
        what: 'ts at absorbedThrough is already absorbed; strictly-greater participates',
        snapshot: SNAP,
        modsNow: [MOD_A],
        deltas: [
            d('hide', 'msg-late', 1789000000000, MOD_A),
            d('hide', 'msg-new', 1789000000001, MOD_A)
        ],
        effective: {
            hiddenMessageIds: ['msg-new', 'msg-owner-hid'],
            bannedMembers: [{ address: USER_Y, sinceEpoch: 3 }]
        }
    },
    {
        what: 'a dismissed moderator loses the pending deltas',
        snapshot: SNAP,
        modsNow: [MOD_B],
        deltas: [
            d('hide', 'msg-0009', 1789000001000, MOD_A),
            d('hide', 'msg-0010', 1789000002000, MOD_B)
        ],
        effective: {
            hiddenMessageIds: ['msg-0010', 'msg-owner-hid'],
            bannedMembers: [{ address: USER_Y, sinceEpoch: 3 }]
        }
    },
    {
        what: 'a later ban replaces the epoch stamp; null means hide everything',
        snapshot: SNAP,
        modsNow: [MOD_A],
        deltas: [
            d('ban', USER_X, 1789000001000, MOD_A, 5),
            d('ban', USER_X, 1789000002000, MOD_A, null)
        ],
        effective: {
            hiddenMessageIds: ['msg-owner-hid'],
            bannedMembers: [
                { address: USER_X, sinceEpoch: null },
                { address: USER_Y, sinceEpoch: 3 }
            ]
        }
    },
    {
        what: 'same ts orders by (mod, op, target): ban applies before unban removes it',
        snapshot: SNAP,
        modsNow: [MOD_A, MOD_B],
        deltas: [
            d('unban', USER_X, 1789000001000, MOD_B),
            d('ban', USER_X, 1789000001000, MOD_A, 2)
        ],
        effective: {
            hiddenMessageIds: ['msg-owner-hid'],
            bannedMembers: [{ address: USER_Y, sinceEpoch: 3 }]
        }
    }
];

console.log(JSON.stringify({ cases }, null, 2));
