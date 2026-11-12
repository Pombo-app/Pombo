// iOS keeps the layout viewport at full height when the keyboard opens and pans
// the page to reveal the focused field, pushing the header under the status bar.
const KEYBOARD_MIN_PX = 120;

export function isIOSWebKit() {
    return typeof CSS !== 'undefined' && typeof CSS.supports === 'function'
        && CSS.supports('-webkit-touch-callout', 'none');
}

/**
 * While the composer has focus and the on-screen keyboard is up, size the app
 * to the visual viewport (via --app-vh) and keep the page pinned to the top.
 * @returns {Function|null} disposer, or null when there is nothing to watch
 */
export function fitAppToKeyboard({ composer, messagesArea, viewport = window.visualViewport, win = window, doc = document }) {
    if (!viewport || !composer) return null;
    const root = doc.documentElement;
    let active = false;

    const update = () => {
        const fullHeight = Math.max(root.clientHeight, win.innerHeight);
        const open = composer.contains(doc.activeElement)
            && Math.abs(viewport.scale - 1) < 0.01
            && fullHeight - viewport.height > KEYBOARD_MIN_PX;
        if (!open && !active) return;

        const fromBottom = messagesArea
            ? messagesArea.scrollHeight - messagesArea.scrollTop - messagesArea.clientHeight
            : 0;
        if (open) {
            root.style.setProperty('--app-vh', `${viewport.height}px`);
            root.classList.add('ios-keyboard-open');
        } else {
            root.style.removeProperty('--app-vh');
            root.classList.remove('ios-keyboard-open');
        }
        active = open;
        if (messagesArea) {
            messagesArea.scrollTop = messagesArea.scrollHeight - messagesArea.clientHeight - fromBottom;
        }
        win.scrollTo(0, 0);
    };

    viewport.addEventListener('resize', update);
    viewport.addEventListener('scroll', update);
    doc.addEventListener('focusin', update);
    return () => {
        viewport.removeEventListener('resize', update);
        viewport.removeEventListener('scroll', update);
        doc.removeEventListener('focusin', update);
    };
}
