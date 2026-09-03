// Invariant: every client.resend call reads RAW. The SDK validation that raw
// turns off is replaced by verifyEnvelopeAuthenticity on non-gated streams
// and by resolveAuthor (envelope-signer recovery) on gated ones; a call site
// added without raw silently reintroduces the half-connected-node stalls and
// the revalidate-against-the-present behaviour the raw reads exist to avoid.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const FILES = [
    'src/js/streamr.js',
    'src/js/streamr/History.js',
    'src/js/dm.js',
    'src/js/storageMedia.js'
];

describe('resend raw invariant', () => {
    for (const file of FILES) {
        it(`every client.resend in ${file} passes raw: true`, () => {
            const source = readFileSync(join(root, file), 'utf8');
            const lines = source.split('\n');
            const offenders = [];
            lines.forEach((line, i) => {
                if (!line.includes('client.resend(')) return;
                const window = lines.slice(i, i + 12).join('\n');
                if (!/raw:\s*true/.test(window)) {
                    offenders.push(`${file}:${i + 1}`);
                }
            });
            expect(offenders, `client.resend without raw at: ${offenders.join(', ')}`)
                .toEqual([]);
        });
    }

    it('no other module calls client.resend directly', () => {
        // New call sites belong in streamr.js/History.js where the invariant
        // above and the authenticity guards are enforced.
        const { execSync } = require('child_process');
        // Cheap static sweep without a grep dependency: scan src/js excluding
        // the two sanctioned files.
        const { readdirSync, statSync } = require('fs');
        const offenders = [];
        const walk = (dir) => {
            for (const name of readdirSync(dir)) {
                const p = join(dir, name);
                if (statSync(p).isDirectory()) { walk(p); continue; }
                if (!p.endsWith('.js')) continue;
                const rel = p.slice(root.length + 1).replaceAll('\\', '/');
                if (FILES.includes(rel)) continue;
                if (readFileSync(p, 'utf8').includes('client.resend(')) {
                    offenders.push(rel);
                }
            }
        };
        walk(join(root, 'src', 'js'));
        expect(offenders).toEqual([]);
    });
});
