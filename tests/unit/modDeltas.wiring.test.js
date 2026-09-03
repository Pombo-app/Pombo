/**
 * The delta path end to end: a moderator's MOD_ACTION reaching a client,
 * being composed onto the owner's snapshot, and the owner absorbing it.
 *
 * Exercises the real ModDeltas and the real AdminState.recompose against a
 * minimal manager — what the suite could not catch before is a delta that
 * verifies but never reaches `channel.adminState`.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ethers } from 'ethers';

globalThis.ethers = ethers;

const { ModDeltas } = await import('../../src/js/channels/ModDeltas.js');
const { AdminState } = await import('../../src/js/channels/AdminState.js');
const { buildModAction } = await import('../../src/js/channels/modAction.js');

const STREAM = '0xowner/pombo/channel/test-1';
const OWNER = new ethers.Wallet('0x' + '11'.repeat(32));
const MOD = new ethers.Wallet('0x' + '22'.repeat(32));
const STRANGER = new ethers.Wallet('0x' + '33'.repeat(32));

let isModerator;

vi.mock('../../src/js/gate.js', () => ({
    gateManager: { _isModerator: (...args) => isModerator(...args) }
}));

function makeManager() {
    const channel = {
        messageStreamId: STREAM,
        createdBy: OWNER.address,
        gate: { address: '0xgate' },
        adminSnapshot: {
            hiddenMessageIds: [], bannedMembers: [], pins: [], absorbedThrough: 0
        }
    };
    const manager = {
        channels: new Map([[STREAM, channel]]),
        notifyHandlers: vi.fn(),
        published: [],
        publishAdminState: vi.fn(async (id, update) => {
            manager.published.push(update);
            return { rev: 1, state: update.patch };
        })
    };
    manager.adminState = new AdminState(manager);
    manager.modDeltas = new ModDeltas(manager);
    manager.adminState.recompose(channel);
    return { manager, channel };
}

// The moderator lookup is a dynamic import away, so give it real ticks.
const flush = async () => { for (let i = 0; i < 20; i++) await new Promise(r => setTimeout(r, 1)); };

describe('MOD_ACTION deltas reaching the rendered state', () => {
    beforeEach(() => { isModerator = async () => true; });

    it('a moderator delta lands on channel.adminState once the gate confirms them', async () => {
        const { manager, channel } = makeManager();
        const delta = buildModAction({
            streamId: STREAM, op: 'hide', target: 'msg-1', privateKey: MOD.privateKey
        });

        expect(manager.modDeltas.ingest(STREAM, delta)).toBe(true);
        // Before the gate answers the signer is unknown, so nothing counts.
        expect(channel.adminState.hiddenMessageIds).toEqual([]);

        await flush();
        expect(channel.adminState.hiddenMessageIds).toEqual(['msg-1']);
        // The owner's own word is untouched.
        expect(channel.adminSnapshot.hiddenMessageIds).toEqual([]);
    });

    it('a delta from someone the gate does not moderate never counts', async () => {
        isModerator = async () => false;
        const { manager, channel } = makeManager();
        manager.modDeltas.ingest(STREAM, buildModAction({
            streamId: STREAM, op: 'hide', target: 'msg-1', privateKey: STRANGER.privateKey
        }));
        await flush();
        expect(channel.adminState.hiddenMessageIds).toEqual([]);
    });

    it('the owner is a moderator without asking the gate', async () => {
        isModerator = async () => { throw new Error('should not be asked'); };
        const { manager, channel } = makeManager();
        manager.modDeltas.ingest(STREAM, buildModAction({
            streamId: STREAM, op: 'hide', target: 'msg-2', privateKey: OWNER.privateKey
        }));
        expect(channel.adminState.hiddenMessageIds).toEqual(['msg-2']);
    });

    it('a ban delta carries its epoch into the composed state', async () => {
        const { manager, channel } = makeManager();
        manager.modDeltas.ingest(STREAM, buildModAction({
            streamId: STREAM, op: 'ban', target: STRANGER.address,
            sinceEpoch: 7, privateKey: MOD.privateKey
        }));
        await flush();
        expect(channel.adminState.bannedMembers).toEqual([
            { address: STRANGER.address.toLowerCase(), sinceEpoch: 7 }
        ]);
    });

    it('dismissing the moderator dissolves their unabsorbed deltas', async () => {
        const { manager, channel } = makeManager();
        manager.modDeltas.ingest(STREAM, buildModAction({
            streamId: STREAM, op: 'hide', target: 'msg-3', privateKey: MOD.privateKey
        }));
        await flush();
        expect(channel.adminState.hiddenMessageIds).toEqual(['msg-3']);

        isModerator = async () => false;
        await manager.modDeltas.refreshModerators(channel);
        await flush();
        expect(channel.adminState.hiddenMessageIds).toEqual([]);
    });

    it('absorbing publishes the composition and moves absorbedThrough to what was read', async () => {
        const { manager, channel } = makeManager();
        const delta = buildModAction({
            streamId: STREAM, op: 'hide', target: 'msg-4',
            privateKey: MOD.privateKey, ts: 1_700_000_000_000
        });
        manager.modDeltas.ingest(STREAM, delta);
        await flush();

        await manager.modDeltas.absorb(STREAM);
        expect(manager.published).toHaveLength(1);
        expect(manager.published[0].patch).toMatchObject({
            hiddenMessageIds: ['msg-4'],
            absorbedThrough: 1_700_000_000_000
        });
    });

    it('what the owner absorbed survives the moderator being dismissed', async () => {
        const { manager, channel } = makeManager();
        const delta = buildModAction({
            streamId: STREAM, op: 'hide', target: 'msg-5',
            privateKey: MOD.privateKey, ts: 1_700_000_000_000
        });
        manager.modDeltas.ingest(STREAM, delta);
        await flush();
        await manager.modDeltas.absorb(STREAM);

        // The owner's snapshot now says it, so the delta is redundant.
        channel.adminSnapshot = {
            hiddenMessageIds: ['msg-5'], bannedMembers: [], pins: [],
            absorbedThrough: 1_700_000_000_000
        };
        isModerator = async () => false;
        await manager.modDeltas.refreshModerators(channel);
        await flush();
        expect(channel.adminState.hiddenMessageIds).toEqual(['msg-5']);
    });

    it('a tampered delta is rejected outright', () => {
        const { manager } = makeManager();
        const delta = buildModAction({
            streamId: STREAM, op: 'hide', target: 'msg-6', privateKey: MOD.privateKey
        });
        delta.target = 'msg-other';
        expect(manager.modDeltas.ingest(STREAM, delta)).toBe(false);
    });
});

describe('what the owner is still asked to confirm', () => {
    beforeEach(() => { isModerator = async () => true; });

    it('stops counting a delta once the snapshot has absorbed it', async () => {
        const { manager, channel } = makeManager();
        const delta = buildModAction({
            streamId: STREAM, op: 'hide', target: 'msg-7',
            privateKey: MOD.privateKey, ts: 1_700_000_000_000
        });
        manager.modDeltas.ingest(STREAM, delta);
        await flush();
        expect(manager.modDeltas.pending(channel)).toHaveLength(1);

        // The owner ratified everything up to this delta.
        channel.adminSnapshot = {
            hiddenMessageIds: ['msg-7'], bannedMembers: [], pins: [],
            absorbedThrough: 1_700_000_000_000
        };
        expect(manager.modDeltas.pending(channel)).toHaveLength(0);
        expect(await manager.modDeltas.absorb(STREAM)).toBeNull();
    });
});
