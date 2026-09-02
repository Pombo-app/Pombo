/**
 * PomboGate client — the on-chain side of gated channels (N-C).
 *
 * One EIP-1167 clone per channel, deployed through the PomboGateFactory. The
 * clone is the channel's on-wire publisher for every member (ERC-1271), and
 * two views drive the client:
 *
 *   isValidSignature — consumed by the Streamr SDK, never called here. Since
 *                      v3 it answers the same question as checkAccess (plus
 *                      the read-only filter), so a lapsed member stops
 *                      publishing without any owner transaction.
 *   checkAccess      — the CURRENT gate. Decides epoch-key distribution
 *                      (answering a KEY_REQUEST) and UI state. Cached per
 *                      (gate, user) like the SDK caches isValidSignature.
 *
 * Writes (createGate / allow / ban / …) are owner transactions signed with
 * the local account wallet — the same wallet that already pays for stream
 * creation, so no new signing path.
 *
 * All reads go through a plain JsonRpcProvider with endpoint failover. The
 * Streamr SDK's provider is not reachable from app code, and GasEstimator's
 * raw fetch has no ABI layer — a lazy ethers provider is the smallest correct
 * tool.
 */

import { CONFIG, getRpcEndpoints } from './config.js';
import { Logger } from './logger.js';

const GATE_ABI = [
    'function owner() view returns (address)',
    'function mode() view returns (uint8)',
    'function token() view returns (address)',
    'function minBalance() view returns (uint256)',
    'function price() view returns (uint256)',
    'function duration() view returns (uint64)',
    'function wireIdentity() view returns (uint8)',
    'function readOnly() view returns (bool)',
    'function banned(address) view returns (bool)',
    'function allowlist(address) view returns (bool)',
    'function paidUntil(address) view returns (uint64)',
    'function moderators(address) view returns (bool)',
    'function checkAccess(address user) view returns (bool)',
    'function states(address[] users) view returns (tuple(bool access, bool banned, bool moderator, bool allowed, uint64 paidUntil)[])',
    'function membersCount() view returns (uint256)',
    'function membersAt(uint256 offset, uint256 limit) view returns (address[])',
    'function allow(address user)',
    'function allowBatch(address[] users)',
    'function revokeAllow(address user)',
    'function pay()',
    'function payWithPermit(uint256 permitValue, uint256 deadline, uint8 v, bytes32 r, bytes32 s)',
    'function ban(address user)',
    'function unban(address user)',
    'function setModerator(address user, bool enabled)',
    'function setPrice(uint256 price)',
    'function setDuration(uint64 duration)',
    'event ModeratorSet(address indexed user, bool enabled)',
    'event Allowed(address indexed user)',
    'event AllowRevoked(address indexed user)',
    'event Paid(address indexed user, uint64 paidUntil)',
    'event Banned(address indexed user)',
    'event Unbanned(address indexed user)',
    'event PriceSet(uint256 price)',
    'event DurationSet(uint64 duration)'
];

const FACTORY_ABI = [
    'function createGate(uint8 mode, address token, uint256 minBalance, uint256 price, uint64 duration, uint8 wireIdentity, bool readOnly) returns (address)',
    'event GateCreated(address indexed gate, address indexed owner, uint8 mode)'
];

// Canonical wrapped-native on Polygon (WPOL, WETH9 code). pay() auto-wraps
// native POL into it when the standing WPOL balance is short — deposit() is
// only assumed safe for THIS address, never for arbitrary payment tokens.
const WRAPPED_NATIVE = '0x0d500b1d8e8ef31e21c99d1db9a6444d3adf1270';
const WRAPPED_NATIVE_ABI = ['function deposit() payable'];

// balanceOf covers ERC-721 too (same selector); decimals/allowance are ERC-20 only.
const TOKEN_ABI = [
    'function balanceOf(address) view returns (uint256)',
    'function allowance(address owner, address spender) view returns (uint256)',
    'function approve(address spender, uint256 value) returns (bool)',
    'function decimals() view returns (uint8)',
    'function symbol() view returns (string)'
];

/** Mirrors PomboGate.Mode on-chain — order is part of the ABI, never reorder. */
export const GATE_MODE = Object.freeze({
    NONE: 0,            // Closed: owner-managed allowlist
    TOKEN_BALANCE: 1,
    NFT_OWNERSHIP: 2,
    PAID: 3
});

const GATE_MODE_NAMES = ['none', 'token', 'nft', 'paid'];

/** Mirrors PomboGate.WireIdentity on-chain — order is part of the ABI. */
export const WIRE_IDENTITY = Object.freeze({
    VISIBLE: 0, // every message signed by its author's account
    SEALED: 1 // shared channel key on the wire, authorship sealed inside
});

const WIRE_IDENTITY_NAMES = ['visible', 'sealed'];

class GateManager {
    constructor() {
        this._provider = null;
        this._rpcIndex = 0;
        // (gate, user) → { value, at } — TTL'd like the SDK's ERC-1271 cache
        this._accessCache = new Map();
        // (gate, user) → { until, at } — paidUntil in unix seconds, same TTL
        this._paidCache = new Map();
        // gate → { info, at }. TTL'd since v3: price and duration are
        // owner-mutable (setPrice/setDuration), so "fetched once" would show
        // a stale price to everyone else for the whole session.
        this._infoCache = new Map();
        // token → { symbol, decimals } — immutable, fetched once
        this._tokenMetaCache = new Map();
    }

    // ------------------------------------------------------------- provider

    _currentRpcUrl() {
        // getRpcEndpoints() reads the user's RPC preference (Settings) —
        // entries are Streamr-SDK-shaped ({ url }), not plain strings, and
        // JsonRpcProvider needs the string or it treats the object as a
        // FetchRequest ("url.clone is not a function").
        const endpoints = getRpcEndpoints();
        const entry = endpoints[this._rpcIndex % endpoints.length];
        return typeof entry === 'string' ? entry : entry?.url;
    }

    _makeProvider(url) {
        return new ethers.JsonRpcProvider(url, CONFIG.network.chainId, {
            staticNetwork: true,
            batchMaxCount: 1
        });
    }

    _getProvider() {
        // Re-resolve on every call so a Settings RPC change takes effect
        // immediately instead of after the next failure rotation.
        const url = this._currentRpcUrl();
        if (!this._provider || this._providerUrl !== url) {
            this._provider = this._makeProvider(url);
            this._providerUrl = url;
        }
        return this._provider;
    }

    /**
     * Run an RPC operation, rotating to the next endpoint once on failure.
     * Mirrors GasEstimator's sticky-with-failover behaviour. A revert
     * (CALL_EXCEPTION) is the chain answering, not the endpoint failing —
     * rotating on it would just replay the same revert against every
     * endpoint in the list.
     */
    async _withProvider(op) {
        try {
            return await op(this._getProvider());
        } catch (firstError) {
            if (firstError?.code === 'CALL_EXCEPTION') throw firstError;
            this._rpcIndex++;
            Logger.debug('gate: RPC failed, rotating endpoint:', firstError.message);
            return op(this._getProvider());
        }
    }

    _readContract(gateAddress) {
        return new ethers.Contract(gateAddress, GATE_ABI, this._getProvider());
    }

    _readToken(tokenAddress) {
        return new ethers.Contract(tokenAddress, TOKEN_ABI, this._getProvider());
    }

    /** The local account wallet, connected for transactions. */
    async _txSigner() {
        const { authManager } = await import('./auth.js');
        const signer = authManager.getSigner();
        if (!signer) throw new Error('Wallet locked — cannot send gate transaction');
        return signer.connect(this._getProvider());
    }

    // ---------------------------------------------------------------- reads

    /**
     * Gate parameters. Owner, mode, token, minBalance, wireIdentity and
     * readOnly are immutable; price and duration are owner-mutable, hence the
     * TTL (same window as checkAccess) plus explicit invalidation after our
     * own setPrice/setDuration.
     * @returns {Promise<{owner: string, mode: number, modeName: string,
     *   token: string, minBalance: bigint, price: bigint, duration: bigint,
     *   wireIdentity: number, wireIdentityName: string, readOnly: boolean}>}
     */
    async getGateInfo(gateAddress) {
        const key = gateAddress.toLowerCase();
        const cached = this._infoCache.get(key);
        if (cached && Date.now() - cached.at < CONFIG.gate.checkAccessCacheMs) {
            if (cached.info === null) throw new Error('gate is not v3 (unsupported)');
            return cached.info;
        }
        let info;
        try {
            info = await this._readGateInfo(gateAddress);
        } catch (error) {
            // A revert means the gate lacks the v3 getters — a pre-v3 clone.
            // Unsupported by decision; cache the verdict so every consumer of
            // a dead channel doesn't hammer the RPC re-discovering it.
            if (error?.code === 'CALL_EXCEPTION') {
                this._infoCache.set(key, { info: null, at: Date.now() });
                throw new Error('gate is not v3 (unsupported)');
            }
            throw error;
        }
        this._infoCache.set(key, { info, at: Date.now() });
        return info;
    }

    _readGateInfo(gateAddress) {
        return this._withProvider(async () => {
            const gate = this._readContract(gateAddress);
            const [owner, mode, token, minBalance, price, duration, wireIdentity, readOnly] = await Promise.all([
                gate.owner(), gate.mode(), gate.token(),
                gate.minBalance(), gate.price(), gate.duration(),
                gate.wireIdentity(), gate.readOnly()
            ]);
            return {
                owner: owner.toLowerCase(),
                mode: Number(mode),
                modeName: GATE_MODE_NAMES[Number(mode)] ?? 'unknown',
                token: token.toLowerCase(),
                minBalance, price, duration,
                wireIdentity: Number(wireIdentity),
                wireIdentityName: WIRE_IDENTITY_NAMES[Number(wireIdentity)] ?? 'visible',
                readOnly: Boolean(readOnly)
            };
        });
    }

    /** Drop the cached parameters for one gate (after setPrice/setDuration). */
    invalidateInfo(gateAddress) {
        this._infoCache.delete(gateAddress.toLowerCase());
    }

    /**
     * The CURRENT gate for a user — key distribution and UI, never history.
     * Cached for CONFIG.gate.checkAccessCacheMs per (gate, user).
     *
     * Fail-closed: an RPC outage reports no access rather than wrapping an
     * epoch key for someone the chain might have cut. The requester retries
     * (N-B backoff) and a healthy responder or recovered RPC answers then.
     */
    async checkAccess(gateAddress, userAddress) {
        const value = await this.checkAccessOrNull(gateAddress, userAddress);
        if (value === null) {
            Logger.warn('gate: checkAccess unavailable — failing closed');
            return false;
        }
        return value;
    }

    /**
     * checkAccess for CONTENT filtering: null when the chain is unreachable,
     * so callers can render the message (fail-open) instead of hiding
     * legitimate traffic on an RPC hiccup. Key distribution must keep using
     * the fail-closed checkAccess above. Failures are never cached.
     * @returns {Promise<boolean|null>}
     */
    async checkAccessOrNull(gateAddress, userAddress) {
        const key = `${gateAddress.toLowerCase()}|${userAddress.toLowerCase()}`;
        const cached = this._accessCache.get(key);
        if (cached && Date.now() - cached.at < CONFIG.gate.checkAccessCacheMs) {
            return cached.value;
        }
        let value;
        try {
            value = await this._withProvider(() =>
                this._readContract(gateAddress).checkAccess(userAddress));
        } catch (error) {
            Logger.warn('gate: checkAccess read failed:', error.message);
            return null;
        }
        this._accessCache.set(key, { value, at: Date.now() });
        if (this._accessCache.size > 2000) {
            const oldest = this._accessCache.keys().next().value;
            this._accessCache.delete(oldest);
        }
        return value;
    }

    /**
     * Overwrite one (gate, user) access-cache entry with a verdict just read
     * elsewhere (the states() batch). The lost-access sweep seeds it so the
     * member it is rotating for is refused keys immediately — a stale cached
     * `true` would otherwise hand out the fresh epoch for up to the TTL.
     */
    noteAccess(gateAddress, userAddress, value) {
        this._accessCache.set(
            `${gateAddress.toLowerCase()}|${userAddress.toLowerCase()}`,
            { value: !!value, at: Date.now() });
    }

    /** @returns {Promise<bigint>} Unix seconds the subscription runs to; 0 = never paid */
    paidUntil(gateAddress, userAddress) {
        return this._withProvider(() =>
            this._readContract(gateAddress).paidUntil(userAddress));
    }

    /**
     * Cached paidUntil for UI chrome (banner, header, members panel) — one
     * RPC read per TTL window instead of one per render. Cleared alongside
     * the access cache, so a renewal is visible immediately.
     * @returns {Promise<number|null>} Unix seconds (0 = never paid), or null
     *   when the chain is unreachable — callers keep their last rendered
     *   state instead of flashing "expired" on an RPC hiccup.
     */
    async paidUntilCached(gateAddress, userAddress) {
        const key = `${gateAddress.toLowerCase()}|${userAddress.toLowerCase()}`;
        const cached = this._paidCache.get(key);
        if (cached && Date.now() - cached.at < CONFIG.gate.checkAccessCacheMs) {
            return cached.until;
        }
        let until;
        try {
            until = Number(await this.paidUntil(gateAddress, userAddress));
        } catch (error) {
            Logger.warn('gate: paidUntil read failed:', error.message);
            return null;
        }
        this._paidCache.set(key, { until, at: Date.now() });
        if (this._paidCache.size > 2000) {
            const oldest = this._paidCache.keys().next().value;
            this._paidCache.delete(oldest);
        }
        return until;
    }

    /**
     * Display metadata for a gate's token. `decimals` is null for ERC-721
     * collections (the getter does not exist there) — render whole units.
     * @returns {Promise<{symbol: string, decimals: number|null}>}
     */
    async getTokenMeta(tokenAddress) {
        const key = tokenAddress.toLowerCase();
        if (this._tokenMetaCache.has(key)) return this._tokenMetaCache.get(key);
        const meta = await this._withProvider(async () => {
            const token = this._readToken(tokenAddress);
            const [symbol, decimals] = await Promise.all([
                token.symbol().catch(() => `${tokenAddress.slice(0, 6)}…${tokenAddress.slice(-4)}`),
                token.decimals().then(Number).catch(() => null)
            ]);
            return { symbol, decimals };
        });
        this._tokenMetaCache.set(key, meta);
        return meta;
    }

    /** ERC-20 balance, or owned-token count for an ERC-721 collection. */
    getTokenBalance(tokenAddress, userAddress) {
        return this._withProvider(() =>
            this._readToken(tokenAddress).balanceOf(userAddress));
    }

    /**
     * The CURRENT on-chain state of a set of candidate addresses, plus the
     * owner — what the permissions panel renders.
     *
     * The candidate set (not the flags) comes from the caller: on a Closed
     * (NONE) gate the locally-synced member cache names everyone the owner
     * minted; on TOKEN/NFT/PAID gates the KEY_REQUEST authors seen on -4
     * are the candidates (N-D — free-tier RPCs cap eth_getLogs at 10k
     * blocks, so there is no event scan and no indexer in v0).
     *
     * `access` is the mode-aware CURRENT gate (checkAccess) — the membership
     * signal that works for every mode, where `allowed` only means NONE.
     *
     * One states() call covers the whole set. Its access field is strict, so
     * a broken gate token makes it revert — the fallback reads the non-token
     * flags per address and reports no access, which is the same fail-closed
     * the rest of the client applies.
     *
     * @param {string} gateAddress
     * @param {string[]} [candidates] - Addresses to check (owner is implicit)
     * @returns {Promise<Array<{address: string, isOwner: boolean, access: boolean,
     *   allowed: boolean, banned: boolean, moderator: boolean, paidUntil: number}>>}
     */
    async getGateMembers(gateAddress, candidates = []) {
        const info = await this.getGateInfo(gateAddress);
        const owner = info.owner;
        const gateAddr = gateAddress.toLowerCase();
        const addresses = new Set([owner]);
        for (const candidate of candidates) {
            const addr = String(candidate || '').toLowerCase();
            if (/^0x[0-9a-f]{40}$/.test(addr) && addr !== gateAddr) addresses.add(addr);
        }
        const list = Array.from(addresses);

        let members;
        try {
            const states = await this._withProvider(() =>
                this._readContract(gateAddress).states(list));
            members = list.map((address, i) => ({
                address,
                access: states[i].access,
                banned: states[i].banned,
                moderator: states[i].moderator,
                allowed: states[i].allowed,
                paidUntil: Number(states[i].paidUntil),
                isOwner: address === owner
            }));
            // The states() batch is an authoritative access read — refresh the
            // per-user cache so a cut this read just revealed refuses keys
            // immediately instead of after the TTL. (Not on the fallback path
            // below: its per-flag access is a guess, never cacheable.)
            for (const m of members) this.noteAccess(gateAddress, m.address, m.access);
        } catch (error) {
            Logger.warn('gate: states() failed, falling back to flag reads:', error.message);
            members = await this._withProvider(async () => {
                const gate = this._readContract(gateAddress);
                return Promise.all(list.map(async (address) => {
                    const [allowed, banned, moderator, paidUntil] = await Promise.all([
                        gate.allowlist(address).catch(() => false),
                        gate.banned(address).catch(() => false),
                        gate.moderators(address).catch(() => false),
                        info.mode === GATE_MODE.PAID
                            ? gate.paidUntil(address).then(Number).catch(() => 0) : 0
                    ]);
                    return {
                        address, allowed, banned, moderator, paidUntil,
                        access: address === owner,
                        isOwner: address === owner
                    };
                }));
            });
        }
        // Owner first, then moderators, then current members, then the rest
        return members.sort((a, b) =>
            (b.isOwner - a.isOwner) || (b.moderator - a.moderator)
            || (b.access - a.access) || a.address.localeCompare(b.address));
    }

    /**
     * The full on-chain allowlist of a Closed (NONE) gate, paged through
     * membersAt. This is the enumeration that makes the loss-of-access sweep
     * complete on Closed gates — candidates no longer depend on what this
     * client happened to see.
     * @returns {Promise<string[]>} lowercase addresses
     */
    async listMembers(gateAddress, pageSize = 500) {
        return this._withProvider(async () => {
            const gate = this._readContract(gateAddress);
            const total = Number(await gate.membersCount());
            const members = [];
            for (let offset = 0; offset < total; offset += pageSize) {
                const page = await gate.membersAt(offset, pageSize);
                for (const address of page) members.push(address.toLowerCase());
            }
            return members;
        });
    }

    /** Drop cached access for one user (after allow/ban) or a whole gate. */
    invalidateAccess(gateAddress, userAddress = null) {
        const prefix = gateAddress.toLowerCase();
        for (const cache of [this._accessCache, this._paidCache]) {
            for (const key of cache.keys()) {
                if (!key.startsWith(prefix)) continue;
                if (userAddress && key !== `${prefix}|${userAddress.toLowerCase()}`) continue;
                cache.delete(key);
            }
        }
    }

    // ----------------------------------------------------------------- txs

    /**
     * Deploy this channel's gate clone. The caller (our wallet) becomes the
     * gate owner. wireIdentity and readOnly are immutable for the life of the
     * gate — the contract is the authority on both; the stream-metadata flags
     * are cached copies for the Explore cards.
     *
     * @param {Object} [params] - Mode NONE (Closed) needs no token params
     * @returns {Promise<string>} The clone address (lowercase)
     */
    async createGate({ mode = GATE_MODE.NONE, token = ethers.ZeroAddress,
        minBalance = 0n, price = 0n, duration = 0n,
        wireIdentity = WIRE_IDENTITY.VISIBLE, readOnly = false } = {}) {
        const signer = await this._txSigner();
        const factory = new ethers.Contract(CONFIG.gate.factoryAddress, FACTORY_ABI, signer);
        const tx = await factory.createGate(mode, token, minBalance, price, duration, wireIdentity, readOnly);
        Logger.info('gate: createGate tx', tx.hash);
        const receipt = await tx.wait();
        const created = receipt.logs
            .map((log) => { try { return factory.interface.parseLog(log); } catch { return null; } })
            .find((parsed) => parsed?.name === 'GateCreated');
        if (!created) throw new Error('createGate: no GateCreated event in receipt');
        const gateAddress = created.args.gate.toLowerCase();
        Logger.info('gate: created', gateAddress, 'mode', Number(created.args.mode));
        return gateAddress;
    }

    async _ownerCall(gateAddress, method, args, invalidateUser = null) {
        const signer = await this._txSigner();
        const gate = new ethers.Contract(gateAddress, GATE_ABI, signer);
        const tx = await gate[method](...args);
        Logger.info(`gate: ${method} tx`, tx.hash);
        await tx.wait();
        this.invalidateAccess(gateAddress, invalidateUser);
    }

    /**
     * Closed (NONE) channels: admit a member. Reverts on-chain if the target
     * is banned — unban first, so re-admitting stays an explicit decision.
     */
    allow(gateAddress, userAddress) {
        return this._ownerCall(gateAddress, 'allow', [userAddress], userAddress);
    }

    /** Closed (NONE) channels: admit several members in one transaction. */
    allowBatch(gateAddress, userAddresses) {
        return this._ownerCall(gateAddress, 'allowBatch', [userAddresses]);
    }

    /**
     * Closed (NONE) channels: take a member off the allowlist without the ban
     * mark, so a later allow() readmits them. Cuts access, keys and transport
     * alike — the distinction from ban is the stigma, not the mechanics.
     */
    revokeAllow(gateAddress, userAddress) {
        return this._ownerCall(gateAddress, 'revokeAllow', [userAddress], userAddress);
    }

    /**
     * Cut access — and with it ingest — in any mode. Owner-only since v3;
     * moderators ban at the client layer (ADMIN_STATE / MOD_ACTION), never
     * on-chain.
     */
    ban(gateAddress, userAddress) {
        return this._ownerCall(gateAddress, 'ban', [userAddress], userAddress);
    }

    unban(gateAddress, userAddress) {
        return this._ownerCall(gateAddress, 'unban', [userAddress], userAddress);
    }

    /**
     * Appoint or dismiss a moderator (owner only). Appointing also allowlists
     * them on Closed gates — mirror the contract's semantics.
     */
    setModerator(gateAddress, userAddress, enabled) {
        return this._ownerCall(gateAddress, 'setModerator', [userAddress, enabled], userAddress);
    }

    /** PAID gates: change the price for future payments (owner only). */
    async setPrice(gateAddress, price) {
        await this._ownerCall(gateAddress, 'setPrice', [price]);
        this.invalidateInfo(gateAddress);
    }

    /** PAID gates: change the period for future payments (owner only). */
    async setDuration(gateAddress, duration) {
        await this._ownerCall(gateAddress, 'setDuration', [duration]);
        this.invalidateInfo(gateAddress);
    }

    // ----------------------------------------------------------- member txs

    async _memberCall(gateAddress, method, args = []) {
        const signer = await this._txSigner();
        const gate = new ethers.Contract(gateAddress, GATE_ABI, signer);
        const tx = await gate[method](...args);
        Logger.info(`gate: ${method} tx`, tx.hash);
        await tx.wait();
        this.invalidateAccess(gateAddress, signer.address);
        return signer.address.toLowerCase();
    }

    /**
     * PAID gates: pay for one subscription period (renewing early extends
     * from the current end). WPOL-priced gates wrap native POL to cover any
     * shortfall first; then the gate is approved for exactly `price` when the
     * standing allowance is short — three transactions worst case, one when
     * allowance and balance already cover it.
     *
     * @param {string} gateAddress
     * @param {function(string): void} [onStep] - 'wrap' | 'approve' | 'pay' progress
     * @returns {Promise<string>} The paying address (lowercase)
     */
    async pay(gateAddress, onStep = null) {
        // Always pay against the LIVE price: a cached one can be stale for up
        // to the TTL after a setPrice, and approving the old amount would
        // either revert the transfer or leave a dangling allowance.
        this.invalidateInfo(gateAddress);
        const info = await this.getGateInfo(gateAddress);
        const signer = await this._txSigner();
        const token = new ethers.Contract(info.token, TOKEN_ABI, signer);

        if (info.token === WRAPPED_NATIVE) {
            const balance = await token.balanceOf(signer.address);
            if (balance < info.price) {
                const shortfall = info.price - balance;
                const native = await signer.provider.getBalance(signer.address);
                if (native <= shortfall) {
                    throw new Error('Not enough POL to cover the subscription price');
                }
                onStep?.('wrap');
                const wrapper = new ethers.Contract(info.token, WRAPPED_NATIVE_ABI, signer);
                const wrapTx = await wrapper.deposit({ value: shortfall });
                Logger.info('gate: wrap POL tx', wrapTx.hash);
                await wrapTx.wait();
            }
        }

        const allowance = await token.allowance(signer.address, gateAddress);
        if (allowance < info.price) {
            onStep?.('approve');
            // USDT-style tokens revert on non-zero → non-zero approve
            if (allowance > 0n) {
                const resetTx = await token.approve(gateAddress, 0n);
                await resetTx.wait();
            }
            const approveTx = await token.approve(gateAddress, info.price);
            Logger.info('gate: approve tx', approveTx.hash);
            await approveTx.wait();
        }
        onStep?.('pay');
        return this._memberCall(gateAddress, 'pay');
    }

    /**
     * Explore card access info (N-D), as the 3-line pricing anatomy the
     * cards render: VERB (Subscribe = recurring payment, Hold = mere
     * possession — the semantic split users must get) / VALUE / QUALIFIER
     * ('in your wallet' says "you pay nothing" without a help sentence).
     * POL for WPOL-priced gates; NONE never lists (null parts). Both
     * reads cache.
     * @returns {Promise<{mode: number, verb: string|null, value: string|null, qualifier: string|null}>}
     */
    async gateCardInfo(gateAddress) {
        const info = await this.getGateInfo(gateAddress);
        if (info.mode === GATE_MODE.NONE) {
            return { mode: info.mode, verb: null, value: null, qualifier: null };
        }
        const meta = await this.getTokenMeta(info.token);
        const fmt = (value) => {
            const s = ethers.formatUnits(value, meta.decimals ?? 0);
            return s.endsWith('.0') ? s.slice(0, -2) : s;
        };
        if (info.mode === GATE_MODE.TOKEN_BALANCE) {
            return {
                mode: info.mode, verb: 'Hold',
                value: `${fmt(info.minBalance)} ${meta.symbol}`,
                qualifier: 'in your wallet'
            };
        }
        if (info.mode === GATE_MODE.NFT_OWNERSHIP) {
            return {
                mode: info.mode, verb: 'Hold',
                value: `${meta.symbol} NFT`,
                qualifier: 'in your wallet'
            };
        }
        const days = Number(info.duration) / 86400;
        const daysLabel = Number.isInteger(days) ? String(days) : days.toFixed(1);
        const paySymbol = info.token === WRAPPED_NATIVE ? 'POL' : meta.symbol;
        return {
            mode: info.mode, verb: 'Subscribe',
            value: `${fmt(info.price)} ${paySymbol}`,
            // "per" spells out the recurrence under SUBSCRIBE
            qualifier: daysLabel === '1' ? 'per day' : `per ${daysLabel} days`
        };
    }

    /**
     * Channel Details access line, by gate MODE (N-D): only Closed (NONE)
     * reads 'Verified Membership' — token/NFT show the condition, paid the
     * price/period, mirroring the Create modal's lineup. Both reads cache.
     */
    async gateAccessLabel(gateAddress) {
        const info = await this.getGateInfo(gateAddress);
        if (info.mode === GATE_MODE.NONE) return 'Verified Membership';
        const meta = await this.getTokenMeta(info.token);
        const fmt = (value) => {
            const s = ethers.formatUnits(value, meta.decimals ?? 0);
            return s.endsWith('.0') ? s.slice(0, -2) : s;
        };
        if (info.mode === GATE_MODE.TOKEN_BALANCE) {
            return `Gated · Hold ≥ ${fmt(info.minBalance)} ${meta.symbol}`;
        }
        if (info.mode === GATE_MODE.NFT_OWNERSHIP) {
            return `Gated · Hold ${meta.symbol} NFT`;
        }
        const days = Number(info.duration) / 86400;
        const daysLabel = Number.isInteger(days) ? String(days) : days.toFixed(1);
        // WPOL-priced gates display POL: pay() auto-wraps, so plain POL is
        // literally what the subscriber spends. PAID only — on a balance
        // gate WPOL and native POL are different holdings.
        const paySymbol = info.token === WRAPPED_NATIVE ? 'POL' : meta.symbol;
        return `Paid · ${fmt(info.price)} ${paySymbol} / ${daysLabel} ${daysLabel === '1' ? 'day' : 'days'}`;
    }

    /** Whether an address moderates this gate (v1 gates lack the getter → false). */
    async _isModerator(gateAddress, userAddress) {
        try {
            return await this._withProvider(() =>
                this._readContract(gateAddress).moderators(userAddress));
        } catch {
            return false;
        }
    }

    /** Whether the given address may manage this gate's membership. */
    async canModerate(gateAddress, userAddress) {
        if (!userAddress) return false;
        try {
            const info = await this.getGateInfo(gateAddress);
            if (info.owner === userAddress.toLowerCase()) return true;
        } catch { /* fall through to the moderator read */ }
        return this._isModerator(gateAddress, userAddress);
    }
}

export const gateManager = new GateManager();
