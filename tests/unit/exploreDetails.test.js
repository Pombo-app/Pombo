import { describe, it, expect } from 'vitest';
import { ethers } from 'ethers';

globalThis.ethers = ethers;

const { GATE_MODE } = await import('../../src/js/gate.js');
const { renderExploreDetails, channelTypeLabel } = await import('../../src/js/ui/exploreDetails.js');

const OWNER = '0x7ea24eb97d400a76f8d96be92c4e7fce576aedb9';

describe('renderExploreDetails', () => {
    const base = {
        streamId: `${OWNER}/room-1`,
        name: 'Room',
        description: 'About the room',
        type: 'public',
        createdAt: Date.UTC(2026, 8, 17, 12)
    };

    it('lists type, owner, creation date and ID, with copy for owner and ID', () => {
        const html = renderExploreDetails(base, { thumbHtml: '<img>' });

        expect(html).toContain('Open');
        expect(html).toContain('About the room');
        expect(html).toContain('0x7ea2...edb9');
        expect(html).toContain('Sep 17, 2026');
        expect(html).toContain(`${OWNER}/room-1`);
        expect(html).toContain(`data-copy="${OWNER}"`);
        expect(html).toContain(`data-copy="${OWNER}/room-1"`);
    });

    it('shows the audience and the access terms only for gated channels', () => {
        expect(renderExploreDetails(base, { thumbHtml: '' })).not.toContain('Identity on the wire');

        const html = renderExploreDetails(
            { ...base, type: 'gated', wireIdentity: 'sealed' },
            { thumbHtml: '', gateInfo: { mode: GATE_MODE.PAID, verb: 'Subscribe', value: '0.2 POL', qualifier: 'per day' } }
        );

        expect(html).toContain('Paid');
        expect(html).toContain('Subscribe 0.2 POL per day');
        expect(html).toContain('Sealed');
    });

    it('shows the message stream retention as Storage, and nothing when it is unknown', () => {
        expect(renderExploreDetails(base, { thumbHtml: '', storageDays: 30 })).toContain('30 days');
        expect(renderExploreDetails(base, { thumbHtml: '', storageDays: 1 })).toContain('1 day');
        expect(renderExploreDetails(base, { thumbHtml: '' })).not.toContain('Storage');
    });

    it('names the owner by ENS when known', () => {
        expect(renderExploreDetails(base, { thumbHtml: '', ownerName: 'bob.eth' })).toContain('bob.eth');
    });

    it('offers Report as a disabled button marked Soon', () => {
        const html = renderExploreDetails(base, { thumbHtml: '' });
        expect(html).toMatch(/<button[^>]*disabled[^>]*>[\s\S]*Report · Soon/);
    });

    it('labels a gate by its mode', () => {
        const gated = { type: 'gated' };
        expect(channelTypeLabel({ type: 'password' })).toBe('Password');
        expect(channelTypeLabel(gated, { mode: GATE_MODE.PAID })).toBe('Paid');
        expect(channelTypeLabel(gated, { mode: GATE_MODE.NONE })).toBe('Closed');
        expect(channelTypeLabel(gated, { mode: GATE_MODE.TOKEN_BALANCE })).toBe('Gated');
        expect(channelTypeLabel(gated, null)).toBe('Gated');
        expect(channelTypeLabel({ type: 'public', readOnly: true })).toBe('Open · Read-Only');
        expect(channelTypeLabel({ ...gated, readOnly: true }, { mode: GATE_MODE.PAID })).toBe('Paid · Read-Only');
    });
});
