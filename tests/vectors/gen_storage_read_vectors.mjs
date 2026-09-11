// One-shot generator for the signed storage read parity vectors: the
// `x-pombo-*` headers a client sends to a Pombo storage node fork for a
// history read of a gated channel (storageReadSigner.js; mirrored by the
// Android bridge page and by the native StorageReadSigner.kt).
//
// Message (one field per line, joined by "\n"):
//   pombo-storage-node / read / streamId / partition / issuedAt / nonce /
//   resendType / canonicalQuery
// canonicalQuery = query parameters sorted by name, `name=value` with the
// values decoded, joined by `&`, repeats in received order.
// Signature = EIP-191 personal_sign over the UTF-8 message.
import { Wallet } from 'ethers';
import { parseStorageDataUrl, buildReadMessage } from '../../src/js/storageReadSigner.js';

const USER_PRIV = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d';
const wallet = new Wallet(USER_PRIV);
const BASE = 'https://1.storage.example';
const STREAM = '0xaaaabbbbccccddddeeeeffff0000111122223333/deadbeef01-1';
const KEYS = '0xaaaabbbbccccddddeeeeffff0000111122223333/deadbeef01-4';
const enc = encodeURIComponent;

const CASES = [
    {
        name: 'last, the SDK shape',
        url: `${BASE}/streams/${enc(STREAM)}/data/partitions/0/last?count=50&format=raw`,
        issuedAt: 1789000000000, nonce: '0f1e2d3c4b5a69788796a5b4c3d2e1f0'
    },
    {
        name: 'from with publisher and chain, unsorted on the wire',
        url: `${BASE}/streams/${enc(STREAM)}/data/partitions/1/from?fromTimestamp=1788999000000&fromSequenceNumber=3&publisherId=0x9709ca1b0000000000000000000000000000abcd&msgChainId=Ab3%2Fx%2Bz&format=raw`,
        issuedAt: 1789000001000, nonce: '00000000000000000000000000000001'
    },
    {
        name: 'range on the keys stream, metadata format',
        url: `${BASE}/streams/${enc(KEYS)}/data/partitions/1/range?fromTimestamp=0&toTimestamp=1789000000000&format=metadata`,
        issuedAt: 1789000002000, nonce: 'ffffffffffffffffffffffffffffffff'
    },
    {
        name: 'repeated parameter keeps received order',
        url: `${BASE}/streams/${enc(STREAM)}/data/partitions/3/last?count=2&x=b&x=a&format=raw`,
        issuedAt: 1789000003000, nonce: '0123456789abcdef0123456789abcdef'
    }
];

const vectors = [];
for (const c of CASES) {
    const parsed = parseStorageDataUrl(c.url);
    const message = buildReadMessage({
        streamId: parsed.streamId, partition: parsed.partition, issuedAt: c.issuedAt,
        nonce: c.nonce, resendType: parsed.resendType, canonicalQuery: parsed.canonicalQuery
    });
    vectors.push({
        name: c.name,
        url: c.url,
        streamId: parsed.streamId,
        partition: parsed.partition,
        resendType: parsed.resendType,
        canonicalQuery: parsed.canonicalQuery,
        issuedAt: c.issuedAt,
        nonce: c.nonce,
        message,
        headers: {
            'x-pombo-user': wallet.address,
            'x-pombo-issued-at': String(c.issuedAt),
            'x-pombo-nonce': c.nonce,
            'x-pombo-signature': await wallet.signMessage(message)
        }
    });
}

console.log(JSON.stringify({ userPriv: USER_PRIV, user: wallet.address, vectors }, null, 2));
