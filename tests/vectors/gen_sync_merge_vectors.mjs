// One-shot generator for the sync-merge slice parity vectors.
//
// The timestamped slices (blocked peers, DM leave times, trusted contacts,
// username, Graph API key) are resolved latest-wins by `sliceTs`. Both clients
// must pick the same side, or the account's devices disagree on who is blocked
// or what the account is called — and the wrong pick can erase a value on
// every device.
//
// The vectors fix the slice outcome of one merge step (base = this device,
// incoming = a remote snapshot), the stamping of unstamped values before a
// state leaves the device, how sent DMs carry deletions and edits, and how two
// copies of a channel record merge.
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

const DM = '0x00000000000000000000000000000000000000a1/Pombo-DM-1';
const text = (id, timestamp, extra = {}) => ({ id, type: 'text', text: `text of ${id}`, timestamp, ...extra });

const CH = '0x00000000000000000000000000000000000000a1/c0ffee-1';
const record = (extra = {}) => ({
    messageStreamId: CH, name: 'Channel', type: 'public', createdAt: 1000, joinedAt: 1000,
    storageDays: 30, accessSnapshot: [], ...extra
});

// Channel records: each field comes from the copy that stamped it later; the
// join-time rule only decides what no stamp does, and whether the channel is
// joined at all.
const channel = (what, base, incoming) => {
    const merged = mergeState(base, incoming);
    return { what, base, incoming, expected: { channels: merged.channels, channelsLeftAt: merged.channelsLeftAt } };
};

// Sent DMs: a deletion on any device removes the message on every device,
// and the latest edit wins.
const sent = (what, base, incoming) => {
    const merged = mergeState(base, incoming);
    return { what, base, incoming, expected: { sentMessages: merged.sentMessages, sentDeletedAt: merged.sentDeletedAt } };
};

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
    ],
    sent: [
        sent('a message deleted here stays deleted against a copy that still has it',
            { sentMessages: { [DM]: [text('m1', 1000)] }, sentDeletedAt: { [DM]: { m2: 5000 } } },
            { sentMessages: { [DM]: [text('m1', 1000), text('m2', 2000)] } }),
        sent('a deletion made on another device removes the copy held here',
            { sentMessages: { [DM]: [text('m1', 1000), text('m2', 2000)] } },
            { sentMessages: { [DM]: [text('m1', 1000)] }, sentDeletedAt: { [DM]: { m2: 5000 } } }),
        sent('deletions from both sides are joined, the latest time per message',
            { sentMessages: {}, sentDeletedAt: { [DM]: { m2: 5000, m3: 100 } } },
            { sentMessages: {}, sentDeletedAt: { [DM]: { m2: 6000, m4: 200 } } }),
        sent('a snapshot from a client that knows no deletions keeps the ones held here',
            { sentMessages: { [DM]: [text('m1', 1000)] }, sentDeletedAt: { [DM]: { m2: 5000 } } },
            { sentMessages: { [DM]: [text('m1', 1000), text('m2', 2000)] }, sentDeletedAt: undefined }),
        sent('the deletion of a message does not touch one sent later under a new id',
            { sentMessages: { [DM]: [text('m3', 7000)] }, sentDeletedAt: { [DM]: { m2: 5000 } } },
            { sentMessages: { [DM]: [text('m2', 2000), text('m3', 7000)] } }),
        sent('the later edit wins, whichever side holds it',
            { sentMessages: { [DM]: [text('m1', 1000, { text: 'first', _edited: true, _editedAt: 3000 })] } },
            { sentMessages: { [DM]: [text('m1', 1000, { text: 'second', _edited: true, _editedAt: 4000 })] } }),
        sent('an older edit arriving does not undo a newer one here',
            { sentMessages: { [DM]: [text('m1', 1000, { text: 'second', _edited: true, _editedAt: 4000 })] } },
            { sentMessages: { [DM]: [text('m1', 1000, { text: 'first', _edited: true, _editedAt: 3000 })] } }),
        sent('an edit replaces the copy that was never edited',
            { sentMessages: { [DM]: [text('m1', 1000)] } },
            { sentMessages: { [DM]: [text('m1', 1000, { text: 'fixed', _edited: true, _editedAt: 3000 })] } }),
        sent('a deletion wins over a later edit made on another device',
            { sentMessages: { [DM]: [] }, sentDeletedAt: { [DM]: { m1: 5000 } } },
            { sentMessages: { [DM]: [text('m1', 1000, { text: 'later', _edited: true, _editedAt: 9000 })] } }),
        sent('a deletion from another device wins over a later edit held here',
            { sentMessages: { [DM]: [text('m1', 1000, { text: 'later', _edited: true, _editedAt: 9000 })] } },
            { sentMessages: { [DM]: [] }, sentDeletedAt: { [DM]: { m1: 5000 } } })
    ],
    channels: [
        channel('a stamped field held here beats an old unstamped copy arriving',
            { channels: [record({ name: 'Renamed', fieldTs: { name: 5000 } })] },
            { channels: [record()] }),
        channel('a stamped field arriving beats the old unstamped copy held here',
            { channels: [record()] },
            { channels: [record({ name: 'Renamed', fieldTs: { name: 5000 } })] }),
        channel('two devices changing different fields keep both changes',
            { channels: [record({ name: 'Renamed', fieldTs: { name: 5000 } })] },
            { channels: [record({ accessSnapshot: ['0x00000000000000000000000000000000000000b1'], fieldTs: { accessSnapshot: 6000 } })] }),
        channel('the same two changes merged in the other order give the same record',
            { channels: [record({ accessSnapshot: ['0x00000000000000000000000000000000000000b1'], fieldTs: { accessSnapshot: 6000 } })] },
            { channels: [record({ name: 'Renamed', fieldTs: { name: 5000 } })] }),
        channel('a client that drops the stamps neither reverts a stamped field nor erases the stamps',
            { channels: [record({ storageDays: 90, fieldTs: { storageDays: 5000 } })] },
            { channels: [record({ storageDays: 30 })] }),
        channel('an older stamp arriving does not undo a newer one held here',
            { channels: [record({ name: 'Newer', fieldTs: { name: 6000 } })] },
            { channels: [record({ name: 'Older', fieldTs: { name: 5000 } })] }),
        channel('equal stamps fall back to the join-time rule, which gives the tie to the incoming copy',
            { channels: [record({ name: 'Here', fieldTs: { name: 5000 } })] },
            { channels: [record({ name: 'Arriving', fieldTs: { name: 5000 } })] }),
        channel('a field only one copy carries is kept, whichever copy wins the others',
            { channels: [record({ keysStreamId: `${CH.slice(0, -2)}-4`, storageProvider: 'streamr' })] },
            { channels: [record({ inboxStreamId: null, name: 'Renamed', fieldTs: { name: 5000 } })] }),
        channel('a leave newer than the join removes the channel whatever its stamps say',
            { channels: [record({ name: 'Renamed', fieldTs: { name: 9000 } })] },
            { channels: [], channelsLeftAt: { [CH]: 5000 } }),
        channel('a join newer than the leave keeps the channel and retires the leave',
            { channels: [record({ joinedAt: 7000 })] },
            { channels: [], channelsLeftAt: { [CH]: 5000 } })
    ]
}, null, 2));
