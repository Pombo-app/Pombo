/**
 * Channel Details chips describe the CHANNEL. Two ways they used to lie: a
 * gated channel was labelled "Verified Membership" before the gate had been
 * read, naming one of the four modes as fact; and "Announcements" lit up for
 * anyone who merely could not publish, on a channel that is not read-only.
 */

import { describe, it, expect, vi } from 'vitest';

vi.mock('../../src/js/logger.js', () => ({
    Logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }
}));
vi.mock('../../src/js/identity.js', () => ({ identityManager: { getCachedENS: vi.fn(() => null) } }));
vi.mock('../../src/js/channelImageManager.js', () => ({ channelImageManager: {} }));

const { headerUI } = await import('../../src/js/ui/HeaderUI.js');

describe('the access chip', () => {
    it('says only "Gated" until the gate has been read', () => {
        const html = headerUI.getChannelTypeLabel('gated', false, true);
        expect(html).toContain('Gated');
        expect(html).not.toContain('Verified Membership');
    });

    it('keeps the plain labels of the ungated types', () => {
        expect(headerUI.getChannelTypeLabel('public', false, true)).toContain('Open');
        expect(headerUI.getChannelTypeLabel('password', false, true)).toContain('Password Protected');
        expect(headerUI.getChannelTypeLabel('dm', false, true)).toContain('Direct Message');
    });
});

describe('the announcements chip', () => {
    it('shows on a read-only channel', () => {
        expect(headerUI.getChannelTypeLabel('gated', true, true)).toContain('Announcements');
    });

    it('stays off when the channel is not read-only', () => {
        expect(headerUI.getChannelTypeLabel('gated', false, true)).not.toContain('Announcements');
    });
});

describe('the header, which has no room for labels', () => {
    it('carries the megaphone only when the channel is read-only', () => {
        expect(headerUI.getChannelTypeLabel('gated', true)).toContain('svg');
        const open = headerUI.getChannelTypeLabel('gated', false);
        const announced = headerUI.getChannelTypeLabel('gated', true);
        expect(announced.length).toBeGreaterThan(open.length);
    });
});
