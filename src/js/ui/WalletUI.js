/**
 * Wallet panel: what this account holds on Polygon.
 *
 * Balances are read from the chain on every open and never written to disk.
 * The panel is deliberately about tokens only: the address, the private key
 * and account actions belong to the account, and stay where they are.
 *
 * A token's `symbol()` is text chosen by whoever deployed the contract, so it
 * is escaped, truncated, and never used to decide anything. Anything outside
 * the three base tokens also shows its address, which is the only identity a
 * token really has.
 */

import { CONFIG } from '../config.js';
import { Logger } from '../logger.js';
import { escapeHtml } from './utils.js';
import { GasEstimator } from './GasEstimator.js';
import { modalManager } from './ModalManager.js';

const PRESETS = CONFIG.gate.tokenPresets.gate;

/**
 * Always listed, even at zero. POL is the native coin (eth_getBalance); the
 * other two are ERC-20 reads against the addresses the gate presets already
 * carry.
 */
const BASE_TOKENS = [
    { id: 'pol', symbol: 'POL', native: true },
    { id: 'data', symbol: 'DATA', address: PRESETS.data.address },
    { id: 'usdc', symbol: 'USDC', address: PRESETS.usdc.address }
];

/**
 * Listed only when the account holds some. Addresses, not names: each one was
 * confirmed on Polygon by reading its own `symbol()`, and that is also what
 * the panel renders, so a contract that renames itself cannot leave a stale
 * label here (the Polygon USDT address answers "USDT0" today).
 */
const CURATED_TOKENS = [
    '0xc2132D05D31c914a87C6611C10748AEb04B58e8F',
    '0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619',
    '0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270',
    '0x1BFD67037B42Cf73acF2047067bd4F2C47D9BfD6',
    '0x8f3Cf7ad23Cd3CaDbD9735AFf958023239c6A063'
];

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

const shortAddress = (a) => `${a.slice(0, 6)}…${a.slice(-4)}`;

/**
 * Whole units from a wei-style integer, at most 4 decimals, trailing zeros
 * trimmed. Dust reads as "< 0.0001" rather than a row of zeros.
 * @param {bigint} raw
 * @param {number} decimals
 */
export function formatTokenAmount(raw, decimals) {
    if (typeof raw !== 'bigint' || !Number.isInteger(decimals) || decimals < 0) return null;
    if (raw === 0n) return '0';

    const base = 10n ** BigInt(decimals);
    const whole = raw / base;
    const frac = raw % base;

    if (whole === 0n) {
        // 4 decimal places, rounded down: showing more of a dust balance than
        // that is noise, and rounding up would claim funds that are not there.
        const shown = decimals <= 4 ? frac : frac / (10n ** BigInt(decimals - 4));
        const scale = decimals <= 4 ? decimals : 4;
        if (shown === 0n) return '< 0.0001';
        const padded = shown.toString().padStart(scale, '0').replace(/0+$/, '');
        return `0.${padded}`;
    }

    if (frac === 0n) return whole.toString();
    const shown = decimals <= 4 ? frac : frac / (10n ** BigInt(decimals - 4));
    const scale = decimals <= 4 ? decimals : 4;
    const padded = shown.toString().padStart(scale, '0').replace(/0+$/, '');
    return padded ? `${whole}.${padded}` : whole.toString();
}

class WalletUI {
    constructor() {
        this.deps = {};
        this._wired = false;
        // id → { symbol, address, value, state: 'loading'|'ok'|'error' }
        this.rows = new Map();
        this._loadToken = 0;
    }

    /**
     * @param {Object} deps
     * @param {Object} deps.authManager
     * @param {Function} deps.showNotification
     */
    init(deps) {
        this.deps = { ...this.deps, ...deps };
        const wrapper = document.getElementById('wallet-btn-wrapper');
        if (!wrapper) {
            Logger.warn('Wallet button markup missing');
            return;
        }
        wrapper.classList.remove('hidden');

        if (this._wired) return;
        this._wired = true;

        document.getElementById('wallet-btn')?.addEventListener('click', () => this.open());
        document.getElementById('close-wallet-btn')?.addEventListener('click', () => this.close());
        document.getElementById('wallet-refresh-btn')?.addEventListener('click', () => this.refresh());
        document.getElementById('wallet-fund-btn')?.addEventListener('click', () => this.fundWithMetaMask());
        document.getElementById('wallet-add-open')?.addEventListener('click', () => this._openAddRow());
        document.getElementById('wallet-add-cancel')?.addEventListener('click', () => this._closeAddRow());
        document.getElementById('wallet-add-confirm')?.addEventListener('click', () => {
            this.addToken(document.getElementById('wallet-add-input')?.value);
        });
        document.getElementById('wallet-add-input')?.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') this.addToken(e.target.value);
            if (e.key === 'Escape') this._closeAddRow();
        });

        const modal = document.getElementById('wallet-modal');
        modal?.addEventListener('click', (e) => {
            if (e.target === modal) this.close();
        });
    }

    open() {
        modalManager.show('wallet-modal');
        this._closeAddRow();
        this.refresh();
    }

    close() {
        modalManager.hide('wallet-modal');
    }

    /** Re-read every listed token. Safe to call while a read is in flight. */
    async refresh() {
        const address = this.deps.authManager?.getAddress();
        const listEl = document.getElementById('wallet-rows');
        if (!listEl) return;

        if (!address) {
            listEl.innerHTML = '<div class="wallet-empty">Not connected</div>';
            return;
        }

        const token = ++this._loadToken;
        const list = this.tokens();
        this.rows.clear();
        for (const t of list) {
            this.rows.set(t.id, {
                symbol: t.symbol,
                address: t.address || null,
                kind: t.kind,
                state: 'loading',
                value: null,
                raw: null
            });
        }
        this.render();

        await Promise.all(list.map(async (t) => {
            const row = this.rows.get(t.id);
            try {
                const value = t.native
                    ? await this._nativeBalance(address)
                    : await this._tokenBalance(t.address, address);
                if (token !== this._loadToken) return;
                if (value === null) throw new Error('no value');
                row.state = 'ok';
                row.value = value.text;
                row.raw = value.raw;
                row.symbol = value.symbol || row.symbol;
            } catch (e) {
                if (token !== this._loadToken) return;
                Logger.debug('wallet: balance unavailable', t.symbol || t.address, e?.message || e);
                row.state = 'error';
            }
            this.render();
        }));
    }

    /**
     * The tokens this panel lists, in render order: the three that are always
     * shown, the curated ones (rendered only when held), then whatever the
     * user added here.
     */
    tokens() {
        const seen = new Set(BASE_TOKENS.filter((t) => t.address).map((t) => t.address.toLowerCase()));
        const list = BASE_TOKENS.map((t) => ({ ...t, kind: 'base' }));

        for (const address of CURATED_TOKENS) {
            const key = address.toLowerCase();
            if (seen.has(key)) continue;
            seen.add(key);
            list.push({ id: `curated:${key}`, address, kind: 'curated', symbol: '' });
        }
        for (const address of this.watchlist()) {
            const key = address.toLowerCase();
            if (seen.has(key)) continue;
            seen.add(key);
            list.push({ id: `custom:${key}`, address, kind: 'custom', symbol: '' });
        }
        return list;
    }

    /** Addresses this device lists on top of the built-in ones. */
    watchlist() {
        const address = this.deps.authManager?.getAddress();
        if (!address) return [];
        try {
            const raw = localStorage.getItem(CONFIG.storageKeys.walletTokens(address));
            const parsed = raw ? JSON.parse(raw) : [];
            return Array.isArray(parsed) ? parsed.filter((a) => ADDRESS_RE.test(a)) : [];
        } catch {
            return [];
        }
    }

    _saveWatchlist(addresses) {
        const address = this.deps.authManager?.getAddress();
        if (!address) return;
        try {
            localStorage.setItem(
                CONFIG.storageKeys.walletTokens(address), JSON.stringify(addresses));
        } catch (e) {
            Logger.warn('wallet: could not save the token list:', e?.message || e);
        }
    }

    async _nativeBalance(address) {
        const wei = await GasEstimator.getBalance(address);
        if (wei === null || wei === undefined) return null;
        // GasEstimator hands back a Number; POL is the one balance the rest of
        // the app already reads that way.
        const raw = BigInt(Math.round(wei));
        const text = formatTokenAmount(raw, 18);
        return text === null ? null : { text, raw };
    }

    async _tokenBalance(tokenAddress, address) {
        const { gateManager } = await import('../gate.js');
        const [meta, balance] = await Promise.all([
            gateManager.getTokenMeta(tokenAddress),
            gateManager.getTokenBalance(tokenAddress, address)
        ]);
        // An ERC-721 collection has no decimals(); a token that will not say
        // how many it has cannot be rendered as an amount.
        if (meta?.decimals === null || meta?.decimals === undefined) return null;
        const raw = BigInt(balance);
        const text = formatTokenAmount(raw, meta.decimals);
        return text === null ? null : { text, raw, symbol: meta.symbol };
    }

    render() {
        const listEl = document.getElementById('wallet-rows');
        if (!listEl) return;

        listEl.innerHTML = Array.from(this.rows.values()).filter((row) => {
            // A curated token is an offer, not a promise: it earns a row by
            // being held. One whose read failed is dropped rather than filling
            // the panel with "Unavailable" for coins the user never asked for.
            if (row.kind !== 'curated') return true;
            return row.state === 'ok' && row.raw > 0n;
        }).map((row) => {
            const value = row.state === 'loading'
                ? '<span class="wallet-row-pending">···</span>'
                : row.state === 'error'
                    ? '<span class="wallet-row-error">Unavailable</span>'
                    : `<span class="wallet-row-value">${escapeHtml(row.value)}</span>`;
            const addr = row.kind !== 'base' && row.address
                ? `<span class="wallet-row-address">${escapeHtml(shortAddress(row.address))}</span>`
                : '';
            const remove = row.kind === 'custom'
                ? `<button class="wallet-row-remove" data-remove-token="${escapeHtml(row.address)}" title="Remove from this list" aria-label="Remove token">
                       <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"/></svg>
                   </button>`
                : '';
            // The symbol is whatever the contract says it is: escaped, capped,
            // and shown beside the address, which is the part that identifies.
            return `
                <div class="wallet-row">
                    <div class="wallet-row-token">
                        <span class="wallet-row-symbol">${escapeHtml(String(row.symbol || '').slice(0, 12))}</span>
                        ${addr}
                    </div>
                    <div class="wallet-row-end">
                        ${value}
                        ${remove}
                    </div>
                </div>`;
        }).join('');

        listEl.querySelectorAll('[data-remove-token]').forEach((btn) => {
            btn.addEventListener('click', () => this.removeToken(btn.dataset.removeToken));
        });
    }

    /** Add an ERC-20 by address, after the chain confirms it is one. */
    async addToken(input) {
        const errorEl = document.getElementById('wallet-add-error');
        const setError = (msg) => {
            if (errorEl) {
                errorEl.textContent = msg || '';
                errorEl.classList.toggle('hidden', !msg);
            }
        };

        const address = String(input || '').trim();
        if (!ADDRESS_RE.test(address)) {
            setError('Paste a token address (0x and 40 hex characters)');
            return false;
        }
        const key = address.toLowerCase();
        if (this.tokens().some((t) => t.address?.toLowerCase() === key)) {
            setError('Already listed');
            return false;
        }

        const account = this.deps.authManager?.getAddress();
        if (!account) return false;

        setError('');
        const addBtn = document.getElementById('wallet-add-confirm');
        if (addBtn) addBtn.disabled = true;
        try {
            const value = await this._tokenBalance(address, account);
            if (value === null) throw new Error('not an ERC-20');
            this._saveWatchlist([...this.watchlist(), address]);
            this._closeAddRow();
            await this.refresh();
            return true;
        } catch (e) {
            Logger.debug('wallet: add token refused', address, e?.message || e);
            setError('Not an ERC-20 on Polygon');
            return false;
        } finally {
            if (addBtn) addBtn.disabled = false;
        }
    }

    removeToken(address) {
        const key = String(address || '').toLowerCase();
        this._saveWatchlist(this.watchlist().filter((a) => a.toLowerCase() !== key));
        this.refresh();
    }

    _openAddRow() {
        document.getElementById('wallet-add-row')?.classList.remove('hidden');
        document.getElementById('wallet-add-open')?.classList.add('hidden');
        document.getElementById('wallet-add-input')?.focus();
    }

    _closeAddRow() {
        const input = document.getElementById('wallet-add-input');
        if (input) input.value = '';
        document.getElementById('wallet-add-error')?.classList.add('hidden');
        document.getElementById('wallet-add-row')?.classList.add('hidden');
        document.getElementById('wallet-add-open')?.classList.remove('hidden');
    }

    /**
     * Top up the in-app account from MetaMask. Moved here with the panel: it
     * funds the wallet, not the account identity.
     */
    async fundWithMetaMask() {
        const { showNotification } = this.deps;
        const localAddress = this.deps.authManager?.getAddress();
        if (!localAddress) {
            showNotification?.('No account connected', 'error');
            return;
        }

        if (typeof window.ethereum === 'undefined') {
            showNotification?.('MetaMask not detected. Please install MetaMask.', 'error');
            window.open('https://metamask.io/download/', '_blank');
            return;
        }

        try {
            const accounts = await window.ethereum.request({ method: 'eth_requestAccounts' });
            if (!accounts || accounts.length === 0) {
                showNotification?.('MetaMask connection cancelled', 'error');
                return;
            }
            const metamaskAddress = accounts[0];

            const chainId = await window.ethereum.request({ method: 'eth_chainId' });
            if (chainId !== '0x89') {
                try {
                    await window.ethereum.request({
                        method: 'wallet_switchEthereumChain',
                        params: [{ chainId: '0x89' }]
                    });
                } catch (switchError) {
                    if (switchError.code === 4902) {
                        const { getNetworkParams } = await import('../config.js');
                        await window.ethereum.request({
                            method: 'wallet_addEthereumChain',
                            params: [getNetworkParams()]
                        });
                    } else {
                        throw switchError;
                    }
                }
            }

            const amount = await this._askAmount();
            if (!amount) return;

            const amountWei = BigInt(Math.floor(parseFloat(amount) * 1e18));
            const amountHex = '0x' + amountWei.toString(16);

            showNotification?.('Confirm transaction in MetaMask...', 'info');

            const txHash = await window.ethereum.request({
                method: 'eth_sendTransaction',
                params: [{ from: metamaskAddress, to: localAddress, value: amountHex }]
            });

            showNotification?.('Transaction sent! Waiting for confirmation...', 'info');

            let receipt = null;
            while (!receipt) {
                await new Promise((resolve) => setTimeout(resolve, 2000));
                receipt = await window.ethereum.request({
                    method: 'eth_getTransactionReceipt',
                    params: [txHash]
                });
            }

            if (receipt.status === '0x1') {
                showNotification?.(`Funded ${amount} POL successfully!`, 'success');
                this.refresh();
            } else {
                showNotification?.('Transaction failed', 'error');
            }
        } catch (error) {
            Logger.error('MetaMask funding error:', error);
            if (error.code === 4001) {
                showNotification?.('Transaction cancelled', 'error');
            } else {
                showNotification?.('Error: ' + (error.message || 'Unknown error'), 'error');
            }
        }
    }

    /** Amount prompt for the MetaMask top-up. */
    _askAmount() {
        return new Promise((resolve) => {
            const modal = document.createElement('div');
            modal.className = 'fixed inset-0 bg-black/80 flex items-center justify-center z-50';
            modal.innerHTML = `
                <div class="bg-[#111113] rounded-2xl w-[320px] overflow-hidden shadow-2xl border border-white/[0.06]">
                    <div class="px-5 pt-5 pb-4">
                        <div class="flex items-center justify-between">
                            <h3 class="text-[15px] font-medium text-white">Fund Account</h3>
                            <button id="close-fund-modal" class="text-white/30 hover:text-white transition p-1 -mr-1">
                                <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M6 18L18 6M6 6l12 12"/>
                                </svg>
                            </button>
                        </div>
                    </div>
                    <div class="px-5 pb-5">
                        <input id="fund-amount-input" type="number" step="0.01" min="0" placeholder="0.5"
                            class="w-full bg-white/5 border border-white/10 text-white px-4 py-3 rounded-xl text-sm focus:outline-none focus:border-white/30 transition placeholder:text-white/20">
                        <p class="text-xs text-white/30 mt-2">Amount in POL to send to this account</p>
                        <button id="confirm-fund-btn" class="w-full mt-4 bg-[#F6851B] hover:bg-[#e5780f] text-white px-4 py-2.5 rounded-xl text-sm font-medium transition">
                            Send
                        </button>
                    </div>
                </div>`;
            document.body.appendChild(modal);

            const input = modal.querySelector('#fund-amount-input');
            const cleanup = (value) => {
                modal.remove();
                resolve(value);
            };
            modal.querySelector('#confirm-fund-btn').addEventListener('click', () => {
                const value = parseFloat(input.value);
                cleanup(Number.isFinite(value) && value > 0 ? String(value) : null);
            });
            modal.querySelector('#close-fund-modal').addEventListener('click', () => cleanup(null));
            modal.addEventListener('click', (e) => {
                if (e.target === modal) cleanup(null);
            });
            input.addEventListener('keydown', (e) => {
                if (e.key === 'Enter') modal.querySelector('#confirm-fund-btn').click();
            });
            setTimeout(() => input.focus(), 100);
        });
    }
}

export const walletUI = new WalletUI();
