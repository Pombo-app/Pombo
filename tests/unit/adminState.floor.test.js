/**
 * The local moderation floor: a device that has applied a moderation snapshot
 * refuses an older or empty one on the next (cold) session, so a storage node
 * cannot roll moderation back by serving stale history. The floor is per
 * (account, channel), persisted locally, and only ever moves forward.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../../src/js/logger.js', () => ({
    Logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const { AdminState } = await import('../../src/js/channels/AdminState.js');

const OWNER = '0x' + 'aa'.repeat(20);
const STREAM = `${OWNER}/room-1`;

function makeManager() {
    return {
        _isValidAdminState: (m) => !!m && m.type === 'ADMIN_STATE' && typeof m.rev === 'number' && !!m.state,
        _normalizeAdminState: (s) => ({
            bannedMembers: s.bannedMembers || [],
            hiddenMessageIds: s.hiddenMessageIds || [],
            pins: s.pins || [],
        }),
        channels: new Map(),
    };
}

const msg = (rev, ts, state) => ({ type: 'ADMIN_STATE', rev, ts, createdBy: OWNER, state });
const freshChannel = () => ({ messageStreamId: STREAM, createdBy: OWNER, adminState: { bannedMembers: [], hiddenMessageIds: [], pins: [] } });

let admin;

beforeEach(() => {
    localStorage.clear();
    admin = new AdminState(makeManager());
});

describe('moderation floor: refuses a rolled-back snapshot', () => {
    it('persists the applied snapshot and refuses a lower rev on a cold session', () => {
        // Session 1: apply rev 5 (bans someone) — this persists the floor.
        const c1 = freshChannel();
        expect(admin.applyAdminState(c1, msg(5, 5000, { bannedMembers: ['0xbanned'], hiddenMessageIds: ['h1'], pins: [] }))).toBe(true);

        // Session 2 (cold): a fresh channel object seeds from the floor.
        const c2 = freshChannel();
        admin._seedFromFloor(c2);
        expect(c2.adminRev).toBe(5);
        expect(c2.adminState.bannedMembers).toContain('0xbanned'); // moderation restored, not empty

        // A hostile/stale node serves an OLDER snapshot → refused.
        expect(admin.applyAdminState(c2, msg(3, 9000, { bannedMembers: [], hiddenMessageIds: [], pins: [] }))).toBe(false);
        expect(c2.adminState.bannedMembers).toContain('0xbanned');

        // The genuine current snapshot (rev 5, identical) is a no-op, state kept.
        expect(admin.applyAdminState(c2, msg(5, 5000, { bannedMembers: ['0xbanned'], hiddenMessageIds: ['h1'], pins: [] }))).toBe(false);
        expect(c2.adminState.hiddenMessageIds).toContain('h1');
    });

    it('still moves forward: a higher rev applies and raises the floor', () => {
        const c1 = freshChannel();
        admin.applyAdminState(c1, msg(5, 5000, { bannedMembers: ['0xbanned'], hiddenMessageIds: [], pins: [] }));

        const c2 = freshChannel();
        admin._seedFromFloor(c2);
        // Owner unbanned and bumped the rev while we were away.
        expect(admin.applyAdminState(c2, msg(6, 6000, { bannedMembers: [], hiddenMessageIds: [], pins: [] }))).toBe(true);
        expect(c2.adminRev).toBe(6);
        expect(c2.adminState.bannedMembers).toHaveLength(0);

        // The new floor is 6: a later cold session refuses rev 5 again.
        const c3 = freshChannel();
        admin._seedFromFloor(c3);
        expect(c3.adminRev).toBe(6);
        expect(admin.applyAdminState(c3, msg(5, 5000, { bannedMembers: ['0xbanned'], hiddenMessageIds: [], pins: [] }))).toBe(false);
        expect(c3.adminState.bannedMembers).toHaveLength(0);
    });

    it('no floor yet: the first snapshot a device sees is taken', () => {
        const c = freshChannel();
        admin._seedFromFloor(c); // nothing persisted → no-op
        expect(c.adminRev).toBeUndefined();
        expect(admin.applyAdminState(c, msg(1, 1000, { bannedMembers: ['0xb'], hiddenMessageIds: [], pins: [] }))).toBe(true);
    });

    it('the floor is per channel', () => {
        const c1 = freshChannel();
        admin.applyAdminState(c1, msg(5, 5000, { bannedMembers: [], hiddenMessageIds: [], pins: [] }));
        const other = { messageStreamId: `${OWNER}/room-2`, createdBy: OWNER, adminState: { bannedMembers: [], hiddenMessageIds: [], pins: [] } };
        admin._seedFromFloor(other);
        expect(other.adminRev).toBeUndefined(); // different channel, no floor
    });
});
