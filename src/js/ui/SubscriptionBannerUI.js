/**
 * SubscriptionBannerUI
 *
 * Paid-channel subscription chrome: a static strip above the messages list —
 * amber "ends in N days" inside the warning window, red "expired" with a
 * Renew CTA after the cutoff (no grace period: paidUntil is a hard stop).
 * The time-left line lives in Channel Details / Access (ChannelSettingsUI),
 * not in the chat header.
 *
 * The banner, the empty timeline and the composer all read stateOf() rather
 * than compare timestamps themselves. Status reads are cached here for
 * STATUS_TTL_MS, so update() is safe on every render, and a renewal must go
 * through noteRenewed() to drop that cache.
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
        // streamId → { paid, until (unix sec), owner, moderator, banned, at }
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

    /** @param {Object} elements - { banner, text, renewBtn, dismissBtn, clockIcon, alertIcon, gavelIcon } */
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
     * Where the viewer stands with this channel. Sync by design: the
     * empty-state renderer and the composer read it while rendering.
     *
     * The order is the gate contract's: owner above all, then the ban, then
     * the moderator role, and only then the clock.
     * @returns {'active'|'expired'|'unsubscribed'|'banned'|null}
     */
    stateOf(streamId) {
        if (this._clientBanned(streamId)) return 'banned';
        const entry = this._status.get(streamId);
        if (!entry?.paid || entry.owner) return null;
        if (entry.banned) return 'banned';
        if (entry.moderator) return null;
        if (!entry.until) return 'unsubscribed';
        return entry.until * 1000 > Date.now() ? 'active' : 'expired';
    }

    /**
     * A ban the moderators keep in ADMIN_STATE rather than on the gate. It
     * hides the author's messages for everyone, so writing here reaches
     * nobody; the reader is told the same thing either way.
     */
    _clientBanned(streamId) {
        const channel = this._resolveChannel();
        if (channel?.streamId !== streamId) return false;
        const me = this.deps.authManager?.getAddress?.()?.toLowerCase();
        const banned = channel?.adminState?.bannedMembers;
        // Entries are {address, sinceEpoch}; older snapshots carry plain strings
        return !!me && Array.isArray(banned)
            && banned.some((e) => String(e?.address ?? e).toLowerCase() === me);
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
        if (!channel) {
            this._hideAll();
            return;
        }
        if (channel.gate?.address) {
            const entry = this._status.get(channel.streamId);
            if (!entry || Date.now() - entry.at > STATUS_TTL_MS) {
                this._refresh(channel);
            }
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
                this._status.set(streamId, { paid: false, until: 0, at: Date.now() });
                return;
            }
            // One states() call answers every flag at the same block
            const rows = await gateManager.getGateMembers(channel.gate.address, [me]);
            const mine = rows.find((row) => row.address === me.toLowerCase());
            if (!mine) return; // chain unreachable — keep the last state
            this._status.set(streamId, {
                paid: true,
                until: mine.paidUntil,
                owner: mine.isOwner,
                moderator: mine.moderator,
                banned: mine.banned,
                at: Date.now()
            });
            // The empty-state renderer reads stateOf() synchronously
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

        // A client ban applies to channels with no gate, which have no entry
        const msLeft = (this._status.get(channel.streamId)?.until ?? 0) * 1000 - Date.now();
        const active = state === 'active';
        if (active) this._armExpiry(channel.streamId, msLeft);

        if (active && (msLeft >= WARNING_MS || this._dismissedWarn.has(channel.streamId))) {
            els.banner.classList.add('hidden');
            return;
        }

        els.banner.classList.toggle('subscription-banner--expired', !active);
        if (els.text) {
            els.text.textContent = {
                active: `Subscription ends in ${formatRemaining(msLeft)}`,
                expired: 'Subscription expired',
                unsubscribed: 'No active subscription',
                banned: 'A moderator removed your access to this channel'
            }[state];
        }
        const banned = state === 'banned';
        els.clockIcon?.classList.toggle('hidden', !active);
        els.alertIcon?.classList.toggle('hidden', active || banned);
        els.gavelIcon?.classList.toggle('hidden', !banned);
        // Paying again buys a banned account nothing
        els.renewBtn?.classList.toggle('hidden', banned);
        if (els.renewBtn) els.renewBtn.textContent = state === 'unsubscribed' ? 'Subscribe' : 'Renew';
        // The expired strip is the access state, not a notice — no dismissing it
        els.dismissBtn?.classList.toggle('hidden', !active);
        els.banner.classList.remove('hidden');
    }

    /** Wake up at the cutoff: a channel left open renders once. */
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
