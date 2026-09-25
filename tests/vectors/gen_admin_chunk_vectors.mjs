// One-shot generator for the ADMIN_STATE framing parity vectors.
//
// A moderation snapshot too big for one wire message travels on the -3 as a
// run of admin_chunk rows closed by an admin_manifest. Both clients must frame
// it the same way, or a snapshot split by one owner device never reassembles
// on the members' other client, and they keep the previous moderation.
//
// The vectors fix the split (how a snapshot becomes rows, at a small budget
// so the fixtures stay readable: rev and ts on every row, a surrogate pair
// never cut) and the reassembly rules (order does not matter, runs are kept
// apart, an incomplete or unparseable run is dropped whole).
import { splitFramed, joinFramed, ADMIN_FRAME } from '../../src/js/syncChunks.js';

const LIMIT = 200;

const snapshot = (rev, ts, pinText) => ({
    type: 'ADMIN_STATE', v: 1, rev, ts, createdBy: '0x1111111111111111111111111111111111111111',
    state: {
        bannedMembers: [{ address: '0x2222222222222222222222222222222222222222', sinceEpoch: 3 }],
        hiddenMessageIds: ['m-1', 'm-2'],
        pins: [{ targetId: 'm-9', pinnedAt: 1789000000000, snapshot: { sender: '0x3333333333333333333333333333333333333333', text: pinText } }],
        absorbedThrough: 0
    }
});

const small = {
    type: 'ADMIN_STATE', v: 1, rev: 4, ts: 1789000005000,
    state: { bannedMembers: [], hiddenMessageIds: ['m-1'], pins: [], absorbedThrough: 0 }
};
const big = snapshot(5, 1789000009000, 'x'.repeat(700));
const other = snapshot(6, 1789000019000, 'y'.repeat(700));

// An emoji placed so a cut at a multiple of the budget would fall between its
// two halves.
const prefix = JSON.stringify(snapshot(7, 1789000029000, '')).indexOf('"text":""') + '"text":"'.length;
const cut = Math.ceil((prefix + 1) / LIMIT) * LIMIT;
const straddling = snapshot(7, 1789000029000, 'p'.repeat(cut - 1 - prefix) + '\u{1F426}' + 'q'.repeat(300));

const bigRun = splitFramed(big, 'runA', ADMIN_FRAME, LIMIT);
const otherRun = splitFramed(other, 'runB', ADMIN_FRAME, LIMIT);
const payloadsOf = (messages) => joinFramed(messages, ADMIN_FRAME).map(r => r.payload);

console.log(JSON.stringify({
    limit: LIMIT,
    split: [
        {
            what: 'a snapshot that fits travels as itself, with no framing',
            payload: small,
            messages: splitFramed(small, 'runA', ADMIN_FRAME, LIMIT)
        },
        {
            what: 'a big snapshot becomes chunks numbered from zero, then its manifest, rev and ts on every row',
            payload: big,
            messages: bigRun
        },
        {
            what: 'a cut never falls between the two halves of a surrogate pair',
            payload: straddling,
            messages: splitFramed(straddling, 'runA', ADMIN_FRAME, LIMIT)
        }
    ],
    reassemble: [
        {
            what: 'a complete run rebuilds the snapshot byte for byte',
            messages: bigRun,
            payloads: [big]
        },
        {
            what: 'arrival order does not matter',
            messages: [...bigRun].reverse(),
            payloads: [big]
        },
        {
            what: 'two runs in one window stay apart, a whole snapshot among them is not a run',
            messages: [...bigRun, small, ...otherRun],
            payloads: payloadsOf([...bigRun, small, ...otherRun])
        },
        {
            what: 'a run whose head fell out of the window is dropped whole',
            messages: bigRun.slice(1),
            payloads: []
        },
        {
            what: 'a run with no manifest is not assumed complete',
            messages: bigRun.filter(m => m.type !== 'admin_manifest'),
            payloads: []
        },
        {
            what: 'a run whose chunks do not form JSON is dropped',
            messages: [
                { type: 'admin_chunk', v: 1, rev: 1, ts: 1, runId: 'bad', chunkIndex: 0, chunkCount: 1, data: '{oops' },
                { type: 'admin_manifest', v: 1, rev: 1, ts: 1, runId: 'bad', chunkCount: 1 }
            ],
            payloads: []
        }
    ]
}, null, 2));
