/**
 * Finding the gate clone an interrupted channel creation deployed. The free
 * endpoints cap eth_getLogs ranges (dRPC: 100 blocks), so the scan goes in
 * ranges they all accept, and it stops at about an hour of blocks.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { ethers } from 'ethers';

globalThis.ethers = ethers;

const { gateManager, GATE_MODE } = await import('../../src/js/gate.js');
const { CONFIG } = await import('../../src/js/config.js');

const OWNER = '0x1111111111111111111111111111111111111111';
const iface = new ethers.Interface(['event GateCreated(address indexed gate, address indexed owner, uint8 mode)']);
const gateAt = (n) => '0x' + n.toString(16).padStart(40, '0');

const log = (blockNumber, gate, mode = GATE_MODE.NONE) => ({
    ...iface.encodeEventLog('GateCreated', [gate, OWNER, mode]),
    address: CONFIG.gate.factoryAddress, blockNumber
});

describe('gateManager.findCreatedGate', () => {
    let ranges;
    let logs;
    let latest;
    let failLogs;

    beforeEach(() => {
        ranges = [];
        logs = [];
        latest = 10_000;
        failLogs = false;
        const provider = {
            getBlockNumber: async () => latest,
            getLogs: async (filter) => {
                if (failLogs) throw new Error('rpc down');
                ranges.push([filter.fromBlock, filter.toBlock]);
                expect(filter.address).toBe(CONFIG.gate.factoryAddress);
                expect(filter.topics[2]).toBe(ethers.zeroPadValue(OWNER, 32));
                return logs.filter(l => l.blockNumber >= filter.fromBlock && l.blockNumber <= filter.toBlock);
            }
        };
        gateManager._withProvider = (op) => op(provider);
    });

    afterEach(() => {
        delete gateManager._withProvider;
    });

    it('scans in 100-block ranges from the start block and stops at the first match', async () => {
        logs = [log(1250, gateAt(7))];

        expect(await gateManager.findCreatedGate(OWNER, 1000, GATE_MODE.NONE)).toBe(gateAt(7));
        expect(ranges).toEqual([[1000, 1099], [1100, 1199], [1200, 1299]]);
    });

    it('skips gates already backing a channel and gates of another mode', async () => {
        logs = [log(1001, gateAt(1)), log(1002, gateAt(2), GATE_MODE.PAID), log(1003, gateAt(3))];

        expect(await gateManager.findCreatedGate(OWNER, 1000, GATE_MODE.NONE, [gateAt(1).toUpperCase()]))
            .toBe(gateAt(3));
    });

    it('never reads past the latest block', async () => {
        latest = 1150;

        expect(await gateManager.findCreatedGate(OWNER, 1000, GATE_MODE.NONE)).toBeNull();
        expect(ranges).toEqual([[1000, 1099], [1100, 1150]]);
    });

    it('gives up after about an hour of blocks', async () => {
        latest = 100_000;
        logs = [log(3000, gateAt(9))];

        expect(await gateManager.findCreatedGate(OWNER, 1000, GATE_MODE.NONE)).toBeNull();
        expect(ranges.at(-1)).toEqual([2800, 2800]);
        expect(ranges.every(([from, to]) => to - from < 100)).toBe(true);
    });

    it('throws when the chain cannot be read', async () => {
        failLogs = true;

        await expect(gateManager.findCreatedGate(OWNER, 1000, GATE_MODE.NONE)).rejects.toThrow('rpc down');
    });
});
