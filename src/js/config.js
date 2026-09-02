/**
 * Application Configuration
 * Centralized configuration for network, retry logic, and app settings
 */

// Polygon RPC endpoints, in the default order of preference. The user's
// selection in Settings is an ordered subset of these plus an optional custom
// URL: what is enabled is exactly what gets used, and the first one is the
// preferred one.
//
// `webviewSafe` records whether the endpoint answers CORS from the Android
// bridge's https://pombo.local origin. That property is independent from being
// alive: an endpoint can serve everyone and still be down, or be up and refuse
// the origin. Only the Android client is constrained by it.
export const RPC_ENDPOINTS = [
    { key: 'drpc', name: 'dRPC', url: 'https://polygon.drpc.org', webviewSafe: true },
    { key: 'publicnode', name: 'PublicNode', url: 'https://polygon-bor-rpc.publicnode.com', webviewSafe: true },
    { key: 'tenderly', name: 'Tenderly', url: 'https://polygon.gateway.tenderly.co', webviewSafe: true },
    { key: '1rpc', name: '1RPC (Privacy)', url: 'https://1rpc.io/matic', webviewSafe: true }
];

/** The custom URL is a row of its own, orderable and toggleable like the rest. */
export const RPC_CUSTOM_KEY = 'custom';

/** Enabled out of the box: two providers, so one going down is not an outage. */
export const RPC_DEFAULT_ENABLED = ['drpc', 'publicnode'];

export const CONFIG = {
    // Polygon Network Configuration
    network: {
        chainId: 137,
        name: 'Polygon Mainnet',
        currency: {
            name: 'POL',
            symbol: 'POL',
            decimals: 18
        },
        // Advertised to the wallet in wallet_addEthereumChain, so it stays the
        // plain list of every endpoint rather than the user's selection.
        rpcEndpoints: RPC_ENDPOINTS.map(e => e.url),
        blockExplorer: 'https://polygonscan.com',
        // Ethereum mainnet providers for ENS resolution 
        ensProviderUrls: [
            'https://ethereum-rpc.publicnode.com',
            'https://eth.meowrpc.com',
            'https://eth.llamarpc.com',
            'https://eth.drpc.org',
            'https://cloudflare-eth.com'
        ],
        rpcTimeoutMs: 5000,            // Per-call HTTP RPC timeout (GasEstimator)
        fallbackGasPriceGwei: 120      // Fallback gas price when all RPCs fail
    },

    // Retry Configuration
    retry: {
        maxAttempts: 7,
        baseDelayMs: 3000,
        // Multiplier for exponential backoff: delay = baseDelay * multiplier^(attempt-1)
        backoffMultiplier: 2
    },

    // Stream Configuration
    stream: {
        // Number of messages to load on join (includes edits/deletes/reactions)
        initialMessages: 50,
        // Number of messages to load on scroll
        loadMoreCount: 50,
        // Message stream partitions
        messagePartitions: 1,
        // Ephemeral stream partitions (control + media)
        ephemeralPartitions: 2
    },

    // Storage Providers
    storage: {
        // Default provider: 'streamr' or 'custom'
        defaultProvider: 'streamr',
        // Default retention days for Streamr storage
        defaultRetentionDays: 180,
        // TTL-aware republish on owner open (see docs/TTL_REPUBLISH_PLAN.md):
        // when a retained -3 artifact (ADMIN_STATE / CHANNEL_IMAGE /
        // PASSWORD_CHALLENGE) is older than this fraction of the channel's
        // storage TTL, the owner republishes it to reset the retention clock.
        ttlRepublishAgeFraction: 0.8
    },

    // On-chain channel gates (PomboGate, N-C). One EIP-1167 clone per gated
    // channel; the clone address is the channel's publisher id and its
    // isValidSignature/checkAccess drive envelope validation and epoch-key
    // distribution. See docs/UNIFIED_IMPLEMENTATION_PLAN.md §7.11.
    gate: {
        // PomboGateFactory v3 on Polygon PoS (pre-audit deploy, 2026-09-02).
        // v3 is the single gate: isValidSignature answers checkAccess plus
        // the read-only filter, so lapsed access cuts publishing at ingest.
        // No legacy: v1/v2 gates are not supported and their channels are
        // expected to be recreated.
        factoryAddress: '0x7DeA564Acff815cc34aC79329a83A91244207253',
        // checkAccess eth_call cache — mirrors the SDK's own ERC-1271 TTL
        checkAccessCacheMs: 10 * 60 * 1000,
        // Live messages may use the previous epoch's kid for this long after
        // a rotation (the "short tolerance" of the kid freshness rule)
        kidFreshnessToleranceMs: 10 * 60 * 1000,
        // Quick-pick tokens for the create modal (N-D), Polygon PoS mainnet.
        // POL diverges by context: 0x…1010 is Polygon's system contract for
        // the NATIVE coin — its balanceOf mirrors the native balance, so
        // balance gates work, but it has no usable transferFrom, so pay()
        // would always revert — hence WPOL on the paid side. Payers holding
        // only plain POL are covered: pay() auto-wraps the shortfall.
        tokenPresets: {
            gate: {
                pol: { label: 'POL', address: '0x0000000000000000000000000000000000001010' },
                usdc: { label: 'USDC', address: '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359' },
                data: { label: 'DATA', address: '0x3a9A81d576d83FF21f26f325066054540720fC34' }
            },
            pay: {
                pol: { label: 'POL (wrapped)', address: '0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270' },
                usdc: { label: 'USDC', address: '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359' },
                data: { label: 'DATA', address: '0x3a9A81d576d83FF21f26f325066054540720fC34' }
            }
        }
    },

    // DM Configuration
    dm: {
        // Deterministic stream path prefix
        streamPrefix: 'Pombo-DM',
        // Max conversations stored locally
        maxConversations: 100,
        // Max sent messages per conversation (local storage)
        maxSentMessages: 200,
        // Inbox history to load on login
        inboxHistoryCount: 100,
        // Number of inbox messages to fetch per pagination request
        loadMoreCount: 100,
        // Time window (ms) per pagination search (7 days)
        searchWindowMs: 7 * 24 * 3600 * 1000,
    },

    // Channel Settings
    channels: {
        reactionDebounceMs: 500,       // Minimum time between same reaction sends
        onlineTimeoutMs: 25000,        // 25s to consider user offline (5x heartbeat)
        maxRetries: 3,                 // Message publish retry limit
        retryDelayMs: 2000,            // Delay between retries
        batchWindowMs: 100,            // Window to collect messages for batch verification
        batchMaxSize: 50,              // Maximum batch size before flushing
        accessHeartbeatMs: 15000,      // Interval for persisting channel access (lastAccess)
        latestMessageFetchLast: 10 // Latest-message preview window (P0 holds messages + reactions; need a margin to find a non-reaction entry)
    },

    // Identity & ENS
    identity: {
        ensCacheDurationMs: 24 * 60 * 60 * 1000,      // 24h ENS cache
        ensNullCacheDurationMs: 15 * 60 * 1000,        // 15min cache for null ENS results
        maxEnsCacheSize: 500,                          // Max cached ENS entries
        messageTimestampToleranceMs: 5 * 60 * 1000,    // 5min replay-attack window
        providerCooldownMs: 5 * 60 * 1000,             // Skip failed ENS provider for 5min
        // Privacy: every reverse lookup tells the RPC operator who you talk to.
        // Each real lookup is accompanied by this many throwaway ones, so the
        // operator sees N+1 addresses and cannot tell which is real. Same
        // k-anonymity idea as push.tagBytes. Set to 0 to disable.
        //
        // Kept at 2 because the free ENS tiers 429 easily: cover is fired once
        // per resolution (not per provider), but a null result still walks all
        // providers, so the ceiling is N+numProviders requests.
        ensDecoyCount: 2,
        ensQueueGapMs: 250,                            // Gap between background ENS lookups
        ipfsGateway: 'https://ipfs.io/ipfs/' // Gateway for ipfs:// avatar URIs (cloudflare-ipfs.com is dead)
    },

    // Media / File Transfer
    media: {
        maxImageCacheBytes: 100 * 1024 * 1024,            // 100MB max image cache in memory
        imageMaxWidth: 1280,
        imageMaxHeight: 720,
        imageQuality: 0.92,
        imageMaxAssembledBytes: 1 * 1024 * 1024,          // 1MB max mounted chat image payload (jpg/png/webp)
        imageGifMaxAssembledBytes: 5 * 1024 * 1024,       // 5MB max for animated GIFs (cannot be re-compressed without losing animation)
        imagePayloadMaxBytes: 220 * 1024,                 // Max per stored image manifest/chunk payload
        imagePayloadSafetyMarginBytes: 1024,              // Headroom while sizing JSON payload chunks
        imageChunkInitialRawBytes: 150 * 1024,            // Starting raw chunk size before payload measurement
        imageChunkMinRawBytes: 16 * 1024,                 // Smallest raw chunk size before failing
        imageAssemblyTtlMs: 10 * 60 * 1000,               // Keep partial image chunk assemblies for 10 minutes
        // Chunked-image recovery (paginate to fill manifests whose chunks
        // fell outside the initial resend window). See
        // channels.recoverIncompleteImages / preview equivalent.
        recoveryMaxRounds: 20,                            // Max pagination rounds per recovery pass
        recoveryStagnantRoundsLimit: 3,                   // Abort after N consecutive rounds with no progress
        // Targeted window recovery: storage range resends can be silently
        // truncated (WS drop mid-iteration → short response, no error).
        // Before giving up, re-query a small window around each incomplete
        // manifest's timestamp — chunks are always published moments before
        // their manifest. Each attempt opens a fresh storage connection.
        recoveryWindowMs: 15 * 60 * 1000,                 // Window size around the manifest timestamp
        recoveryWindowForwardMarginMs: 60 * 1000,         // Forward margin past the manifest timestamp
        recoveryWindowAttempts: 3,                        // Fresh resend attempts per incomplete image
        recoverySignatureRaceWaitMs: 300,                 // Wait for async signature verification before scanning (TODO: replace with deterministic signal from identityManager)
        recoveryScrollChainCap: 4,                        // Auto-chain consecutive scroll-load batches that yielded 0 visible messages
        jpegInitialQuality: 1.0,
        jpegMinQuality: 0.68,
        webpInitialQuality: 1.0,
        webpMinQuality: 0.68,
        imageResolutionScales: [1, 0.85, 0.72, 0.6, 0.5, 0.4],
        allowJpegToWebpFallback: true,
        forcePngToWebpOnOverflow: true,
        failGifOnOverflow: true,
        legacyImageReadEnabled: true,
        legacyInlineImageWriteEnabled: false,
        pieceSize: 220 * 1024,                  // 220KB chunks
        pieceSendDelayMs: 5,                    // 5ms delay between piece sends
        concurrentSends: 25,                     // Parallel Streamr publishes (bounded concurrency)
        pieceRequestTimeoutMs: 5000,            // 5s per piece retry timeout
        maxPieceFailures: 5,                    // Give up on a piece after N bad deliveries (stops retry loops)
        maxSeederStrikes: 3,                    // Drop a seeder from this transfer after N bad pieces
        speedWindowMs: 10000,                   // Sliding window for the displayed transfer rate
        leecherTimeoutMs: 15000,                // A leecher that has not asked for this long is dropped from the count
        uploadStatsIntervalMs: 500,             // Throttle for upload stat updates (one per piece would be a flood)
        // Adaptive request window (AIMD). Transfers are pull-based: the leecher
        // asks each seeder for specific pieces, so the number of outstanding
        // requests IS the flow control — the request is the credit. The window
        // grows by one per delivered piece and halves on a timeout.
        pieceWindowStart: 8,                    // Initial outstanding piece requests
        pieceWindowMin: 4,                      // Never back off below this
        pieceWindowMax: 64,                     // ~14MB in flight at 220KB pieces
        pieceWindowBackoffCooldownMs: 5000,     // Treat a burst of timeouts as one stall
        maxFileSize: 500 * 1024 * 1024,        // 500MB max upload
        minSeeders: 1,
        preferredSeeders: 3,
        seederRequestIntervalMs: 1000,
        seederDiscoveryTimeoutMs: 30000,
        seederRefreshIntervalMs: 10000,
        maxSeederRequests: 10,
        maxSeedStorage: 700 * 1024 * 1024,     // 700MB persistent storage
        seedFilesExpireDays: 7,
        pieceExpireDays: 3                      // Sweep pieces of downloads abandoned this long ago
    },

    // Persistent File Sharing via storage nodes (engine ported from index.storage.html)
    storageMedia: {
        // Max 240 KB: node-to-node the transport limit is 1 MiB, but publishing FROM
        // THE BROWSER goes over WebRTC/SCTP whose negotiated maxMessageSize is
        // typically 256 KiB — above that the send fails or is silently dropped.
        chunkKB: 240,
        faststart: true,               // Remux MP4-likes (moov first) before chunking — flip off if it misbehaves
        throttleMs: 100,               // Base send spacing when auto-tune is off
        parallel: 1,                   // Publish workers (auto-tune drives the real rate)
        autotune: true,                // Dynamic rate oscillator (search/cut/drain/climb/hold)
        verify: true,                  // Incremental verify & repair after publish
        secondChance: true,            // Pre-repair drain loop while the cluster catches up
        warmUpWaitMs: 2000,            // Wait after 1-byte pings before first real publish
        rateWindowMs: 10000,           // Sliding window for displayed transfer rates
        endpointCacheTtlMs: 10 * 60 * 1000,  // On-chain storage endpoint cache TTL
        nodeFailureLimit: 3,           // Consecutive failures before a node leaves the rotation
        // Download
        downloadConcurrencyDesktop: 5,
        downloadConcurrencyMobile: 3,
        writeBackpressureDesktopMB: 48,
        writeBackpressureMobileMB: 12,
        downloadRetryPasses: 3,
        resendIdleTimeoutMs: 20000,    // SDK-resend fallback inactivity cutoff
        directFetchTimeoutMs: 120000   // Direct HTTP read inactivity watchdog
    },

    // Subscription Manager / Polling
    subscriptions: {
        pollIntervalMs: 30000,         // 30s between background polls
        pollBatchSize: 3,              // Channels per poll cycle
        pollStaggerDelayMs: 2000,      // Delay between channel checks
        minPollIntervalMs: 10000,      // Minimum time between checks for same channel
        maxConcurrentSubs: 1,          // Only 1 full subscription at a time
        activityCheckMessages: 3,      // Messages to fetch for activity check
        previewPresenceIntervalMs: 20000, // Presence broadcast interval in preview
        initialPollDelayMs: 5000,      // Delay before first background poll
        maxPresenceFailures: 3,        // Stop preview presence after N consecutive failures
        adminPollIntervalMs: 30000     // Poll interval for admin-state resend 
    },

    // Push Notifications
    push: {
        // Single stream for push notifications (MVP)
        pushStreamId: '0xae340e799e8151f6a4999d245e466197aa217667/push',
        // List of known relays
        relays: [
            {
                name: 'Pombo Relay 1',
                address: '0x905309e8b4d22a02b08459f42a203c7265abd3ad',
                vapidPublicKey: 'BFsT-uCydgNHZA4r3_vKo2JRyTr0EwziKbJl6rNUNKtbSJLNOzA7Vxm81mVADuitIllOp_HI8fpvBNayOb8BDtY'
            }
        ],
        tagBytes: 1,                   // K-anonymity tag size (256 possible tags)
        powDifficulty: 4,              // PoW leading zeros required
        powMaxTimeMs: 15000,           // Max PoW computation time
        powYieldInterval: 10000,       // Yield to UI every N iterations
        reRegistrationIntervalMs: 6 * 60 * 60 * 1000  // 6h token refresh
    },

    // Notifications UI
    notifications: {
        inviteToastDurationMs: 15000   // Invite toast display duration
    },

    // Cryptography
    crypto: {
        pbkdf2Iterations: 310000       // PBKDF2 key derivation iterations
    },

    // Graph API
    graph: {
        cacheDurationMs: 30000         // 30s query result cache
    },

    // Explore / Channel Discovery Curation
    explore: {
        manifestUrl: '/curation/explore.json',
        cacheTtlMs: 5 * 60 * 1000      // 5min in-memory manifest cache
    },

    // LocalStorage Key Registry
    // Single source of truth for all `pombo_*` keys. Functions normalize
    // addresses to lowercase to prevent case-drift silently splitting state.
    storageKeys: {
        // Static keys (no per-account scoping)
        keystores: 'pombo_keystores',
        rpcPreference: 'pombo_rpc_preference',
        // Plain mirror of the encrypted "ENS Avatars" setting ('0' = off). Device
        // global, not per address: the renderer only knows whose face it draws,
        // never who is looking, and the unlock/account modals draw avatars
        // before any account is unlocked.
        ensAvatarsEnabled: 'pombo_ens_avatars_enabled',
        pushRegistration: 'pombo_push_registration',
        pushRegistrationChannels: (addr) =>
            addr ? `pombo_push_registration_channels_${addr.toLowerCase()}`
                 : 'pombo_push_registration_channels',
        pushRegistrationNativeChannels: (addr) =>
            addr ? `pombo_push_registration_native_channels_${addr.toLowerCase()}`
                 : 'pombo_push_registration_native_channels',
        // Gated channels this DEVICE answers key requests for (the owner
        // key-responder). Local-only on purpose: a synced duty would
        // surprise-drain every device of the account.
        keyResponderChannels: (addr) =>
            addr ? `pombo_key_responder_channels_${addr.toLowerCase()}`
                 : 'pombo_key_responder_channels',

        // Per-address keys (address is normalized to lowercase)
        secure: (addr) => `pombo_secure_${addr.toLowerCase()}`,
        ens: (addr) => `pombo_ens_${addr.toLowerCase()}`,
        ensAvatar: (addr) => `pombo_ens_avatar_${addr.toLowerCase()}`,
        username: (addr) => `pombo_username_${addr.toLowerCase()}`,
        invites: (addr) => `pombo_invites_${addr.toLowerCase()}`,
        invitesMuted: (addr) => `pombo_invites_muted_${addr.toLowerCase()}`,
        dmPush: (addr) => `pombo_dm_push_${addr.toLowerCase()}`,
        syncDirty: (addr) => `pombo_sync_dirty_${addr.toLowerCase()}`,
        syncMode: (addr) => `pombo_sync_mode_${addr.toLowerCase()}`,
        syncAppliedTs: (addr) => `pombo_sync_applied_ts_${addr.toLowerCase()}`,

        // Per-stream keys
        channelAccess: (streamId) => `pombo_channel_access_${streamId}`
    },

    // Application Metadata
    app: {
        name: 'pombo',
        version: '1'
    }
};

/**
 * The saved RPC selection: every known row in the user's order, each flagged
 * on or off, plus the custom URL.
 *
 * Rows are seeded from RPC_ENDPOINTS, so a key dropped from the code
 * disappears from a saved selection on the next read, and an endpoint added to
 * the code arrives at the end and disabled. Enabling one has to stay a
 * deliberate act: it decides who the user talks to.
 *
 * @returns {{rows: Array<{key: string, on: boolean}>, customUrl: string}}
 */
export function loadRpcSelection() {
    let saved = null;
    try {
        saved = JSON.parse(localStorage.getItem(CONFIG.storageKeys.rpcPreference) || 'null');
    } catch (e) {
        saved = null;
    }
    return normalizeRpcSelection(saved && saved.v === 2 ? saved : migrateRpcPreference(saved));
}

/**
 * Turn the pre-selection setting (one preset key plus a custom URL) into a set.
 * 'auto' stood for every endpoint, a provider key for that one alone, 'custom'
 * for the URL.
 */
function migrateRpcPreference(pref) {
    const preset = pref && typeof pref.preset === 'string' ? pref.preset : null;
    const customUrl = pref && typeof pref.customUrl === 'string' ? pref.customUrl : '';
    if (!preset) return { v: 2, rows: [], customUrl };
    if (preset === 'auto') {
        return { v: 2, rows: RPC_ENDPOINTS.map(e => ({ key: e.key, on: true })), customUrl };
    }
    if (preset === RPC_CUSTOM_KEY) {
        return { v: 2, rows: [{ key: RPC_CUSTOM_KEY, on: !!customUrl.trim() }], customUrl };
    }
    return { v: 2, rows: [{ key: preset, on: true }], customUrl };
}

/** Fill in the rows the code knows about and drop the ones it does not. */
function normalizeRpcSelection(sel) {
    const savedRows = Array.isArray(sel && sel.rows) ? sel.rows : [];
    const customUrl = typeof (sel && sel.customUrl) === 'string' ? sel.customUrl.trim() : '';
    const known = new Set(RPC_ENDPOINTS.map(e => e.key).concat(RPC_CUSTOM_KEY));

    const rows = [];
    const placed = new Set();
    for (const row of savedRows) {
        if (!row || !known.has(row.key) || placed.has(row.key)) continue;
        placed.add(row.key);
        rows.push({ key: row.key, on: !!row.on });
    }
    for (const e of RPC_ENDPOINTS) {
        if (!placed.has(e.key)) rows.push({ key: e.key, on: false });
    }

    // The custom endpoint is a row only once one exists: an empty row that can
    // never be ticked is furniture, not a choice.
    const custom = rows.filter(r => r.key === RPC_CUSTOM_KEY);
    const withoutCustom = rows.filter(r => r.key !== RPC_CUSTOM_KEY);
    const ordered = customUrl ? rows : withoutCustom;
    if (customUrl && custom.length === 0) ordered.push({ key: RPC_CUSTOM_KEY, on: true });

    // An empty or all-off selection leaves the app with nowhere to go, so it
    // reads as the default rather than as a choice.
    if (!ordered.some(r => r.on)) {
        for (const r of ordered) r.on = RPC_DEFAULT_ENABLED.includes(r.key);
    }
    return { rows: ordered, customUrl };
}

/** @param {{rows: Array<{key: string, on: boolean}>, customUrl: string}} sel */
export function saveRpcSelection(sel) {
    localStorage.setItem(CONFIG.storageKeys.rpcPreference, JSON.stringify({
        v: 2,
        rows: sel.rows.map(r => ({ key: r.key, on: !!r.on })),
        customUrl: (sel.customUrl || '').trim()
    }));
}

/**
 * The URLs a selection stands for, in order. A custom row with no URL behind
 * it contributes nothing.
 * @returns {string[]}
 */
export function rpcSelectionUrls(sel) {
    const byKey = new Map(RPC_ENDPOINTS.map(e => [e.key, e.url]));
    const urls = [];
    for (const row of sel.rows) {
        if (!row.on) continue;
        const url = row.key === RPC_CUSTOM_KEY ? (sel.customUrl || '').trim() : byKey.get(row.key);
        if (url) urls.push(url);
    }
    return urls;
}

/**
 * RPC endpoints for the Streamr SDK, in the user's order of preference.
 * @returns {Array<{url: string}>}
 */
export function getRpcEndpoints() {
    return rpcSelectionUrls(loadRpcSelection()).map(url => ({ url }));
}

/**
 * Get network configuration for wallet connection
 * @returns {Object} - Network params for wallet_addEthereumChain
 */
export function getNetworkParams() {
    return {
        chainId: `0x${CONFIG.network.chainId.toString(16)}`,
        chainName: CONFIG.network.name,
        nativeCurrency: CONFIG.network.currency,
        rpcUrls: CONFIG.network.rpcEndpoints,
        blockExplorerUrls: [CONFIG.network.blockExplorer]
    };
}
