/**
 * Hold-to-confirm guards irreversible actions (delete channel, delete account,
 * copy private key): releasing before the full hold must never run them.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { holdToConfirm } from '../../src/js/ui/holdToConfirm.js';

const press = (el, type, init = {}) => el.dispatchEvent(new MouseEvent(type, { button: 0, bubbles: true, ...init }));

describe('holdToConfirm', () => {
    let button, label, progress, onConfirm;

    beforeEach(() => {
        vi.useFakeTimers();
        document.body.innerHTML = `
            <button id="b"><span id="l">Hold to Delete (2s)</span><div id="p" class="-translate-x-full"></div></button>`;
        button = document.getElementById('b');
        label = document.getElementById('l');
        progress = document.getElementById('p');
        onConfirm = vi.fn();
    });

    afterEach(() => vi.useRealTimers());

    it('runs onConfirm only after the full hold', async () => {
        holdToConfirm(button, { label, progress, onConfirm });
        press(button, 'pointerdown');
        expect(label.textContent).toBe('Keep holding...');
        expect(progress.classList.contains('translate-x-0')).toBe(true);
        await vi.advanceTimersByTimeAsync(1999);
        expect(onConfirm).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(1);
        expect(onConfirm).toHaveBeenCalledTimes(1);
        expect(label.textContent).toBe('Hold to Delete (2s)');
        expect(progress.classList.contains('-translate-x-full')).toBe(true);
    });

    it.each(['pointerup', 'pointerleave', 'pointercancel'])('%s before the hold completes cancels', async (type) => {
        holdToConfirm(button, { label, progress, onConfirm });
        press(button, 'pointerdown');
        await vi.advanceTimersByTimeAsync(1500);
        press(button, type);
        await vi.advanceTimersByTimeAsync(5000);
        expect(onConfirm).not.toHaveBeenCalled();
        expect(label.textContent).toBe('Hold to Delete (2s)');
        expect(progress.classList.contains('-translate-x-full')).toBe(true);
    });

    it('a second press while holding does not restart or double-fire', async () => {
        holdToConfirm(button, { label, progress, onConfirm });
        press(button, 'pointerdown');
        await vi.advanceTimersByTimeAsync(1000);
        press(button, 'pointerdown');
        await vi.advanceTimersByTimeAsync(1000);
        expect(onConfirm).toHaveBeenCalledTimes(1);
    });

    it('ignores non-primary buttons and a refused canStart', async () => {
        holdToConfirm(button, { label, progress, onConfirm, canStart: () => false });
        press(button, 'pointerdown');
        holdToConfirm(button, { label, progress, onConfirm });
        press(button, 'pointerdown', { button: 2 });
        await vi.advanceTimersByTimeAsync(5000);
        expect(onConfirm).not.toHaveBeenCalled();
    });

    it('holds from the keyboard and cancels on keyup', async () => {
        holdToConfirm(button, { label, progress, onConfirm });
        button.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
        await vi.advanceTimersByTimeAsync(1000);
        button.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter' }));
        await vi.advanceTimersByTimeAsync(5000);
        expect(onConfirm).not.toHaveBeenCalled();
        button.dispatchEvent(new KeyboardEvent('keydown', { key: ' ' }));
        await vi.advanceTimersByTimeAsync(2000);
        expect(onConfirm).toHaveBeenCalledTimes(1);
    });
});
