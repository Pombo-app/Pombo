// One-shot generator for the sync-snapshot framing parity vectors.
//
// A state snapshot too big for one wire message travels as a run of chunks
// closed by a manifest. Both clients must frame it identically, or a push
// split on one never reassembles on the other — and the failure is silent at
// both ends: the network drops an oversized message without telling the
// publisher, and a reader that accepted a partial run would merge truncated
// JSON into the account's state.
//
// The vectors fix the split (how a payload becomes messages, at a small
// budget so the fixtures stay readable) and the reassembly rules (order does
// not matter, runs are kept apart, an incomplete or unparseable run is
// dropped whole).
import { splitSyncPayload, reassembleSyncPayloads } from '../../src/js/syncChunks.js';

const LIMIT = 200;

const snapshot = (fill, ts) => ({
    type: 'sync', v: 1, ts,
    data: { channels: [{ messageStreamId: '0xowner/chan-1', name: fill }] }
});

const big = snapshot('x'.repeat(700), 1789000000000);
const other = snapshot('y'.repeat(700), 1789000009000);
const small = snapshot('fits', 1789000005000);

// An emoji placed so a cut at a multiple of the budget would fall between its
// two halves.
const prefix = JSON.stringify(snapshot('', 1789000029000)).indexOf('"name":""') + '"name":"'.length;
const cut = Math.ceil((prefix + 1) / LIMIT) * LIMIT;
const straddling = snapshot('p'.repeat(cut - 1 - prefix) + '\u{1F426}' + 'q'.repeat(300), 1789000029000);

const bigRun = splitSyncPayload(big, 'runA', LIMIT);
const otherRun = splitSyncPayload(other, 'runB', LIMIT);

console.log(JSON.stringify({
    limit: LIMIT,
    split: [
        {
            what: 'a snapshot that fits travels as itself, with no framing',
            payload: small,
            messages: splitSyncPayload(small, 'runA', LIMIT)
        },
        {
            what: 'a big snapshot becomes chunks numbered from zero, then its manifest',
            payload: big,
            messages: bigRun
        },
        {
            what: 'a cut never falls between the two halves of a surrogate pair',
            payload: straddling,
            messages: splitSyncPayload(straddling, 'runA', LIMIT)
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
            what: 'two runs and a whole snapshot in one window stay apart',
            messages: [...bigRun, small, ...otherRun],
            payloads: reassembleSyncPayloads([...bigRun, small, ...otherRun])
        },
        {
            what: 'a run whose head fell out of the window is dropped whole',
            messages: bigRun.slice(1),
            payloads: []
        },
        {
            what: 'a run with no manifest is not assumed complete',
            messages: bigRun.filter(m => m.type !== 'sync_manifest'),
            payloads: []
        },
        {
            what: 'a run whose chunks do not form JSON is dropped',
            messages: [
                { type: 'sync_chunk', v: 1, ts: 1, syncId: 'bad', chunkIndex: 0, chunkCount: 1, data: '{oops' },
                { type: 'sync_manifest', v: 1, ts: 1, syncId: 'bad', chunkCount: 1 }
            ],
            payloads: []
        }
    ]
}, null, 2));
