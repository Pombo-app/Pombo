/**
 * Configuration Module Tests
 * Tests for centralized application configuration
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
    CONFIG,
    getRpcEndpoints,
    getNetworkParams,
    loadRpcSelection,
    saveRpcSelection,
    rpcSelectionUrls,
    RPC_ENDPOINTS,
    RPC_CUSTOM_KEY,
    RPC_DEFAULT_ENABLED
} from '../../src/js/config.js';

describe('config', () => {
    describe('CONFIG object', () => {
        it('should have network configuration', () => {
            expect(CONFIG.network).toBeDefined();
            expect(CONFIG.network.chainId).toBe(137);
            expect(CONFIG.network.name).toBe('Polygon Mainnet');
        });

        it('should have valid currency config', () => {
            expect(CONFIG.network.currency.symbol).toBe('POL');
            expect(CONFIG.network.currency.decimals).toBe(18);
        });

        it('should have at least one RPC endpoint', () => {
            expect(CONFIG.network.rpcEndpoints).toBeDefined();
            expect(Array.isArray(CONFIG.network.rpcEndpoints)).toBe(true);
            expect(CONFIG.network.rpcEndpoints.length).toBeGreaterThan(0);
        });

        it('should have retry configuration', () => {
            expect(CONFIG.retry).toBeDefined();
            expect(CONFIG.retry.maxAttempts).toBeGreaterThan(0);
            expect(CONFIG.retry.baseDelayMs).toBeGreaterThan(0);
        });

        it('should have stream configuration', () => {
            expect(CONFIG.stream).toBeDefined();
            expect(CONFIG.stream.initialMessages).toBeGreaterThan(0);
            expect(CONFIG.stream.loadMoreCount).toBeGreaterThan(0);
        });

        it('should have storage configuration', () => {
            expect(CONFIG.storage).toBeDefined();
            expect(['streamr', 'custom']).toContain(CONFIG.storage.defaultProvider);
            expect(CONFIG.storage.defaultRetentionDays).toBeGreaterThan(0);
        });

        it('should have app metadata', () => {
            expect(CONFIG.app).toBeDefined();
            expect(CONFIG.app.name).toBe('pombo');
            expect(CONFIG.app.version).toBeDefined();
        });
    });

    describe('getRpcEndpoints', () => {
        it('should return array of objects with url property', () => {
            const endpoints = getRpcEndpoints();
            expect(Array.isArray(endpoints)).toBe(true);
            endpoints.forEach(endpoint => {
                expect(endpoint).toHaveProperty('url');
                expect(typeof endpoint.url).toBe('string');
            });
        });

        it('should return valid HTTP(S) URLs', () => {
            const endpoints = getRpcEndpoints();
            endpoints.forEach(endpoint => {
                expect(endpoint.url).toMatch(/^https?:\/\//);
            });
        });

        it('should return the default endpoints, dRPC first', () => {
            const endpoints = getRpcEndpoints().map(e => e.url);
            expect(endpoints).toEqual(
                RPC_DEFAULT_ENABLED.map(k => RPC_ENDPOINTS.find(e => e.key === k).url)
            );
            expect(endpoints[0]).toContain('drpc.org');
        });
    });

    describe('getNetworkParams', () => {
        it('should return correctly formatted chainId', () => {
            const params = getNetworkParams();
            expect(params.chainId).toBe('0x89'); // 137 in hex
        });

        it('should include chain name', () => {
            const params = getNetworkParams();
            expect(params.chainName).toBe(CONFIG.network.name);
        });

        it('should include native currency', () => {
            const params = getNetworkParams();
            expect(params.nativeCurrency).toEqual(CONFIG.network.currency);
        });

        it('should include RPC URLs array', () => {
            const params = getNetworkParams();
            expect(Array.isArray(params.rpcUrls)).toBe(true);
            expect(params.rpcUrls).toEqual(CONFIG.network.rpcEndpoints);
        });

        it('should include block explorer URLs', () => {
            const params = getNetworkParams();
            expect(Array.isArray(params.blockExplorerUrls)).toBe(true);
            expect(params.blockExplorerUrls).toContain(CONFIG.network.blockExplorer);
        });
    });

    describe('RPC_ENDPOINTS', () => {
        it('should list several endpoints with a key, a name and an https url', () => {
            expect(RPC_ENDPOINTS.length).toBeGreaterThan(2);
            RPC_ENDPOINTS.forEach(e => {
                expect(typeof e.key).toBe('string');
                expect(typeof e.name).toBe('string');
                expect(e.url).toMatch(/^https:\/\//);
                expect(typeof e.webviewSafe).toBe('boolean');
            });
        });

        it('should have unique keys', () => {
            const keys = RPC_ENDPOINTS.map(e => e.key);
            expect(new Set(keys).size).toBe(keys.length);
        });

        it('should prefer dRPC', () => {
            expect(RPC_ENDPOINTS[0].key).toBe('drpc');
            expect(RPC_ENDPOINTS[0].url).toContain('drpc.org');
        });

        it('should not include endpoints known to be gone', () => {
            RPC_ENDPOINTS.forEach(e => {
                expect(e.url).not.toContain('polygon-rpc.com');
                expect(e.url).not.toContain('blastapi');
                expect(e.url).not.toContain('rpc.ankr.com');
                expect(e.url).not.toContain('meowrpc');
                expect(e.url).not.toContain('llamarpc');
            });
        });

        it('should keep at least one endpoint usable from the Android bridge', () => {
            expect(RPC_ENDPOINTS.some(e => e.webviewSafe)).toBe(true);
        });

        it('should default to enabling endpoints it actually knows', () => {
            const keys = RPC_ENDPOINTS.map(e => e.key);
            RPC_DEFAULT_ENABLED.forEach(k => expect(keys).toContain(k));
        });

        it('should enable at most four endpoints by default, all usable from the Android bridge', () => {
            expect(RPC_DEFAULT_ENABLED.length).toBeLessThanOrEqual(4);
            RPC_DEFAULT_ENABLED.forEach(k =>
                expect(RPC_ENDPOINTS.find(e => e.key === k).webviewSafe).toBe(true));
        });
    });

    describe('getRpcEndpoints with localStorage', () => {
        const STORAGE_KEY = 'pombo_rpc_preference';

        const defaultUrls = () =>
            RPC_DEFAULT_ENABLED.map(k => RPC_ENDPOINTS.find(e => e.key === k).url);


        beforeEach(() => {
            // Clear localStorage before each test
            localStorage.removeItem(STORAGE_KEY);
        });

        afterEach(() => {
            // Clean up after each test
            localStorage.removeItem(STORAGE_KEY);
        });

        it('should return the default endpoints when no preference saved', () => {
            expect(getRpcEndpoints().map(e => e.url)).toEqual(defaultUrls());
        });

        it('should return the saved endpoints when a preference is saved', () => {
            localStorage.setItem(STORAGE_KEY, JSON.stringify({ preset: 'drpc' }));
            const endpoints = getRpcEndpoints();
            expect(endpoints.length).toBe(1);
            expect(endpoints[0].url).toContain('drpc.org');
        });

        it('should return custom URL when custom preset is saved', () => {
            const customUrl = 'https://my-custom-rpc.com';
            localStorage.setItem(STORAGE_KEY, JSON.stringify({ 
                preset: 'custom', 
                customUrl: customUrl 
            }));
            const endpoints = getRpcEndpoints();
            expect(endpoints.length).toBe(1);
            expect(endpoints[0].url).toBe(customUrl);
        });

        it('should fall back to the default on invalid JSON', () => {
            localStorage.setItem(STORAGE_KEY, 'invalid json');
            expect(getRpcEndpoints().map(e => e.url)).toEqual(defaultUrls());
        });

        it('should fall back to the default for an unknown preset', () => {
            localStorage.setItem(STORAGE_KEY, JSON.stringify({ preset: 'unknown-preset' }));
            expect(getRpcEndpoints().map(e => e.url)).toEqual(defaultUrls());
        });
    });

    describe('RPC selection model', () => {
        const STORAGE_KEY = 'pombo_rpc_preference';

        beforeEach(() => localStorage.removeItem(STORAGE_KEY));
        afterEach(() => localStorage.removeItem(STORAGE_KEY));

        it('should offer a row per endpoint, with no custom row until one exists', () => {
            const sel = loadRpcSelection();
            expect(sel.rows.map(r => r.key)).toEqual(RPC_ENDPOINTS.map(e => e.key));
        });

        it('should carry a custom row only while a url stands behind it', () => {
            saveRpcSelection({
                rows: [{ key: 'drpc', on: true }, { key: RPC_CUSTOM_KEY, on: true }],
                customUrl: 'https://my-own-node.example'
            });
            expect(loadRpcSelection().rows.some(r => r.key === RPC_CUSTOM_KEY)).toBe(true);

            saveRpcSelection({
                rows: [{ key: 'drpc', on: true }, { key: RPC_CUSTOM_KEY, on: true }],
                customUrl: ''
            });
            expect(loadRpcSelection().rows.some(r => r.key === RPC_CUSTOM_KEY)).toBe(false);
        });

        it('should keep the saved order and put rows missing from the save last', () => {
            saveRpcSelection({
                rows: [{ key: '1rpc', on: true }, { key: 'drpc', on: true }],
                customUrl: ''
            });
            const sel = loadRpcSelection();
            expect(sel.rows[0].key).toBe('1rpc');
            expect(sel.rows[1].key).toBe('drpc');
            expect(rpcSelectionUrls(sel)).toEqual([
                RPC_ENDPOINTS.find(e => e.key === '1rpc').url,
                RPC_ENDPOINTS.find(e => e.key === 'drpc').url
            ]);
        });

        it('should drop keys the code no longer knows', () => {
            localStorage.setItem(STORAGE_KEY, JSON.stringify({
                v: 2,
                rows: [{ key: 'meowrpc', on: true }, { key: 'drpc', on: true }],
                customUrl: ''
            }));
            const sel = loadRpcSelection();
            expect(sel.rows.some(r => r.key === 'meowrpc')).toBe(false);
            expect(rpcSelectionUrls(sel)).toEqual([RPC_ENDPOINTS[0].url]);
        });

        it('should add endpoints new to the code disabled and at the end', () => {
            saveRpcSelection({ rows: [{ key: 'drpc', on: true }], customUrl: '' });
            const sel = loadRpcSelection();
            expect(sel.rows[0]).toEqual({ key: 'drpc', on: true });
            sel.rows.slice(1).forEach(r => expect(r.on).toBe(false));
        });

        it('should leave a saved selection as it was when the default changes', () => {
            saveRpcSelection({
                rows: [
                    { key: 'drpc', on: true }, { key: 'publicnode', on: true },
                    { key: 'tenderly', on: true }, { key: '1rpc', on: false }
                ],
                customUrl: ''
            });
            const sel = loadRpcSelection();
            expect(rpcSelectionUrls(sel)).toEqual(['drpc', 'publicnode', 'tenderly']
                .map(k => RPC_ENDPOINTS.find(e => e.key === k).url));
            expect(sel.rows.find(r => r.key === 'pocket')).toEqual({ key: 'pocket', on: false });
        });

        it('should fall back to the default when nothing is enabled', () => {
            saveRpcSelection({
                rows: RPC_ENDPOINTS.map(e => ({ key: e.key, on: false })),
                customUrl: ''
            });
            const sel = loadRpcSelection();
            expect(sel.rows.filter(r => r.on).map(r => r.key).sort())
                .toEqual([...RPC_DEFAULT_ENABLED].sort());
        });

        it('should ignore a custom row with no url behind it', () => {
            saveRpcSelection({
                rows: [{ key: RPC_CUSTOM_KEY, on: true }, { key: 'drpc', on: true }],
                customUrl: ''
            });
            expect(rpcSelectionUrls(loadRpcSelection())).toEqual([RPC_ENDPOINTS[0].url]);
        });

        it('should use a custom url alone when that is the whole selection', () => {
            saveRpcSelection({
                rows: [{ key: RPC_CUSTOM_KEY, on: true }],
                customUrl: 'https://my-own-node.example '
            });
            expect(rpcSelectionUrls(loadRpcSelection())).toEqual(['https://my-own-node.example']);
        });
    });

    describe('migration from the preset setting', () => {
        const STORAGE_KEY = 'pombo_rpc_preference';

        beforeEach(() => localStorage.removeItem(STORAGE_KEY));
        afterEach(() => localStorage.removeItem(STORAGE_KEY));

        it('should turn auto into every endpoint, in order', () => {
            localStorage.setItem(STORAGE_KEY, JSON.stringify({ preset: 'auto' }));
            expect(rpcSelectionUrls(loadRpcSelection())).toEqual(RPC_ENDPOINTS.map(e => e.url));
        });

        it('should turn a provider preset into that provider alone', () => {
            localStorage.setItem(STORAGE_KEY, JSON.stringify({ preset: 'tenderly' }));
            const urls = rpcSelectionUrls(loadRpcSelection());
            expect(urls).toEqual([RPC_ENDPOINTS.find(e => e.key === 'tenderly').url]);
        });

        it('should turn custom into the custom url alone', () => {
            localStorage.setItem(STORAGE_KEY, JSON.stringify({
                preset: 'custom', customUrl: 'https://my-own-node.example'
            }));
            expect(rpcSelectionUrls(loadRpcSelection())).toEqual(['https://my-own-node.example']);
        });

        it('should fall back to the default for a preset that is gone', () => {
            localStorage.setItem(STORAGE_KEY, JSON.stringify({ preset: 'meowrpc' }));
            const sel = loadRpcSelection();
            expect(sel.rows.filter(r => r.on).map(r => r.key).sort())
                .toEqual([...RPC_DEFAULT_ENABLED].sort());
        });
    });
});
