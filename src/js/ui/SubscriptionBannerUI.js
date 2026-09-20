/**
 * SubscriptionBannerUI
 *
 * Paid-channel subscription chrome: a static strip above the messages list —
 * amber "ends in N days" inside the warning window, red "expired" with a
 * Renew CTA after the cutoff (no grace period: paidUntil is a hard stop).
 * The time-left line lives in Channel Details / Access (ChannelSettingsUI),
 * not in the chat header.
 *
 * This is where the subscription state is decided for the whole app: the
 * banner, the empty timeline and the composer all read stateOf() instead of
 * comparing timestamps themselves. Status reads are cached here for
 * STATUS_TTL_MS, so update() is safe to call on every render, and a renewal
 * must go through noteRenewed() to drop the cached state.
 */

/** Show the renew warning when less than this remains. */
export const WARNING_MS = 3 * 24 * 60 * 60 * 1000;
const STATUS_TTL_MS = 60_000;
/** Ceiling for the expiry wake-up, which re-arms until the cutoff passes. */
const EXPIRY_TIMER_CEILING_MS = 30 * 60 * 1000;

/** "12 days" / "1 day" / "5h" / "less than an hour" */
export function formatRemaining(msLeft) {
    const days = Math.floor(msLeft / 86_400_000);
    if (days >= 1) return `${days} ${days === 1 ? 'day' : 'days'}`;
    const hours = Math.floor(msLeft / 3_600_000);
    if (hours >= 1) return `${hours}h`;
    return 'less than an hour';
}

class SubscriptionBannerUI {
    constructor() {
        this.deps = {};
        this.elements = null;
        // streamId → { paid, until (unix sec), exempt, at }
        this._status = new Map();
        // streamIds whose <3-day warning was dismissed this session
        this._dismissedWarn = new Set();
        this._refreshing = new Set();
        this._expiryTimer = null;
    }

    /** @param {Object} deps - { channelManager, authManager, Logger, onRenew, onStatusResolved } */
    setDependencies(deps) {
        this.deps = { ...this.deps, ...deps };
    }

    /** @param {Object} elements - { banner, text, renewBtn, dismissBtn } */
    init(elements) {
        this.elements = elements;
        elements?.renewBtn?.addEventListener('click', () => this.renewCurrent());
        elements?.dismissBtn?.addEventListener('click', () => {
            const channel = this._resolveChannel();
            if (channel) this._dismissedWarn.add(channel.streamId);
            this._render();
        });
    }

    _resolveChannel() {
        return this.deps.channelManager?.getCurrentChannel?.() || null;
    }

    /**
     * Where the viewer stands with this channel's subscription. Sync by
     * design: the empty-state renderer and the composer read it while
     * rendering. Null while unresolved, on a channel that is not a paid gate,
     * and for an owner or moderator, who never pay.
     * @returns {'active'|'expired'|'unsubscribed'|null}
     */
    stateOf(streamId) {
        const entry = this._status.get(streamId);
        if (!entry?.paid || entry.exempt) return null;
        if (!entry.until) return 'unsubscribed';
        return entry.until * 1000 > Date.now() ? 'active' : 'expired';
    }

    /** Drop the cached status after a renewal so the next render re-reads. */
    noteRenewed(streamId) {
        this._status.delete(streamId);
        this._dismissedWarn.delete(streamId);
        this.update();
    }

    /** Re-render from cached status; kick an async refresh when stale. */
    update() {
        if (!this.elements?.banner) return;
        const channel = this._resolveChannel();
        if (!channel?.gate?.address) {
            this._hideAll();
            return;
        }
        const entry = this._status.get(channel.streamId);
        if (!entry || Date.now() - entry.at > STATUS_TTL_MS) {
            this._refresh(channel);
        }
        this._render();
    }

    async _refresh(channel) {
        const streamId = channel.streamId;
        if (this._refreshing.has(streamId)) return;
        this._refreshing.add(streamId);
        try {
            const { gateManager, GATE_MODE } = await import('../gate.js');
            const me = this.deps.authManager?.getAddress?.();
            if (!me) return;
            const info = await gateManager.getGateInfo(channel.gate.address);
            if (info.mode !== GATE_MODE.PAID) {
                this._status.set(streamId, { paid: false, until: 0, exempt: true, at: Date.now() });
                return;
            }
            // One states() call answers owner, moderator and paidUntil at the
            // same block, and refreshes the access cache a lapsed
            // subscription would otherwise leave reading true for its TTL.
            const rows = await gateManager.getGateMembers(channel.gate.address, [me]);
            const mine = rows.find((row) => row.address === me.toLowerCase());
            if (!mine) return; // chain unreachable — keep the last state
            this._status.set(streamId, {
                paid: true,
                until: mine.paidUntil,
                exempt: mine.isOwner || mine.moderator,
                at: Date.now()
            });
            // The empty-state renderer reads stateOf() synchronously — give
            // it a chance to swap "waiting for keys" for "expired" now
            this.deps.onStatusResolved?.(streamId);
        } catch (error) {
            this.deps.Logger?.debug?.('subscription status refresh failed:', error?.message);
        } finally {
            this._refreshing.delete(streamId);
            this._render();
        }
    }

    _render() {
        const els = this.elements;
        if (!els?.banner) return;
        const channel = this._resolveChannel();
        const state = channel ? this.stateOf(channel.streamId) : null;
        if (!state) {
            this._hideAll();
            return;
        }

        const msLeft = this._status.get(channel.streamId).until * 1000 - Date.now();
        const active = state === 'active';
        if (active) this._armExpiry(channel.streamId, msLeft);

        if (active && (msLeft >= WARNING_MS || this._dismissedWarn.has(channel.streamId))) {
            els.banner.classList.add('hidden');
            return;
        }

        els.banner.classList.toggle('subscription-banner--expired', !active);
        if (els.text) {
            els.text.textContent = active
                ? `Subscription ends in ${formatRemaining(msLeft)} — renewing extends from the current end`
                : state === 'expired'
                    ? 'Subscription expired — new messages stay locked until you renew'
                    : 'No active subscription. New messages stay locked until you subscribe.';
        }
        if (els.renewBtn) els.renewBtn.textContent = state === 'unsubscribed' ? 'Subscribe' : 'Renew';
        // The expired strip is the access state, not a notice — no dismissing it
        els.dismissBtn?.classList.toggle('hidden', !active);
        els.banner.classList.remove('hidden');
    }

    /**
     * Wake up when the subscription lapses. A channel left open renders once
     * and would otherwise keep showing the warning it drew before the cutoff.
     */
    _armExpiry(streamId, msLeft) {
        clearTimeout(this._expiryTimer);
        this._expiryTimer = setTimeout(() => {
            this._status.delete(streamId);
            this.update();
        }, Math.min(msLeft + 1000, EXPIRY_TIMER_CEILING_MS));
    }

    _hideAll() {
        clearTimeout(this._expiryTimer);
        this.elements?.banner?.classList.add('hidden');
    }

    /** Open the renewal flow for the channel being viewed. */
    renewCurrent() {
        const channel = this._resolveChannel();
        if (!channel?.gate?.address) return;
        this.deps.onRenew?.(channel);
    }
}

export const subscriptionBannerUI = new SubscriptionBannerUI();
