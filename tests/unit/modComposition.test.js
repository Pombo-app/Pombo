// The composition vectors are the shared spec: the same JSON drives this
// suite and the Kotlin one, so a divergence between the clients fails here
// instead of silently in a room.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { composeModeration, banHidesMessage } from '../../src/js/channels/modComposition.js';

const vectors = JSON.parse(readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), '..', '..',
        'docs', 'GATED-CHANNELS-mod-composition-vectors.json'), 'utf8'));

describe('moderation composition (parity vectors)', () => {
    for (const c of vectors.cases) {
        it(c.what, () => {
            const out = composeModeration(c.snapshot, c.deltas, c.modsNow);
            expect(out.hiddenMessageIds).toEqual([...c.effective.hiddenMessageIds].sort());
            expect(out.bannedMembers).toEqual(
                [...c.effective.bannedMembers].sort((a, b) => a.address.localeCompare(b.address)));
        });
    }
});

describe('ban epoch stamp', () => {
    it('a ban without an epoch hides everything', () => {
        expect(banHidesMessage({ address: '0xa', sinceEpoch: null }, 3)).toBe(true);
        expect(banHidesMessage({ address: '0xa', sinceEpoch: null }, null)).toBe(true);
    });

    it('a stamped ban hides from that epoch onward and keeps what came before', () => {
        const entry = { address: '0xa', sinceEpoch: 5 };
        expect(banHidesMessage(entry, 4)).toBe(false);
        expect(banHidesMessage(entry, 5)).toBe(true);
        expect(banHidesMessage(entry, 9)).toBe(true);
    });

    it('an unknown epoch keeps the message: hiding needs proof, not a guess', () => {
        expect(banHidesMessage({ address: '0xa', sinceEpoch: 5 }, null)).toBe(false);
    });
});
