/**
 * Channel Health reads a channel against what its type requires: a false is
 * a finding, a null is a check the chain did not answer, and a missing -1 is
 * only reported.
 */

import { describe, it, expect, vi } from 'vitest';
import { expectedChannelState, diagnoseChannel, channelFindings } from '../../src/js/channels/ChannelHealth.js';

const OWNER = '0x' + 'ab'.repeat(20);
const CLONE = '0x' + 'cd'.repeat(20);
const id = `${OWNER}/room-1`;

const channel = (over = {}) => ({ messageStreamId: id, type: 'public', ...over });
const gated = (over = {}) => channel({ type: 'gated', gate: { address: CLONE }, wireIdentity: 'sealed', exposure: 'hidden', ...over });
const kinds = (state) => state.streams.map(s => s.kind);
const grantsOf = (state, kind) => state.streams.find(s => s.kind === kind).grants;

describe('expected state', () => {
    it('a public channel has four streams, three of them stored, with public grants', () => {
        const s = expectedChannelState(channel());
        expect(kinds(s)).toEqual(['message', 'ephemeral', 'admin', 'interactions']);
        expect(s.streams.filter(x => x.stored).map(x => x.kind)).toEqual(['message', 'admin', 'interactions']);
        expect(grantsOf(s, 'message')).toEqual([{ public: true, permissions: ['subscribe', 'publish'] }]);
        expect(grantsOf(s, 'admin')).toEqual([{ public: true, permissions: ['subscribe'] }]);
    });

    it('read-only takes the public publish off the -1 only', () => {
        const s = expectedChannelState(channel({ readOnly: true }));
        expect(grantsOf(s, 'message')).toEqual([{ public: true, permissions: ['subscribe'] }]);
        expect(grantsOf(s, 'interactions')).toEqual([{ public: true, permissions: ['subscribe', 'publish'] }]);
    });

    it('a Sealed clone only reads on the -1, -2 and -5, and reads and writes on the -4', () => {
        const s = expectedChannelState(gated());
        expect(kinds(s)).toEqual(['message', 'ephemeral', 'admin', 'keys', 'interactions']);
        for (const k of ['message', 'ephemeral', 'interactions']) {
            expect(grantsOf(s, k)).toEqual([{ userId: CLONE, permissions: ['subscribe'] }]);
        }
        expect(grantsOf(s, 'keys')).toEqual([{ userId: CLONE, permissions: ['subscribe', 'publish'] }]);
    });

    it('a Visible clone reads and writes on the -1', () => {
        const s = expectedChannelState(gated({ wireIdentity: 'visible' }));
        expect(grantsOf(s, 'message')).toEqual([{ userId: CLONE, permissions: ['subscribe', 'publish'] }]);
    });

    it('a listed gated channel lets the public read the -3, a hidden one does not', () => {
        expect(grantsOf(expectedChannelState(gated({ exposure: 'visible' })), 'admin'))
            .toEqual([{ userId: CLONE, permissions: ['subscribe'] }, { public: true, permissions: ['subscribe'] }]);
        expect(grantsOf(expectedChannelState(gated()), 'admin'))
            .toEqual([{ userId: CLONE, permissions: ['subscribe'] }]);
    });
});

/** The chain as the registry contracts answer it; `nodes[suffix] === null` is a lookup that fails. */
function deps({ missing = [], unreadable = [], grants = true, nodes = { default: ['0xnode'] }, days = () => 180, desc } = {}) {
    const suffix = (sid) => sid.slice(-2);
    const nodesOf = (sid) => (suffix(sid) in nodes ? nodes[suffix(sid)] : nodes.default);
    const description = (sid) => desc?.(sid) ?? (sid.endsWith('-1')
        ? { a: 'pombo' }
        : { a: 'pombo', ln: id, k: { '-3': 'admin', '-4': 'keys', '-5': 'interactions' }[suffix(sid)] });
    return {
        pomboNode: '0xpombo',
        streamrController: {
            chainStreamExists: vi.fn(async (sid) => {
                if (unreadable.some(m => sid.endsWith(m))) throw new Error('RPC timeout');
                return !missing.some(m => sid.endsWith(m));
            }),
            chainStreamMetadata: vi.fn(async (sid) => ({
                partitions: sid.endsWith('-1') ? 12 : sid.endsWith('-4') ? 4 : 3,
                description: JSON.stringify(description(sid)),
                storageDays: days(sid)
            })),
            chainIsStorageNodeOf: vi.fn(async (sid, n) => {
                const list = nodesOf(sid);
                if (list === null) throw new Error('RPC timeout');
                return list.includes(n);
            }),
            getStreamStorageInfo: vi.fn(async (sid) => ({ ok: true, nodes: nodesOf(sid) ?? [] })),
            _permissionsInPlace: vi.fn(async (sid) => (typeof grants === 'function' ? grants(sid) : grants)),
            verifyPasswordChallenge: vi.fn(async () => ({ found: true, valid: true }))
        },
        gateManager: { getGateInfo: vi.fn(async () => ({ readOnly: false })) }
    };
}

describe('diagnosis', () => {
    it('a healthy public channel has nothing to report', async () => {
        const report = await diagnoseChannel(channel(), deps());
        expect(channelFindings(report)).toEqual({ issues: [], unchecked: [], reported: [] });
    });

    it('a missing -5 is one issue, and what lives on it is not asked', async () => {
        const report = await diagnoseChannel(channel(), deps({ missing: ['-5'] }));
        expect(channelFindings(report).issues).toEqual(['-5 stream']);
    });

    it('a -5 with no storage node is a storage issue', async () => {
        const report = await diagnoseChannel(channel(), deps({ nodes: { default: ['0xnode'], '-5': [] } }));
        expect(channelFindings(report).issues).toEqual(['-5 storage']);
    });

    it('a stream it could not read is not checked, not missing', async () => {
        const report = await diagnoseChannel(channel(), deps({ unreadable: ['-3'] }));
        const f = channelFindings(report);
        expect(f.issues).toEqual([]);
        expect(f.unchecked).toEqual(['-3 stream']);
    });

    it('a storage lookup that did not answer is not checked', async () => {
        const report = await diagnoseChannel(channel(), deps({ nodes: { default: ['0xnode'], '-5': null } }));
        expect(channelFindings(report).unchecked).toEqual(['-5 storage']);
    });

    it('a retention that differs from the -1 is an issue', async () => {
        const d = deps({ days: (sid) => (sid.endsWith('-3') ? 30 : 180) });
        expect(channelFindings(await diagnoseChannel(channel(), d)).issues).toEqual(['-3 retention']);
    });

    it('reads nodes and retention from the chain, not from the indexed or cached view', async () => {
        const d = deps({ nodes: { default: ['0xpombo'] } });
        d.streamrController.getStreamStorageInfo = vi.fn(async (sid) =>
            ({ ok: true, nodes: sid.endsWith('-1') ? ['0xold'] : [], storageDays: 18 }));
        const report = await diagnoseChannel(channel(), d);
        expect(channelFindings(report)).toEqual({ issues: [], unchecked: [], reported: [] });
        expect(report.streams.message.nodes).toEqual(['0xpombo']);
        expect(report.streams.admin.storageDays).toBe(180);
    });

    it('a missing -1 is only reported', async () => {
        const report = await diagnoseChannel(channel(), deps({ missing: ['-1'] }));
        const f = channelFindings(report);
        expect(f.reported).toEqual(['-1 stream missing']);
        expect(f.issues).not.toContain('-1 stream');
    });

    it('a Sealed clone with a publish grant on the -1 is a permissions issue', async () => {
        const report = await diagnoseChannel(gated(), deps({ grants: (sid) => !sid.endsWith('-1') }));
        expect(channelFindings(report).issues).toEqual(['-1 permissions']);
    });

    it('a -1 read-only flag that disagrees with the gate is an issue', async () => {
        const d = deps({ desc: (sid) => (sid.endsWith('-1') ? { a: 'pombo', r: true } : undefined) });
        expect(channelFindings(await diagnoseChannel(gated(), d)).issues).toEqual(['read-only flag']);
    });

    it('a Protected channel without the password cannot check the challenge', async () => {
        const report = await diagnoseChannel(channel({ type: 'password' }), deps());
        expect(channelFindings(report).unchecked).toEqual(['password challenge']);
    });
});

import { channelRepairSteps, channelRepairUnits, repairChannel } from '../../src/js/channels/ChannelHealth.js';

const POMBO = '0xae340e799e8151f6a4999d245e466197aa217667';
const UNITS = { createStream: 420, setPublicPermissions: 80, setPermissionsBatch: 210, addStorageNode: 165, setStorageDayCount: 50, updateStreamMetadata: 210 };
const steps = async (ch, d) => channelRepairSteps(await diagnoseChannel(ch, d), POMBO).map(s => `${s.step}:${s.kind}${s.node ? '@' + s.node : ''}`);

describe('repair steps', () => {
    it('a healthy channel needs nothing', async () => {
        expect(await steps(channel(), deps())).toEqual([]);
    });

    it('a missing -5 is created, granted and stored like the -1', async () => {
        expect(await steps(channel(), deps({ missing: ['-5'] })))
            .toEqual(['create:interactions', 'grants:interactions', 'storage:interactions@0xnode']);
    });

    it('a -5 missing one of the -1 nodes gets that node only', async () => {
        const d = deps({ nodes: { default: ['0xnode', '0xother'], '-5': ['0xnode'] } });
        expect(await steps(channel(), d)).toEqual(['storage:interactions@0xother']);
    });

    it('with no storage on the -1, a stream gets the Pombo node for 180 days', async () => {
        const report = await diagnoseChannel(channel(), deps({ nodes: { default: [] } }));
        const s = channelRepairSteps(report, POMBO);
        expect(s.filter(x => x.step === 'storage').map(x => [x.kind, x.node, x.days]))
            .toEqual([['message', POMBO, 180], ['admin', POMBO, 180], ['interactions', POMBO, 180]]);
    });

    it('a check that did not answer is never repaired', async () => {
        expect(await steps(channel(), deps({ unreadable: ['-3'], nodes: { default: ['0xnode'], '-5': null } }))).toEqual([]);
    });

    it('a missing -1 is never repaired', async () => {
        expect(await steps(channel(), deps({ missing: ['-1'] }))).toEqual([]);
    });

    it('the Sealed clone publish grant and the read-only flag are repaired', async () => {
        const d = deps({ grants: (sid) => !sid.endsWith('-1'), desc: (sid) => (sid.endsWith('-1') ? { a: 'pombo', r: true } : undefined) });
        expect(await steps(gated(), d)).toEqual(['grants:message', 'readOnly:message']);
    });

    it('is charged step by step, and gated grants cost a batch', async () => {
        const report = await diagnoseChannel(gated(), deps({ missing: ['-5'] }));
        const s = channelRepairSteps(report, POMBO);
        expect(channelRepairUnits(s, UNITS)).toBe(420 + 210 + 165 + 50);
    });
});

describe('repair', () => {
    it('sends the steps in order and counts what failed', async () => {
        const report = await diagnoseChannel(channel(), deps({ missing: ['-5'] }));
        const s = channelRepairSteps(report, POMBO);
        const sent = [];
        const sc = {
            client: { createStream: vi.fn(async () => { sent.push('create'); }), setPermissions: vi.fn(async () => { sent.push('grants'); }) },
            _streamIfExists: vi.fn(async () => null),
            _permissionsInPlace: vi.fn(async () => false),
            addStorageNodeToStream: vi.fn(async () => { sent.push('storage'); return { success: false }; })
        };
        const retry = async (_name, fn) => fn();
        const result = await repairChannel(channel(), report, s,
            { streamrController: sc, executeWithRetryAndVerify: retry, app: { name: 'pombo', version: '1' }, pomboNode: POMBO });
        expect(sent).toEqual(['create', 'grants', 'storage']);
        expect(result).toEqual({ ok: 2, failed: 1 });
        expect(JSON.parse(sc.client.createStream.mock.calls[0][0].description)).toEqual({ a: 'pombo', v: '1', ln: id, k: 'interactions' });
    });
});
