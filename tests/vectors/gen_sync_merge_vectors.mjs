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
// state leaves the device, how sent DMs carry deletions and edits, how two
// copies of a channel record merge, and which changes to a state are news
// worth a push.
import { mergeState, stampedSliceTs } from '../../src/js/syncMerge.js';
import { syncStateKey } from '../../src/js/syncStateKey.js';

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

// Publishing: a push goes out only when a state differs in its news. The
// expectations are written here by hand, field by field, so the vectors are the
// spec rather than a copy of the implementation's lists.
const A = (n) => `0x${String(n).padStart(40, '0')}`;
const PUBLISH_BASE = {
    sentMessages: { [DM]: [text('m1', 1000)] },
    sentDeletedAt: { [DM]: { m0: 900 } },
    sentReactions: { [DM]: { m1: { '👍': [A(1)] } } },
    channels: [record({
        type: 'gated', ephemeralStreamId: `${CH.slice(0, -2)}-2`, adminStreamId: `${CH.slice(0, -2)}-3`,
        keysStreamId: `${CH.slice(0, -2)}-4`, interactionsStreamId: `${CH.slice(0, -2)}-5`, inboxStreamId: `${A(9)}/Pombo-DM-1`,
        storageProvider: 'streamr', gate: { address: A(7) }, wireIdentity: 'sealed', createdBy: A(8), password: 'secret',
        members: [A(1)], rotatedForNoAccess: [A(2)], accessSnapshot: [A(1)], knownBanned: [A(3)], storageEnabled: true,
        adminStorageDays: 30, keysStorageDays: 30, interactionsStorageDays: 30, exposure: 'hidden', description: 'about',
        language: 'en', category: 'news', metaUpdatedAt: 2000, readOnly: true, writeOnly: true, classification: 'club',
        peerAddress: A(4), fieldTs: { name: 3000 }
    })],
    channelsLeftAt: { [`${A(5)}/gone-1`]: 500 },
    epochKeys: {
        [CH]: {
            epochs: { k1: { keyHex: '0xaa', keyHash: '0xa1', epoch: 1 } },
            announces: { 1: { keyId: 'k1', keyHash: '0xa1', timestamp: 100, validFrom: 100 } },
            currentEpoch: 1,
            pendingRequests: { r1: { fromEpoch: 1, sentAt: 100 } },
            helloEpochs: [1], helloName: 'Bob', helloTs: 100, seenRequesters: [A(1)],
            pubKey: { keyId: 'p1', keyHex: '0xbb', rev: 1 }, pubAnnounce: { keyId: 'p1', rev: 1, timestamp: 100 },
            intKey: { keyId: 'i1', keyHex: '0xcc', rev: 1 }, intAnnounce: { keyId: 'i1', rev: 1, timestamp: 100 }
        }
    },
    blockedPeers: [A(6)],
    dmLeftAt: { [A(10)]: 700 },
    trustedContacts: { [A(11)]: { nickname: 'Carol', addedAt: 800 } },
    ensCache: { [A(11)]: { name: 'carol.eth', timestamp: 100 } },
    username: 'Bob',
    graphApiKey: 'key',
    sliceTs: { username: 100 }
};
const NOT_NEWS = {
    slices: ['ensCache', 'sliceTs'],
    channel: ['ephemeralStreamId', 'adminStreamId', 'keysStreamId', 'interactionsStreamId', 'inboxStreamId', 'storageProvider'],
    epochKeys: ['announces', 'pendingRequests', 'helloEpochs', 'helloName', 'helloTs', 'seenRequesters', 'pubAnnounce', 'intAnnounce']
};
const NEWS = {
    slices: ['sentMessages', 'sentDeletedAt', 'sentReactions', 'channelsLeftAt', 'blockedPeers', 'dmLeftAt', 'trustedContacts', 'username', 'graphApiKey'],
    channel: ['name', 'type', 'createdAt', 'joinedAt', 'storageDays', 'accessSnapshot', 'gate', 'wireIdentity', 'createdBy', 'password',
        'members', 'rotatedForNoAccess', 'knownBanned', 'storageEnabled', 'adminStorageDays', 'keysStorageDays', 'interactionsStorageDays',
        'exposure', 'description', 'language', 'category', 'metaUpdatedAt', 'readOnly', 'writeOnly', 'classification', 'peerAddress', 'fieldTs'],
    epochKeys: ['epochs', 'currentEpoch', 'pubKey', 'intKey']
};
const mutate = (value) => {
    if (typeof value === 'string') return `${value}x`;
    if (typeof value === 'number') return value + 1;
    if (typeof value === 'boolean') return !value;
    if (Array.isArray(value)) return [...value, 'x'];
    return { ...value, x: 1 };
};
const classified = (level, keys) => {
    for (const key of keys) {
        if (NEWS[level].includes(key) === NOT_NEWS[level].includes(key)) throw new Error(`publish: ${level} field ${key} must be news or not, once`);
    }
};
classified('slices', Object.keys(PUBLISH_BASE).filter((k) => k !== 'channels' && k !== 'epochKeys'));
classified('channel', Object.keys(PUBLISH_BASE.channels[0]).filter((k) => k !== 'messageStreamId'));
classified('epochKeys', Object.keys(PUBLISH_BASE.epochKeys[CH]));

// A case is a small patch on the shared base, so the file stays readable:
// `set` puts values at paths, `reverseKeys` reverses the key order of the
// objects at paths, `reverse` reverses the arrays at paths. `basePatch`, when
// present, is applied to the base first and the case compares against that.
const at = (root, path) => path.reduce((node, key) => node[key], root);
const applyPatch = (state, patch = {}) => {
    const out = structuredClone(state);
    for (const [path, value] of patch.set || []) at(out, path.slice(0, -1))[path.at(-1)] = structuredClone(value);
    for (const path of patch.reverse || []) at(out, path).reverse();
    for (const path of patch.reverseKeys || []) {
        const reversed = Object.fromEntries(Object.entries(at(out, path)).reverse());
        if (!path.length) return reversed;
        at(out, path.slice(0, -1))[path.at(-1)] = reversed;
    }
    return out;
};
const publish = (what, patch, same, basePatch = null) => {
    const from = applyPatch(PUBLISH_BASE, basePatch || {});
    if ((syncStateKey(from) === syncStateKey(applyPatch(from, patch))) !== same) {
        throw new Error(`publish vector "${what}": expected ${same ? 'no push' : 'a push'}`);
    }
    return basePatch ? { what, basePatch, patch, same } : { what, patch, same };
};
const field = (path) => ({ set: [[path, mutate(at(PUBLISH_BASE, path))]] });
const publishCases = [
    ...[...NEWS.slices, ...NOT_NEWS.slices].map((slice) => publish(
        `a change in ${slice} ${NEWS.slices.includes(slice) ? 'is' : 'is not'} news`,
        field([slice]), NOT_NEWS.slices.includes(slice))),
    ...[...NEWS.channel, ...NOT_NEWS.channel].map((name) => publish(
        `a change in a channel's ${name} ${NEWS.channel.includes(name) ? 'is' : 'is not'} news`,
        field(['channels', 0, name]), NOT_NEWS.channel.includes(name))),
    ...[...NEWS.epochKeys, ...NOT_NEWS.epochKeys].map((name) => publish(
        `a change in a channel's epoch keys ${name} ${NEWS.epochKeys.includes(name) ? 'is' : 'is not'} news`,
        field(['epochKeys', CH, name]), NOT_NEWS.epochKeys.includes(name))),
    publish('a channel joined is news', { set: [[['channels', 1], record({ messageStreamId: `${A(12)}/new-1` })]] }, false),
    publish('a channel left is news', { set: [[['channels'], []]] }, false),
    publish('a new channel in the epoch keys is news', { set: [[['epochKeys', `${A(12)}/new-1`], { currentEpoch: 1 }]] }, false),
    publish('a slice this client does not know is news', { set: [[['somethingNew'], { a: 1 }]] }, false),
    publish('the order of the keys is not news', { reverseKeys: [['channels', 0], ['epochKeys', CH], []] }, true),
    publish('the order of the channel list is not news', { reverse: [['channels']] }, true,
        { set: [[['channels', 1], record({ messageStreamId: `${A(12)}/aaa-1` })]] }),
    publish('an empty field and a missing one are the same state', {
        set: [
            [['channels', 0, 'inviteCode'], null], [['channels', 0, 'note'], ''], [['channels', 0, 'pinned'], false],
            [['channels', 0, 'tags'], []], [['channels', 0, 'extra'], {}], [['sentReactions', DM, 'm9'], { '👍': [] }]
        ]
    }, true),
    publish('a field emptied is news', { set: [[['channels', 0, 'password'], null]] }, false)
];

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
    ],
    publish: { base: PUBLISH_BASE, cases: publishCases }
}, null, 2));
