import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../../src/js/logger.js', () => ({ Logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

const { RotationRetry, OWED_ROTATION_MESSAGE } = await import('../../src/js/channels/RotationRetry.js');

const CHANNEL = '0xowner/room-1';

let failures, rotations, owned, account, covered, waits, clock, retry;

/** Let the retry run until it parks on the clock or runs out of work. */
const settleDown = () => new Promise((r) => setTimeout(r, 0));

function newRetry() {
    return new RotationRetry({
        account: () => account,
        rotate: async () => {
            if (failures > 0) { failures--; throw new Error('no connections'); }
            rotations++;
        },
        covered: async (_id, addresses) => { covered.push(addresses); },
        stillOwned: () => owned
    }, {
        sleep: async (ms) => { waits.push(ms); if (clock) await clock.promise; }
    });
}

beforeEach(() => {
    localStorage.clear();
    failures = 0;
    rotations = 0;
    owned = true;
    account = '0xOwner';
    covered = [];
    waits = [];
    clock = null;
    retry = newRetry();
});

function parkedClock() {
    let resolve;
    const promise = new Promise((r) => { resolve = r; });
    return { promise, resolve };
}

describe('RotationRetry', () => {
    it('a rotation that goes out now covers the address and owes nothing', async () => {
        expect(await retry.rotateFor(CHANNEL, ['0xAbC'])).toBe(true);

        expect(rotations).toBe(1);
        expect(covered).toEqual([['0xabc']]);
        expect(retry.isOwed(CHANNEL)).toBe(false);
        expect(waits).toEqual([]);
    });

    it('a failed rotation stays owed and is retried on a backoff until it goes out', async () => {
        failures = 3;

        expect(await retry.rotateFor(CHANNEL, ['0xabc'])).toBe(false);
        await settleDown();

        expect(waits).toEqual([5000, 10000, 20000]);
        expect(rotations).toBe(1);
        expect(covered).toEqual([['0xabc']]);
        expect(retry.isOwed(CHANNEL)).toBe(false);
    });

    it('the backoff stays at its last step', async () => {
        failures = 7;

        await retry.rotateFor(CHANNEL, ['0xabc']);
        await settleDown();

        expect(waits).toEqual([5000, 10000, 20000, 40000, 60000, 60000, 60000]);
        expect(rotations).toBe(1);
    });

    it('a send is refused while the rotation cannot go out, and rotates first once it can', async () => {
        failures = Infinity;
        clock = parkedClock();
        expect(await retry.rotateFor(CHANNEL, ['0xabc'])).toBe(false);

        await expect(retry.settle(CHANNEL)).rejects.toThrow(OWED_ROTATION_MESSAGE);
        expect(rotations).toBe(0);

        failures = 0;
        await retry.settle(CHANNEL);

        expect(rotations).toBe(1);
        expect(covered).toEqual([['0xabc']]);
        expect(retry.isOwed(CHANNEL)).toBe(false);
    });

    it('nothing owed means a send does not rotate', async () => {
        await retry.settle(CHANNEL);

        expect(rotations).toBe(0);
    });

    it('a channel this account no longer owns stops the retry', async () => {
        failures = Infinity;
        owned = false;

        expect(await retry.rotateFor(CHANNEL, ['0xabc'])).toBe(false);
        await settleDown();

        expect(waits).toEqual([5000]);
        expect(retry.isOwed(CHANNEL)).toBe(false);
        expect(covered).toEqual([]);
    });

    it('one rotation covers every cut owed on the channel', async () => {
        failures = Infinity;
        clock = parkedClock();
        await retry.rotateFor(CHANNEL, ['0xabc']);

        failures = 0;
        expect(await retry.rotateFor(CHANNEL, ['0xdef'])).toBe(true);

        expect(rotations).toBe(1);
        expect(covered).toEqual([['0xabc', '0xdef']]);
        expect(retry.isOwed(CHANNEL)).toBe(false);
    });

    it('what one session owed the next one owes, and takes up once it connects', async () => {
        failures = Infinity;
        clock = parkedClock();
        await retry.rotateFor(CHANNEL, ['0xabc']);

        failures = 0;
        const nextSession = newRetry();
        expect(nextSession.isOwed(CHANNEL)).toBe(true);

        nextSession.resume([CHANNEL, '0xowner/other']);
        await settleDown();

        expect(rotations).toBe(1);
        expect(covered).toEqual([['0xabc']]);
        expect(nextSession.isOwed(CHANNEL)).toBe(false);
    });

    it("another account on the device owes nothing for this one's cuts", async () => {
        failures = Infinity;
        clock = parkedClock();
        await retry.rotateFor(CHANNEL, ['0xabc']);

        account = '0xSomeoneElse';

        expect(retry.isOwed(CHANNEL)).toBe(false);
        await retry.settle(CHANNEL);
        expect(rotations).toBe(0);
    });

    it('the parked retry finds nothing left once a send settled it', async () => {
        failures = Infinity;
        clock = parkedClock();
        await retry.rotateFor(CHANNEL, ['0xabc']);
        failures = 0;
        await retry.settle(CHANNEL);

        clock.resolve();
        await settleDown();

        expect(rotations).toBe(1);
        expect(covered).toHaveLength(1);
    });
});
