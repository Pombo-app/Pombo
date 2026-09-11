/**
 * The app's own confirmation dialog: a title, a sentence or two, Cancel and
 * one decisive button. The web twin of the Android confirm dialogs, used
 * where the browser's `confirm()` used to be.
 */

/**
 * @param {Object} options
 * @param {string} options.title
 * @param {string} options.message
 * @param {string} [options.detail] - A quieter second line, when there is one.
 * @param {string} [options.confirmLabel='Confirm']
 * @returns {Promise<boolean>} true when the decisive button was pressed
 */
export function confirmDialog({ title, message, detail = '', confirmLabel = 'Confirm' }) {
    const modal = document.getElementById('confirm-dialog-modal');
    if (!modal) {
        return Promise.resolve(window.confirm(`${title}\n\n${message}${detail ? `\n${detail}` : ''}`));
    }
    const ok = modal.querySelector('#confirm-dialog-ok');
    const cancel = modal.querySelector('#confirm-dialog-cancel');
    const detailEl = modal.querySelector('#confirm-dialog-detail');
    modal.querySelector('#confirm-dialog-title').textContent = title;
    modal.querySelector('#confirm-dialog-message').textContent = message;
    detailEl.textContent = detail;
    detailEl.classList.toggle('hidden', !detail);
    ok.textContent = confirmLabel;

    return new Promise((resolve) => {
        const settle = (value) => {
            modal.classList.add('hidden');
            ok.removeEventListener('click', onOk);
            cancel.removeEventListener('click', onCancel);
            modal.removeEventListener('click', onBackdrop);
            document.removeEventListener('keydown', onKey);
            resolve(value);
        };
        const onOk = () => settle(true);
        const onCancel = () => settle(false);
        const onBackdrop = (e) => { if (e.target === modal) settle(false); };
        const onKey = (e) => { if (e.key === 'Escape') settle(false); };
        ok.addEventListener('click', onOk);
        cancel.addEventListener('click', onCancel);
        modal.addEventListener('click', onBackdrop);
        document.addEventListener('keydown', onKey);
        modal.classList.remove('hidden');
        ok.focus();
    });
}
