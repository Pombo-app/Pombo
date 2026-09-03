// One-shot generator for the MOD_ACTION parity vectors: the signed moderation
// delta that moderators publish on the message stream's moderation partition.
//
// The delta is self-contained: `sig` is the moderator's ACCOUNT signature over
// a domain-tagged digest of the fields, so it stays verifiable on any raw
// read path, independent of transport validation. Receivers additionally
// check `mod ∈ moderators()` while the delta is unabsorbed.
//
// Digest (field order is the canon — never serialize JSON into it):
//   keccak256(utf8(
//     `POMBO_MOD_V1|<streamId lower>|<op>|<target lower>|<sinceEpoch|''>|<ts>`
//   ))
// `sinceEpoch` participates only for op 'ban' (empty string otherwise, and
// for a 'ban' meaning "hide everything").
import { SigningKey, keccak256, toUtf8Bytes, computeAddress } from 'ethers';

const MOD_PRIV = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d';
const STREAM = '0xaaaabbbbccccddddeeeeffff0000111122223333/deadbeef01-1';
const key = new SigningKey(MOD_PRIV);
const mod = computeAddress(key.publicKey).toLowerCase();

function digest(op, target, sinceEpoch, ts) {
    const epochPart = op === 'ban' && sinceEpoch != null ? String(sinceEpoch) : '';
    return keccak256(toUtf8Bytes(
        `POMBO_MOD_V1|${STREAM.toLowerCase()}|${op}|${target.toLowerCase()}|${epochPart}|${ts}`));
}

function delta(op, target, ts, sinceEpoch = null) {
    const d = digest(op, target, sinceEpoch, ts);
    const out = {
        t: 'MOD_ACTION', op, target: target.toLowerCase(), ts,
        mod, sig: key.sign(d).serialized
    };
    if (op === 'ban' && sinceEpoch != null) out.sinceEpoch = sinceEpoch;
    return { delta: out, digest: d };
}

console.log(JSON.stringify({
    modPriv: MOD_PRIV,
    mod,
    streamId: STREAM,
    vectors: [
        delta('hide', 'msg-0001', 1789000000000),
        delta('unhide', 'msg-0001', 1789000001000),
        delta('ban', '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC', 1789000002000, 7),
        delta('ban', '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC', 1789000003000),
        delta('unban', '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC', 1789000004000)
    ]
}, null, 2));
