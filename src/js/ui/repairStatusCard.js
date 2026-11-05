/**
 * The status card shared by the diagnose-and-repair panels (DM inbox,
 * Channel Health): one icon, colour and default text per state.
 */

const SEARCH = '<svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M21 21l-5.197-5.197m0 0A7.5 7.5 0 105.196 5.196a7.5 7.5 0 0010.607 10.607z"/></svg>';
const SPIN = '<svg class="w-4 h-4 animate-spin" fill="none" viewBox="0 0 24 24"><circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle><path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"></path></svg>';
const CHECK = '<svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 12.75L11.25 15 15 9.75M21 12a9 9 0 11-18 0 9 9 0 0118 0z"/></svg>';
const WARN = '<svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126zM12 15.75h.007v.008H12v-.008z"/></svg>';
const CROSS = '<svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9.75 9.75l4.5 4.5m0-4.5l-4.5 4.5M21 12a9 9 0 11-18 0 9 9 0 0118 0z"/></svg>';

export const REPAIR_STATES = {
    idle: { icon: SEARCH, iconBg: 'bg-overlay-5 text-overlay-20', border: 'border-overlay-5', title: 'Not checked', detail: 'Run a diagnosis' },
    loading: { icon: SPIN, iconBg: 'bg-overlay-5 text-overlay-40', border: 'border-overlay-5', title: 'Diagnosing...', detail: 'Checking streams, permissions and storage' },
    healthy: { icon: CHECK, iconBg: 'bg-green-500/10 text-success', border: 'border-green-500/10', title: 'Healthy', detail: 'All checks passed' },
    issues: { icon: WARN, iconBg: 'bg-yellow-500/10 text-yellow-400', border: 'border-yellow-500/10', title: 'Issues found', detail: 'Click Repair to fix' },
    error: { icon: CROSS, iconBg: 'bg-red-500/10 text-danger', border: 'border-red-500/10', title: 'Error', detail: 'Something went wrong' },
    repairing: { icon: SPIN, iconBg: 'bg-[#F6851B]/10 text-[#F6851B]', border: 'border-[#F6851B]/10', title: 'Repairing...', detail: 'This may require gas' },
    repaired: { icon: CHECK, iconBg: 'bg-green-500/10 text-success', border: 'border-green-500/10', title: 'Repaired', detail: 'All issues fixed' }
};

/**
 * @param {{card, icon, title, detail}} els
 * @param {string} state - A REPAIR_STATES key
 * @param {string} [detail] - Overrides the state's default detail
 * @param {Object} [texts] - Per-panel { state: { title, detail } } overrides
 */
export function paintRepairStatus(els, state, detail, texts = {}) {
    const s = { ...(REPAIR_STATES[state] || REPAIR_STATES.idle), ...(texts[state] || {}) };
    els.icon.innerHTML = s.icon;
    els.icon.className = `w-8 h-8 flex-shrink-0 flex items-center justify-center rounded-full ${s.iconBg}`;
    els.card.className = `p-4 rounded-xl bg-overlay-3 border ${s.border}`;
    els.title.textContent = s.title;
    els.detail.textContent = detail || s.detail;
}
