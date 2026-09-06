/**
 * The roster's name rules, against the web-generated vectors the Android side
 * reads too (docs/GATED-CHANNELS-hello-vectors.json).
 *
 * The rule that is easy to get wrong: a hello WITHOUT a name does not erase
 * the name an older hello carried — the name comes from the newest hello that
 * actually declared one, while `ts` and `spk` come from the newest hello.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ethers } from 'ethers';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';

globalThis.ethers = ethers;

const { epochKeyManager } = await import('../../src/js/epochKeyManager.js');
const { streamrController } = await import('../../src/js/streamr.js');
const { epochKeyCrypto } = await import('../../src/js/epochKeyCrypto.js');

function loadVectors() {
    let dir = process.cwd();
    for (let i = 0; i < 6; i++) {
        const candidate = join(dir, 'docs', 'GATED-CHANNELS-hello-vectors.json');
        if (existsSync(candidate)) return JSON.parse(readFileSync(candidate, 'utf8'));
        dir = dirname(dir);
    }
    return null;
}

const VECTORS = loadVectors();
const STREAM = '0xowner/pombo/roster-1';
const channel = {
    messageStreamId: STREAM,
    keysStreamId: '0xowner/pombo/roster-4',
    type: 'gated',
    gate: { address: '0xgate' }
};

/** Feed the manager a set of hellos as if they came off the -4/P1 resend. */
function stubResend(hellos) {
    vi.spyOn(streamrController, 'resendKeysMessages').mockResolvedValue(
        hellos.map(h => ({
            data: { e: 'epoch-aes-gcm', k: 'kid-1', ct: h, iv: 'iv' },
            publisherId: h.account,
            timestamp: h.ts
        })));
    vi.spyOn(epochKeyManager, 'getKeyForKid').mockResolvedValue('key');
    vi.spyOn(epochKeyCrypto, 'decryptWithEpochKey').mockImplementation(
        async (envelope) => envelope.ct);
    vi.spyOn(epochKeyManager, '_rosterCapable').mockResolvedValue(true);
}

describe('roster names from MEMBER_HELLO', () => {
    beforeEach(() => {
        vi.restoreAllMocks();
        epochKeyManager.state.delete(STREAM);
    });

    it('matches the web vectors case by case', async () => {
        expect(VECTORS, 'hello vectors not found').toBeTruthy();
        for (const vector of VECTORS.vectors) {
            epochKeyManager.state.delete(STREAM);
            stubResend(vector.hellos);
            const roster = await epochKeyManager.getRosterMembers(channel);
            const sorted = [...roster].sort((a, b) => a.account.localeCompare(b.account));
            const expected = [...vector.roster].sort((a, b) => a.account.localeCompare(b.account));
            expect(sorted, vector.what).toEqual(expected);
        }
    });

    it('refuses a hello whose envelope signer is not the account it claims', async () => {
        stubResend([{
            t: 'MEMBER_HELLO',
            account: '0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266',
            ts: 1_789_000_000_000,
            name: 'Impostor'
        }]);
        // Re-stub the resend so the publisher is someone else entirely.
        vi.spyOn(streamrController, 'resendKeysMessages').mockResolvedValue([{
            data: {
                e: 'epoch-aes-gcm', k: 'kid-1', iv: 'iv',
                ct: {
                    t: 'MEMBER_HELLO',
                    account: '0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266',
                    ts: 1_789_000_000_000, name: 'Impostor'
                }
            },
            publisherId: '0x70997970c51812dc3a010c7d01b50e0d17dc79c8',
            timestamp: 1_789_000_000_000
        }]);
        expect(await epochKeyManager.getRosterMembers(channel)).toEqual([]);
    });

    it('names a bubble by the chain: ENS, nickname, roster, senderName, address', async () => {
        const { chatAreaUI } = await import('../../src/js/ui/ChatAreaUI.js');
        const { identityManager } = await import('../../src/js/identity.js');
        const alice = '0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266';
        stubResend(VECTORS.vectors[0].hellos);
        await epochKeyManager.getRosterMembers(channel);   // roster says "Alice"

        const named = (msg) => chatAreaUI._displayNameFor(msg, channel);

        // The roster name gives a name to someone whose message carries none.
        expect(named({ sender: alice, timestamp: 1 })).toBe('Alice');
        // Between the roster and the payload, the most recent claim wins.
        expect(named({ sender: alice, timestamp: 1, senderName: 'Older' })).toBe('Alice');
        expect(named({ sender: alice, timestamp: 9_999_999_999_999, senderName: 'Newer' }))
            .toBe('Newer');
        // A contact nickname outranks both.
        vi.spyOn(identityManager, 'getTrustedContact').mockReturnValue({ nickname: 'Nick' });
        expect(named({ sender: alice, timestamp: 1, senderName: 'Newer' })).toBe('Nick');
        // ENS outranks everything.
        vi.spyOn(identityManager, 'getCachedENS').mockReturnValue('alice.eth');
        expect(named({ sender: alice, timestamp: 1 })).toBe('alice.eth');
        // Nobody knows them: the address, never an empty label.
        vi.restoreAllMocks();
        expect(named({ sender: '0x' + 'ab'.repeat(20), timestamp: 1 })).toMatch(/^0xab/);
    });

    it('serves the last read roster synchronously for the bubbles', async () => {
        stubResend(VECTORS.vectors[0].hellos);
        await epochKeyManager.getRosterMembers(channel);
        const named = VECTORS.vectors[0].roster.find(r => r.name);
        expect(epochKeyManager.getRosterName(STREAM, named.account))
            .toEqual({ name: named.name, ts: named.ts });
        expect(epochKeyManager.getRosterName(STREAM, '0x' + '99'.repeat(20))).toBeNull();
    });
});
