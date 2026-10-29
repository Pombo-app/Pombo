/**
 * On touch, the message menu opens on a 500 ms long press at the finger, and
 * only then: a short tap, a scroll or a press on an inner control must not.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const touch = (el, type, x = 50, y = 60) => {
    const e = new Event(type, { bubbles: true, cancelable: true });
    const list = type === 'touchend' || type === 'touchcancel' ? [] : [{ clientX: x, clientY: y }];
    Object.defineProperty(e, 'touches', { value: list });
    Object.defineProperty(e, 'changedTouches', { value: [{ clientX: x, clientY: y }] });
    el.dispatchEvent(e);
    return e;
};

describe('message menu long press', () => {
    let menu, bubble, trigger, open;

    beforeEach(async () => {
        vi.useFakeTimers();
        vi.resetModules();
        document.body.innerHTML = `
            <div id="messages-area">
                <div class="message-entry" data-sender="0xabc" data-msg-id="m1">
                    <div class="message-bubble"><span id="t">hi</span><span class="reply-trigger" id="r"></span></div>
                </div>
            </div>
            <div id="message-context-menu" class="hidden"></div>`;
        ({ messageContextMenuUI: menu } = await import('../../src/js/ui/MessageContextMenuUI.js'));
        menu.setElements({ messagesArea: document.getElementById('messages-area') });
        menu.init();
        open = vi.spyOn(menu, '_openMenuForMessage').mockImplementation(() => {});
        bubble = document.getElementById('t');
        trigger = document.getElementById('r');
    });

    afterEach(() => vi.useRealTimers());

    it('opens at the touch point after 500 ms', () => {
        touch(bubble, 'touchstart', 40, 70);
        vi.advanceTimersByTime(499);
        expect(open).not.toHaveBeenCalled();
        vi.advanceTimersByTime(1);
        expect(open).toHaveBeenCalledTimes(1);
        expect(open.mock.calls[0].slice(1)).toEqual([40, 70]);
        expect(touch(bubble, 'touchend').defaultPrevented).toBe(true);
    });

    it('a short tap does not open it', () => {
        touch(bubble, 'touchstart');
        vi.advanceTimersByTime(300);
        expect(touch(bubble, 'touchend').defaultPrevented).toBe(false);
        vi.advanceTimersByTime(1000);
        expect(open).not.toHaveBeenCalled();
    });

    it('moving the finger (a scroll) cancels it', () => {
        touch(bubble, 'touchstart', 50, 60);
        touch(bubble, 'touchmove', 50, 75);
        vi.advanceTimersByTime(1000);
        expect(open).not.toHaveBeenCalled();
    });

    it('a press on an inner control does not open it', () => {
        touch(trigger, 'touchstart');
        vi.advanceTimersByTime(1000);
        expect(open).not.toHaveBeenCalled();
    });
});
