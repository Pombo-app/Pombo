/**
 * SubscriptionBannerUI Tests
 * Covers: stateOf across the three member states, and what the strip says
 * and shows.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

const gateManager = {
    getGateInfo: vi.fn(),
    getGateMembers: vi.fn()
};

vi.mock('../../src/js/gate.js', () => ({
    gateManager,
    GATE_MODE: { NONE: 0, TOKEN_BALANCE: 1, NFT_OWNERSHIP: 2, PAID: 3 }
}));

const ME = '0x1111111111111111111111111111111111111111';
const OWNER = '0x2222222222222222222222222222222222222222';
const GATE = '0x3333333333333333333333333333333333333333';
const STREAM = `${OWNER}/paid-1`;
const DAY = 86_400;

const nowSec = () => Math.floor(Date.now() / 1000);

let subscriptionBannerUI;
let channel;
let elements;

const member = (overrides = {}) => ({
    address: ME, isOwner: false, moderator: false, banned: false,
    allowed: false, access: true, paidUntil: 0, ...overrides
});

const hiddenElement = (tag) => {
    const el = document.createElement(tag);
    el.classList.add('hidden');
    return el;
};

/** Resolve the status for the open channel and render from it. */
const settle = async () => {
    subscriptionBannerUI.update();
    await vi.waitFor(() => expect(gateManager.getGateInfo).toHaveBeenCalled());
    await Promise.resolve();
    await Promise.resolve();
};

beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();
    ({ subscriptionBannerUI } = await import('../../src/js/ui/SubscriptionBannerUI.js'));
    channel = { streamId: STREAM, name: 'Paid', gate: { address: GATE } };
    elements = {
        banner: hiddenElement('div'), text: hiddenElement('span'),
        renewBtn: hiddenElement('button'), dismissBtn: hiddenElement('button'),
        clockIcon: hiddenElement('svg'), alertIcon: hiddenElement('svg'),
        gavelIcon: hiddenElement('svg')
    };
    subscriptionBannerUI.init(elements);
    subscriptionBannerUI.setDependencies({
        channelManager: { getCurrentChannel: () => channel },
        authManager: { getAddress: () => ME }
    });
    gateManager.getGateInfo.mockResolvedValue({ mode: 3, owner: OWNER });
    gateManager.getGateMembers.mockResolvedValue([member()]);
});

describe('stateOf', () => {
    it('calls a member who never paid unsubscribed, not expired', async () => {
        await settle();
        expect(subscriptionBannerUI.stateOf(STREAM)).toBe('unsubscribed');
    });

    it('calls an elapsed paidUntil expired', async () => {
        gateManager.getGateMembers.mockResolvedValue([member({ paidUntil: nowSec() - 60, access: false })]);
        await settle();
        expect(subscriptionBannerUI.stateOf(STREAM)).toBe('expired');
    });

    it('calls a paidUntil in the future active', async () => {
        gateManager.getGateMembers.mockResolvedValue([member({ paidUntil: nowSec() + DAY })]);
        await settle();
        expect(subscriptionBannerUI.stateOf(STREAM)).toBe('active');
    });

    it('exempts the owner and the moderators, who never pay', async () => {
        gateManager.getGateMembers.mockResolvedValue([member({ moderator: true })]);
        await settle();
        expect(subscriptionBannerUI.stateOf(STREAM)).toBe(null);
    });

    it('calls a banned member banned, whatever they paid', async () => {
        gateManager.getGateMembers.mockResolvedValue([member({
            paidUntil: nowSec() + DAY, banned: true, access: false
        })]);
        await settle();
        expect(subscriptionBannerUI.stateOf(STREAM)).toBe('banned');
    });

    it('bans a moderator too, because the contract does', async () => {
        gateManager.getGateMembers.mockResolvedValue([member({ moderator: true, banned: true, access: false })]);
        await settle();
        expect(subscriptionBannerUI.stateOf(STREAM)).toBe('banned');
    });

    it('says nothing about a gate that is not paid', async () => {
        gateManager.getGateInfo.mockResolvedValue({ mode: 1, owner: OWNER });
        await settle();
        expect(subscriptionBannerUI.stateOf(STREAM)).toBe(null);
        expect(gateManager.getGateMembers).not.toHaveBeenCalled();
    });
});

describe('the strip', () => {
    it('offers Subscribe, not Renew, to a member who never paid', async () => {
        await settle();
        expect(elements.banner.classList.contains('hidden')).toBe(false);
        expect(elements.text.textContent).toMatch(/No active subscription/);
        expect(elements.renewBtn.textContent).toBe('Subscribe');
    });

    it('offers Renew once a subscription has lapsed', async () => {
        gateManager.getGateMembers.mockResolvedValue([member({ paidUntil: nowSec() - 60, access: false })]);
        await settle();
        expect(elements.text.textContent).toMatch(/Subscription expired/);
        expect(elements.renewBtn.textContent).toBe('Renew');
        expect(elements.dismissBtn.classList.contains('hidden')).toBe(true);
    });

    it('stays out of the way while the subscription is comfortably active', async () => {
        gateManager.getGateMembers.mockResolvedValue([member({ paidUntil: nowSec() + 30 * DAY })]);
        await settle();
        expect(elements.banner.classList.contains('hidden')).toBe(true);
    });

    it('warns, dismissibly, close to the end', async () => {
        gateManager.getGateMembers.mockResolvedValue([member({ paidUntil: nowSec() + 2 * DAY + 3600 })]);
        await settle();
        expect(elements.banner.classList.contains('hidden')).toBe(false);
        expect(elements.text.textContent).toMatch(/ends in 2 days/);
        expect(elements.dismissBtn.classList.contains('hidden')).toBe(false);
    });
});

describe('the icon', () => {
    const shown = (el) => !el.classList.contains('hidden');

    it('counts down with a clock while access still holds', async () => {
        gateManager.getGateMembers.mockResolvedValue([member({ paidUntil: nowSec() + 2 * DAY })]);
        await settle();
        expect([shown(elements.clockIcon), shown(elements.alertIcon), shown(elements.gavelIcon)])
            .toEqual([true, false, false]);
    });

    it('turns to an alert once the subscription has lapsed', async () => {
        gateManager.getGateMembers.mockResolvedValue([member({ paidUntil: nowSec() - 60, access: false })]);
        await settle();
        expect([shown(elements.clockIcon), shown(elements.alertIcon), shown(elements.gavelIcon)])
            .toEqual([false, true, false]);
    });

    it('alerts a member who never paid', async () => {
        await settle();
        expect([shown(elements.clockIcon), shown(elements.alertIcon), shown(elements.gavelIcon)])
            .toEqual([false, true, false]);
    });

    it('keeps the gavel for a removal by a moderator', async () => {
        gateManager.getGateMembers.mockResolvedValue([member({
            paidUntil: nowSec() + DAY, banned: true, access: false
        })]);
        await settle();
        expect([shown(elements.clockIcon), shown(elements.alertIcon), shown(elements.gavelIcon)])
            .toEqual([false, false, true]);
    });
});
