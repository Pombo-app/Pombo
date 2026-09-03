// The delta vectors are the shared spec: this suite and the Kotlin one read
// the same JSON, so a divergence in the digest or the field order fails here
// rather than as a delta one client silently ignores.
import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { ethers } from 'ethers';

globalThis.ethers = ethers;

const vectors = JSON.parse(readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..',
        'docs', 'GATED-CHANNELS-mod-action-vectors.json'), 'utf8'));

let modActionDigest, buildModAction, verifyModAction;
beforeAll(async () => {
    ({ modActionDigest, buildModAction, verifyModAction } =
        await import('../../src/js/channels/modAction.js'));
});

describe('MOD_ACTION parity vectors', () => {
    it('reproduces every vector digest', () => {
        for (const v of vectors.vectors) {
            const digest = modActionDigest({
                streamId: vectors.streamId,
                op: v.delta.op,
                target: v.delta.target,
                sinceEpoch: v.delta.sinceEpoch,
                ts: v.delta.ts
            });
            expect(digest).toBe(v.digest);
        }
    });

    it('verifies every vector delta back to the moderator', () => {
        for (const v of vectors.vectors) {
            expect(verifyModAction(vectors.streamId, v.delta)).toBe(vectors.mod);
        }
    });

    it('rebuilds byte-identical deltas from the same inputs', () => {
        for (const v of vectors.vectors) {
            const rebuilt = buildModAction({
                streamId: vectors.streamId,
                op: v.delta.op,
                target: v.delta.target,
                sinceEpoch: v.delta.sinceEpoch ?? null,
                privateKey: vectors.modPriv,
                ts: v.delta.ts
            });
            expect(rebuilt).toEqual(v.delta);
        }
    });
});

describe('MOD_ACTION rejection', () => {
    const good = vectors.vectors[0].delta;

    it('rejects a tampered target', () => {
        expect(verifyModAction(vectors.streamId, { ...good, target: 'msg-9999' }))
            .not.toBe(vectors.mod);
    });

    it('rejects a delta replayed onto another channel', () => {
        expect(verifyModAction('0xdead/other-1', good)).not.toBe(vectors.mod);
    });

    it('rejects a mod field that disagrees with the signature', () => {
        expect(verifyModAction(vectors.streamId, { ...good, mod: '0x' + '11'.repeat(20) }))
            .toBeNull();
    });

    it('rejects an unknown op and a missing signature', () => {
        expect(verifyModAction(vectors.streamId, { ...good, op: 'delete' })).toBeNull();
        expect(verifyModAction(vectors.streamId, { ...good, sig: undefined })).toBeNull();
    });

    it('a ban stamped with an epoch does not verify without it', () => {
        const stamped = vectors.vectors.find(v => v.delta.sinceEpoch != null).delta;
        const { sinceEpoch, ...withoutEpoch } = stamped;
        expect(verifyModAction(vectors.streamId, withoutEpoch)).not.toBe(vectors.mod);
    });
});
