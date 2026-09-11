// One-shot generator for the `stored` parity vectors: the signed request body
// a client sends to a Pombo storage node fork to ask which of its own rows
// the node holds (storagePurge.js storedOn; mirrored by StoragePurge.kt).
//
// Message (one field per line, joined by "\n"):
//   pombo-storage-node / stored / streamId / partition / issuedAt / nonce /
//   `timestamp:sequenceNumber` per target, in the order sent.
// Signature = EIP-191 personal_sign over the UTF-8 message; the body carries
// user, issuedAt, nonce, signature and the targets. The node answers
// `present` or `absent` per target, never `forbidden`.
import { Wallet } from 'ethers';
import { buildStoredMessage, signedStoredBody } from '../../src/js/storagePurge.js';

const USER_PRIV = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d';
const wallet = new Wallet(USER_PRIV);
const signer = { address: wallet.address, sign: (m) => wallet.signMessage(m) };
const STREAM = '0x7ea24eb97d400a76f8d96be92c4e7fce576aedb9/Pombo-DM-1';

const CASES = [
    {
        name: 'one announce row on the messages partition',
        partition: 0, issuedAt: 1789000000000, nonce: '0f1e2d3c4b5a69788796a5b4c3d2e1f0',
        targets: [{ timestamp: 1788999000000, sequenceNumber: 0 }]
    },
    {
        name: 'three chunk rows of a DM file on its first chunk partition, in the order sent',
        partition: 4, issuedAt: 1789000001000, nonce: '00000000000000000000000000000001',
        targets: [
            { timestamp: 1788999000000, sequenceNumber: 0 },
            { timestamp: 1788999000250, sequenceNumber: 0 },
            { timestamp: 1788999000250, sequenceNumber: 1 }
        ]
    }
];

const vectors = [];
for (const c of CASES) {
    const message = buildStoredMessage({ streamId: STREAM, partition: c.partition, issuedAt: c.issuedAt, nonce: c.nonce, targets: c.targets });
    const body = await signedStoredBody(STREAM, c.partition, c.targets, signer, { issuedAt: c.issuedAt, nonce: c.nonce });
    vectors.push({ name: c.name, streamId: STREAM, partition: c.partition, message, body });
}

console.log(JSON.stringify({ userPriv: USER_PRIV, user: wallet.address, vectors }, null, 2));
