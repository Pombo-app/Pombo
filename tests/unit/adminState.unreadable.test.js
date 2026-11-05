/**
 * The bootstrap tells whether the -3 holds a newer state this account could
 * not open: then the bans on screen may be the floor's stale copy, and the
 * banner must not take them as the viewer's standing.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../../src/js/logger.js', () => ({
    Logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const resendAdminState = vi.fn();
vi.mock('../../src/js/streamr.js', () => ({
    streamrController: { resendAdminState: (...a) => resendAdminState(...a) },
    STREAM_CONFIG: { ADMIN_HISTORY_COUNT: 10 },
    deriveAdminId: (id) => id.replace(/-1$/, '-3')
}));

const { AdminState } = await import('../../src/js/channels/AdminState.js');

const OWNER = '0x' + 'aa'.repeat(20);
const STREAM = `${OWNER}/room-1`;

let channel;
let admin;

beforeEach(() => {
    localStorage.clear();
    channel = { messageStreamId: STREAM, createdBy: OWNER, adminTs: 1_000 };
    const channels = new Map([[STREAM, channel]]);
    admin = new AdminState({ channels, handleAdminMessage: vi.fn(), _normalizeAdminState: (s) => s });
});

describe('bootstrapAdminState', () => {
    it('marks the -3 unreadable when a newer sealed state could not be opened', async () => {
        resendAdminState.mockImplementation(async (_id, { report }) => { report.newestUnreadTs = 5_000; return null; });
        await admin.bootstrapAdminState(STREAM, `${OWNER}/room-3`);
        expect(channel.adminUnreadable).toBe(true);
    });

    it('marks it readable when nothing newer was sealed away', async () => {
        resendAdminState.mockImplementation(async (_id, { report }) => { report.newestUnreadTs = 500; return null; });
        await admin.bootstrapAdminState(STREAM, `${OWNER}/room-3`);
        expect(channel.adminUnreadable).toBe(false);
    });
});
