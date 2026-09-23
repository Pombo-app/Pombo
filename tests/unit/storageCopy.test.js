/**
 * A storage provider added to a live channel gets what the channel cannot run
 * without published again by its owner, and is asked for those exact rows
 * until it holds them. Only what is still missing there is published again.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../../src/js/logger.js', () => ({
    Logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }
}));

const OWNER = '0x' + 'aa'.repeat(20);
const STREAM = `${OWNER}/room-1`;
const ADMIN = `${OWNER}/room-3`;
const KEYS = `${OWNER}/room-4`;
const NEW_NODE = '0x' + 'bb'.repeat(20);

const resendChannelImage = vi.fn();
const publishPasswordChallenge = vi.fn();
vi.mock('../../src/js/streamr.js', () => ({
    streamrController: {
        resendChannelImage: (...args) => resendChannelImage(...args),
        publishPasswordChallenge: (...args) => publishPasswordChallenge(...args)
    },
    STREAM_CONFIG: {
        ADMIN_STREAM: { MODERATION: 0, CHANNEL_IMAGE: 1, PASSWORD_CHALLENGE: 2 },
        KEYS_STREAM: { KEY_EXCHANGE: 0 }
    },
    deriveAdminId: (id) => id.replace(/-1$/, '-3')
}));
vi.mock('../../src/js/auth.js', () => ({
    authManager: { getAddress: () => OWNER, signMessage: async () => '0xsig' }
}));
const probeStream = vi.fn();
const resolveProviders = vi.fn();
vi.mock('../../src/js/storageEndpoints.js', () => ({
    storageEndpoints: {
        probeStream: (...args) => probeStream(...args),
        resolveFresh: (...args) => resolveProviders(...args),
        hasFeature: () => true
    }
}));
const storedOn = vi.fn();
vi.mock('../../src/js/storagePurge.js', () => ({ storedOn: (...args) => storedOn(...args) }));
const republishAnchors = vi.fn();
const currentAnchorKeyIds = vi.fn();
vi.mock('../../src/js/epochKeyManager.js', () => ({
    epochKeyManager: {
        republishAnchors: (...args) => republishAnchors(...args),
        currentAnchorKeyIds: (...args) => currentAnchorKeyIds(...args),
        loadPersistedState: () => {}
    },
    usesEpochKeys: (channel) => !!channel?.gate?.address && !!channel?.keysStreamId
}));

const { StorageCopy } = await import('../../src/js/channels/StorageCopy.js');
const { CONFIG } = await import('../../src/js/config.js');

const node = (features = ['stored'], answered = true) =>
    ({ nodeAddress: NEW_NODE, urls: ['https://new.example'], features: new Set(features), answered });

let manager;
let channel;
let copy;
let clock;
let held;   // rows the new provider holds: `${streamId}|${partition}|${ts}`

beforeEach(() => {
    localStorage.clear();
    [resendChannelImage, publishPasswordChallenge, probeStream, storedOn, republishAnchors].forEach((f) => f.mockReset());
    resendChannelImage.mockResolvedValue(null);
    clock = 1000;
    held = new Set();
    channel = {
        messageStreamId: STREAM,
        adminStreamId: ADMIN,
        keysStreamId: KEYS,
        type: 'gated',
        gate: { address: '0x' + 'cc'.repeat(20) },
        adminLoaded: true,
        adminRev: 4,
        adminSnapshot: { bannedMembers: [], hiddenMessageIds: [], pins: ['m1'] }
    };
    manager = {
        channels: new Map([[STREAM, channel]]),
        isChannelOwner: vi.fn(() => true),
        notifyHandlers: vi.fn(),
        bootstrapAdminState: vi.fn(async () => {}),
        publishAdminState: vi.fn(async () => ({ published: { timestamp: ++clock, sequenceNumber: 0 } })),
        ttlRepublish: { republishImage: vi.fn(async () => ({ timestamp: ++clock, sequenceNumber: 0 })) }
    };
    republishAnchors.mockImplementation(async () => [
        { partition: 0, timestamp: ++clock, sequenceNumber: 0 },
        { partition: 0, timestamp: ++clock, sequenceNumber: 0 }
    ]);
    probeStream.mockResolvedValue([node()]);
    storedOn.mockImplementation(async (_providers, streamId, partition, targets) =>
        new Set(targets
            .filter((t) => held.has(`${streamId}|${partition}|${t.timestamp}`))
            .map((t) => `${t.timestamp}:${t.sequenceNumber}`)));
    copy = new StorageCopy(manager, { sleep: async () => {} });
});

/** The new provider stores whatever is published from now on. */
function providerStoresEverything() {
    republishAnchors.mockImplementation(async () => {
        const refs = [{ partition: 0, timestamp: ++clock, sequenceNumber: 0 }];
        refs.forEach((r) => held.add(`${KEYS}|0|${r.timestamp}`));
        return refs;
    });
    manager.publishAdminState.mockImplementation(async () => {
        const ts = ++clock;
        held.add(`${ADMIN}|0|${ts}`);
        return { published: { timestamp: ts, sequenceNumber: 0 } };
    });
    manager.ttlRepublish.republishImage.mockImplementation(async () => {
        const ts = ++clock;
        held.add(`${ADMIN}|1|${ts}`);
        return { timestamp: ts, sequenceNumber: 0 };
    });
}

describe('StorageCopy.prepare()', () => {
    it('reads the admin state and the image before the provider is added', async () => {
        channel.adminLoaded = false;
        resendChannelImage.mockResolvedValue({ data: 'data:image/png;base64,AA', hash: '0xh' });

        const snapshot = await copy.prepare(STREAM);

        expect(manager.bootstrapAdminState).toHaveBeenCalledWith(STREAM, ADMIN, null);
        expect(snapshot.image).toMatchObject({ hash: '0xh' });
    });

    it('prepares nothing for an account that does not own the channel', async () => {
        manager.isChannelOwner.mockReturnValue(false);

        expect(await copy.prepare(STREAM)).toBeNull();
        expect(resendChannelImage).not.toHaveBeenCalled();
    });
});

describe('StorageCopy.copyTo()', () => {
    it('publishes the anchors and confirms them on the new provider', async () => {
        providerStoresEverything();

        const outcome = await copy.copyTo(STREAM, NEW_NODE, { image: { data: 'x', hash: '0xh' } });

        expect(outcome).toBe('present');
        expect(republishAnchors).toHaveBeenCalledWith(channel);
        expect(manager.publishAdminState).toHaveBeenCalledWith(STREAM, { state: channel.adminSnapshot });
        expect(manager.ttlRepublish.republishImage).toHaveBeenCalledTimes(1);
        expect(manager.notifyHandlers).toHaveBeenCalledWith('storage_copy_confirmed', { streamId: STREAM, node: NEW_NODE });
        expect(copy.pending(STREAM)).toEqual([]);
    });

    it('asks the new provider, and only it, for the rows it was sent', async () => {
        providerStoresEverything();

        await copy.copyTo(STREAM, NEW_NODE, null);

        for (const [providers] of storedOn.mock.calls) {
            expect(providers.map((p) => p.nodeAddress)).toEqual([NEW_NODE]);
        }
    });

    it('publishes again only what the provider still lacks', async () => {
        providerStoresEverything();
        let adminLost = true;
        manager.publishAdminState.mockImplementation(async () => {
            const ts = ++clock;
            if (!adminLost) held.add(`${ADMIN}|0|${ts}`);
            adminLost = false;
            return { published: { timestamp: ts, sequenceNumber: 0 } };
        });

        const outcome = await copy.copyTo(STREAM, NEW_NODE, null);

        expect(outcome).toBe('present');
        expect(manager.publishAdminState).toHaveBeenCalledTimes(2);
        expect(republishAnchors).toHaveBeenCalledTimes(1);
    });

    it('keeps the copy pending, and says so, when the provider never holds it', async () => {
        const outcome = await copy.copyTo(STREAM, NEW_NODE, null);

        expect(outcome).toBe('missing');
        expect(republishAnchors).toHaveBeenCalledTimes(CONFIG.subscriptions.storageCopyRepublishLimit + 1);
        expect(copy.pending(STREAM)).toEqual([NEW_NODE]);
        expect(manager.notifyHandlers).toHaveBeenCalledWith('storage_copy_unconfirmed', { streamId: STREAM, node: NEW_NODE });
    });

    it('keeps asking while the new provider is not listed yet', async () => {
        providerStoresEverything();
        probeStream.mockResolvedValueOnce([]).mockResolvedValue([node()]);

        expect(await copy.copyTo(STREAM, NEW_NODE, null)).toBe('present');
    });

    it('stops at a provider that cannot say what it holds', async () => {
        probeStream.mockResolvedValue([node(['signedReads'])]);

        const outcome = await copy.copyTo(STREAM, NEW_NODE, null);

        expect(outcome).toBe('unverifiable');
        expect(copy.pending(STREAM)).toEqual([]);
        expect(manager.notifyHandlers).toHaveBeenCalledWith('storage_copy_unverifiable', { streamId: STREAM, node: NEW_NODE });
    });

    it('keeps the copy pending for a provider that does not answer', async () => {
        probeStream.mockResolvedValue([node([], false)]);

        const outcome = await copy.copyTo(STREAM, NEW_NODE, null);

        expect(outcome).toBe('missing');
        expect(copy.pending(STREAM)).toEqual([NEW_NODE]);
        expect(manager.notifyHandlers).toHaveBeenCalledWith('storage_copy_unconfirmed', { streamId: STREAM, node: NEW_NODE });
    });

    it('counts an item that failed to publish as missing, and publishes it again', async () => {
        providerStoresEverything();
        manager.publishAdminState
            .mockRejectedValueOnce(new Error('No epoch key'));

        const outcome = await copy.copyTo(STREAM, NEW_NODE, null);

        expect(outcome).toBe('present');
        expect(manager.publishAdminState).toHaveBeenCalledTimes(2);
    });

    it('copies the password challenge of a password channel', async () => {
        providerStoresEverything();
        channel.type = 'password';
        channel.gate = null;
        channel.password = 'pw';
        publishPasswordChallenge.mockImplementation(async () => {
            const ts = ++clock;
            held.add(`${ADMIN}|2|${ts}`);
            return { timestamp: ts, sequenceNumber: 3 };
        });

        expect(await copy.copyTo(STREAM, NEW_NODE, null)).toBe('present');
        expect(publishPasswordChallenge).toHaveBeenCalledWith(ADMIN, 'pw');
        expect(republishAnchors).not.toHaveBeenCalled();
    });
});

describe('StorageCopy.resume()', () => {
    it('runs a pending copy again when the owner opens the channel', async () => {
        providerStoresEverything();
        localStorage.setItem('pombo_storage_copy_pending', JSON.stringify({ [`${OWNER}|${STREAM}`]: [NEW_NODE] }));

        await copy.resume(STREAM);

        expect(manager.notifyHandlers)
            .toHaveBeenCalledWith('storage_copy_confirmed', { streamId: STREAM, node: NEW_NODE });
        expect(copy.pending(STREAM)).toEqual([]);
    });
});

describe('StorageCopy.ensureRemainingHold()', () => {
    const OLD = { nodeAddress: '0x' + 'dd'.repeat(20), urls: ['https://old.example'] };
    const STAYING = { nodeAddress: NEW_NODE, urls: ['https://new.example'] };
    const ANNOUNCE = { content: { t: 'key_announce', epoch: 7, keyId: '7.cur' } };
    const SEALED = { content: { e: 'epoch-aes-gcm' } };
    let serves;   // `${url}|${streamId}|${partition}` → rows that provider serves

    const serve = (provider, streamId, partition, rows) =>
        serves.set(`${provider.urls[0]}|${streamId}|${partition}`, rows);

    beforeEach(() => {
        serves = new Map();
        resolveProviders.mockResolvedValue([OLD, STAYING]);
        currentAnchorKeyIds.mockReturnValue(['7.cur']);
        globalThis.fetch = vi.fn(async (url) => {
            const [, base, streamId, partition] =
                url.match(/^(https:\/\/[^/]+)\/streams\/([^/]+)\/data\/partitions\/(\d+)\/last/);
            const rows = serves.get(`${base}|${decodeURIComponent(streamId)}|${partition}`) || [];
            return { ok: true, json: async () => rows };
        });
        serve(OLD, KEYS, 0, [ANNOUNCE]);
        serve(OLD, ADMIN, 0, [SEALED]);
    });

    it('lets the removal go on when the provider that stays holds everything', async () => {
        serve(STAYING, KEYS, 0, [ANNOUNCE]);
        serve(STAYING, ADMIN, 0, [SEALED]);

        await copy.ensureRemainingHold(STREAM, OLD.nodeAddress);

        expect(republishAnchors).not.toHaveBeenCalled();
    });

    it('copies what the provider that stays lacks, then lets the removal go on', async () => {
        providerStoresEverything();
        serve(STAYING, ADMIN, 0, [SEALED]);
        republishAnchors.mockImplementation(async () => {
            serve(STAYING, KEYS, 0, [ANNOUNCE]);
            const ts = ++clock;
            held.add(`${KEYS}|0|${ts}`);
            return [{ partition: 0, timestamp: ts, sequenceNumber: 0 }];
        });

        await copy.ensureRemainingHold(STREAM, OLD.nodeAddress);

        expect(republishAnchors).toHaveBeenCalledTimes(1);
        expect(manager.notifyHandlers).toHaveBeenCalledWith('storage_copy_before_remove', { streamId: STREAM });
    });

    it('refuses the removal while the provider that stays still lacks it', async () => {
        await expect(copy.ensureRemainingHold(STREAM, OLD.nodeAddress)).rejects.toThrow(/was not removed/);
    });

    it('asks for the image only when the provider leaving serves one', async () => {
        serve(STAYING, KEYS, 0, [ANNOUNCE]);
        serve(STAYING, ADMIN, 0, [SEALED]);
        serve(OLD, ADMIN, 1, [SEALED]);

        await expect(copy.ensureRemainingHold(STREAM, OLD.nodeAddress)).rejects.toThrow(/was not removed/);
    });

    it('protects nothing when the provider leaving is the last one', async () => {
        resolveProviders.mockResolvedValue([OLD]);

        await copy.ensureRemainingHold(STREAM, OLD.nodeAddress);

        expect(globalThis.fetch).not.toHaveBeenCalled();
    });

    it('refuses the removal when the providers of the channel cannot be read', async () => {
        resolveProviders.mockRejectedValue(new Error('Graph API error: 503'));

        await expect(copy.ensureRemainingHold(STREAM, OLD.nodeAddress)).rejects.toThrow(/was not removed/);
        expect(globalThis.fetch).not.toHaveBeenCalled();
    });

    it('refuses the removal while a provider still waiting for its copy is not listed yet', async () => {
        resolveProviders.mockResolvedValue([OLD]);
        copy._setPending(STREAM, NEW_NODE, true);

        await expect(copy.ensureRemainingHold(STREAM, OLD.nodeAddress)).rejects.toThrow(/not confirmed yet/);
    });

    it('checks nothing for an account that does not own the channel', async () => {
        manager.isChannelOwner.mockReturnValue(false);

        await copy.ensureRemainingHold(STREAM, OLD.nodeAddress);

        expect(resolveProviders).not.toHaveBeenCalled();
    });
});
