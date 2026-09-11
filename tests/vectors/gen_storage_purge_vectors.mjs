// One-shot generator for the purge parity vectors: the signed request body a
// client sends to a Pombo storage node fork to remove specific messages
// (storagePurge.js; mirrored by the native StoragePurge.kt).
//
// Message (one field per line, joined by "\n"):
//   pombo-storage-node / purge / streamId / partition / issuedAt / nonce /
//   `timestamp:sequenceNumber` per target, in the order sent.
// Signature = EIP-191 personal_sign over the UTF-8 message; the body carries
// user, issuedAt, nonce, signature and the targets.
import { Wallet } from 'ethers';
import { buildPurgeMessage, signedPurgeBody } from '../../src/js/storagePurge.js';

const USER_PRIV = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d';
const wallet = new Wallet(USER_PRIV);
const signer = { address: wallet.address, sign: (m) => wallet.signMessage(m) };
const STREAM = '0xaaaabbbbccccddddeeeeffff0000111122223333/deadbeef01-1';

const CASES = [
    {
        name: 'one target',
        partition: 0, issuedAt: 1789000000000, nonce: '0f1e2d3c4b5a69788796a5b4c3d2e1f0',
        targets: [{ timestamp: 1788999000000, sequenceNumber: 0 }]
    },
    {
        name: 'three targets in the order sent, one with a sequence number above zero',
        partition: 3, issuedAt: 1789000001000, nonce: '00000000000000000000000000000001',
        targets: [
            { timestamp: 1788999000000, sequenceNumber: 2 },
            { timestamp: 1788998000000, sequenceNumber: 0 },
            { timestamp: 1788999000000, sequenceNumber: 1 }
        ]
    }
];

const vectors = [];
for (const c of CASES) {
    const message = buildPurgeMessage({ streamId: STREAM, partition: c.partition, issuedAt: c.issuedAt, nonce: c.nonce, targets: c.targets });
    const body = await signedPurgeBody(STREAM, c.partition, c.targets, signer, { issuedAt: c.issuedAt, nonce: c.nonce });
    vectors.push({ name: c.name, streamId: STREAM, partition: c.partition, message, body });
}

console.log(JSON.stringify({ userPriv: USER_PRIV, user: wallet.address, vectors }, null, 2));
