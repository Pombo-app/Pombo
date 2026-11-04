/**
 * Channel Health: what a channel's streams must look like for its type, what
 * the chain says they look like, and the steps that close the gap.
 *
 * Every check is true, false, or null when the chain did not answer. Only a
 * false is a finding and only a false is repaired: an RPC that failed is not
 * a stream that is missing.
 *
 * Shared Sealed keys are not checked here: their addresses rotate, and the
 * rekey tools own them. The clone is, and in Sealed it must not publish on
 * the -1/-2 (a grant it never uses would let a modified client
 * self-identify on the wire).
 */

import {
    MESSAGE_STREAM, EPHEMERAL_STREAM, ADMIN_STREAM, KEYS_STREAM, INTERACTIONS_STREAM,
    deriveEphemeralId, deriveAdminId, deriveKeysId, deriveInteractionsId
} from '../streamConstants.js';

const SUB = ['subscribe'];
const SUB_PUB = ['subscribe', 'publish'];

/** Storage given to a stored stream when the -1 itself has none (DM inbox parity). */
export const DEFAULT_STORAGE_DAYS = 180;

/**
 * The streams a channel of this type must have, and the grants each one
 * needs. `grants` lists only the grantees this check owns.
 */
export function expectedChannelState(channel) {
    const id = channel.messageStreamId;
    const gated = channel.type === 'gated';
    const sealed = gated && channel.wireIdentity === 'sealed';
    const clone = channel.gate?.address || null;
    const listed = channel.exposure === 'visible';
    const pub = (permissions) => ({ public: true, permissions });
    const viaClone = (permissions) => ({ userId: clone, permissions });

    const streams = [
        {
            kind: 'message', id, partitions: MESSAGE_STREAM.PARTITIONS, stored: true, linked: false,
            grants: gated
                ? (clone ? [viaClone(sealed ? SUB : SUB_PUB)] : [])
                : [pub(channel.readOnly ? SUB : SUB_PUB)]
        },
        {
            kind: 'ephemeral', id: channel.ephemeralStreamId || deriveEphemeralId(id),
            partitions: EPHEMERAL_STREAM.PARTITIONS, stored: false, linked: true, metaKind: null,
            grants: gated ? (clone ? [viaClone(sealed ? SUB : SUB_PUB)] : []) : [pub(SUB_PUB)]
        },
        {
            kind: 'admin', id: channel.adminStreamId || deriveAdminId(id),
            partitions: ADMIN_STREAM.PARTITIONS, stored: true, linked: true, metaKind: 'admin',
            grants: gated
                ? [...(clone ? [viaClone(SUB)] : []), ...(listed ? [pub(SUB)] : [])]
                : [pub(SUB)]
        }
    ];
    if (gated) {
        streams.push({
            kind: 'keys', id: channel.keysStreamId || deriveKeysId(id),
            partitions: KEYS_STREAM.PARTITIONS, stored: true, linked: true, metaKind: 'keys',
            grants: clone ? [viaClone(SUB_PUB)] : []
        });
    }
    streams.push({
        kind: 'interactions', id: channel.interactionsStreamId || deriveInteractionsId(id),
        partitions: INTERACTIONS_STREAM.PARTITIONS, stored: true, linked: true, metaKind: 'interactions',
        grants: gated ? (clone ? [viaClone(sealed ? SUB : SUB_PUB)] : []) : [pub(SUB_PUB)]
    });

    return {
        streams,
        password: channel.type === 'password',
        gate: gated ? clone : null,
        readOnly: !!channel.readOnly
    };
}

const tri = async (read) => {
    try {
        return await read();
    } catch {
        return null;
    }
};

/**
 * Reads the chain for every expected stream. Never throws for a single
 * failed read; that check comes back null.
 *
 * @param {Object} channel
 * @param {Object} deps - { streamrController, gateManager, pomboNode, password }
 */
export async function diagnoseChannel(channel, deps) {
    const { streamrController: sc, gateManager } = deps;
    const expected = expectedChannelState(channel);
    const report = { channelId: channel.messageStreamId, expected, streams: {}, password: null, gate: null };

    // The contracts, not the SDK: its cache keeps the old value after a write
    // whose receipt read failed, and a repair built on it undoes the fix. The
    // registry cannot list a stream's nodes, so the indexed lists plus the
    // Pombo node are the candidates, each asked one by one.
    const candidates = new Set(deps.pomboNode ? [String(deps.pomboNode).toLowerCase()] : []);
    for (const want of expected.streams.filter(s => s.stored)) {
        const info = await sc.getStreamStorageInfo(want.id);
        if (info.ok) info.nodes.forEach(n => candidates.add(String(n).toLowerCase()));
    }

    for (const want of expected.streams) {
        const got = { id: want.id, exists: null, partitions: null, partitionsOk: null, metadataOk: null, grantsOk: null, nodes: null, storageDays: null };
        report.streams[want.kind] = got;
        got.exists = await tri(() => sc.chainStreamExists(want.id));
        if (got.exists === false) {
            got.partitionsOk = false;
            got.metadataOk = false;
            got.grantsOk = false;
            if (want.stored) got.nodes = [];
            continue;
        }
        if (got.exists !== true) continue;

        const md = await tri(() => sc.chainStreamMetadata(want.id));
        if (md !== null) {
            got.partitions = Number.isFinite(md.partitions) ? md.partitions : 1;
            got.partitionsOk = got.partitions >= want.partitions;
            if (want.stored) got.storageDays = Number.isFinite(md.storageDays) ? md.storageDays : null;
        }
        const meta = md === null ? null : await tri(async () => (md.description ? JSON.parse(md.description) : {}));
        if (meta !== null) {
            got.metadataOk = meta.a === 'pombo' && (!want.linked
                || (meta.ln === channel.messageStreamId && (!want.metaKind || meta.k === want.metaKind)));
            if (want.kind === 'message' && expected.gate) got.readOnlyMeta = !!meta.r;
        }
        got.grantsOk = want.grants.length === 0 ? true : await tri(() => sc._permissionsInPlace(want.id, want.grants));
        if (want.stored) {
            got.nodes = await tri(async () => {
                const nodes = [];
                for (const n of candidates) {
                    if (await sc.chainIsStorageNodeOf(want.id, n)) nodes.push(n);
                }
                return nodes;
            });
        }
    }

    const message = report.streams.message;
    for (const want of expected.streams.filter(s => s.stored)) {
        const got = report.streams[want.kind];
        if (got.nodes === null) {
            got.storageOk = null;
        } else if (want.kind === 'message') {
            got.storageOk = got.nodes.length > 0;
        } else if (message.nodes === null) {
            got.storageOk = null;
        } else {
            const need = message.nodes.length > 0 ? message.nodes : [];
            got.storageOk = got.nodes.length > 0 && need.every(n => got.nodes.includes(n));
            got.retentionOk = message.storageDays === null || got.storageDays === message.storageDays;
        }
    }

    if (expected.password) {
        report.password = { checked: !!deps.password, found: null };
        if (deps.password && report.streams.admin.exists) {
            const res = await tri(() => sc.verifyPasswordChallenge(report.streams.admin.id, deps.password));
            if (res) report.password.found = !!(res.found && res.valid);
        }
    }

    if (expected.gate) {
        report.gate = { address: expected.gate, exists: null, readOnly: null };
        const info = await tri(() => gateManager.getGateInfo(expected.gate));
        if (info) {
            report.gate.exists = true;
            report.gate.readOnly = !!info.readOnly;
        }
    }
    return report;
}

const LABEL = { message: '-1', ephemeral: '-2', admin: '-3', keys: '-4', interactions: '-5' };

/**
 * The repair steps for a diagnosis, in the order they are sent. A stream
 * created here needs its grants and storage as well.
 *
 * Storage follows the DM inbox: a stream gets the -1's nodes and retention,
 * and the Pombo node with DEFAULT_STORAGE_DAYS when the -1 has none.
 */
export function channelRepairSteps(report, pomboNode) {
    const steps = [];
    const message = report.streams.message;
    if (message.exists === false) return steps;
    const targetNodes = message.nodes?.length ? message.nodes : [String(pomboNode).toLowerCase()];
    const targetDays = message.nodes?.length ? (message.storageDays ?? DEFAULT_STORAGE_DAYS) : DEFAULT_STORAGE_DAYS;
    const gated = !!report.expected.gate;

    for (const want of report.expected.streams) {
        const got = report.streams[want.kind];
        const created = got.exists === false;
        if (created) steps.push({ step: 'create', kind: want.kind });
        if (!created && got.exists !== true) continue;
        if (!created && got.partitionsOk === false) steps.push({ step: 'partitions', kind: want.kind });
        if (!created && got.metadataOk === false) steps.push({ step: 'metadata', kind: want.kind });
        if (want.grants.length && (created || got.grantsOk === false)) steps.push({ step: 'grants', kind: want.kind, gated });
        if (want.stored && (created || got.storageOk === false)) {
            const missing = targetNodes.filter(n => !(got.nodes || []).includes(n));
            for (const node of missing) steps.push({ step: 'storage', kind: want.kind, node, days: targetDays });
        } else if (want.stored && got.storageOk && got.retentionOk === false) {
            steps.push({ step: 'retention', kind: want.kind, days: targetDays });
        }
    }
    if (report.gate?.exists && message.readOnlyMeta !== null && message.readOnlyMeta !== undefined
        && message.readOnlyMeta !== report.gate.readOnly) {
        steps.push({ step: 'readOnly', kind: 'message', readOnly: report.gate.readOnly });
    }
    if (report.password?.checked && report.password.found === false) {
        steps.push({ step: 'challenge', kind: 'admin' });
    }
    return steps;
}

/** Gas units of a repair (GasEstimator.GAS_UNITS). The password challenge is a message, not a transaction. */
export function channelRepairUnits(steps, units) {
    return steps.reduce((sum, s) => sum + ({
        create: units.createStream,
        partitions: units.updateStreamMetadata,
        metadata: units.updateStreamMetadata,
        readOnly: units.updateStreamMetadata,
        grants: s.gated ? units.setPermissionsBatch : units.setPublicPermissions,
        storage: units.addStorageNode + units.setStorageDayCount,
        retention: units.setStorageDayCount,
        challenge: 0
    }[s.step] ?? 0), 0);
}

const linkedMetadata = (want, channel, app) => JSON.stringify({
    a: app.name, v: app.version, ln: channel.messageStreamId, ...(want.metaKind ? { k: want.metaKind } : {})
});

/**
 * Sends the steps one at a time. Each write asks the chain first, so a run
 * cut short is resumed by diagnosing again and repairing what is left.
 *
 * @param {Object} deps - { streamrController, executeWithRetryAndVerify, app, pomboNode, password }
 * @param {Function} onStep - (step, 'start'|'ok'|'fail')
 * @returns {Promise<{ok: number, failed: number}>}
 */
export async function repairChannel(channel, report, steps, deps, onStep = () => {}) {
    const { streamrController: sc, executeWithRetryAndVerify: retryVerify, app } = deps;
    const wantOf = (kind) => report.expected.streams.find(s => s.kind === kind);
    let ok = 0;
    let failed = 0;
    for (const s of steps) {
        const want = wantOf(s.kind);
        onStep(s, 'start');
        try {
            if (s.step === 'create') {
                await retryVerify(`health:create${want.kind}`,
                    () => sc.client.createStream({ id: want.id, description: linkedMetadata(want, channel, app), partitions: want.partitions }),
                    () => sc._streamIfExists(want.id), { maxRetries: 7 });
            } else if (s.step === 'partitions') {
                await sc.patchStreamMetadata(want.id, { partitions: want.partitions });
            } else if (s.step === 'metadata' || s.step === 'readOnly') {
                const md = await sc.chainStreamMetadata(want.id);
                const current = JSON.parse(md.description || '{}');
                const set = s.step === 'metadata' ? JSON.parse(linkedMetadata(want, channel, app)) : { r: s.readOnly };
                await sc.patchStreamMetadata(want.id, { description: JSON.stringify({ ...current, ...set }) });
            } else if (s.step === 'grants') {
                await retryVerify(`health:grants${want.kind}`,
                    () => sc.client.setPermissions({ streamId: want.id, assignments: want.grants }),
                    async () => ((await sc._permissionsInPlace(want.id, want.grants)) ? true : null),
                    { maxRetries: 7 });
            } else if (s.step === 'storage') {
                const pombo = s.node === String(deps.pomboNode).toLowerCase();
                const res = await sc.addStorageNodeToStream(want.id, {
                    storageProvider: pombo ? 'streamr' : 'custom',
                    customStorageAddress: pombo ? undefined : s.node,
                    storageDays: s.days
                });
                if (!res?.success) throw new Error(res?.error || 'storage was not added');
            } else if (s.step === 'retention') {
                if (!(await sc.setStorageDays(want.id, s.days, { retries: 3 }))) throw new Error('retention was not set');
            } else if (s.step === 'challenge') {
                await sc.publishPasswordChallenge(want.id, deps.password);
            }
            ok++;
            onStep(s, 'ok');
        } catch (e) {
            failed++;
            onStep(s, 'fail', e);
        }
    }
    return { ok, failed };
}

/**
 * What the diagnosis found broken, what it could not read, and what it only
 * reports (never repairs).
 */
export function channelFindings(report) {
    const issues = [];
    const unchecked = [];
    const reported = [];
    const note = (value, label, list = issues) => {
        if (value === false) list.push(label);
        else if (value === null || value === undefined) unchecked.push(label);
    };
    for (const want of report.expected.streams) {
        const got = report.streams[want.kind];
        const s = LABEL[want.kind];
        if (want.kind === 'message' && got.exists === false) {
            reported.push(`${s} stream missing`);
            continue;
        }
        note(got.exists, `${s} stream`);
        if (!got.exists) continue;
        note(got.partitionsOk, `${s} partitions`);
        note(got.metadataOk, `${s} metadata`);
        note(got.grantsOk, `${s} permissions`);
        if (want.stored) {
            note(got.storageOk, `${s} storage`);
            if (got.storageOk && got.retentionOk === false) issues.push(`${s} retention`);
        }
    }
    if (report.password) {
        if (!report.password.checked) unchecked.push('password challenge');
        else note(report.password.found, 'password challenge');
    }
    if (report.gate) {
        if (report.gate.exists === null) unchecked.push('gate');
        else {
            const meta = report.streams.message.readOnlyMeta;
            if (meta === null || meta === undefined) unchecked.push('read-only flag');
            else if (meta !== report.gate.readOnly) issues.push('read-only flag');
        }
    }
    return { issues, unchecked, reported };
}
