/**
 * On iOS the keyboard does not shrink the layout viewport: the composer must
 * size the app to the visual viewport while it has focus, and give it back.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { fitAppToKeyboard, isIOSWebKit } from '../../src/js/ui/iosKeyboard.js';

const FULL = 812;
const KEYBOARD_UP = 480;

describe('fitAppToKeyboard', () => {
    let root, viewport, composer, input, other, messagesArea, scrollTo, dispose;

    const setViewport = (height, scale = 1) => {
        viewport.height = height;
        viewport.scale = scale;
        viewport.dispatchEvent(new Event('resize'));
    };

    beforeEach(() => {
        document.body.innerHTML = `
            <input id="search">
            <div id="composer"><input id="message"></div>`;
        composer = document.getElementById('composer');
        input = document.getElementById('message');
        other = document.getElementById('search');
        root = document.documentElement;
        Object.defineProperty(root, 'clientHeight', { configurable: true, value: FULL });
        Object.defineProperty(window, 'innerHeight', { configurable: true, value: FULL });
        viewport = Object.assign(new EventTarget(), { height: FULL, scale: 1 });
        messagesArea = {
            scrollHeight: 2000,
            get clientHeight() { return root.style.getPropertyValue('--app-vh') ? 300 : 600; },
            scrollTop: 1400
        };
        scrollTo = vi.spyOn(window, 'scrollTo').mockImplementation(() => {});
        dispose = fitAppToKeyboard({ composer, messagesArea, viewport });
    });

    afterEach(() => {
        dispose?.();
        root.style.removeProperty('--app-vh');
        root.classList.remove('ios-keyboard-open');
        scrollTo.mockRestore();
    });

    it('sizes the app to the visual viewport while the composer has the keyboard', () => {
        input.focus();
        setViewport(KEYBOARD_UP);

        expect(root.style.getPropertyValue('--app-vh')).toBe(`${KEYBOARD_UP}px`);
        expect(root.classList.contains('ios-keyboard-open')).toBe(true);
        expect(scrollTo).toHaveBeenCalledWith(0, 0);
    });

    it('gives the layout back when the keyboard closes', () => {
        input.focus();
        setViewport(KEYBOARD_UP);
        setViewport(FULL);

        expect(root.style.getPropertyValue('--app-vh')).toBe('');
        expect(root.classList.contains('ios-keyboard-open')).toBe(false);
    });

    it('leaves other fields to the default iOS behaviour', () => {
        other.focus();
        setViewport(KEYBOARD_UP);

        expect(root.style.getPropertyValue('--app-vh')).toBe('');
        expect(scrollTo).not.toHaveBeenCalled();
    });

    it('releases the app when focus moves to another field with the keyboard up', () => {
        input.focus();
        setViewport(KEYBOARD_UP);
        other.focus();

        expect(root.style.getPropertyValue('--app-vh')).toBe('');
        expect(root.classList.contains('ios-keyboard-open')).toBe(false);
    });

    it('does not mistake a pinch zoom for the keyboard', () => {
        input.focus();
        setViewport(FULL / 2, 2);

        expect(root.style.getPropertyValue('--app-vh')).toBe('');
    });

    it('keeps the newest messages in view as the list shrinks', () => {
        input.focus();
        setViewport(KEYBOARD_UP);

        expect(messagesArea.scrollTop).toBe(2000 - 300);
    });

    it('keeps the same distance from the bottom when scrolled up', () => {
        messagesArea.scrollTop = 1200;
        input.focus();
        setViewport(KEYBOARD_UP);

        expect(messagesArea.scrollTop).toBe(2000 - 300 - 200);
    });

    it('stops listening once disposed', () => {
        dispose();
        dispose = null;
        input.focus();
        setViewport(KEYBOARD_UP);

        expect(root.style.getPropertyValue('--app-vh')).toBe('');
    });
});

describe('isIOSWebKit', () => {
    afterEach(() => vi.unstubAllGlobals());

    it('follows support for -webkit-touch-callout', () => {
        vi.stubGlobal('CSS', { supports: (prop, value) => prop === '-webkit-touch-callout' && value === 'none' });
        expect(isIOSWebKit()).toBe(true);
        vi.stubGlobal('CSS', { supports: () => false });
        expect(isIOSWebKit()).toBe(false);
    });
});
