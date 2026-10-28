/**
 * PinnedBannerUI Tests
 * Covers: newest-pin-first ordering, the tap walk-back through older pins, and
 * closing the banner until a newer pin arrives, remembered per account.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../../src/js/ui/PreviewModeUI.js', () => ({
    previewModeUI: {
        getPreviewChannel: vi.fn(() => null)
    }
}));

vi.mock('../../src/js/ui/utils.js', () => ({
    formatAddress: vi.fn(a => (a ? a.substring(0, 8) : ''))
}));

vi.mock('../../src/js/identity.js', () => ({
    identityManager: {
        getCachedENS: vi.fn(() => null)
    }
}));

const { pinnedBannerUI } = await import('../../src/js/ui/PinnedBannerUI.js');

function makePin(targetId, text, pinnedAt) {
    return {
        targetId,
        pinnedAt,
        snapshot: { sender: '0xabcdef0123', text, senderName: 'Alice' }
    };
}

describe('PinnedBannerUI', () => {
    let elements;
    let channel;
    let account;

    beforeEach(() => {
        localStorage.clear();
        document.body.innerHTML = `
            <div id="pinned-banner" class="pinned-banner hidden">
                <div id="pinned-banner-name"></div>
                <div id="pinned-banner-text"></div>
                <span id="pinned-banner-count" class="hidden"></span>
                <button id="pinned-banner-close"></button>
            </div>
        `;
        elements = {
            banner: document.getElementById('pinned-banner'),
            name: document.getElementById('pinned-banner-name'),
            text: document.getElementById('pinned-banner-text'),
            count: document.getElementById('pinned-banner-count'),
            closeBtn: document.getElementById('pinned-banner-close')
        };

        pinnedBannerUI._hidden = {};
        pinnedBannerUI._hiddenFor = undefined;
        pinnedBannerUI._cursor = new Map();
        pinnedBannerUI._currentPin = null;
        pinnedBannerUI._currentStreamId = null;
        pinnedBannerUI.elements = elements;

        account = '0xBob';
        channel = {
            streamId: 'stream-1',
            messages: [],
            adminState: { pins: [] }
        };
        pinnedBannerUI.setDependencies({
            getActiveChannel: () => channel,
            getAccount: () => account,
            channelManager: {},
            chatAreaUI: { scrollToMessage: vi.fn() }
        });
    });

    const threePins = () => [
        makePin('m1', 'oldest', 1000),
        makePin('m2', 'middle', 2000),
        makePin('m3', 'newest', 3000)
    ];
    const hidden = () => elements.banner.classList.contains('hidden');

    it('shows the most recently pinned message', () => {
        channel.adminState.pins = threePins();

        pinnedBannerUI.update();

        expect(hidden()).toBe(false);
        expect(elements.text.textContent).toBe('newest');
    });

    it('shows the newest pin even when every pinnedAt is identical', () => {
        // Android restamps every pin's `pinnedAt` on each ADMIN_STATE
        // republish, so only array order distinguishes them.
        channel.adminState.pins = [
            makePin('m1', 'oldest', 5000),
            makePin('m2', 'newest', 5000)
        ];

        pinnedBannerUI.update();

        expect(elements.text.textContent).toBe('newest');
    });

    it('a tap jumps to the shown pin, then shows the one before it, wrapping', () => {
        channel.adminState.pins = threePins();
        const scroll = pinnedBannerUI.deps.chatAreaUI.scrollToMessage;

        pinnedBannerUI.update();
        expect(elements.count.textContent).toBe('1/3');

        pinnedBannerUI.jumpAndAdvance();
        expect(scroll).toHaveBeenLastCalledWith('m3');
        expect(elements.text.textContent).toBe('middle');
        expect(elements.count.textContent).toBe('2/3');

        pinnedBannerUI.jumpAndAdvance();
        expect(scroll).toHaveBeenLastCalledWith('m2');
        expect(elements.text.textContent).toBe('oldest');

        pinnedBannerUI.jumpAndAdvance();
        expect(scroll).toHaveBeenLastCalledWith('m1');
        expect(elements.text.textContent).toBe('newest');
        expect(hidden()).toBe(false);
    });

    it('hides the counter for a lone pin', () => {
        channel.adminState.pins = [makePin('m1', 'only', 1000)];

        pinnedBannerUI.update();

        expect(elements.count.classList.contains('hidden')).toBe(true);
    });

    it('close hides the banner whichever pin is shown', () => {
        channel.adminState.pins = threePins();
        pinnedBannerUI.update();
        pinnedBannerUI.jumpAndAdvance();

        pinnedBannerUI.dismissCurrent();

        expect(hidden()).toBe(true);
    });

    it('a closed banner comes back when a newer pin arrives', () => {
        channel.adminState.pins = threePins();
        pinnedBannerUI.update();
        pinnedBannerUI.dismissCurrent();

        channel.adminState.pins = [...threePins(), makePin('m4', 'fresh', 4000)];
        pinnedBannerUI.update();

        expect(hidden()).toBe(false);
        expect(elements.text.textContent).toBe('fresh');
    });

    it('closing is remembered on this device, per account', () => {
        channel.adminState.pins = threePins();
        pinnedBannerUI.update();
        pinnedBannerUI.dismissCurrent();

        // A fresh start reads it back.
        pinnedBannerUI._hiddenFor = undefined;
        pinnedBannerUI._hidden = {};
        pinnedBannerUI.update();
        expect(hidden()).toBe(true);

        account = '0xAlice';
        pinnedBannerUI.update();
        expect(hidden()).toBe(false);
    });

    it('a guest closes for the session only', () => {
        account = null;
        channel.adminState.pins = threePins();
        pinnedBannerUI.update();
        pinnedBannerUI.dismissCurrent();

        expect(hidden()).toBe(true);
        expect(localStorage.length).toBe(0);
    });

    it('showAndScroll reopens a closed banner on the newest pin', () => {
        channel.adminState.pins = threePins();
        pinnedBannerUI.update();
        pinnedBannerUI.jumpAndAdvance();
        pinnedBannerUI.dismissCurrent();

        pinnedBannerUI.showAndScroll();

        expect(hidden()).toBe(false);
        expect(elements.text.textContent).toBe('newest');
        expect(pinnedBannerUI.deps.chatAreaUI.scrollToMessage).toHaveBeenLastCalledWith('m3');
    });

    it('unpinning the pin it was closed on reopens it', () => {
        channel.adminState.pins = [makePin('m1', 'only', 1000)];
        pinnedBannerUI.update();
        pinnedBannerUI.dismissCurrent();
        expect(hidden()).toBe(true);

        // Unpinned, then pinned again → the banner comes back.
        channel.adminState.pins = [];
        pinnedBannerUI._reconcileDismissals(channel);
        channel.adminState.pins = [makePin('m1', 'only', 4000)];
        pinnedBannerUI.update();

        expect(hidden()).toBe(false);
        expect(elements.text.textContent).toBe('only');
    });
});
