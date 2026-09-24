// One-shot generator for the sync-merge slice parity vectors.
//
// The timestamped slices (blocked peers, DM leave times, trusted contacts,
// username, Graph API key) are resolved latest-wins by `sliceTs`. Both clients
// must pick the same side, or the account's devices disagree on who is blocked
// or what the account is called — and the wrong pick can erase a value on
// every device.
//
// The vectors fix the slice outcome of one merge step (base = this device,
// incoming = a remote snapshot) and the stamping of unstamped values before a
// state leaves the device.
import { mergeState, stampedSliceTs } from '../../src/js/syncMerge.js';

const SLICES = ['blockedPeers', 'dmLeftAt', 'trustedContacts', 'username', 'graphApiKey'];

const EMPTY = { blockedPeers: [], dmLeftAt: {}, trustedContacts: {}, username: null, graphApiKey: null, sliceTs: {} };
const RESTORED = {
    blockedPeers: ['0x00000000000000000000000000000000000000b1'],
    dmLeftAt: { '0x00000000000000000000000000000000000000d1': 1788000000000 },
    trustedContacts: { '0x00000000000000000000000000000000000000c1': { nickname: 'Carol', addedAt: 1788000000000 } },
    username: 'Bob',
    graphApiKey: 'key-restored',
    sliceTs: {}
};

const slicesOf = (state) => {
    const out = {};
    for (const key of SLICES) out[key] = state[key];
    out.sliceTs = state.sliceTs;
    return out;
};

const merge = (what, base, incoming) => ({
    what,
    base,
    incoming,
    expected: slicesOf(mergeState(base, incoming))
});

console.log(JSON.stringify({
    merge: [
        merge('an unstamped empty snapshot never erases unstamped values', RESTORED, EMPTY),
        merge('unstamped values still reach a device that holds nothing', EMPTY, RESTORED),
        merge('values stamped by the restore floor beat an empty snapshot',
            { ...RESTORED, sliceTs: stampedSliceTs(RESTORED) }, EMPTY),
        merge('a stamped clear still propagates over older values',
            { ...RESTORED, sliceTs: { blockedPeers: 100, dmLeftAt: 100, trustedContacts: 100, username: 100, graphApiKey: 100 } },
            { ...EMPTY, sliceTs: { blockedPeers: 200, dmLeftAt: 200, trustedContacts: 200, username: 200, graphApiKey: 200 } }),
        merge('a newer local stamp keeps its value against an older remote one',
            { ...RESTORED, sliceTs: { blockedPeers: 300, dmLeftAt: 300, trustedContacts: 300, username: 300, graphApiKey: 300 } },
            { ...EMPTY, username: 'Robert', sliceTs: { username: 200 } }),
        merge('between two unstamped values the incoming one wins',
            RESTORED,
            { ...RESTORED, username: 'Robert', blockedPeers: ['0x00000000000000000000000000000000000000b2'] })
    ],
    stamp: [
        {
            what: 'values without a stamp take the floor; empties and real stamps are left alone',
            state: { ...RESTORED, dmLeftAt: {}, sliceTs: { trustedContacts: 1789000000000 } },
            sliceTs: stampedSliceTs({ ...RESTORED, dmLeftAt: {}, sliceTs: { trustedContacts: 1789000000000 } })
        },
        {
            what: 'a snapshot that holds nothing stays unstamped',
            state: EMPTY,
            sliceTs: stampedSliceTs(EMPTY)
        }
    ]
}, null, 2));
