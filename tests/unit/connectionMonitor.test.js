import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { ConnectionMonitor } from '../../src/js/connectionMonitor.js';

describe('ConnectionMonitor', () => {
    let probe, onChange, monitor;

    beforeEach(() => {
        vi.useFakeTimers();
        probe = vi.fn(async () => false);
        onChange = vi.fn();
        monitor = new ConnectionMonitor({ probe, onChange }, { now: () => Date.now() });
    });

    afterEach(() => vi.useRealTimers());

    it('never probes while nothing is suspect', async () => {
        await vi.advanceTimersByTimeAsync(300000);
        expect(probe).not.toHaveBeenCalled();
        expect(monitor.offline).toBe(false);
    });

    it('declares offline only after 60 s of failed probes, probing every 15 s', async () => {
        monitor.setBrowserOnline(false);
        await vi.advanceTimersByTimeAsync(0);
        expect(probe).toHaveBeenCalledTimes(1);
        await vi.advanceTimersByTimeAsync(45000);
        expect(probe).toHaveBeenCalledTimes(4);
        expect(onChange).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(15000);
        expect(probe).toHaveBeenCalledTimes(5);
        expect(onChange).toHaveBeenCalledWith(true);
        expect(monitor.offline).toBe(true);
    });

    it('a dead node with a reachable storage node is not offline', async () => {
        probe.mockResolvedValue(true);
        monitor.setNodeAlive(false);
        await vi.advanceTimersByTimeAsync(300000);
        expect(onChange).not.toHaveBeenCalled();
        expect(probe.mock.calls.length).toBeGreaterThan(1);
    });

    it('a dead node with nothing to probe is not declared offline', async () => {
        probe.mockResolvedValue(null);
        monitor.setNodeAlive(false);
        await vi.advanceTimersByTimeAsync(300000);
        expect(onChange).not.toHaveBeenCalled();
    });

    it('a short drop never shows the banner', async () => {
        monitor.setBrowserOnline(false);
        await vi.advanceTimersByTimeAsync(30000);
        probe.mockResolvedValue(true);
        monitor.setBrowserOnline(true);
        await vi.advanceTimersByTimeAsync(300000);
        expect(onChange).not.toHaveBeenCalled();
    });

    it('back online exits only once a probe gets through, and probes at once', async () => {
        monitor.setBrowserOnline(false);
        await vi.advanceTimersByTimeAsync(60000);
        expect(monitor.offline).toBe(true);
        const calls = probe.mock.calls.length;
        monitor.setBrowserOnline(true);
        await vi.advanceTimersByTimeAsync(1999);
        expect(probe.mock.calls.length).toBe(calls);
        await vi.advanceTimersByTimeAsync(1);
        expect(probe.mock.calls.length).toBe(calls + 1);
        expect(monitor.offline).toBe(true);
        probe.mockResolvedValue(true);
        await vi.advanceTimersByTimeAsync(15000);
        expect(monitor.offline).toBe(false);
        expect(onChange).toHaveBeenLastCalledWith(false);
        const after = probe.mock.calls.length;
        await vi.advanceTimersByTimeAsync(300000);
        expect(probe.mock.calls.length).toBe(after);
    });

    it('the node coming up clears offline', async () => {
        monitor.setNodeAlive(false);
        await vi.advanceTimersByTimeAsync(60000);
        expect(monitor.offline).toBe(true);
        monitor.setNodeAlive(true);
        expect(monitor.offline).toBe(false);
    });

    it('a slow probe does not stretch the 15 s cadence', async () => {
        probe.mockImplementation(() => new Promise((resolve) => setTimeout(() => resolve(false), 8000)));
        monitor.setBrowserOnline(false);
        await vi.advanceTimersByTimeAsync(60000);
        expect(probe).toHaveBeenCalledTimes(5);
        expect(monitor.offline).toBe(false);
        await vi.advanceTimersByTimeAsync(8000);
        expect(monitor.offline).toBe(true);
    });

    it('a probe that gets through restarts the 60 s window', async () => {
        monitor.setNodeAlive(false);
        await vi.advanceTimersByTimeAsync(45000);
        probe.mockResolvedValueOnce(true);
        await vi.advanceTimersByTimeAsync(15000);
        await vi.advanceTimersByTimeAsync(45000);
        expect(monitor.offline).toBe(false);
        await vi.advanceTimersByTimeAsync(15000);
        expect(monitor.offline).toBe(true);
    });
});
