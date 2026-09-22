/**
 * A published message is read back from storage until it is there; still
 * missing at its last read it is marked undelivered, and a node that never
 * answered proves nothing either way.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../../src/js/logger.js', () => ({
    Logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }
}));

const resendMessageEnvelopes = vi.fn();
vi.mock('../../src/js/streamr.js', () => ({
    streamrController: { resendMessageEnvelopes: (...args) => resendMessageEnvelopes(...args) }
}));
const resolveStorage = vi.fn();
vi.mock('../../src/js/storageEndpoints.js', () => ({
    storageEndpoints: { resolve: (...args) => resolveStorage(...args) }
}));

const { DeliveryConfirm, UNDELIVERED_REASON } = await import('../../src/js/channels/DeliveryConfirm.js');
const { CONFIG } = await import('../../src/js/config.js');

const STREAM = '0x' + 'aa'.repeat(20) + '/room-1';
const GATE = '0x' + 'bb'.repeat(20);
const T0 = 1_000_000;

let clock;
let manager;
let channel;
let confirm;

beforeEach(() => {
    resendMessageEnvelopes.mockReset();
    resolveStorage.mockReset();
    resolveStorage.mockResolvedValue([{ nodeAddress: '0x1', urls: ['https://node.example'] }]);
    clock = T0;
    manager = { notifyHandlers: vi.fn() };
    channel = { messageStreamId: STREAM, type: 'gated' };
    confirm = new DeliveryConfirm(manager, { sleep: async (ms) => { clock += ms; }, now: () => clock });
});

const settle = () => confirm.loops.get(STREAM) || Promise.resolve();
const published = (timestamp) => ({ timestamp, publisherId: GATE });
const msg = (id) => ({ id, text: id, pending: false });

describe('DeliveryConfirm', () => {
    it('marks a message delivered once storage serves its envelope', async () => {
        const m = msg('m1');
        resendMessageEnvelopes.mockResolvedValue([{ timestamp: 5000, publisherId: GATE }]);

        confirm.track(channel, m, published(5000));
        expect(confirm.pending(STREAM)).toBe(1);
        await settle();

        expect(m.delivered).toBe(true);
        expect(m.failed).toBeUndefined();
        expect(confirm.pending(STREAM)).toBe(0);
        expect(resendMessageEnvelopes).toHaveBeenCalledTimes(1);
        expect(resendMessageEnvelopes).toHaveBeenCalledWith(STREAM, { from: 4999, to: 5001 });
        expect(manager.notifyHandlers).toHaveBeenCalledWith('message_delivered',
            expect.objectContaining({ streamId: STREAM, messageId: 'm1', message: m }));
        expect(clock).toBe(T0 + CONFIG.subscriptions.deliveryConfirmDelaysMs[0]);
    });

    it('marks a message undelivered after every read came back without it', async () => {
        const m = msg('m2');
        resendMessageEnvelopes.mockResolvedValue([]);

        confirm.track(channel, m, published(5000));
        await settle();

        const delays = CONFIG.subscriptions.deliveryConfirmDelaysMs;
        expect(resendMessageEnvelopes).toHaveBeenCalledTimes(delays.length);
        expect(m).toMatchObject({ failed: true, undelivered: true, failError: UNDELIVERED_REASON });
        expect(m.delivered).toBeUndefined();
        expect(manager.notifyHandlers).toHaveBeenCalledTimes(1);
        expect(manager.notifyHandlers).toHaveBeenCalledWith('message_failed',
            expect.objectContaining({ streamId: STREAM, messageId: 'm2', message: m, error: UNDELIVERED_REASON }));
        expect(clock).toBe(T0 + delays.reduce((a, b) => a + b, 0));
    });

    it('leaves a message as sent when storage never answered', async () => {
        const m = msg('m3');
        resendMessageEnvelopes.mockRejectedValue(new Error('503'));

        confirm.track(channel, m, published(5000));
        await settle();

        expect(resendMessageEnvelopes).toHaveBeenCalledTimes(CONFIG.subscriptions.deliveryConfirmDelaysMs.length);
        expect(m.failed).toBeUndefined();
        expect(m.delivered).toBeUndefined();
        expect(confirm.pending(STREAM)).toBe(0);
        expect(manager.notifyHandlers).not.toHaveBeenCalled();
    });

    it('judges on the one read that answered, even after failed ones', async () => {
        const m = msg('m4');
        resendMessageEnvelopes
            .mockRejectedValueOnce(new Error('503'))
            .mockRejectedValueOnce(new Error('503'))
            .mockRejectedValueOnce(new Error('503'))
            .mockResolvedValue([]);

        confirm.track(channel, m, published(5000));
        await settle();

        expect(m).toMatchObject({ failed: true, undelivered: true });
    });

    it('reads nothing for a channel without storage', async () => {
        resolveStorage.mockResolvedValue([]);
        const m = msg('m5');

        confirm.track(channel, m, published(5000));
        await settle();

        expect(resendMessageEnvelopes).not.toHaveBeenCalled();
        expect(confirm.pending(STREAM)).toBe(0);
        expect(m.failed).toBeUndefined();
        expect(manager.notifyHandlers).not.toHaveBeenCalled();
    });

    it('ignores DMs and publishes without an envelope timestamp', () => {
        confirm.track({ messageStreamId: STREAM, type: 'dm' }, msg('d1'), published(5000));
        confirm.track(channel, msg('m6'), undefined);
        confirm.track(channel, msg('m7'), { publisherId: GATE });

        expect(confirm.pending(STREAM)).toBe(0);
        expect(confirm.loops.size).toBe(0);
    });

    it('shares one read between messages in flight and judges each on its own clock', async () => {
        const a = msg('a');
        const b = msg('b');
        resendMessageEnvelopes.mockImplementation(async () =>
            (clock >= T0 + 15_000 ? [{ timestamp: 7000, publisherId: GATE }] : []));

        confirm.track(channel, a, published(5000));
        clock += 2000;
        confirm.track(channel, b, published(7000));
        await settle();

        expect(b.delivered).toBe(true);
        expect(a).toMatchObject({ failed: true, undelivered: true });
        expect(resendMessageEnvelopes.mock.calls.length).toBeLessThanOrEqual(6);
        expect(resendMessageEnvelopes.mock.calls[0][1]).toEqual({ from: 4999, to: 7001 });
    });

    it('does not take another publisher\'s envelope at the same millisecond for ours', async () => {
        const m = msg('m8');
        resendMessageEnvelopes.mockResolvedValue([{ timestamp: 5000, publisherId: '0x' + 'cc'.repeat(20) }]);

        confirm.track(channel, m, published(5000));
        await settle();

        expect(m).toMatchObject({ failed: true, undelivered: true });
    });

    it('reads the envelope time and publisher the way a StreamMessage exposes them', async () => {
        const m = msg('m9');
        resendMessageEnvelopes.mockResolvedValue([{ timestamp: 9000, publisherId: GATE }]);

        confirm.track(channel, m, { getTimestamp: () => 9000, getPublisherId: () => GATE.toUpperCase() });
        await settle();

        expect(m.delivered).toBe(true);
    });
});
