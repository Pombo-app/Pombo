// One-shot generator for the MEMBER_HELLO name/prev parity vectors.
//
// The hello payload (sealed with the epoch key on the roster partition) gains
// two optional fields: `name` (the author's display name at publish time,
// trimmed, max 64 chars) and `prev` (the `ts` of this account's previous
// hello, an audit chain — informational, never load-bearing). Authenticity is
// unchanged: the roster only accepts a hello whose ENVELOPE signer equals the
// declared `account`, so no in-payload signature exists.
//
// The reduction half fixes the roster semantics both clients must share:
// dedupe by account, newest `ts` wins, a hello without `name` never erases a
// name an older hello carried (name is "last SET wins", not "last hello
// wins") — a fresh device that does not know the name yet must not blank it.
const helloA1 = { t: 'MEMBER_HELLO', account: '0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266', spk: '0x02aa', ts: 1789000000000, name: 'Alice' };
const helloA2 = { t: 'MEMBER_HELLO', account: '0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266', spk: '0x02aa', ts: 1789000005000, prev: 1789000000000 };
const helloA3 = { t: 'MEMBER_HELLO', account: '0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266', spk: '0x02aa', ts: 1789000009000, name: 'Alice Renamed', prev: 1789000005000 };
const helloB1 = { t: 'MEMBER_HELLO', account: '0x70997970c51812dc3a010c7d01b50e0d17dc79c8', ts: 1789000002000 };

console.log(JSON.stringify({
    vectors: [
        {
            what: 'newest ts wins per account; a name-less hello keeps the older name',
            hellos: [helloA1, helloA2, helloB1],
            roster: [
                { account: helloA1.account, spk: '0x02aa', ts: 1789000005000, name: 'Alice' },
                { account: helloB1.account, spk: null, ts: 1789000002000, name: null }
            ]
        },
        {
            what: 'a rename replaces the name; order of arrival must not matter',
            hellos: [helloA3, helloA1, helloA2],
            roster: [
                { account: helloA1.account, spk: '0x02aa', ts: 1789000009000, name: 'Alice Renamed' }
            ]
        }
    ]
}, null, 2));
