/**
 * Storage panel: one retention figure, plus the badges that say when a
 * channel's stored streams (-1, -3, and -4 on gated) drifted apart.
 *
 * Without them the panel reports the message stream and stays silent about
 * the others, which is how a keys stream ends up purging on a schedule
 * nobody chose.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../../src/js/logger.js', () => ({
    Logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }
}));
vi.mock('../../src/js/ui/ModalManager.js', () => ({ modalManager: { show: vi.fn(), hide: vi.fn() } }));
vi.mock('../../src/js/relayManager.js', () => ({ relayManager: {} }));
vi.mock('../../src/js/graph.js', () => ({ graphAPI: {} }));
vi.mock('../../src/js/identity.js', () => ({ identityManager: { getCachedENS: vi.fn(() => null) } }));
vi.mock('../../src/js/media.js', () => ({ mediaController: {} }));
vi.mock('../../src/js/channelImageManager.js', () => ({ channelImageManager: {} }));

const { channelSettingsUI } = await import('../../src/js/ui/ChannelSettingsUI.js');

const POMBO_NODE = '0xae340e799e8151f6a4999d245e466197aa217667';

describe('storage panel rendering', () => {
    let readonly;
    let editor;
    let mixed;
    let mixedText;
    let list;

    beforeEach(() => {
        // Same shape as the panel: the warning is a sibling of both
        // retention states, not a child of either.
        document.body.innerHTML = `
            <div>
                <label>Retention Period</label>
                <div id="channel-storage-retention-readonly">-</div>
                <div id="channel-storage-retention-editor" class="hidden">
                    <input id="channel-storage-retention-input" />
                </div>
                <div id="channel-storage-retention-mixed" class="hidden">
                    <p><svg></svg><span id="channel-storage-retention-mixed-text"></span></p>
                </div>
            </div>
            <div id="channel-storage-nodes-list"></div>
            <div id="channel-storage-no-storage" class="hidden"></div>
        `;
        readonly = document.getElementById('channel-storage-retention-readonly');
        editor = document.getElementById('channel-storage-retention-editor');
        mixed = document.getElementById('channel-storage-retention-mixed');
        mixedText = document.getElementById('channel-storage-retention-mixed-text');
        list = document.getElementById('channel-storage-nodes-list');
        channelSettingsUI.elements = {
            channelStorageRetentionReadonly: readonly,
            channelStorageRetentionEditor: editor,
            channelStorageRetentionMixed: mixed,
            channelStorageRetentionMixedText: mixedText,
            channelStorageRetentionInput: document.getElementById('channel-storage-retention-input'),
            channelStorageNodesList: list,
            channelStorageNoStorage: document.getElementById('channel-storage-no-storage')
        };
        channelSettingsUI.deps = { showNotification: vi.fn() };
    });

    const node = (extra = {}) => ({
        address: POMBO_NODE, onMessage: true, onAdmin: true, onKeys: true, ...extra
    });
    const info = (extra = {}) => ({
        enabled: true,
        nodes: [node()],
        storageDays: 180,
        retention: { message: 180, admin: 180, keys: 180 },
        retentionInSync: true,
        hasKeysStream: true,
        ...extra
    });

    describe('retention', () => {
        it('shows one figure, the message stream one', () => {
            channelSettingsUI._renderStorageList({}, info({
                retention: { message: 180, admin: 30, keys: 3 }
            }), false);
            expect(readonly.textContent).toContain('180 days');
        });

        it('stays silent when the streams agree', () => {
            channelSettingsUI._renderStorageList({}, info(), false);
            expect(readonly.textContent).toBe('180 days');
            expect(mixed.classList.contains('hidden')).toBe(true);
        });

        it('warns when the streams hold different retentions', () => {
            channelSettingsUI._renderStorageList({}, info({
                retention: { message: 180, admin: 180, keys: 3 },
                retentionInSync: false
            }), false);

            expect(mixed.classList.contains('hidden')).toBe(false);
            expect(mixedText.textContent).toMatch(/not the same/i);
            expect(readonly.textContent).toBe('180 days');
        });

        it('tells whoever can manage the channel how to fix it', () => {
            channelSettingsUI._renderStorageList({}, info({ retentionInSync: false }), true);
            expect(mixedText.textContent).toMatch(/save it again/i);
        });

        it('does not tell a reader to save what they cannot save', () => {
            channelSettingsUI._renderStorageList({}, info({ retentionInSync: false }), false);
            expect(mixedText.textContent).not.toMatch(/save/i);
        });

        // Each retention state is hidden for exactly the audience the other
        // one serves, so a warning living inside either is invisible to half
        // the people who need it — the managing half included.
        it('keeps the warning outside both retention states', () => {
            channelSettingsUI._renderStorageList({}, info({ retentionInSync: false }), true);
            expect(readonly.contains(mixed)).toBe(false);
            expect(editor.contains(mixed)).toBe(false);
        });

        it('names what each stream holds on hover', () => {
            channelSettingsUI._renderStorageList({}, info({
                retention: { message: 180, admin: 30, keys: 3 },
                retentionInSync: false
            }), false);

            expect(mixed.title).toContain('messages 180');
            expect(mixed.title).toContain('admin 30');
            expect(mixed.title).toContain('keys 3');
        });

        it('leaves the keys stream out of the detail when there is none', () => {
            channelSettingsUI._renderStorageList({}, info({
                retention: { message: 180, admin: 30, keys: null },
                retentionInSync: false,
                hasKeysStream: false
            }), false);

            expect(mixed.title).toContain('admin 30');
            expect(mixed.title).not.toContain('keys');
        });

        it('clears the warning again once the streams agree', () => {
            channelSettingsUI._renderStorageList({}, info({ retentionInSync: false }), false);
            channelSettingsUI._renderStorageList({}, info(), false);
            expect(mixed.classList.contains('hidden')).toBe(true);
        });
    });

    describe('node list', () => {
        it('does not badge a node present on every stored stream', () => {
            channelSettingsUI._renderStorageList({}, info(), false);
            expect(list.innerHTML).not.toContain('partial');
        });

        it('badges a node missing from the keys stream', () => {
            channelSettingsUI._renderStorageList({}, info({
                nodes: [node({ onKeys: false })]
            }), false);
            expect(list.innerHTML).toContain('partial');
        });

        it('does not badge a missing keys flag on a channel with no keys stream', () => {
            channelSettingsUI._renderStorageList({}, info({
                nodes: [node({ onKeys: false })],
                retention: { message: 180, admin: 180, keys: null },
                hasKeysStream: false
            }), false);
            expect(list.innerHTML).not.toContain('partial');
        });

        // A lookup that timed out says nothing about that stream.
        it('does not badge a node when a stream lookup failed', () => {
            channelSettingsUI._renderStorageList({}, info({
                nodes: [node({ onMessage: false })],
                allStreamsRead: false
            }), false);
            expect(list.innerHTML).not.toContain('partial');
        });
    });
});

describe('_reportStorageResult()', () => {
    let notify;

    beforeEach(() => {
        notify = vi.fn();
        channelSettingsUI.deps = { showNotification: notify };
    });

    const outcome = (results, sent, verified) => ({ results, sent, verified });

    it('reports success when every write landed and the read-back agrees', () => {
        channelSettingsUI._reportStorageResult(
            outcome({ message: 'applied', admin: 'applied', keys: 'applied' }, 3, true), 'add');
        expect(notify).toHaveBeenCalledWith('Storage provider added', 'success');
    });

    // Nothing to pay for is a success, not a silent no-op.
    it('says so when there was nothing to do', () => {
        channelSettingsUI._reportStorageResult(outcome({}, 0, null), 'add');
        expect(notify).toHaveBeenCalledWith(expect.stringContaining('already'), 'success');
    });

    it('reports partial when one stream failed', () => {
        channelSettingsUI._reportStorageResult(
            outcome({ message: 'applied', admin: 'applied', keys: 'failed' }, 3, false), 'add');
        expect(notify).toHaveBeenCalledWith(expect.stringContaining('partially'), 'error');
    });

    // Every write claimed success and the streams still disagree: saying
    // "done" here is the silent failure this whole path exists to stop.
    it('refuses to call it done when the read-back still disagrees', () => {
        channelSettingsUI._reportStorageResult(
            outcome({ message: 'applied', admin: 'applied' }, 2, false), 'add');
        expect(notify).toHaveBeenCalledWith(expect.stringContaining('partially'), 'error');
    });

    it('reports outright failure when nothing took the change', () => {
        channelSettingsUI._reportStorageResult(
            outcome({ message: 'failed', admin: 'failed' }, 2, false), 'add');
        expect(notify).toHaveBeenCalledWith(expect.stringContaining('Failed to add'), 'error');
    });
});
