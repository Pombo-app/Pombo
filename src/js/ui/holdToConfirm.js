/**
 * Hold-to-confirm for irreversible actions: the button must be held for
 * `ms` before `onConfirm` runs; releasing early cancels.
 *
 * Expects the button to contain a label element and a progress bar that
 * starts at -translate-x-full and animates over the same duration via CSS.
 *
 * @param {HTMLElement} button
 * @param {Object} opts
 * @param {HTMLElement} [opts.label]
 * @param {HTMLElement} [opts.progress]
 * @param {() => boolean} [opts.canStart]
 * @param {() => (void|Promise<void>)} opts.onConfirm
 * @param {number} [opts.ms]
 */
export function holdToConfirm(button, { label, progress, canStart = () => true, onConfirm, ms = 2000 }) {
    const HOLDING = 'Hold (2s)';
    const idleText = label?.textContent;
    let timer = null;

    const reset = () => {
        if (timer) {
            clearTimeout(timer);
            timer = null;
        }
        progress?.classList.remove('translate-x-0');
        progress?.classList.add('-translate-x-full');
        if (label && label.textContent === HOLDING) label.textContent = idleText;
    };

    const start = () => {
        if (timer || !canStart()) return;
        progress?.classList.remove('-translate-x-full');
        progress?.classList.add('translate-x-0');
        if (label) label.textContent = HOLDING;
        timer = setTimeout(async () => {
            timer = null;
            try {
                await onConfirm();
            } finally {
                reset();
            }
        }, ms);
    };

    button.addEventListener('pointerdown', (e) => {
        if (e.button !== 0) return;
        start();
    });
    button.addEventListener('pointerup', reset);
    button.addEventListener('pointerleave', reset);
    button.addEventListener('pointercancel', reset);
    // A long press on touch would otherwise open the browser's context menu.
    button.addEventListener('contextmenu', (e) => e.preventDefault());
    button.addEventListener('keydown', (e) => {
        if ((e.key === 'Enter' || e.key === ' ') && !e.repeat) {
            e.preventDefault();
            start();
        }
    });
    button.addEventListener('keyup', (e) => {
        if (e.key === 'Enter' || e.key === ' ') reset();
    });
    button.addEventListener('blur', reset);

    return { idleText, reset };
}
