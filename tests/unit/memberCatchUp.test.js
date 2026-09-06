/**
 * The member's catch-up sweep: who runs it, and what one tick actually does.
 *
 * A green suite would not have caught the two ways this fails silently — the
 * owner polling their own channel, or a tick that sweeps the keys and never
 * touches the messages.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ethers } from 'ethers';

globalThis.ethers = ethers;

const { memberCatchUp } = await import('../../src/js/memberCatchUp.js');
const { epochKeyManager } = await import('../../src/js/epochKeyManager.js');
const { streamrController } = await import('../../src/js/streamr.js');
const { authManager } = await import('../../src/js/auth.js');
const { CONFIG } = await import('../../src/js/config.js');

const OWNER = '0xF39Fd6e51aad88F6F4ce6aB8827279cffFb92266';
const MEMBER = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8';

function channel(extra = {}) {
    return {
        messageStreamId: `${OWNER.toLowerCase()}/pombo/room-1`,
        keysStreamId: `${OWNER.toLowerCase()}/pombo/room-4`,
        createdBy: OWNER,
        gate: { address: '0xgate' },
        ...extra
    };
}

describe('member catch-up', () => {
    let sweptKeys, sweptMessages;

    beforeEach(() => {
        vi.useFakeTimers();
        sweptKeys = 0; sweptMessages = 0;
        vi.spyOn(epochKeyManager, 'ensureChannelKeys').mockImplementation(async () => { sweptKeys++; });
        vi.spyOn(streamrController, 'fetchHistoryAsync').mockImplementation(
            (id, partition, count, handler, password, done) => { sweptMessages++; done?.(); });
    });

    afterEach(() => {
        memberCatchUp.stop();
        vi.useRealTimers();
        vi.restoreAllMocks();
    });

    it('runs for a member and sweeps both the keys and the messages', async () => {
        vi.spyOn(authManager, 'getAddress').mockReturnValue(MEMBER);
        memberCatchUp.start(channel(), () => {});
        expect(memberCatchUp.getStreamId()).toBe(channel().messageStreamId);

        await vi.advanceTimersByTimeAsync(CONFIG.subscriptions.memberCatchUpIntervalMs + 10);
        expect(sweptKeys).toBe(1);
        expect(sweptMessages).toBe(1);
    });

    it('never runs for the owner — they publish, and answer their own keys', async () => {
        vi.spyOn(authManager, 'getAddress').mockReturnValue(OWNER);
        memberCatchUp.start(channel(), () => {});
        expect(memberCatchUp.getStreamId()).toBeNull();
        await vi.advanceTimersByTimeAsync(CONFIG.subscriptions.memberCatchUpIntervalMs * 2);
        expect(sweptKeys + sweptMessages).toBe(0);
    });

    it('never runs in preview, and never on an ungated channel', () => {
        vi.spyOn(authManager, 'getAddress').mockReturnValue(MEMBER);
        memberCatchUp.start(channel({ preview: true }), () => {});
        expect(memberCatchUp.getStreamId()).toBeNull();
        memberCatchUp.start(channel({ gate: null }), () => {});
        expect(memberCatchUp.getStreamId()).toBeNull();
    });

    it('stops only for the channel it was asked to stop', () => {
        vi.spyOn(authManager, 'getAddress').mockReturnValue(MEMBER);
        memberCatchUp.start(channel(), () => {});
        memberCatchUp.stop('0xsomeone/else-1');
        expect(memberCatchUp.getStreamId()).toBe(channel().messageStreamId);
        memberCatchUp.stop(channel().messageStreamId);
        expect(memberCatchUp.getStreamId()).toBeNull();
    });

    it('feeds what it finds into the ordinary ingest', async () => {
        vi.spyOn(authManager, 'getAddress').mockReturnValue(MEMBER);
        const seen = [];
        vi.spyOn(streamrController, 'fetchHistoryAsync').mockImplementation(
            (id, partition, count, handler, password, done) => {
                handler({ id: 'm1', text: 'late', sender: OWNER, timestamp: 1 });
                done?.();
            });
        memberCatchUp.start(channel(), (m) => seen.push(m));
        await vi.advanceTimersByTimeAsync(CONFIG.subscriptions.memberCatchUpIntervalMs + 10);
        expect(seen.map(m => m.id)).toEqual(['m1']);
    });
});
