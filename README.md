# Pombo Web

**Pombo** is a peer-to-peer messaging and social media app, built on open infrastructure instead of a company's servers.
Your people. Your rules. Your money.

This is the web client, also installable as a PWA, live at
[app.pombo.cc](https://app.pombo.cc). It is the reference implementation of the
Pombo wire protocol.

· Website: [pombo.cc](https://pombo.cc)
· App: [app.pombo.cc](https://app.pombo.cc)
· Docs: [docs.pombo.cc](https://docs.pombo.cc)

---

## What Pombo does

- **Channels whose access rule is a contract you own**, not a policy somebody
  else writes and you are made to accept.
  - **Paid channels that pay you directly.** The subscription goes from the
    subscriber's wallet to yours, in any ERC-20. No platform cut, no payout
    schedule, no account anyone can freeze.
  - **Spam has to be paid for.** A gated channel stays open: the rule is
    holding a token or an NFT, and whoever holds it walks in without asking
    anyone's permission. What changes is the price of abuse. One funded wallet
    buys one seat, so a bot farm needs thousands of them, and the refusal is
    the contract's, not the app's: a non-holder never receives a key, and the
    network refuses what they sign.
- **Direct messages** end-to-end encrypted, with the sender sealed inside the
  envelope, so not even someone watching your inbox learns who wrote to you.
- **Your history lives where you decide.** The channel owner picks the storage
  providers: the Pombo cluster, a community node, their own, or all three at
  once.
- **Notifications that reveal nothing.** The relay that wakes your phone never
  learns the channel, the sender or the message.
- **Your account is a keypair on your device.** No sign-up, no e-mail, no
  password reset, no server holding your data because no server has it.
- **Media, video and files**, peer-to-peer for what is transient, on storage
  nodes for what must outlive the sender's session.
- **Sync across your own devices** without a sync server, through your own
  encrypted inbox.

---

## How it works

### There is no Pombo server

The client is a static site. It has no backend of its own, and everything it
reads comes from public infrastructure:

| What | Where it comes from |
|---|---|
| Message transport | Streamr network |
| Channel ownership and access | Polygon contracts |
| Channel discovery and permissions | Streamr subgraph on The Graph |
| History | Storage nodes, chosen per channel |

**Every one of those endpoints is replaceable by the user**, in Settings:
Polygon RPCs are an ordered list you enable and reorder, with a custom slot;
The Graph runs on your own API key if you supply one; storage providers are
your choice per channel. The project operates two things, both optional and
both replaceable: the default storage cluster, and the push relay, which is
blind by construction.

### A channel is a set of streams

Four streams derived from one base ID, five when membership is contract-backed.
Protocol constants, not configuration.

| Stream | Storage | Carries |
|---|---|---|
| `-1` message | yes | conversation, edits and deletes, moderator deltas, file chunks |
| `-2` ephemeral | no | presence, typing, peer-to-peer media signalling |
| `-3` admin | yes | moderation snapshot, channel image, password challenge. Owner publishes, everyone reads |
| `-4` keys | yes | key announces, requests and answers, the sealed member roster. Contract-backed channels only; members publish and read |
| `-5` interactions | yes | reactions |

DM inboxes use the same `-1` layout with extra partitions for sync and invites,
so one inbox serves everything.

### Storage: who keeps your history

Streamr streams are broadcast, not memory. History exists because a storage
node retains it, and the channel owner chooses which.

| Model | What it is | How you get it |
|---|---|---|
| **Pombo** | The cluster the project runs | Default, plug and play |
| **Third-party** | Any storage provider someone else runs | Paste its address into the channel's Storage panel |
| **Self-hosted** | Your own node or cluster | Run it, register it, paste its address |

All three are the same mechanism: "Pombo" is just a preset address, with no
privileged path for the project's cluster. A custom provider is validated
before it is accepted, since a browser cannot read from a node that publishes
no HTTPS URL.

**They combine.** A channel can hold several providers at once, added or
removed on-chain at any point in its life, so its history can have independent
copies under different operators and no single one can erase it. Reads rotate
across every healthy URL a provider publishes, and one that keeps failing is
dropped from the rotation for the session.

The node software the project publishes and runs,
[pombo-storage-node](https://github.com/Pombo-app/pombo-storage-node), is a
build of the Streamr storage node that validates every message before storing
it, serves the history of private channels and inboxes only to a request
signed by someone with current access, stamps each message with the time it
arrived, deletes on request from whoever can prove authorship or moderates the
channel, and enforces retention itself. The client detects those capabilities
per provider and works against a plain Streamr node without them.

Retention is per stream, 1 to 365 days. Artifacts that are written once and
then only read (moderation state, channel image, password challenge) are
republished by the owner before their retention expires, so bans and pins do
not quietly vanish.

### Privacy on the wire

Encryption protects what you said; this is about who can see that it was you.
A channel session publishes under a throwaway keypair, created on first
publish, never persisted, discarded when you leave, and your account travels
as a signed proof inside the payload: in the clear in open channels, inside
the encryption everywhere else. DMs go further, with the sender sealed inside
the envelope so that even the recipient's inbox names nobody.

Contract-backed channels are the one place the throwaway identity does not
apply, because anything the network checks has to be readable by non-members.
The creator picks once, at creation, whether authorship is **Sealed** (everyone
publishes under one shared key; members attribute, the network cannot) or
**Visible** (your account signs each message and the network validates it
against the contract). Sealed is the default; the choice is shown on the
channel's card in Explore. The full table of who learns your account in each
context is in the docs:
[Publisher identity](https://docs.pombo.cc/protocol/identity).

There is no per-channel anonymous toggle. Taking part unlinked means a second
account, which is free, instant and completely separate.

### Keys for contract-backed channels

Content is encrypted with a channel-wide **epoch key**, distributed on `-4`.
The admin announces each key by its hash and never the key itself; any member
holding it can answer a request, and a key is adopted only if it hashes to
what was announced. Requests and answers are stored, so a request made when
nobody is online is answered later by whoever comes back. Removing or banning
a member rotates the key at once. Sealed channels carry two more keys on the
same stream, a shared publish key and an interactions key, which is what lets
a read-only channel have reactions from members who cannot post. The protocol
is described in the docs: [Encryption](https://docs.pombo.cc/protocol/encryption).

---

## Features

**Channels**

| Type | Access rule | Read | Write |
|---|---|---|---|
| **Open** | Streamr permissions | Public | Public |
| **Protected** | A shared password | Public stream, encrypted content | Anyone with the password |
| **Closed** | PomboGate contract, owner allowlist | Members | Members |
| **Gated** | PomboGate contract, token or NFT holding | Holders | Holders |
| **Paid** | PomboGate contract, subscription paid to the owner | Subscribers | Subscribers |

Those two columns are enforced by different layers, and it is worth knowing
which:

| | What holds the line |
|---|---|
| **Write** | The network and the storage node, in Visible: every message is validated against the contract at ingest, so selling the token, letting a subscription lapse or being banned cuts writing on any node. In Sealed the network only sees the shared publish key and never consults the contract. |
| **Read** | Key distribution: no key ever reaches a non-member. On a Pombo storage node, stored history of a private channel is served only to a signed request from someone the gate accepts right now. |
| **History** | The storage node, which validates signature and publish permission before storing, and the client, which verifies signer and key generation on read. |

- Closed, Gated and Paid are the **contract-backed** three: one EIP-1167
  `PomboGate` clone per channel, minted on Polygon. It answers a single
  question, "does this signer have access right now?", to the network at
  ingest, to storage nodes on read, and to our clients before they hand over a
  key, so none of them can disagree about who is in.
- **Identity on the wire**, Sealed or Visible, is picked at creation, held in
  the contract and never changes.
- **Read-only** is a flag on the contract, also fixed at creation: only the
  owner and the moderators publish, while members read, react and appear as
  present.
- Password channels verify a candidate password locally against a published
  challenge, so it never touches the network.
- Any channel can be **Listed or Unlisted**, which affects Explore only: a
  direct link to an unlisted channel still works. A channel can also be
  write-only, straight from the stream permissions.

**Messaging**

- Every type but Open encrypts content before it reaches the network, so the
  transport carries ciphertext and the keys never leave the members.
- Edits and deletes as signed overrides, so history stays append-only.
- Reactions, replies, pinned banners, read/unread tracking, message grouping,
  link detection, YouTube embeds through `youtube-nocookie`.

**Moderation**

- Owner-appointed moderators, read from the contract, so contract-backed
  channels only: elsewhere the owner moderates alone.
- The owner moderates by publishing a snapshot on `-3`, which only they can
  write. A moderator publishes signed deltas on the message stream instead, and
  every client folds them onto the snapshot. The owner later absorbs them into
  a snapshot of their own, and that is what makes a moderator's decisions
  outlive the moderator.
- A ban is three independent effects, any combination: **hide their
  messages**, free and reversible; **cut their access**, one transaction,
  after which they neither write nor receive keys; **erase their messages from
  storage**, sent to every provider of the channel and reported per provider.
- A ban carries the key generation it starts from, so hiding someone does not
  erase a year of legitimate contributions along with the bad week.
- Hiding and pinning converge by periodic refresh plus an in-band signal, so a
  ban lands immediately on anyone watching.
- Deleting your own message erases the stored copy too, wherever the storage
  node can verify you wrote it: always in Visible channels, during the
  publishing session elsewhere, never in Sealed channels, where the owner or a
  moderator erases instead.

**Media and files**

- Images with adaptive compression: a resolution and quality ladder that
  converges on a payload that fits the wire, chunked when needed.
- Video and large files peer-to-peer, with hash verification per piece.
- Persistent file sharing over storage nodes: incremental verify and repair on
  upload, resumable download, encrypted per file in password channels and per
  pair in DMs.

**Identity**

- Multiple profiles per device, plus a guest mode that persists nothing.
- Deterministic SVG avatars from the address, so everyone sees the same face
  with nothing stored anywhere.
- ENS names and avatars across five providers with failover, and decoy lookups
  so the RPC operator cannot tell who you are actually looking up.
- Trusted contacts with an explicit trust level per peer.

**Sync and backup**

- Channels, contacts, settings and keys sync between your devices over your own
  encrypted inbox, merged so a channel you left cannot come back.
- Three modes: automatic, skip on start, manual only.
- Encrypted account backups go through the same merge path, so a restore cannot
  duplicate or resurrect anything.

**Discovery**

- Explore with a curated list, the access rule and the identity mode on the
  card.
- Previews that let you read a channel before joining it, under exactly the
  rules a member reads by.
- QR invites, deep links, Android App Links.

---

## Under the hood

- Four runtime dependencies: `@streamr/sdk`, `ethers` 6, `dompurify`, `qrcode`.
- Heavy crypto runs in a Web Worker pool, and sync merging in a worker of its
  own.
- Account data on the device is encrypted at rest under a key derived from a
  wallet signature, isolated per address. The service worker keeps a small
  store outside it, because it has to work before the wallet is unlocked.
- Errors follow an explicit per-layer contract, with retries, backoff, a
  circuit breaker on the relay, RPC failover and storage-node health tracking.
- **Testing:** `npm run test:run` runs the full suite. Three kinds carry most
  of the weight:
  - parity vectors generated here and checked by the Android client, so the two
    cannot silently diverge on a wire format;
  - tests that build real messages with the SDK's own signer, so a pinned SDK
    internal fails loudly on upgrade rather than mis-attributing authors;
  - deployment-invariant tests that assert on the workflow file, the CSP and
    the shipped artifact, catching files that are committed, correct, and never
    actually served.
- **Security:** a CSP admitting no inline script and no foreign origin,
  declared twice and checked by a test that both copies agree; a clickjacking
  guard; DOMPurify on a narrow allowlist with a version floor enforced in CI;
  fonts served from this origin.
- **Deploys** build from source in CI and publish to GitHub Pages, so what is
  served is provably the committed source, with no checked-in bundle to tamper
  with.

---

## Development

Built and tested on Node.js 24.

```
npm install
npm run build          # CSS + JS bundles
npm run watch          # rebuild on change
npm run serve          # build and serve locally
npm run build:minify   # production bundles

npm run test:run       # full suite
npm run test:coverage  # with V8 coverage
```

### Where the claims on this page live

```
src/js/
├── streamConstants.js   the stream layout, as protocol constants
├── streamr.js, streamr/ Streamr client: publish, subscribe, raw resend
├── channels.js, channels/  messaging core, admin state, moderator deltas
├── dm.js                direct messages over the inbox stream
├── gate.js              PomboGate client, one clone per channel
├── epochKey*.js         key protocol for contract-backed channels
├── keyResponder.js      answering key requests made while nobody was online
├── publisherProof.js    throwaway publisher bound to an account
├── envelopeSigner.js    author recovery in Visible mode
├── authorship.js        author sealed inside the payload, Sealed mode
├── dmCrypto.js          ECDH + HKDF + AES-GCM, sealed sender
├── storageEndpoints.js  on-chain provider resolution, rotation, health
├── storageFetch.js      signed reads, receipt timestamps, 401/403/503 handling
├── storageMedia.js      file sharing over storage nodes
├── streamRetention.js   per-stream retention (ttlRepublish.js resets the clock)
├── secureStorage.js     encrypted localStorage + IndexedDB
├── syncManager.js       cross-device sync (syncMerge.js is the pure part)
├── pushProtocol.js      K-anonymous tags and proof of work
├── ui/                  one module per surface
├── workers/             crypto pool and sync worker
└── utils/               retry, errors, retention
tests/                   unit, smoke, cross-client parity vectors
sw.js                    service worker: offline and push
```

## Related repositories

- [Pombo-Android](https://github.com/Pombo-app/Pombo-Android): native client, port of this protocol.
- [pombo-contracts](https://github.com/Pombo-app/pombo-contracts): `PomboGate` and `PomboGateFactory`.
- [pombo-storage-node](https://github.com/Pombo-app/pombo-storage-node): the storage node, a build of the Streamr node.
- [Pombo-push](https://github.com/Pombo-app/Pombo-push): the push relay.
- [Pombo-docs](https://github.com/Pombo-app/Pombo-docs): source of [docs.pombo.cc](https://docs.pombo.cc).

## License

[MIT](LICENSE)
