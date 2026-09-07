/**
 * F-01 regression vector: a forged edit/delete override cannot mutate another
 * user's message.
 *
 * The authorization is split across two places, and both compare the override's
 * `account` to the target message's `sender`:
 *   - handleOverrideMessage  (the target is already loaded)
 *   - applyPendingOverrides  (the override arrived before the target)
 *
 * That comparison is only safe because `account` is DERIVED at ingest by
 * streamrController.attachAccount from the transport publisher and the payload
 * proof — never trusted from the wire. So the faithful vector runs the real
 * attachAccount over each forged shape before handing the override to the real
 * MessageOverrides, then asserts the victim's message is untouched.
 *
 * Forged shapes (an attacker who does not hold the victim's key):
 *   A  no proof, plus spoofed account/sender fields  → attachAccount clobbers them
 *   B  the attacker's own valid proof                → account = attacker
 *   C  the victim's proof lifted onto the attacker's publisherId → recovers garbage
 * Positive control: a proof that actually recovers to the victim → applied.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ethers } from 'ethers';

globalThis.ethers = ethers;

// Break the static import cycle MessageOverrides → dm.js → channels.js →
// MessageOverrides by stubbing dm.js. streamr.js stays REAL so the test runs
// the actual attachAccount (author derivation), which is the invariant F-01
// depends on.
vi.mock('../../src/js/logger.js', () => ({
    Logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock('../../src/js/dm.js', () => ({ dmManager: {} }));

const { streamrController } = await import('../../src/js/streamr.js');
const { MessageOverrides } = await import('../../src/js/channels/MessageOverrides.js');
const { createPublisherProof, clearPublisherProofCache } = await import('../../src/js/publisherProof.js');

const STREAM = '0xowner/testchannel-1';
const VICTIM = new ethers.Wallet('0x' + '11'.repeat(32));
const ATTACKER = new ethers.Wallet('0x' + '22'.repeat(32));
const victimAddr = VICTIM.address.toLowerCase();

// Ephemeral publishers: the address the message actually goes out under.
const victimEphemeral = new ethers.Wallet('0x' + '33'.repeat(32)).address;
const attackerEphemeral = ATTACKER.address; // attacker publishes under its own key

let overrides;
let channel;

function freshChannelWithVictimMessage() {
    const channel = {
        messages: [{ id: 'victim-msg', sender: victimAddr, text: 'original text', timestamp: 1000 }],
    };
    const manager = { channels: new Map([[STREAM, channel]]), notifyHandlers: () => {} };
    return { channel, manager };
}

/** Build an override the way the wire carries it, then run the real ingest
 * derivation (attachAccount) under the given on-wire publisher. */
function ingest(override, publisherId) {
    streamrController.attachAccount(override, publisherId);
    return override;
}

const forged = {
    A: () => ingest({ type: 'delete', targetId: 'victim-msg', timestamp: 2000, account: victimAddr, sender: victimAddr }, attackerEphemeral),
    B: () => ingest({ type: 'delete', targetId: 'victim-msg', timestamp: 2000, proof: createPublisherProof(ATTACKER.privateKey, attackerEphemeral) }, attackerEphemeral),
    C: () => ingest({ type: 'delete', targetId: 'victim-msg', timestamp: 2000, proof: createPublisherProof(VICTIM.privateKey, victimEphemeral) }, attackerEphemeral),
};

beforeEach(() => {
    clearPublisherProofCache();
    ({ channel, overrides } = (() => {
        const { channel, manager } = freshChannelWithVictimMessage();
        return { channel, overrides: new MessageOverrides(manager) };
    })());
});

describe('F-01: forged override cannot delete/edit another account\'s message', () => {
    describe('target already loaded (handleOverrideMessage)', () => {
        for (const variant of ['A', 'B', 'C']) {
            it(`variant ${variant}: forged delete is rejected, victim message stays`, () => {
                overrides.handleOverrideMessage(STREAM, forged[variant]());
                const msg = channel.messages.find(m => m.id === 'victim-msg');
                expect(msg, `variant ${variant} deleted the victim message`).toBeDefined();
                expect(msg.text).toBe('original text');
            });

            it(`variant ${variant}: forged edit is rejected, text unchanged`, () => {
                const ov = forged[variant]();
                ov.type = 'edit';
                ov.text = 'HIJACKED';
                overrides.handleOverrideMessage(STREAM, ov);
                const msg = channel.messages.find(m => m.id === 'victim-msg');
                expect(msg).toBeDefined();
                expect(msg.text, `variant ${variant} edited the victim message`).toBe('original text');
                expect(msg._edited).toBeFalsy();
            });
        }
    });

    describe('target not yet loaded (applyPendingOverrides)', () => {
        for (const variant of ['A', 'B', 'C']) {
            it(`variant ${variant}: forged delete parked then applied is still rejected`, () => {
                // Override arrives first, targeting a message not in the channel yet.
                channel.messages = [];
                overrides.handleOverrideMessage(STREAM, forged[variant]());
                // Now the real message lands and pending overrides are flushed.
                channel.messages.push({ id: 'victim-msg', sender: victimAddr, text: 'original text', timestamp: 1000 });
                overrides.applyPendingOverrides(channel);
                const msg = channel.messages.find(m => m.id === 'victim-msg');
                expect(msg, `variant ${variant} deleted via pending path`).toBeDefined();
                expect(msg._deleted).toBeFalsy();
                expect(msg.text).toBe('original text');
            });
        }
    });

    describe('positive control: the real author can delete their own message', () => {
        it('a proof that recovers to the victim applies the delete', () => {
            const legit = ingest(
                { type: 'delete', targetId: 'victim-msg', timestamp: 2000, proof: createPublisherProof(VICTIM.privateKey, victimEphemeral) },
                victimEphemeral, // published under the victim's own ephemeral key
            );
            expect(legit.account).toBe(victimAddr); // sanity: ingest resolved to the victim
            overrides.handleOverrideMessage(STREAM, legit);
            expect(channel.messages.find(m => m.id === 'victim-msg'), 'legit delete did not apply').toBeUndefined();
        });
    });
});
