import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('../../src/js/logger.js', () => ({ Logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

const { NodeRevival, NODE_REPORT_TIMEOUT_MS } = await import('../../src/js/streamr/NodeRevival.js');

let network, checks, rebuilds, rebuildFails, revival;

const elapse = (ms) => vi.advanceTimersByTimeAsync(ms);

beforeEach(() => {
    vi.useFakeTimers();
    network = true;
    checks = 0;
    rebuilds = 0;
    rebuildFails = false;
    revival = new NodeRevival({
        networkUp: async () => { checks++; return network; },
        rebuild: async () => {
            rebuilds++;
            if (rebuildFails) throw new Error('no signer');
        }
    });
});

afterEach(() => vi.useRealTimers());

describe('NodeRevival', () => {
    it('rebuilds a failed start at once when the network answers', async () => {
        revival.onDead();
        await elapse(0);

        expect(checks).toBe(1);
        expect(rebuilds).toBe(1);
        expect(revival.rebuilding).toBe(true);
    });

    it('waits longer after each failed rebuild, up to the last step', async () => {
        revival.onDead();
        await elapse(0);
        for (const wait of [15000, 30000, 60000, 120000, 300000, 300000]) {
            const before = rebuilds;
            revival.onDead();
            await elapse(wait - 1);
            expect(rebuilds).toBe(before);
            await elapse(1);
            expect(rebuilds).toBe(before + 1);
        }
    });

    it('does not rebuild while the network check fails, and keeps checking on the backoff', async () => {
        network = false;
        revival.onDead();
        await elapse(0);
        expect(checks).toBe(1);

        await elapse(15000);
        expect(checks).toBe(2);
        await elapse(29999);
        expect(checks).toBe(2);
        await elapse(1);
        expect(checks).toBe(3);
        expect(rebuilds).toBe(0);

        network = true;
        revival.kick();
        await elapse(0);

        expect(rebuilds).toBe(1);
    });

    it('a kick skips what is left of the wait', async () => {
        revival.onDead();
        await elapse(0);
        revival.onDead();

        revival.kick();
        await elapse(0);

        expect(rebuilds).toBe(2);
    });

    it('never runs two rebuilds at once', async () => {
        revival.onDead();
        await elapse(0);
        revival.kick();
        revival.kick();
        revival.onDead();
        await elapse(0);

        expect(rebuilds).toBe(1);
        expect(revival.rebuilding).toBe(false);
    });

    it('a node that comes up resets the backoff and ignores kicks', async () => {
        revival.onDead();
        await elapse(0);
        revival.onDead();
        await elapse(15000);
        revival.onAlive();

        revival.kick();
        await elapse(0);
        expect(rebuilds).toBe(2);

        revival.onDead();
        await elapse(0);

        expect(rebuilds).toBe(3);
    });

    it('a node that comes up during the network check is left alone', async () => {
        let answer;
        revival = new NodeRevival({
            networkUp: () => new Promise((r) => { answer = r; }),
            rebuild: async () => { rebuilds++; }
        });
        revival.onDead();
        await elapse(0);
        revival.onAlive();
        answer(true);
        await elapse(0);

        expect(rebuilds).toBe(0);
    });

    it('a rebuild that never reports counts as failed', async () => {
        revival.onDead();
        await elapse(0);
        await elapse(NODE_REPORT_TIMEOUT_MS);

        expect(revival.rebuilding).toBe(false);
        await elapse(14999);
        expect(rebuilds).toBe(1);
        await elapse(1);
        expect(rebuilds).toBe(2);
    });

    it('a rebuild that throws counts as failed', async () => {
        rebuildFails = true;
        revival.onDead();
        await elapse(0);

        expect(revival.rebuilding).toBe(false);
        await elapse(15000);
        expect(rebuilds).toBe(2);
    });
});
