/**
 * The identifier row of Channel Details. A DM's stream id is the peer's
 * address with the inbox suffix, so the row names an address there and a
 * stream id everywhere else — and what it copies is always the full value,
 * never the abbreviation on screen.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../../src/js/logger.js', () => ({
    Logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }
}));
vi.mock('../../src/js/ui/ModalManager.js', () => ({ modalManager: { show: vi.fn(), hide: vi.fn() } }));
vi.mock('../../src/js/relayManager.js', () => ({ relayManager: {} }));
vi.mock('../../src/js/graph.js', () => ({ graphAPI: {} }));
vi.mock('../../src/js/identity.js', () => ({ identityManager: { getCachedENS: vi.fn(() => null) } }));
vi.mock('../../src/js/media.js', () => ({ mediaController: {} }));
vi.mock('../../src/js/channelImageManager.js', () => ({ channelImageManager: {} }));

const { channelSettingsUI } = await import('../../src/js/ui/ChannelSettingsUI.js');

const PEER = '0x03E2b466754F187F571AB48c69e3AB592E76D819';
const CHANNEL_ID = '0xae340e799e8151f6a4999d245e466197aa217667/9862eb7bd898f338-1';

describe('channel details identifier row', () => {
    let code;
    let label;

    beforeEach(() => {
        document.body.innerHTML = `
            <div id="channel-facts">
                <div id="channel-id-row">
                    <span id="channel-id-label">ID</span>
                    <code id="channel-settings-id"></code>
                </div>
            </div>
        `;
        code = document.getElementById('channel-settings-id');
        label = document.getElementById('channel-id-label');
        channelSettingsUI.elements = { channelSettingsId: code };
    });

    it('abbreviates the owner address of a stream id and keeps the path', () => {
        channelSettingsUI._applyIdentifierRow({ type: 'public', streamId: CHANNEL_ID });
        expect(label.textContent).toBe('ID');
        expect(code.textContent).toBe('0xae34...7667/9862eb7bd898f338-1');
        expect(code.dataset.copy).toBe(CHANNEL_ID);
    });

    it('names the peer address on a DM', () => {
        channelSettingsUI._applyIdentifierRow({
            type: 'dm', streamId: `${PEER.toLowerCase()}/Pombo-DM-1`, peerAddress: PEER
        });
        expect(label.textContent).toBe('Address');
        expect(code.textContent).toBe('0x03E2...D819');
        expect(code.dataset.copy).toBe(PEER);
        expect(code.dataset.copyLabel).toBe('Address');
    });

    it('falls back to the stream namespace when a DM carries no peer address', () => {
        channelSettingsUI._applyIdentifierRow({
            type: 'dm', streamId: `${PEER.toLowerCase()}/Pombo-DM-1`
        });
        expect(code.dataset.copy).toBe(PEER.toLowerCase());
    });

    it('drops the subscription row left by the previous channel', () => {
        const stale = document.createElement('div');
        stale.id = 'channel-settings-paid-left';
        document.getElementById('channel-facts').appendChild(stale);
        channelSettingsUI._applyIdentifierRow({ type: 'public', streamId: CHANNEL_ID });
        expect(document.getElementById('channel-settings-paid-left')).toBeNull();
    });
});
