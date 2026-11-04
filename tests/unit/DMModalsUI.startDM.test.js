/**
 * Start DM opens the conversation over whatever view is showing. Closing the
 * modal pops its history entry, and that pop must neither reach the router
 * nor land after the conversation is selected, or the router leaves the
 * conversation with no current channel and the composer sends nothing.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('../../src/js/auth.js', () => ({ authManager: {} }));
vi.mock('../../src/js/streamr.js', () => ({ streamrController: {} }));

const { dmModalsUI } = await import('../../src/js/ui/DMModalsUI.js');
const { modalManager } = await import('../../src/js/ui/ModalManager.js');

const PEER = '0x7ea24eb97d400a76f8d96be92c4e7fce576aedb9';
const CONVERSATION = `${PEER}/Pombo-DM-1`;

describe('Start DM', () => {
    let routed;
    const router = (e) => routed.push(e.state);

    beforeEach(() => {
        document.body.innerHTML = `
            <div id="new-dm-modal" class="hidden">
                <input id="dm-address-input">
                <button id="start-dm-btn">Start DM</button>
            </div>
        `;
        modalManager.modalStack = [];
        modalManager._subStates = [];
        modalManager._swallowNextPop = false;
        routed = [];
        window.addEventListener('popstate', router);
    });

    afterEach(() => {
        window.removeEventListener('popstate', router);
    });

    it('selects the conversation after the modal history step popped, without routing it', async () => {
        const selected = [];
        dmModalsUI.setDependencies({
            modalManager,
            dmManager: { startDM: vi.fn().mockResolvedValue({ messageStreamId: CONVERSATION }) },
            renderChannelList: vi.fn(),
            selectChannel: vi.fn(async (id) => { selected.push({ id, state: window.history.state }); })
        });

        dmModalsUI.showNewDMModal();
        expect(window.history.state).toEqual({ modal: 'new-dm-modal' });
        document.getElementById('dm-address-input').value = PEER;
        await dmModalsUI.handleStartDM();
        await new Promise(r => setTimeout(r, 50));

        expect(selected).toEqual([{ id: CONVERSATION, state: null }]);
        expect(routed).toEqual([]);
        expect(document.getElementById('new-dm-modal').classList.contains('hidden')).toBe(true);
    });
});
