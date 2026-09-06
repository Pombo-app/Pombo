/**
 * Who may move a channel's moderation state.
 *
 * The snapshot carries bans, hidden messages and pins, so accepting one from
 * the wrong author hands moderation to a stranger. Stream permissions stop
 * that on the network, but history is read RAW from storage now, so the
 * client has to make the same judgement itself.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../../src/js/logger.js', () => ({
    Logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }
}));

const { AdminState } = await import('../../src/js/channels/AdminState.js');

const OWNER = '0x' + 'aa'.repeat(20);
const STRANGER = '0x' + 'cc'.repeat(20);

const snapshot = (createdBy, rev = 1) => ({
    type: 'ADMIN_STATE', rev, ts: 1000, createdBy,
    state: { bannedMembers: ['0xbanned'], hiddenMessageIds: [], pins: [] }
});

describe('applyAdminState owner gate', () => {
    let admin;
    let channel;

    beforeEach(() => {
        // The manager is only reached for the helpers this path calls.
        admin = new AdminState({
            _isValidAdminState: (m) => !!m && m.type === 'ADMIN_STATE' && typeof m.rev === 'number' && !!m.state,
            _normalizeAdminState: (s) => ({
                bannedMembers: s.bannedMembers || [],
                hiddenMessageIds: s.hiddenMessageIds || [],
                pins: s.pins || []
            }),
            channels: new Map()
        });
        channel = {
            messageStreamId: `${OWNER}/room-1`,
            adminState: { bannedMembers: [], hiddenMessageIds: [], pins: [] }
        };
        // recompose folds the moderator deltas onto the snapshot; this suite
        // is about who the snapshot may come from.
        vi.spyOn(admin, 'recompose').mockImplementation(() => {});
    });

    it('applies the owner\'s snapshot', () => {
        channel.createdBy = OWNER;
        expect(admin.applyAdminState(channel, snapshot(OWNER))).toBe(true);
    });

    it('refuses a snapshot from anyone else', () => {
        channel.createdBy = OWNER;
        expect(admin.applyAdminState(channel, snapshot(STRANGER))).toBe(false);
    });

    /**
     * A joined record can carry no createdBy at all. The check used to be
     * skipped there, which is the one case where it matters most: a channel
     * someone else owns, whose moderation state we take on trust.
     */
    it('falls back to the stream namespace when the record has no createdBy', () => {
        delete channel.createdBy;
        expect(admin.applyAdminState(channel, snapshot(STRANGER))).toBe(false);
        expect(admin.applyAdminState(channel, snapshot(OWNER))).toBe(true);
    });
});
