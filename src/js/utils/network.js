export const NO_NETWORK = 'No network connection';

/** True only when the browser reports no network at all; `onLine === true` proves nothing. */
export function isOffline() {
    return typeof navigator !== 'undefined' && navigator.onLine === false;
}
