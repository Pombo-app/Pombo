/**
 * Channel Details, "Identity on the wire": the chip beside the access type
 * that says who can read authorship. It belongs to the gate, so it never
 * shows on a channel that has none, and it never guesses a mode it was not
 * told.
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

describe('identity on the wire chip', () => {
    let chips;

    const wire = () => document.getElementById('channel-settings-wire');

    beforeEach(() => {
        document.body.innerHTML = `
            <div id="channel-settings-type">
                <div class="flex flex-col gap-1.5"><span>Verified Membership</span></div>
            </div>
        `;
        chips = document.getElementById('channel-settings-type');
        channelSettingsUI.elements = { channelSettingsType: chips };
    });

    it('names the Sealed mode', () => {
        channelSettingsUI._applyWireIdentityLine({ type: 'gated', wireIdentity: 'sealed' });
        expect(wire()?.textContent).toBe('Sealed');
    });

    it('names the Visible mode', () => {
        channelSettingsUI._applyWireIdentityLine({ type: 'gated', wireIdentity: 'visible' });
        expect(wire()?.textContent).toBe('Visible');
    });

    it('adds no chip on a channel with no gate', () => {
        channelSettingsUI._applyWireIdentityLine({ type: 'public' });
        expect(wire()).toBeNull();
    });

    it('adds no chip rather than guessing when the mode is unknown', () => {
        channelSettingsUI._applyWireIdentityLine({ type: 'gated' });
        expect(wire()).toBeNull();
    });

    it('replaces the chip instead of stacking one per open', () => {
        channelSettingsUI._applyWireIdentityLine({ type: 'gated', wireIdentity: 'sealed' });
        channelSettingsUI._applyWireIdentityLine({ type: 'gated', wireIdentity: 'visible' });
        expect(chips.querySelectorAll('#channel-settings-wire').length).toBe(1);
        expect(wire()?.textContent).toBe('Visible');
    });

    it('leaves no stale chip when the next channel has no gate', () => {
        channelSettingsUI._applyWireIdentityLine({ type: 'gated', wireIdentity: 'sealed' });
        channelSettingsUI._applyWireIdentityLine({ type: 'public' });
        expect(wire()).toBeNull();
    });
});
