/**
 * The admin_invalidate signal on the -2: with the snapshot aboard it is
 * applied inline; without it (the snapshot went out split on the -3) the
 * receiver reads the -3, and never takes a snapshot from anyone but the owner.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../../src/js/logger.js', () => ({ Logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock('../../src/js/streamr.js', () => ({ streamrController: {}, STREAM_CONFIG: { MESSAGE_STREAM: { MESSAGES: 0, CONTROL: 1, MODERATION: 2 } } }));
vi.mock('../../src/js/auth.js', () => ({ authManager: { isConnected: () => true, getAddress: () => '0xmember' } }));
vi.mock('../../src/js/identity.js', () => ({ identityManager: {} }));
vi.mock('../../src/js/secureStorage.js', () => ({ secureStorage: {} }));
vi.mock('../../src/js/relayManager.js', () => ({ relayManager: {} }));
vi.mock('../../src/js/dm.js', () => ({ dmManager: {} }));
vi.mock('../../src/js/media.js', () => ({ mediaController: {} }));
vi.mock('../../src/js/adminStatePoller.js', () => ({ adminStatePoller: { getStreamId: () => null, markFresh: vi.fn() } }));

const { MessageFlow } = await import('../../src/js/channels/MessageFlow.js');

const OWNER = '0xowner';
const STREAM = `${OWNER}/chan-1`;
const snapshot = { type: 'ADMIN_STATE', rev: 8, ts: 800, createdBy: OWNER, state: {} };

let flow, manager, channel;

beforeEach(() => {
    channel = { createdBy: OWNER, adminRev: 7 };
    manager = {
        channels: new Map([[STREAM, channel]]),
        _isValidAdminState: (m) => !!m && m.type === 'ADMIN_STATE' && typeof m.rev === 'number' && !!m.state,
        handleAdminMessage: vi.fn(),
        adminState: { readAfterSignal: vi.fn() }
    };
    flow = new MessageFlow(manager);
});

describe('admin_invalidate', () => {
    it('applies a snapshot that rode along', async () => {
        await flow.handleControlMessage(STREAM, { type: 'admin_invalidate', rev: 8, ts: 800, snapshot, account: OWNER });
        expect(manager.handleAdminMessage).toHaveBeenCalledWith(STREAM, snapshot);
        expect(manager.adminState.readAfterSignal).not.toHaveBeenCalled();
    });

    it('reads the -3 for a newer snapshot that did not ride along', async () => {
        await flow.handleControlMessage(STREAM, { type: 'admin_invalidate', rev: 8, ts: 800, account: OWNER });
        expect(manager.adminState.readAfterSignal).toHaveBeenCalledWith(STREAM, 8);
        expect(manager.handleAdminMessage).not.toHaveBeenCalled();
    });

    it('ignores a signal for a rev it already has', async () => {
        await flow.handleControlMessage(STREAM, { type: 'admin_invalidate', rev: 7, ts: 700, account: OWNER });
        expect(manager.adminState.readAfterSignal).not.toHaveBeenCalled();
    });

    it('ignores a signal from someone other than the owner', async () => {
        await flow.handleControlMessage(STREAM, { type: 'admin_invalidate', rev: 8, ts: 800, account: '0xstranger' });
        expect(manager.adminState.readAfterSignal).not.toHaveBeenCalled();
        await flow.handleControlMessage(STREAM, { type: 'admin_invalidate', rev: 8, ts: 800, snapshot, account: '0xstranger' });
        expect(manager.handleAdminMessage).not.toHaveBeenCalled();
    });
});
