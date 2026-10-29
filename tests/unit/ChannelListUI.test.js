import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/js/logger.js', () => ({
    Logger: {
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn()
    }
}));

import { channelListUI } from '../../src/js/ui/ChannelListUI.js';

describe('ChannelListUI', () => {
    let channelList;
    let channelManager;
    let secureStorage;
    let onChannelSelect;

    function createChannel(overrides = {}) {
        return {
            streamId: 'stream-1',
            name: 'General',
            type: 'channel',
            classification: 'community',
            messages: [],
            ...overrides
        };
    }

    beforeEach(() => {
        document.body.innerHTML = '<div id="channel-list"></div>';
        channelList = document.getElementById('channel-list');

        channelManager = {
            getAllChannels: vi.fn(),
            getCurrentChannel: vi.fn(() => null)
        };

        secureStorage = {
            getChannelOrder: vi.fn(() => []),
            getChannelLastAccess: vi.fn(() => 0),
            setChannelOrder: vi.fn()
        };

        onChannelSelect = vi.fn();

        channelListUI.elements = {};
        channelListUI.currentFilter = 'all';
        channelListUI.clickListenersAttached = false;
        channelListUI.dragAndDropBound = false;
        channelListUI.draggedItem = null;
        channelListUI.draggedStreamId = null;
        channelListUI.setElements({ channelList });
        channelListUI.setDependencies({ channelManager, secureStorage, onChannelSelect });
    });

    it('reuses existing DOM rows when the rendered list is unchanged', () => {
        const channels = [
            createChannel({ streamId: 'alpha', name: 'Alpha' }),
            createChannel({ streamId: 'beta', name: 'Beta', type: 'dm' })
        ];

        channelManager.getAllChannels.mockReturnValue(channels);
        channelManager.getCurrentChannel.mockReturnValue({ streamId: 'alpha' });

        channelListUI.render();

        const alphaRow = channelList.querySelector('[data-stream-id="alpha"]');
        const betaRow = channelList.querySelector('[data-stream-id="beta"]');

        channelManager.getAllChannels.mockReturnValue(channels.map(channel => ({
            ...channel,
            messages: [...channel.messages]
        })));
        channelManager.getCurrentChannel.mockReturnValue({ streamId: 'alpha' });

        channelListUI.render();

        expect(channelList.querySelector('[data-stream-id="alpha"]')).toBe(alphaRow);
        expect(channelList.querySelector('[data-stream-id="beta"]')).toBe(betaRow);
    });

    it('replaces only the row whose rendered state changed', () => {
        const initialChannels = [
            createChannel({ streamId: 'alpha', name: 'Alpha' }),
            createChannel({ streamId: 'beta', name: 'Beta' })
        ];

        channelManager.getAllChannels.mockReturnValue(initialChannels);
        channelListUI.render();

        const alphaRow = channelList.querySelector('[data-stream-id="alpha"]');
        const betaRow = channelList.querySelector('[data-stream-id="beta"]');

        channelManager.getAllChannels.mockReturnValue([
            createChannel({
                streamId: 'alpha',
                name: 'Alpha',
                messages: [{ id: 'm1', timestamp: 10, type: 'message' }]
            }),
            createChannel({ streamId: 'beta', name: 'Beta' })
        ]);

        channelListUI.render();

        expect(channelList.querySelector('[data-stream-id="alpha"]')).not.toBe(alphaRow);
        expect(channelList.querySelector('[data-stream-id="beta"]')).toBe(betaRow);
        expect(channelList.querySelector('[data-channel-count="alpha"]').textContent).toBe('1');
    });

    it('does not duplicate click handlers across repeated renders', () => {
        const channels = [
            createChannel({ streamId: 'alpha', name: 'Alpha' }),
            createChannel({ streamId: 'beta', name: 'Beta' })
        ];

        channelManager.getAllChannels.mockReturnValue(channels);

        channelListUI.render();
        channelListUI.render();

        channelList.querySelector('[data-stream-id="beta"]').click();

        expect(onChannelSelect).toHaveBeenCalledTimes(1);
        expect(onChannelSelect).toHaveBeenCalledWith('beta');
    });

    it('renders semantic spacing hooks instead of hardcoded padding utilities', () => {
        channelManager.getAllChannels.mockReturnValue([
            createChannel({
                streamId: 'alpha',
                name: 'Alpha',
                readOnly: true,
                messages: [{ id: 'm1', timestamp: 10, type: 'message' }]
            })
        ]);

        channelListUI.render();

        const row = channelList.querySelector('[data-stream-id="alpha"]');
        const main = row.querySelector('.channel-item-main');
        const readOnlyIcon = row.querySelector('.channel-item-readonly-icon');
        const actions = row.querySelector('.channel-item-actions');
        const counter = row.querySelector('.channel-msg-count');

        expect(row.className).not.toContain('px-3');
        expect(row.className).not.toContain('py-2');
        expect(main.className).not.toContain('ml-3');
        expect(readOnlyIcon.className).not.toContain('ml-3');
        expect(readOnlyIcon.className).not.toContain('gap-1');
        expect(actions.className).not.toContain('ml-2');
        expect(actions.className).not.toContain('gap-1.5');
        expect(counter.className).not.toContain('px-1.5');
        expect(counter.className).not.toContain('py-0.5');
    });

    it('renders only the read-only megaphone in the sidebar and no other type icons', () => {
        channelManager.getAllChannels.mockReturnValue([
            createChannel({ streamId: 'alpha', name: 'Alpha', type: 'password', readOnly: true }),
            createChannel({ streamId: 'beta', name: 'Beta', type: 'public', readOnly: false })
        ]);

        channelListUI.render();

        const alphaIcon = channelList.querySelector('[data-stream-id="alpha"] .channel-item-readonly-icon');
        const betaIcon = channelList.querySelector('[data-stream-id="beta"] .channel-item-readonly-icon');

        expect(alphaIcon).not.toBeNull();
        expect(alphaIcon.querySelector('svg')).not.toBeNull();
        expect(betaIcon).toBeNull();
        expect(channelList.querySelector('.channel-item-type-icons')).toBeNull();
    });

    it('keeps channel avatar images draggable while suppressing native context menus', () => {
        const cachedImageSpy = vi.spyOn(channelListUI, '_getCachedImageDataUrl').mockReturnValue('data:image/png;base64,abc');

        channelManager.getAllChannels.mockReturnValue([
            createChannel({
                streamId: 'alpha',
                name: 'Alpha',
                adminStreamId: 'admin-alpha'
            })
        ]);

        channelListUI.render();

        const image = channelList.querySelector('[data-stream-id="alpha"] .channel-item-image');
        const event = new MouseEvent('contextmenu', { bubbles: true, cancelable: true });

        expect(image.getAttribute('draggable')).toBe('true');
        expect(image.dispatchEvent(event)).toBe(false);
        expect(event.defaultPrevented).toBe(true);

        cachedImageSpy.mockRestore();
    });

    describe('empty list', () => {
        it('offers Explore when there are no channels at all', () => {
            const openExploreView = vi.fn();
            channelListUI.setDependencies({ channelManager, secureStorage, onChannelSelect, openExploreView });
            channelManager.getAllChannels.mockReturnValue([]);

            channelListUI.render();

            const button = [...channelList.querySelectorAll('button')].find((b) => b.textContent === 'Explore channels');
            expect(channelList.textContent).toContain('No channels yet');
            button.click();
            expect(openExploreView).toHaveBeenCalledTimes(1);
        });

        it('a filtered tab with nothing in it only says so', () => {
            channelListUI.setDependencies({ channelManager, secureStorage, onChannelSelect, openExploreView: vi.fn() });
            channelManager.getAllChannels.mockReturnValue([]);
            channelListUI.currentFilter = 'personal';

            channelListUI.render();

            expect(channelList.querySelector('button')).toBeNull();
            channelListUI.currentFilter = 'all';
        });
    });

    describe('interrupted creations', () => {
        const interrupted = { basePath: '0xme/abcd', name: '<b>Group</b>', type: 'gated' };
        let onFinishPendingCreate;
        let onDiscardPendingCreate;

        beforeEach(() => {
            onFinishPendingCreate = vi.fn().mockResolvedValue(undefined);
            onDiscardPendingCreate = vi.fn().mockResolvedValue(undefined);
            channelManager.getInterruptedCreates = vi.fn(() => [interrupted]);
            channelListUI.setDependencies({
                channelManager, secureStorage, onChannelSelect, onFinishPendingCreate, onDiscardPendingCreate
            });
        });

        it('shows one row above the channels, the name as text, and keeps it through re-renders', () => {
            channelManager.getAllChannels.mockReturnValue([createChannel({ streamId: 'alpha' })]);

            channelListUI.render();
            channelListUI.render();

            const rows = channelList.querySelectorAll('.pending-create');
            expect(rows).toHaveLength(1);
            expect(channelList.firstElementChild.classList.contains('pending-creates')).toBe(true);
            expect(rows[0].querySelector('b')).toBeNull();
            expect(rows[0].textContent).toContain('Group');
            expect(rows[0].textContent).toContain('creation interrupted');
        });

        it('shows next to the empty state too', () => {
            channelManager.getAllChannels.mockReturnValue([]);

            channelListUI.render();

            expect(channelList.querySelectorAll('.pending-create')).toHaveLength(1);
            expect(channelList.textContent).toContain('No channels yet');
        });

        it('Finish and Discard hand over the creation and never select a channel', async () => {
            channelManager.getAllChannels.mockReturnValue([]);
            channelListUI.render();

            channelList.querySelector('[data-pending-action="finish"]').click();
            await vi.waitFor(() => expect(onFinishPendingCreate).toHaveBeenCalledWith('0xme/abcd'));
            channelList.querySelector('[data-pending-action="discard"]').click();
            await vi.waitFor(() => expect(onDiscardPendingCreate).toHaveBeenCalledWith('0xme/abcd'));
            expect(onChannelSelect).not.toHaveBeenCalled();
        });

        it('disables both buttons while the action runs', () => {
            onFinishPendingCreate.mockReturnValue(new Promise(() => {}));
            channelManager.getAllChannels.mockReturnValue([]);
            channelListUI.render();

            channelList.querySelector('[data-pending-action="finish"]').click();

            const buttons = [...channelList.querySelectorAll('.pending-create button')];
            expect(buttons.every(button => button.disabled)).toBe(true);
        });
    });
});