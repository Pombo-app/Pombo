/**
 * GasEstimator Module Tests
 * Tests for gas price formatting and estimation utilities
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { GasEstimator } from '../../src/js/ui/GasEstimator.js';

describe('GasEstimator', () => {
    describe('formatPOL', () => {
        it('should format very small amounts', () => {
            expect(GasEstimator.formatPOL(1e10)).toBe('< 0.0001 POL'); // 0.00000001 POL
        });

        it('should format small amounts with 4 decimals', () => {
            const wei = 0.001 * 1e18; // 0.001 POL
            expect(GasEstimator.formatPOL(wei)).toBe('~0.0010 POL');
        });

        it('should format medium amounts with 3 decimals', () => {
            const wei = 0.5 * 1e18; // 0.5 POL
            expect(GasEstimator.formatPOL(wei)).toBe('~0.500 POL');
        });

        it('should format larger amounts with 3 decimals', () => {
            const wei = 1.5 * 1e18; // 1.5 POL
            expect(GasEstimator.formatPOL(wei)).toBe('~1.500 POL');
        });

        it('should handle zero', () => {
            expect(GasEstimator.formatPOL(0)).toBe('< 0.0001 POL');
        });
    });

    describe('formatGwei', () => {
        it('should format gwei correctly', () => {
            const wei = 30 * 1e9; // 30 gwei
            expect(GasEstimator.formatGwei(wei)).toBe('30.0 gwei');
        });

        it('should format decimal gwei', () => {
            const wei = 25.5 * 1e9; // 25.5 gwei
            expect(GasEstimator.formatGwei(wei)).toBe('25.5 gwei');
        });

        it('should format low gwei', () => {
            const wei = 1 * 1e9; // 1 gwei
            expect(GasEstimator.formatGwei(wei)).toBe('1.0 gwei');
        });
    });

    describe('formatBalancePOL', () => {
        it('should return "Error" for null', () => {
            expect(GasEstimator.formatBalancePOL(null)).toBe('Error');
        });

        it('should return "Error" for undefined', () => {
            expect(GasEstimator.formatBalancePOL(undefined)).toBe('Error');
        });

        it('should format zero balance', () => {
            expect(GasEstimator.formatBalancePOL(0)).toBe('0 POL');
        });

        it('should format very small balance', () => {
            const wei = 0.00001 * 1e18;
            expect(GasEstimator.formatBalancePOL(wei)).toBe('< 0.0001 POL');
        });

        it('should format small balance with 4 decimals', () => {
            const wei = 0.1234 * 1e18;
            expect(GasEstimator.formatBalancePOL(wei)).toBe('0.1234 POL');
        });

        it('should format medium balance with 3 decimals', () => {
            const wei = 5.678 * 1e18;
            expect(GasEstimator.formatBalancePOL(wei)).toBe('5.678 POL');
        });

        it('should format large balance with 2 decimals', () => {
            const wei = 150.5 * 1e18;
            expect(GasEstimator.formatBalancePOL(wei)).toBe('150.50 POL');
        });
    });

    describe('GAS_UNITS constants', () => {
        it('should have createStream gas estimate', () => {
            expect(GasEstimator.GAS_UNITS.createStream).toBe(420000);
        });

        it('should have setPublicPermissions gas estimate', () => {
            expect(GasEstimator.GAS_UNITS.setPublicPermissions).toBe(80000);
        });

        it('should have setPermissionsBatch gas estimate', () => {
            expect(GasEstimator.GAS_UNITS.setPermissionsBatch).toBe(210000);
        });

        it('should have addStorageNode gas estimate', () => {
            expect(GasEstimator.GAS_UNITS.addStorageNode).toBe(165000);
        });

        it('should have setStorageDayCount gas estimate', () => {
            expect(GasEstimator.GAS_UNITS.setStorageDayCount).toBe(50000);
        });
    });

    describe('RPC_URLS configuration', () => {
        it('should have multiple RPC endpoints', () => {
            expect(GasEstimator.RPC_URLS.length).toBeGreaterThan(1);
        });

        it('should have polygon/matic RPC URLs', () => {
            GasEstimator.RPC_URLS.forEach(url => {
                // URLs can contain 'polygon' or 'matic' (both refer to Polygon network)
                const isPolygonUrl = url.includes('polygon') || url.includes('matic');
                expect(isPolygonUrl).toBe(true);
            });
        });
    });

    describe('CACHE_DURATION', () => {
        it('should cache for 1 minute', () => {
            expect(GasEstimator.CACHE_DURATION).toBe(60000);
        });
    });

    describe('getGasPrice (with mocked fetch)', () => {
        beforeEach(() => {
            // Reset cache before each test
            GasEstimator.cachedGasPrice = null;
            GasEstimator.cacheTime = 0;
            GasEstimator.currentRpcIndex = 0;
        });

        it('should return cached value if still valid', async () => {
            const cachedPrice = 30 * 1e9;
            GasEstimator.cachedGasPrice = cachedPrice;
            GasEstimator.cacheTime = Date.now();
            
            const price = await GasEstimator.getGasPrice();
            expect(price).toBe(cachedPrice);
        });

        it('should return fallback if cache expired and RPC fails', async () => {
            // Set expired cache
            GasEstimator.cachedGasPrice = 20 * 1e9;
            GasEstimator.cacheTime = Date.now() - 120000; // 2 minutes ago
            
            // Mock fetch to fail
            const originalFetch = globalThis.fetch;
            globalThis.fetch = vi.fn().mockRejectedValue(new Error('Network error'));
            
            const price = await GasEstimator.getGasPrice();
            
            // Should return fallback 120 gwei (CONFIG.network.fallbackGasPriceGwei)
            expect(price).toBe(120 * 1e9);
            
            globalThis.fetch = originalFetch;
        });
    });

    describe('estimateCosts', () => {
        beforeEach(() => {
            // Set a known cached gas price
            GasEstimator.cachedGasPrice = 30 * 1e9; // 30 gwei
            GasEstimator.cacheTime = Date.now();
        });

        it('should calculate public channel cost', async () => {
            const costs = await GasEstimator.estimateCosts();
            
            // Public = four streams (-1, -2, -3, -5), permissions on all
            // four, storage on the three that keep history.
            const expectedGas = 4 * 420000 + 4 * 80000 + 3 * 165000 + 3 * 50000;
            const expectedCost = 30 * 1e9 * expectedGas;
            
            expect(costs.public).toBe(expectedCost);
        });

        it('should calculate gated channel cost', async () => {
            const costs = await GasEstimator.estimateCosts();
            
            // Gated: the gate contract, five streams, permissions on
            // all five, and storage on the four that keep history.
            const expectedGas = 220000
                + 5 * 420000 + 5 * 210000 + 4 * 165000 + 4 * 50000;
            const expectedCost = 30 * 1e9 * expectedGas;
            
            expect(costs.gated).toBe(expectedCost);
        });

        it('should have password cost equal to public cost', async () => {
            const costs = await GasEstimator.estimateCosts();
            expect(costs.password).toBe(costs.public);
        });

        it('should calculate dmInbox cost (2 streams + 1 storage node + 1 storage day count)', async () => {
            const costs = await GasEstimator.estimateCosts();

            // DM inbox = 2× createStream + 2× setPublicPermissions
            //          + 1× addStorageNode + 1× setStorageDayCount
            const expectedGas = 2 * 420000 + 2 * 80000 + 165000 + 50000;
            const expectedCost = 30 * 1e9 * expectedGas;

            expect(costs.dmInbox).toBe(expectedCost);
        });

        it('should return formatted values', async () => {
            const costs = await GasEstimator.estimateCosts();
            
            expect(costs.formatted.public).toContain('POL');
            expect(costs.formatted.password).toContain('POL');
            expect(costs.formatted.gated).toContain('POL');
            expect(costs.formatted.dmInbox).toContain('POL');
            expect(costs.formatted.gasPrice).toContain('gwei');
        });

        it('should return current gas price', async () => {
            const costs = await GasEstimator.estimateCosts();
            expect(costs.gasPrice).toBe(30 * 1e9);
        });
    });

    describe('rpcCall', () => {
        let originalFetch;
        
        beforeEach(() => {
            originalFetch = globalThis.fetch;
            GasEstimator.currentRpcIndex = 0;
        });
        
        afterEach(() => {
            globalThis.fetch = originalFetch;
        });

        it('should return result on successful RPC call', async () => {
            globalThis.fetch = vi.fn().mockResolvedValue({
                ok: true,
                json: () => Promise.resolve({ jsonrpc: '2.0', result: '0x1234', id: 1 })
            });
            
            const result = await GasEstimator.rpcCall('eth_gasPrice');
            expect(result.result).toBe('0x1234');
        });

        it('should try next RPC on failure', async () => {
            let callCount = 0;
            globalThis.fetch = vi.fn().mockImplementation(() => {
                callCount++;
                if (callCount === 1) {
                    return Promise.reject(new Error('First RPC failed'));
                }
                return Promise.resolve({
                    ok: true,
                    json: () => Promise.resolve({ jsonrpc: '2.0', result: '0xabc', id: 1 })
                });
            });
            
            const result = await GasEstimator.rpcCall('eth_gasPrice');
            expect(result.result).toBe('0xabc');
            expect(callCount).toBe(2);
        });

        it('should throw when all RPCs fail', async () => {
            globalThis.fetch = vi.fn().mockRejectedValue(new Error('All failed'));
            
            await expect(GasEstimator.rpcCall('eth_gasPrice'))
                .rejects.toThrow('All failed');
        });

        it('should handle RPC error response', async () => {
            globalThis.fetch = vi.fn().mockResolvedValue({
                ok: true,
                json: () => Promise.resolve({ jsonrpc: '2.0', error: { message: 'RPC error' }, id: 1 })
            });
            
            await expect(GasEstimator.rpcCall('eth_gasPrice'))
                .rejects.toThrow();
        });

        it('should handle HTTP errors', async () => {
            globalThis.fetch = vi.fn().mockResolvedValue({
                ok: false,
                status: 500
            });
            
            await expect(GasEstimator.rpcCall('eth_gasPrice'))
                .rejects.toThrow();
        });

        it('should update currentRpcIndex on success', async () => {
            GasEstimator.currentRpcIndex = 0;
            
            // First RPC fails, second succeeds
            let callCount = 0;
            globalThis.fetch = vi.fn().mockImplementation(() => {
                callCount++;
                if (callCount === 1) {
                    return Promise.reject(new Error('First failed'));
                }
                return Promise.resolve({
                    ok: true,
                    json: () => Promise.resolve({ jsonrpc: '2.0', result: '0x1', id: 1 })
                });
            });
            
            await GasEstimator.rpcCall('eth_gasPrice');
            expect(GasEstimator.currentRpcIndex).toBe(1);
        });
    });

    describe('getBalance', () => {
        let originalFetch;
        
        beforeEach(() => {
            originalFetch = globalThis.fetch;
            GasEstimator.currentRpcIndex = 0;
        });
        
        afterEach(() => {
            globalThis.fetch = originalFetch;
        });

        it('should return balance in wei', async () => {
            const balanceHex = '0xDE0B6B3A7640000'; // 1 ETH/POL in wei
            globalThis.fetch = vi.fn().mockResolvedValue({
                ok: true,
                json: () => Promise.resolve({ jsonrpc: '2.0', result: balanceHex, id: 1 })
            });
            
            const balance = await GasEstimator.getBalance('0x1234');
            expect(balance).toBe(1e18);
        });

        it('should return null on error', async () => {
            globalThis.fetch = vi.fn().mockRejectedValue(new Error('Network error'));
            
            const balance = await GasEstimator.getBalance('0x1234');
            expect(balance).toBeNull();
        });

        it('should call RPC with correct params', async () => {
            globalThis.fetch = vi.fn().mockResolvedValue({
                ok: true,
                json: () => Promise.resolve({ jsonrpc: '2.0', result: '0x0', id: 1 })
            });
            
            await GasEstimator.getBalance('0xTestAddress');
            
            expect(globalThis.fetch).toHaveBeenCalled();
            const callArgs = JSON.parse(globalThis.fetch.mock.calls[0][1].body);
            expect(callArgs.method).toBe('eth_getBalance');
            expect(callArgs.params).toContain('0xTestAddress');
            expect(callArgs.params).toContain('latest');
        });
    });

    describe('getGasPrice (RPC success)', () => {
        let originalFetch;
        
        beforeEach(() => {
            originalFetch = globalThis.fetch;
            GasEstimator.cachedGasPrice = null;
            GasEstimator.cacheTime = 0;
            GasEstimator.currentRpcIndex = 0;
        });
        
        afterEach(() => {
            globalThis.fetch = originalFetch;
        });

        it('should fetch and cache gas price', async () => {
            const gasPriceHex = '0x6FC23AC00'; // 30 gwei
            globalThis.fetch = vi.fn().mockResolvedValue({
                ok: true,
                json: () => Promise.resolve({ jsonrpc: '2.0', result: gasPriceHex, id: 1 })
            });
            
            const price = await GasEstimator.getGasPrice();
            
            expect(price).toBe(30 * 1e9);
            expect(GasEstimator.cachedGasPrice).toBe(30 * 1e9);
        });

        it('should use cached value within duration', async () => {
            GasEstimator.cachedGasPrice = 25 * 1e9;
            GasEstimator.cacheTime = Date.now() - 30000; // 30s ago, within 60s cache
            
            globalThis.fetch = vi.fn();
            
            const price = await GasEstimator.getGasPrice();
            
            expect(price).toBe(25 * 1e9);
            expect(globalThis.fetch).not.toHaveBeenCalled();
        });

        it('should refetch after cache expires', async () => {
            GasEstimator.cachedGasPrice = 25 * 1e9;
            GasEstimator.cacheTime = Date.now() - 70000; // 70s ago, expired
            
            const newPriceHex = '0x9502F9000'; // 40 gwei
            globalThis.fetch = vi.fn().mockResolvedValue({
                ok: true,
                json: () => Promise.resolve({ jsonrpc: '2.0', result: newPriceHex, id: 1 })
            });
            
            const price = await GasEstimator.getGasPrice();
            
            expect(price).toBe(40 * 1e9);
            expect(globalThis.fetch).toHaveBeenCalled();
        });
    });
});
