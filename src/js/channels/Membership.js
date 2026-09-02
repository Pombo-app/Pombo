/**
 * Who belongs to a channel and what they may do: the local member list, the
 * gate's own answer about membership, and the permission reads the UI gates
 * on. Bans live in two places on purpose, the client-side admin state and the
 * contract, and the level helpers here are what keep the two in step.
 */

import { Logger } from '../logger.js';
import { streamrController } from '../streamr.js';
import { authManager } from '../auth.js';
import { parseChainError } from '../utils/chainErrors.js';
import { epochKeyManager } from '../epochKeyManager.js';

export class Membership {
    /**
     * Self-calls go through `manager` on purpose: while the manager is still
     * the entry point, anything that replaces one of its methods has to keep
     * intercepting the calls this class makes. The per-channel caches
     * (`_bannedCache`, `_deletePermCache`) stay on the channel records, so
     * this class holds no state of its own.
     * @param {Object} manager - the channel manager
     */
    constructor(manager) {
        this.manager = manager;
    }

    /**
     * Add a member to a gated channel
     * @param {string} messageStreamId - Message Stream ID (channel key)
     * @param {string} address - Ethereum address to add
     * @returns {Promise<boolean>} - Success status
     */
    async addMember(messageStreamId, address) {
        const channel = this.manager.channels.get(messageStreamId);
        if (!channel) {
            throw new Error('Channel not found');
        }

        if (!channel.gate?.address) {
            throw new Error('Can only add members to gated channels');
        }

        const normalizedAddress = address.toLowerCase();

        if (channel.members.map(m => m.toLowerCase()).includes(normalizedAddress)) {
            throw new Error('Address is already a member');
        }

        // Membership is ONE gate transaction — allow() on the Closed gate.
        // No stream grants: access is proven per-message via ERC-1271.
        try {
            const { gateManager } = await import('../gate.js');
            await gateManager.allow(channel.gate.address, address);
            channel.members.push(address);
            await this.manager.saveChannels();
            Logger.info('Member allowed on gate:', address);
            return true;
        } catch (error) {
            Logger.error('Failed to allow member on gate:', error);
            const chainError = parseChainError(error);
            throw new Error(chainError.message);
        }
    }

    /**
     * Admit several members in ONE transaction (allowBatch), the same call
     * channel creation uses for its initial members.
     * @param {string} messageStreamId - Message Stream ID (channel key)
     * @param {string[]} addresses - Ethereum addresses to admit
     */
    async addMembers(messageStreamId, addresses) {
        const channel = this.manager.channels.get(messageStreamId);
        if (!channel) throw new Error('Channel not found');
        if (!channel.gate?.address) throw new Error('Can only add members to gated channels');

        const known = new Set(channel.members.map(m => m.toLowerCase()));
        const fresh = [...new Set(addresses.map(a => a.toLowerCase()))].filter(a => !known.has(a));
        if (fresh.length === 0) throw new Error('Every address is already a member');

        try {
            const { gateManager } = await import('../gate.js');
            await gateManager.allowBatch(channel.gate.address, fresh);
            channel.members.push(...fresh);
            await this.manager.saveChannels();
            Logger.info(`Gate: ${fresh.length} member(s) allowed in one tx`);
            return true;
        } catch (error) {
            Logger.error('Failed to allow members on gate:', error);
            throw new Error(parseChainError(error).message);
        }
    }

    /**
     * Remove a member from a gated channel
     * @param {string} messageStreamId - Message Stream ID (channel key)
     * @param {string} address - Ethereum address to remove
     * @returns {Promise<boolean>} - Success status
     */
    async removeMember(messageStreamId, address) {
        const channel = this.manager.channels.get(messageStreamId);
        if (!channel) {
            throw new Error('Channel not found');
        }

        if (!channel.gate?.address) {
            throw new Error('Can only remove members from gated channels');
        }

        // Normalize address
        const normalizedAddress = address.toLowerCase();

        // Cannot remove the channel creator
        if (channel.createdBy && channel.createdBy.toLowerCase() === normalizedAddress) {
            throw new Error('Cannot remove the channel creator');
        }

        // Membership is the CONTRACT's, so no local-cache membership check
        // here: the roster and the seen requesters surface members this device
        // never minted, and they must be removable like any other.
        //
        // Removing takes them off the allowlist WITHOUT the ban mark, so a
        // later allow() readmits them. The single gate cuts their transport at
        // ingest, the epoch rotation cuts their reads, and their history stays
        // readable in Pombo clients because reads validate at ingest and never
        // revalidate. Only Closed gates have an allowlist.
        try {
            const { gateManager } = await import('../gate.js');
            await gateManager.revokeAllow(channel.gate.address, address);
            const memberIndex = channel.members.findIndex(m => m.toLowerCase() === normalizedAddress);
            if (memberIndex !== -1) channel.members.splice(memberIndex, 1);
            await this.manager.saveChannels();
            try {
                await epochKeyManager.rotateEpoch(channel);
            } catch (rotateError) {
                Logger.warn('Epoch rotation after removal FAILED — the removed member can still read new messages until the next rotation:', rotateError.message);
            }
            Logger.info('Member removed from the gate allowlist:', address);
            return true;
        } catch (error) {
            Logger.error('Failed to remove member on gate:', error);
            const chainError = parseChainError(error);
            throw new Error(chainError.message);
        }
    }

    /**
     * Ban with its two enforcement levels (see the Android twin).
     * CLIENT is the ADMIN_STATE ban: every client hides the author's messages,
     * free, reversible, creator-only. PROTOCOL is the gate ban: checkAccess
     * goes false so no responder hands out keys, the single gate cuts their
     * transport at ingest, and the rotation that follows cuts reads. Costs gas.
     */
    async banMemberLevels(messageStreamId, address, { client = false, protocol = false } = {}) {
        const channel = this.manager.channels.get(messageStreamId);
        if (!channel) throw new Error('Channel not found');
        if (channel.createdBy && channel.createdBy.toLowerCase() === address.toLowerCase()) {
            throw new Error('Cannot ban the channel creator');
        }

        if (protocol) {
            if (!channel.gate?.address) throw new Error('Only gated channels have a protocol-level ban');
            const { gateManager } = await import('../gate.js');
            try {
                await gateManager.ban(channel.gate.address, address);
            } catch (error) {
                throw new Error(parseChainError(error).message);
            }
            const idx = channel.members.findIndex(m => m.toLowerCase() === address.toLowerCase());
            if (idx !== -1) channel.members.splice(idx, 1);
            channel.knownBanned = [
                ...new Set([...(channel.knownBanned || []), address.toLowerCase()])
            ];
            await this.manager.saveChannels();
            try {
                await epochKeyManager.rotateEpoch(channel);
                // Covered: the deferred pass must not rotate again for this one.
                channel.rotatedForBanned = [
                    ...new Set([...(channel.rotatedForBanned || []), address.toLowerCase()])
                ];
                await this.manager.saveChannels();
            } catch (rotateError) {
                Logger.warn('Epoch rotation after gate ban FAILED — banned member can still read new messages until the next rotation:', rotateError.message);
            }
        }
        if (client) await this.manager.banMember(messageStreamId, address);
        return true;
    }

    /**
     * Lift whichever bans the address carries. The gate ban costs a
     * transaction, so it is only sent when the contract really has them
     * banned; the free ADMIN_STATE entry is cleared alongside.
     */
    async unbanMemberLevels(messageStreamId, address) {
        const channel = this.manager.channels.get(messageStreamId);
        if (!channel) throw new Error('Channel not found');
        const lower = address.toLowerCase();

        if (channel.gate?.address) {
            const banned = await this.manager.getGateBannedMembers(messageStreamId);
            if (banned.some(a => a.toLowerCase() === lower)) {
                const { gateManager } = await import('../gate.js');
                try {
                    await gateManager.unban(channel.gate.address, address);
                } catch (error) {
                    throw new Error(parseChainError(error).message);
                }
            }
        }
        if ((channel.adminState?.bannedMembers || []).some(a => a.toLowerCase() === lower)) {
            await this.manager.unbanMember(messageStreamId, address);
        }
        return true;
    }

    /**
     * Get members of a channel with their permissions
     * @param {string} streamId - Stream ID
     * @returns {Promise<Array>} - Array of { address, canGrant, canEdit, canDelete, isOwner }
     */
    /**
     * Candidate membership answered by the gate: the local cache, the
     * KEY_REQUEST authors seen on -4, the -4/P1 roster and, on Closed gates,
     * the contract's own enumeration — which makes the candidate set complete
     * there instead of limited to what this client happened to see. Empty on
     * failure — each caller picks its own fallback.
     * @returns {Promise<Array>} - [{ address, isOwner, moderator, access, banned, allowed, paidUntil }]
     */
    async getGateMemberFlags(streamId) {
        const channel = this.manager.channels.get(streamId);
        if (!channel?.gate?.address) return [];
        try {
            const { gateManager } = await import('../gate.js');
            const roster = await epochKeyManager.getRosterMembers(channel).catch(() => []);
            const onChain = await gateManager.getGateInfo(channel.gate.address)
                .then(info => info.modeName === 'none'
                    ? gateManager.listMembers(channel.gate.address) : [])
                .catch(() => []);
            const candidates = [
                ...(channel.members || []),
                // Banning drops them from the members cache and the roster
                // stops carrying them, so without this a banned address falls
                // out of the candidate set and the Moderation list loses the
                // one entry it exists to show.
                ...(channel.knownBanned || []),
                ...epochKeyManager.getSeenRequesters(channel.messageStreamId),
                ...roster.map(m => m.account),
                ...onChain
            ];
            const flags = await gateManager.getGateMembers(channel.gate.address, candidates);
            this.manager._rememberBanned(channel, flags);
            return flags;
        } catch (error) {
            Logger.warn('Gate member read failed:', error.message);
            return [];
        }
    }

    /**
     * Remember every banned address the gate reports, so it stays a candidate
     * once the roster and the members cache have let go of it. Self-healing:
     * bans made before this record existed stick the first time they are seen.
     */
    _rememberBanned(channel, flags) {
        const known = new Set((channel.knownBanned || []).map(a => a.toLowerCase()));
        const fresh = flags.filter(m => m.banned)
            .map(m => m.address.toLowerCase())
            .filter(a => !known.has(a));
        if (fresh.length === 0) return;
        channel.knownBanned = [...known, ...fresh];
        this.manager.saveChannels().catch(() => {});
    }

    /** Addresses the GATE has banned (Moderation panel's protocol-level list). */
    async getGateBannedMembers(streamId) {
        const flags = await this.manager.getGateMemberFlags(streamId);
        return flags.filter(m => m.banned).map(m => m.address);
    }

    async getChannelMembers(streamId) {
        const channel = this.manager.channels.get(streamId);
        if (!channel) {
            throw new Error('Channel not found');
        }

        if (!channel.gate?.address) {
            return []; // Public/password channels don't have a member list
        }

        const ownerAddress = channel.createdBy?.toLowerCase();
        const membersMap = new Map(); // address -> permissions

        // Always include owner with full permissions
        if (ownerAddress) {
            membersMap.set(ownerAddress, {
                address: ownerAddress,
                canGrant: true,
                canEdit: true,
                canDelete: true,
                isOwner: true
            });
        }

        // Membership lives on the GATE, not on stream grants — the only
        // stream grantee is the clone itself, so the Graph's list is owner +
        // clone and nothing else. Candidates: the local cache (kept in
        // lockstep with allow/ban transactions) plus the KEY_REQUEST authors
        // seen on -4 (holders and pay() members never pass through the
        // owner, but every reader must request keys). Their CURRENT state —
        // including the moderator flag, which maps onto `canGrant` so the
        // whole members UI works unchanged — is read from the contract;
        // `access` is the mode-aware membership signal (allowlist only means
        // Closed).
        const gateAddr = channel.gate.address.toLowerCase();
        try {
            const { gateManager } = await import('../gate.js');
            // Roster (-4/P1) is the persistent, device-independent candidate
            // source; seenRequesters stays as the fallback for channels
            // created before the roster partition existed.
            const roster = await epochKeyManager.getRosterMembers(channel)
                .catch(() => []);
            const onChain = await gateManager.getGateInfo(channel.gate.address)
                .then(info => info.modeName === 'none'
                    ? gateManager.listMembers(channel.gate.address) : [])
                .catch(() => []);
            const candidates = [
                ...(channel.members || []),
                ...epochKeyManager.getSeenRequesters(channel.messageStreamId),
                ...roster.map(m => m.account),
                ...onChain
            ];
            const gateMembers = await gateManager.getGateMembers(
                channel.gate.address, candidates);
            for (const m of gateMembers) {
                if (!m.isOwner && !m.moderator && !m.access) continue; // banned/ex-members
                membersMap.set(m.address, {
                    address: m.address,
                    canGrant: m.isOwner || m.moderator,
                    canEdit: m.isOwner,
                    canDelete: m.isOwner,
                    isOwner: m.isOwner,
                    paidUntil: m.paidUntil || 0
                });
            }
        } catch (error) {
            // Chain unreachable → local cache, no flags
            Logger.warn('Gate member read failed, using local cache:', error.message);
            for (const addr of channel.members || []) {
                const normalizedAddr = addr.toLowerCase();
                if (normalizedAddr === gateAddr || membersMap.has(normalizedAddr)) continue;
                membersMap.set(normalizedAddr, {
                    address: normalizedAddr,
                    canGrant: false, canEdit: false, canDelete: false, isOwner: false
                });
            }
        }
        return Array.from(membersMap.values()).map(m => {
            try { return { ...m, address: ethers.getAddress(m.address) }; }
            catch { return m; }
        });
    }

    /**
     * Update member permissions (grant or revoke GRANT permission)
     * @param {string} streamId - Stream ID
     * @param {string} address - Member address
     * @param {Object} permissions - { canGrant: boolean }
     */
    async updateMemberPermissions(streamId, address, permissions) {
        const channel = this.manager.channels.get(streamId);
        if (!channel) {
            throw new Error('Channel not found');
        }

        if (!channel.gate?.address) {
            throw new Error('Can only update permissions on gated channels');
        }

        // "Can add members" is the gate's moderator flag — one owner
        // transaction (setModerator), the contract enforces the rest.
        try {
            const { gateManager } = await import('../gate.js');
            await gateManager.setModerator(channel.gate.address, address, !!permissions.canGrant);
            Logger.info('Gate moderator updated:', address, !!permissions.canGrant);
            return true;
        } catch (error) {
            Logger.error('Failed to update gate moderator:', error);
            const chainError = parseChainError(error);
            throw new Error(chainError.message);
        }
    }

    /**
     * Check if current user is the channel owner
     * @param {string} streamId - Stream ID
     * @returns {boolean}
     */
    isChannelOwner(streamId) {
        const channel = this.manager.channels.get(streamId);
        const currentAddress = authManager.getAddress();
        
        if (!currentAddress) return false;
        
        // Check by createdBy field first
        if (channel?.createdBy && 
            channel.createdBy.toLowerCase() === currentAddress.toLowerCase()) {
            return true;
        }
        
        // Fallback: check if streamId starts with user's address (Streamr format: address/path)
        // Extract address part (before the /)
        const streamIdAddress = (streamId?.split('/')[0] || '').toLowerCase();
        const addressLower = currentAddress.toLowerCase();
        
        // Only compare if streamIdAddress looks like a full address (42 chars)
        if (streamIdAddress.length === 42 && streamIdAddress === addressLower) {
            return true;
        }
        
        return false;
    }

    /**
     * Check if current user can add members (owner or has GRANT permission)
     * @param {string} streamId - Stream ID
     * @returns {Promise<boolean>}
     */
    async canAddMembers(streamId) {
        // Owner can always add members
        if (this.manager.isChannelOwner(streamId)) {
            return true;
        }

        // Gated (N-C): moderators appointed on the gate manage membership
        const channel = this.manager.channels.get(streamId);
        if (channel?.gate?.address) {
            try {
                const { gateManager } = await import('../gate.js');
                return await gateManager.canModerate(channel.gate.address, authManager.getAddress());
            } catch (error) {
                Logger.warn('Failed to check gate moderator status:', error.message);
                return false;
            }
        }

        return false;
    }

    /**
     * Pre-load DELETE permission for a channel (fire-and-forget, non-blocking)
     * Caches result on the channel object for faster modal opening
     * @param {string} streamId - Stream ID
     */
    preloadDeletePermission(streamId) {
        const channel = this.manager.channels.get(streamId);
        if (!channel) return;
        
        const currentAddress = authManager.getAddress();
        if (!currentAddress) return;
        
        // If already cached for current wallet, skip
        if (channel._deletePermCache?.address?.toLowerCase() === currentAddress.toLowerCase()) {
            return;
        }
        
        // Fire-and-forget permission check
        streamrController.hasDeletePermission(streamId)
            .then(canDelete => {
                // null = UNKNOWN (client not ready / read failed): caching it
                // would hide the admin surface for the whole session on one
                // transient miss — leave the cache empty and retry next time.
                if (canDelete === null) return;
                // Double-check channel still exists and wallet hasn't changed
                const ch = this.manager.channels.get(streamId);
                const addr = authManager.getAddress();
                if (ch && addr) {
                    ch._deletePermCache = {
                        canDelete,
                        address: addr.toLowerCase()
                    };
                    Logger.debug('Cached DELETE permission:', { streamId: streamId.slice(-20), canDelete });
                }
            })
            .catch(err => {
                Logger.warn('Failed to preload DELETE permission:', err.message);
            });
    }

    /**
     * Get cached DELETE permission for a channel if valid for current wallet
     * @param {string} streamId - Stream ID
     * @returns {{ valid: boolean, canDelete: boolean }}
     */
    getCachedDeletePermission(streamId) {
        const channel = this.manager.channels.get(streamId);
        if (!channel?._deletePermCache) {
            return { valid: false, canDelete: false };
        }
        
        const currentAddress = authManager.getAddress();
        if (!currentAddress) {
            return { valid: false, canDelete: false };
        }
        
        // Cache is valid only if it was checked by the current wallet
        if (channel._deletePermCache.address === currentAddress.toLowerCase()) {
            return { valid: true, canDelete: channel._deletePermCache.canDelete };
        }
        
        return { valid: false, canDelete: false };
    }
}
