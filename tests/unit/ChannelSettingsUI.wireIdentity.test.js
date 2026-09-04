/**
 * Channel Details, "Identity on the wire": the line under Access that says
 * who can read authorship. It belongs to the gate, so it never shows on a
 * channel that has none, and it never guesses a mode it was not told.
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

describe('identity on the wire line', () => {
    let section;
    let value;

    beforeEach(() => {
        document.body.innerHTML = `
            <div id="channel-settings-wire-section" class="hidden">
                <div id="channel-settings-wire"></div>
            </div>
        `;
        section = document.getElementById('channel-settings-wire-section');
        value = document.getElementById('channel-settings-wire');
    });

    it('names the Sealed mode', () => {
        channelSettingsUI._applyWireIdentityLine({ type: 'gated', wireIdentity: 'sealed' });
        expect(section.classList.contains('hidden')).toBe(false);
        expect(value.textContent).toBe('Sealed');
    });

    it('names the Visible mode', () => {
        channelSettingsUI._applyWireIdentityLine({ type: 'gated', wireIdentity: 'visible' });
        expect(section.classList.contains('hidden')).toBe(false);
        expect(value.textContent).toBe('Visible');
    });

    it('stays hidden on a channel with no gate', () => {
        channelSettingsUI._applyWireIdentityLine({ type: 'public' });
        expect(section.classList.contains('hidden')).toBe(true);
    });

    it('stays hidden rather than guessing when the mode is unknown', () => {
        channelSettingsUI._applyWireIdentityLine({ type: 'gated' });
        expect(section.classList.contains('hidden')).toBe(true);
        expect(value.textContent).toBe('');
    });
});
