/**
 * Channel Health panel: the owner's diagnose-and-repair view of a channel's
 * streams (same card and states as the DM inbox panel).
 */

import { escapeHtml } from './utils.js';
import { GasEstimator } from './GasEstimator.js';
import { paintRepairStatus } from './repairStatusCard.js';
import { CONFIG } from '../config.js';
import { STREAM_CONFIG } from '../streamConfig.js';
import { executeWithRetryAndVerify } from '../utils/retry.js';
import {
    diagnoseChannel, channelFindings, channelRepairSteps, channelRepairUnits, repairChannel
} from '../channels/ChannelHealth.js';

const STEP_LABELS = {
    create: 'Creating stream',
    partitions: 'Updating partitions',
    metadata: 'Updating metadata',
    readOnly: 'Updating the read-only flag',
    grants: 'Setting permissions',
    storage: 'Adding storage',
    retention: 'Setting retention',
    challenge: 'Publishing the password challenge'
};
const STREAM_LABELS = { message: '-1', ephemeral: '-2', admin: '-3', keys: '-4', interactions: '-5' };

const TEXTS = { healthy: { title: 'Channel healthy' } };

class ChannelHealthUI {
    constructor() {
        this.deps = {};
        this.channel = null;
        this.report = null;
        this.steps = [];
        this.state = null;
        this._diagnosing = new Set();
        this._repairing = null;
        this._repairDetail = '';
    }

    setDependencies(deps) {
        this.deps = { ...this.deps, ...deps };
    }

    init() {
        document.getElementById('ch-health-check-btn')?.addEventListener('click', () => this.diagnose());
        document.getElementById('ch-health-repair-btn')?.addEventListener('click', () => this.repair());
    }

    async open(channel) {
        this.channel = channel;
        if (this._isRepairing(channel)) {
            this._renderList({ issues: [], reported: [], unchecked: [] });
            this._setState('repairing', this._repairDetail);
            return;
        }
        await this.diagnose();
    }

    _shows(channel) {
        return this.channel?.messageStreamId === channel.messageStreamId;
    }

    _isRepairing(channel) {
        return this._repairing === channel.messageStreamId;
    }

    _setState(state, detail) {
        this.state = state;
        const els = {
            card: document.getElementById('ch-health-status-card'),
            icon: document.getElementById('ch-health-status-icon'),
            title: document.getElementById('ch-health-status-title'),
            detail: document.getElementById('ch-health-status-detail')
        };
        if (Object.values(els).some(el => !el)) return;
        paintRepairStatus(els, state, detail, TEXTS);
        const busy = state === 'loading' || state === 'repairing';
        document.getElementById('ch-health-check-btn')?.classList.toggle('hidden', busy);
        document.getElementById('ch-health-repair-btn')?.classList.toggle('hidden', state !== 'issues' || this.steps.length === 0);
    }

    _renderList(findings) {
        const list = document.getElementById('ch-health-list');
        if (!list) return;
        const row = (mark, colour, text) =>
            `<li class="flex items-start gap-2 text-xs text-overlay-60"><span class="${colour} w-3 shrink-0">${mark}</span><span>${escapeHtml(text)}</span></li>`;
        list.innerHTML = [
            ...findings.issues.map(t => row('⚠', 'text-yellow-400', t)),
            ...findings.reported.map(t => row('✕', 'text-danger', `${t} (cannot be repaired here)`)),
            ...findings.unchecked.map(t => row('?', 'text-overlay-30', `${t}: could not be checked`))
        ].join('');
        list.classList.toggle('hidden', list.innerHTML === '');
    }

    /** Diagnoses one channel and paints the panel only while it still shows that channel. Returns the state. */
    async diagnose(channel = this.channel) {
        const id = channel?.messageStreamId;
        if (!channel || this._diagnosing.has(id) || this._isRepairing(channel)) return null;
        this._diagnosing.add(id);
        const paint = (state, detail) => { if (this._shows(channel)) this._setState(state, detail); };
        paint('loading');
        try {
            const { gateManager } = await import('../gate.js');
            const report = await diagnoseChannel(channel, {
                streamrController: this.deps.streamrController,
                gateManager,
                pomboNode: STREAM_CONFIG.NODE_ADDRESS,
                password: channel.password || null
            });
            const findings = channelFindings(report);
            const steps = channelRepairSteps(report, STREAM_CONFIG.NODE_ADDRESS);
            let state = 'healthy', detail;
            if (findings.issues.length > 0 || findings.reported.length > 0) {
                const n = findings.issues.length + findings.reported.length;
                state = 'issues';
                detail = n === 1 ? `1 issue` : `${n} issues`;
            } else if (findings.unchecked.length > 0) {
                state = 'error';
                detail = `Could not check: ${findings.unchecked.join(', ')}`;
            }
            if (this._shows(channel)) {
                this.report = report;
                this.steps = steps;
                this._renderList(findings);
                this._setState(state, detail);
            }
            return state;
        } catch (e) {
            paint('error', e.message);
            return 'error';
        } finally {
            this._diagnosing.delete(id);
        }
    }

    /** Same rule as the DM inbox repair: block what cannot be paid, ask otherwise. */
    async _confirmCost() {
        const units = channelRepairUnits(this.steps, GasEstimator.GAS_UNITS);
        const address = this.deps.authManager?.getAddress?.();
        if (!units || !address) return true;
        let costWei, balanceWei;
        try {
            [balanceWei, costWei] = await Promise.all([
                GasEstimator.getBalance(address),
                GasEstimator.getGasPrice().then(price => units * price)
            ]);
        } catch {
            return true;
        }
        const cost = GasEstimator.formatPOL(costWei);
        if (balanceWei === 0 || (balanceWei !== null && balanceWei < costWei)) {
            this.deps.showNotification?.(`Insufficient POL: this repair costs about ${cost}.`, 'error', 6000);
            return false;
        }
        const confirmed = await this.deps.notificationUI?.showConfirmToast?.(
            'Repair channel',
            `${this.steps.length} step${this.steps.length === 1 ? '' : 's'}, about ${cost}. Continue?`,
            { confirmLabel: 'Repair', cancelLabel: 'Cancel' }
        );
        return confirmed !== false;
    }

    async repair() {
        const channel = this.channel;
        if (!channel || !this.report || this._diagnosing.has(channel.messageStreamId) || this.steps.length === 0) return;
        if (this._repairing) {
            this.deps.showNotification?.('Another channel repair is still running', 'warning');
            return;
        }
        const report = this.report;
        const steps = this.steps;
        if (!await this._confirmCost()) return;
        this._repairing = channel.messageStreamId;
        this._repairDetail = '';
        this._setState('repairing');
        const toast = this.deps.notificationUI?.showLoadingToast(
            `Repairing ${channel.name || 'channel'}`,
            'You can keep using the app',
            { steps: steps.length, initialLabel: 'Repairing…' }
        );
        let done = 0;
        let result = { ok: 0, failed: 0 };
        try {
            result = await repairChannel(channel, report, steps, {
                streamrController: this.deps.streamrController,
                executeWithRetryAndVerify,
                app: CONFIG.app,
                pomboNode: STREAM_CONFIG.NODE_ADDRESS,
                password: channel.password || null
            }, (step, status) => {
                const label = STEP_LABELS[step.step] || step.step;
                if (status === 'start') {
                    this._repairDetail = `${label} (${STREAM_LABELS[step.kind]})`;
                    if (this._shows(channel)) this._setState('repairing', this._repairDetail);
                    this.deps.notificationUI?.setLoadingProgress(done, `${label}…`);
                } else {
                    done += 1;
                    this.deps.notificationUI?.setLoadingProgress(done);
                }
            });
        } catch (e) {
            this.deps.showNotification?.(`Channel repair failed: ${e.message}`, 'error');
        } finally {
            this._repairing = null;
            this.deps.notificationUI?.hideLoadingToast(toast);
        }
        // Read the chain again: what is still missing is what the next Repair sends.
        const state = await this.diagnose(channel);
        if (result.failed === 0 && state === 'healthy' && this._shows(channel)) {
            this._setState('repaired', `${result.ok} step${result.ok === 1 ? '' : 's'} done`);
        }
        this.deps.showNotification?.(
            result.failed > 0 ? `Channel repair: ${result.ok} done, ${result.failed} failed` : 'Channel repaired',
            result.failed > 0 ? 'warning' : 'success'
        );
    }
}

export const channelHealthUI = new ChannelHealthUI();
export { ChannelHealthUI };
