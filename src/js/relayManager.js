// relayManager.js - Relay Manager for Push Notifications
// ===========================================================
// Manages Service Worker, Web Push subscriptions, and
// communication with Pombo push notification relays.
// ===========================================================

import { Logger } from './logger.js';
import { CONFIG as APP_CONFIG } from './config.js';
import { streamrController } from './streamr.js';
import { channelManager } from './channels.js';
import { storageEndpoints } from './storageEndpoints.js';
import { storageFetch } from './storageFetch.js';
import { withCircuitBreaker, getCircuitState } from './utils/retry.js';
import {
    calculateChannelTag,
    calculateNativeChannelTag,
    createRegistrationPayload,
    createChannelNotificationPayload,
    createNativeChannelNotificationPayload,
    createKeysNotificationPayload,
    DEFAULT_CONFIG
} from './pushProtocol.js';

// ================================================
// CONFIGURATION
// ================================================

const CONFIG = {
    // Push notifications stream
    pushStreamId: DEFAULT_CONFIG.pushStreamId,
    
    // PoW difficulty
    powDifficulty: DEFAULT_CONFIG.powDifficulty,
    
    // Known relays
    relays: DEFAULT_CONFIG.relays,
    
    // Storage key for state persistence
    storageKey: APP_CONFIG.storageKeys.pushRegistration,
    
    // Re-registration interval to refresh tokens before expiry
    reRegistrationInterval: APP_CONFIG.push.reRegistrationIntervalMs
};

// ================================================
// RELAY MANAGER CLASS
// ================================================

class RelayManager {
    constructor() {
        this.initialized = false;
        this.walletAddress = null;
        this.swRegistration = null;
        this.pushSubscription = null;
        this.enabled = false;
        this.subscribedChannels = new Set(); // Public/password channels with notifications
        this.subscribedNativeChannels = new Set(); // Native channels with notifications
        this.reRegistrationTimer = null; // Timer for periodic re-registration
        
        // Listener for Service Worker messages
        if (typeof navigator !== 'undefined' && 'serviceWorker' in navigator) {
            navigator.serviceWorker.addEventListener('message', (event) => {
                this.handleServiceWorkerMessage(event.data, event.ports?.[0]);
            });
        }
    }
    
    // ================================================
    // INITIALIZATION
    // ================================================
    
    /**
     * Initialize the push notifications system.
     * Must be called after wallet is available.
     * 
     * @param {string} walletAddress - User's Ethereum address
     * @returns {Promise<boolean>} - true if initialization successful
     */
    async init(walletAddress) {
        // If already initialized with SAME address, skip
        if (this.initialized && this.walletAddress === walletAddress?.toLowerCase()) {
            Logger.debug('Already initialized with same address');
            return true;
        }
        
        // If initialized with DIFFERENT address, refresh channel subscriptions
        if (this.initialized && this.walletAddress !== walletAddress?.toLowerCase()) {
            Logger.info('Account changed, refreshing subscriptions');
            this.walletAddress = walletAddress?.toLowerCase();
            
            // Clear channel subscriptions (new account = new channels)
            this.subscribedChannels.clear();
            this.subscribedNativeChannels.clear();
            this.loadSubscribedChannels();
            return true;
        }
        
        // Check support
        if (!this.isSupported()) {
            Logger.warn('Push notifications not supported in this browser');
            return false;
        }
        
        try {
            this.walletAddress = walletAddress?.toLowerCase();
            
            // Register Service Worker
            this.swRegistration = await this.registerServiceWorker();
            if (!this.swRegistration) {
                return false;
            }
            
            // Check if we already have permission and subscription
            const hasExisting = await this.checkExistingSubscription();
            
            // Load channels with active notifications
            this.loadSubscribedChannels();
            
            // Start periodic re-registration to keep tokens fresh
            this.startReRegistrationTimer();
            
            this.initialized = true;
            Logger.info('RelayManager initialized');
            return true;
            
        } catch (error) {
            Logger.error('Initialization error:', error);
            return false;
        }
    }
    
    /**
     * Check if push notifications are supported.
     */
    isSupported() {
        return typeof window !== 'undefined' 
            && 'serviceWorker' in navigator 
            && 'PushManager' in window 
            && 'Notification' in window;
    }
    
    /**
     * Register the Service Worker.
     */
    async registerServiceWorker() {
        try {
            // Same server-root problem as the Web Workers. At a root deploy this
            // resolves to '/sw.js' with scope '/' — identical to before. Served
            // from a subfolder it now actually registers, instead of 404ing.
            // (A Service Worker cannot claim a scope broader than its own path,
            // so the folder scope is the only valid one there anyway.)
            const registration = await navigator.serviceWorker.register(
                new URL('sw.js', document.baseURI),
                { scope: new URL('./', document.baseURI).pathname }
            );
            
            Logger.info('Service Worker registered');
            
            // Wait for SW to be ready
            await navigator.serviceWorker.ready;
            
            return registration;
        } catch (error) {
            Logger.error('Error registering Service Worker:', error);
            return null;
        }
    }
    
    /**
     * Check existing subscription.
     */
    async checkExistingSubscription() {
        try {
            this.pushSubscription = await this.swRegistration.pushManager.getSubscription();
            
            if (this.pushSubscription) {
                Logger.info('Existing subscription found');
                this.enabled = true;
                return true;
            }
            
            return false;
        } catch (error) {
            Logger.error('Error checking subscription:', error);
            return false;
        }
    }
    
    // ================================================
    // SUBSCRIPTION MANAGEMENT
    // ================================================
    
    /**
     * Request permission and subscribe to push notifications.
     * 
     * @param {string} vapidPublicKey - VAPID public key of the relay
     * @returns {Promise<PushSubscription|null>}
     */
    async subscribe(vapidPublicKey = null) {
        if (!this.initialized) {
            Logger.error('RelayManager not initialized');
            return null;
        }
        
        // Use first known VAPID key if not specified
        const vapidKey = vapidPublicKey || CONFIG.relays[0]?.vapidPublicKey;
        
        if (!vapidKey) {
            Logger.error('VAPID public key not available');
            return null;
        }
        
        try {
            // Request permission
            const permission = await Notification.requestPermission();
            if (permission !== 'granted') {
                Logger.warn('Permission denied');
                return null;
            }
            
            // Subscribe
            this.pushSubscription = await this.swRegistration.pushManager.subscribe({
                userVisibleOnly: true,
                applicationServerKey: this.urlBase64ToUint8Array(vapidKey)
            });
            
            this.enabled = true;
            // Start the token-refresh timer for this new subscription — init()
            // only starts it when a subscription already existed, so without
            // this call fresh subscriptions never refreshed until reload.
            this.startReRegistrationTimer();
            Logger.info('Subscribed successfully');
            
            return this.pushSubscription;
            
        } catch (error) {
            Logger.error('Error subscribing:', error);
            return null;
        }
    }
    
    /**
     * Cancel subscription.
     */
    async unsubscribe() {
        if (!this.pushSubscription) {
            return true;
        }
        
        try {
            await this.pushSubscription.unsubscribe();
            this.pushSubscription = null;
            this.enabled = false;
            
            // Clear storage
            localStorage.removeItem(CONFIG.storageKey);
            
            // Stop re-registration timer
            this.stopReRegistrationTimer();
            
            Logger.info('Subscription cancelled');
            return true;
        } catch (error) {
            Logger.error('Error cancelling subscription:', error);
            return false;
        }
    }
    
    // ================================================
    // RE-REGISTRATION TIMER
    // ================================================
    
    /**
     * Start periodic re-registration timer.
     * This ensures tokens are refreshed before they expire.
     */
    startReRegistrationTimer() {
        // Clear any existing timer
        this.stopReRegistrationTimer();
        
        if (!this.enabled || !this.pushSubscription) {
            return;
        }
        
        // Set up periodic re-registration for channel subscriptions
        this.reRegistrationTimer = setInterval(() => {
            Logger.info('Periodic channel subscription refresh...');
            this.refreshChannelSubscriptions();
        }, CONFIG.reRegistrationInterval);
        
        Logger.debug('Re-registration timer started (interval:', CONFIG.reRegistrationInterval / 3600000, 'hours)');
    }
    
    /**
     * Stop re-registration timer.
     */
    stopReRegistrationTimer() {
        if (this.reRegistrationTimer) {
            clearInterval(this.reRegistrationTimer);
            this.reRegistrationTimer = null;
            Logger.debug('Re-registration timer stopped');
        }
    }
    
    /**
     * Refresh all channel subscriptions (public and native).
     */
    async refreshChannelSubscriptions() {
        const totalChannels = this.subscribedChannels.size + this.subscribedNativeChannels.size;
        if (totalChannels === 0) return;
        
        Logger.debug('Refreshing', totalChannels, 'channel subscriptions...');
        
        const cbOpts = { threshold: 3, resetTimeoutMs: 120000 };
        
        // Refresh public/password channels
        for (const streamId of this.subscribedChannels) {
            if (getCircuitState('relay-refresh')?.state === 'open') {
                Logger.warn('Relay circuit open — skipping remaining channel refreshes');
                return;
            }
            try {
                await withCircuitBreaker('relay-refresh', async () => {
                    const channelTag = calculateChannelTag(streamId);
                    const payload = createRegistrationPayload(channelTag, this.pushSubscription);
                    await streamrController.publishToPushStream(payload);
                }, cbOpts);
            } catch (error) {
                Logger.warn('Failed to refresh public channel subscription:', streamId.slice(0, 20) + '...');
            }
        }
        
        // Refresh native channels
        for (const streamId of this.subscribedNativeChannels) {
            if (getCircuitState('relay-refresh')?.state === 'open') {
                Logger.warn('Relay circuit open — skipping remaining channel refreshes');
                return;
            }
            try {
                await withCircuitBreaker('relay-refresh', async () => {
                    const channelTag = calculateNativeChannelTag(streamId);
                    const payload = createRegistrationPayload(channelTag, this.pushSubscription);
                    await streamrController.publishToPushStream(payload);
                }, cbOpts);
            } catch (error) {
                Logger.warn('Failed to refresh native channel subscription:', streamId.slice(0, 20) + '...');
            }
        }
    }

    
    // ================================================
    // CHANNEL SUBSCRIPTION (opt-in for public/password)
    // ================================================
    
    /**
     * Load subscribed channels from localStorage.
     */
    loadSubscribedChannels() {
        try {
            // Load public/password channels
            const stored = localStorage.getItem(APP_CONFIG.storageKeys.pushRegistrationChannels(this.walletAddress));
            if (stored) {
                const channels = JSON.parse(stored);
                this.subscribedChannels = new Set(channels);
                Logger.debug('Public channels with notifications:', this.subscribedChannels.size);
            }

            // Load native channels
            const storedNative = localStorage.getItem(APP_CONFIG.storageKeys.pushRegistrationNativeChannels(this.walletAddress));
            if (storedNative) {
                const nativeChannels = JSON.parse(storedNative);
                this.subscribedNativeChannels = new Set(nativeChannels);
                Logger.debug('Native channels with notifications:', this.subscribedNativeChannels.size);
            }

            // Sync to Service Worker (delayed to ensure SW is ready)
            setTimeout(() => this.syncWithServiceWorker(), 1000);
        } catch (e) {
            Logger.warn('Error loading subscribed channels:', e);
        }
    }
    
    /**
     * Save subscribed channels to localStorage.
     */
    saveSubscribedChannels() {
        try {
            // Save public/password channels
            const channels = Array.from(this.subscribedChannels);
            localStorage.setItem(APP_CONFIG.storageKeys.pushRegistrationChannels(this.walletAddress), JSON.stringify(channels));

            // Save native channels
            const nativeChannels = Array.from(this.subscribedNativeChannels);
            localStorage.setItem(APP_CONFIG.storageKeys.pushRegistrationNativeChannels(this.walletAddress), JSON.stringify(nativeChannels));

            // Sync to Service Worker for push verification
            this.syncWithServiceWorker();
        } catch (e) {
            Logger.warn('Error saving subscribed channels:', e);
        }
    }
    
    /**
     * Sync monitored channels to Service Worker for push verification.
     * SW uses this to verify push notifications via HTTP.
     */
    async syncWithServiceWorker() {
        if (!navigator.serviceWorker?.controller) {
            Logger.debug('No Service Worker controller - skipping sync');
            return;
        }

        try {
        const channels = [];
        // DM peer address→name map is no longer shipped to the SW: sealed
        // sender makes the SW unable to identify a DM's sender, so it would be
        // unused peer-identity data sitting in the SW's IndexedDB. The push
        // notification for a DM is deliberately generic (see sw.js).

        // Public/password channels (and DM inboxes)
        for (const streamId of this.subscribedChannels) {
            const channelInfo = channelManager.channels.get(streamId);
            const channelTag = calculateChannelTag(streamId);
            
            // Determine name and type based on channel info or stream ID pattern
            let name = 'Channel';
            let type = channelInfo?.isPrivate ? 'private' : 'public';
            
            // Check if this is a DM inbox (user's own inbox for receiving DMs)
            const isDMInbox = streamId.toLowerCase().includes('/pombo-dm-');
            
            if (channelInfo?.type === 'dm') {
                // DM channel - use saved name or fallback
                name = channelInfo.name || 'Direct Message';
                type = 'dm';
            } else if (isDMInbox && !channelInfo) {
                // DM inbox subscription without channel info
                name = 'Direct Message';
                type = 'dm';
            } else if (channelInfo?.name) {
                name = channelInfo.name;
            }
            
            channels.push({
                streamId,
                type,
                name,
                tag: channelTag,
                storageEndpoints: await this.endpointsFor(streamId),
                // A DM inbox is private (its SUBSCRIBE is the owner's alone),
                // so a Pombo node serves it only to a signed read.
                needsSignature: type === 'dm' || isDMInbox
            });
        }

        // Native channels (group chats, not DMs)
        for (const streamId of this.subscribedNativeChannels) {
            const channelInfo = channelManager.channels.get(streamId);
            const channelTag = calculateNativeChannelTag(streamId);
            
            // Use saved name first, then try to get from participants, then fallback
            let name = channelInfo?.name;
            
            if (!name && channelInfo?.participants) {
                const otherParticipant = channelInfo.participants.find(
                    p => p.address?.toLowerCase() !== this.walletAddress?.toLowerCase()
                );
                if (otherParticipant?.nickname) {
                    name = otherParticipant.nickname;
                }
            }
            
            if (!name) {
                name = 'Direct Message';
            }
            
            channels.push({
                streamId,
                // Only gated channels take this path. The tag prefix keeps the
                // historical name (it is baked into every registration the
                // relay holds), but what the worker is told is the real type.
                type: 'gated',
                name,
                tag: channelTag,
                storageEndpoints: await this.endpointsFor(streamId),
                needsSignature: channelInfo?.type === 'gated'
            });
        }

        navigator.serviceWorker.controller.postMessage({
            type: 'SYNC_CHANNELS',
            channels
        });

        Logger.debug('Synced', channels.length, 'channels to Service Worker');
        } catch (error) {
            // Every caller fires this and forgets; resolving the endpoints
            // reaches the chain, so a failure here must not surface as an
            // unhandled rejection.
            Logger.warn('Service Worker sync failed:', error?.message);
        }
    }

    /**
     * Where a stream's history actually lives, from the chain. An empty answer
     * (no storage, or the chain unreachable) leaves the worker on its built-in
     * list until the next sync.
     */
    async endpointsFor(streamId) {
        try {
            return await storageEndpoints.rotation(streamId);
        } catch (error) {
            Logger.debug(`No storage endpoints for ${streamId.slice(-24)}: ${error.message}`);
            return [];
        }
    }
    
    /**
     * Enable notifications for a channel (opt-in).
     * Used for public and password channels.
     * 
     * @param {string} streamId - Channel stream ID
     * @returns {Promise<boolean>}
     */
    async subscribeToChannel(streamId) {
        if (!this.initialized || !this.pushSubscription) {
            Logger.error('Need to enable notifications first (subscribe())');
            return false;
        }
        
        try {
            const channelTag = calculateChannelTag(streamId);
            Logger.debug('Registering public channel tag:', channelTag);
            
            // Create registration payload for the channel
            const payload = createRegistrationPayload(
                channelTag,
                this.pushSubscription
            );
            
            // Publish to push stream
            await streamrController.publishToPushStream(payload);
            
            // Save locally
            this.subscribedChannels.add(streamId);
            this.saveSubscribedChannels();
            
            Logger.info('Notifications enabled for channel:', streamId.slice(0, 20) + '...');
            return true;
            
        } catch (error) {
            Logger.error('Error subscribing to channel:', error);
            return false;
        }
    }
    
    /**
     * Disable notifications for a channel.
     * Note: Token remains in relay until expiry.
     * 
     * @param {string} streamId - Channel stream ID
     * @returns {boolean}
     */
    unsubscribeFromChannel(streamId) {
        this.subscribedChannels.delete(streamId);
        this.saveSubscribedChannels();
        Logger.info('Notifications disabled for channel:', streamId.slice(0, 20) + '...');
        return true;
    }
    
    /**
     * Check if notifications are active for a channel.
     * 
     * @param {string} streamId - Channel stream ID
     * @returns {boolean}
     */
    isChannelSubscribed(streamId) {
        return this.subscribedChannels.has(streamId);
    }
    
    /**
     * Send wake signal for a channel (all subscribers).
     * Used when someone sends a message in a public/password channel.
     * 
     * @param {string} streamId - Channel stream ID
     * @returns {Promise<boolean>}
     */
    async sendChannelWakeSignal(streamId) {
        if (!this.initialized) {
            Logger.debug('RelayManager not initialized - ignoring channel wake signal');
            return false;
        }
        
        try {
            // Create payload with PoW
            const payload = await createChannelNotificationPayload(
                streamId,
                CONFIG.powDifficulty
            );
            
            // Publish to stream
            await streamrController.publishToPushStream(payload);
            
            Logger.debug('Public channel wake signal sent, tag:', payload.tag);
            return true;
            
        } catch (error) {
            Logger.error('Error sending channel wake signal:', error);
            return false;
        }
    }
    
    // ================================================
    // NATIVE CHANNEL SUBSCRIPTION
    // ================================================
    
    /**
     * Enable notifications for a native channel.
     * Native channels use per-channel tags for granular notification control.
     * 
     * @param {string} streamId - Channel stream ID
     * @returns {Promise<boolean>}
     */
    async subscribeToNativeChannel(streamId) {
        if (!this.initialized || !this.pushSubscription) {
            Logger.error('Need to enable notifications first (subscribe())');
            return false;
        }
        
        try {
            const channelTag = calculateNativeChannelTag(streamId);
            Logger.debug('Registering native channel tag:', channelTag);
            
            // Create registration payload for the native channel
            const payload = createRegistrationPayload(
                channelTag,
                this.pushSubscription
            );
            
            // Publish to push stream
            await streamrController.publishToPushStream(payload);
            
            // Save locally
            this.subscribedNativeChannels.add(streamId);
            this.saveSubscribedChannels();
            
            Logger.info('Notifications enabled for native channel:', streamId.slice(0, 20) + '...');
            return true;
            
        } catch (error) {
            Logger.error('Error subscribing to native channel:', error);
            return false;
        }
    }
    
    /**
     * Disable notifications for a native channel.
     * 
     * @param {string} streamId - Channel stream ID
     * @returns {boolean}
     */
    unsubscribeFromNativeChannel(streamId) {
        this.subscribedNativeChannels.delete(streamId);
        this.saveSubscribedChannels();
        Logger.info('Notifications disabled for native channel:', streamId.slice(0, 20) + '...');
        return true;
    }
    
    /**
     * Check if notifications are active for a native channel.
     * 
     * @param {string} streamId - Channel stream ID
     * @returns {boolean}
     */
    isNativeChannelSubscribed(streamId) {
        return this.subscribedNativeChannels.has(streamId);
    }
    
    /**
     * Send wake signal for a native channel.
     * Used when someone sends a message in a native/DM channel.
     * 
     * @param {string} streamId - Channel stream ID
     * @returns {Promise<boolean>}
     */
    async sendNativeChannelWakeSignal(streamId) {
        if (!this.initialized) {
            Logger.debug('RelayManager not initialized - ignoring native channel wake signal');
            return false;
        }
        
        try {
            // Create payload with PoW
            const payload = await createNativeChannelNotificationPayload(
                streamId,
                CONFIG.powDifficulty
            );
            
            // Publish to stream
            await streamrController.publishToPushStream(payload);
            
            Logger.debug('Native channel wake signal sent, tag:', payload.tag);
            return true;
            
        } catch (error) {
            Logger.error('Error sending native channel wake signal:', error);
            return false;
        }
    }

    /**
     * Send a key-request wake for a gated channel (channelType 'keys'):
     * wakes any device running the key responder for this channel so the
     * KEY_REQUEST just published is answered in seconds. Silent by contract
     * on every receiver — never a user notification.
     *
     * @param {string} streamId - Channel MESSAGE stream ID (-1)
     * @returns {Promise<boolean>}
     */
    async sendKeysWakeSignal(streamId) {
        if (!this.initialized) {
            Logger.debug('RelayManager not initialized - ignoring keys wake signal');
            return false;
        }

        try {
            const payload = await createKeysNotificationPayload(
                streamId,
                CONFIG.powDifficulty
            );
            await streamrController.publishToPushStream(payload);
            Logger.debug('Keys wake signal sent, tag:', payload.tag);
            return true;
        } catch (error) {
            Logger.error('Error sending keys wake signal:', error);
            return false;
        }
    }

    // ================================================
    // HELPERS
    // ================================================
    
    /**
     * Convert VAPID key from base64 to Uint8Array.
     */
    urlBase64ToUint8Array(base64String) {
        const padding = '='.repeat((4 - base64String.length % 4) % 4);
        const base64 = (base64String + padding)
            .replace(/-/g, '+')
            .replace(/_/g, '/');
        
        const rawData = atob(base64);
        const outputArray = new Uint8Array(rawData.length);
        
        for (let i = 0; i < rawData.length; ++i) {
            outputArray[i] = rawData.charCodeAt(i);
        }
        
        return outputArray;
    }
    
    /**
     * Handler for Service Worker messages.
     */
    handleServiceWorkerMessage(data, port) {
        if (!data || !data.type) return;

        switch (data.type) {
            case 'SIGN_STORAGE_READ':
                // The service worker holds no key and must not: it asks this
                // page to sign the read that verifies a wake. Answering null
                // is normal (guest, locked, or a URL that is not a read) and
                // the worker then stays silent.
                storageFetch.signHeadersFor(data.url)
                    .catch((error) => {
                        Logger.debug('Could not sign a storage read for the SW:', error?.message);
                        return null;
                    })
                    .then((headers) => port?.postMessage({ headers: headers || null }));
                break;

            case 'NEW_MESSAGE':
                // New verified message from SW
                Logger.debug('New verified message:', data.streamId?.slice(0, 20));
                window.dispatchEvent(new CustomEvent('pombo-new-message', {
                    detail: {
                        streamId: data.streamId,
                        timestamp: data.timestamp,
                        content: data.content
                    }
                }));
                break;
                
            case 'NOTIFICATION_CLICKED':
                Logger.debug('Notification clicked');
                // Dispatch event to the app
                window.dispatchEvent(new CustomEvent('pombo-notification-clicked'));
                break;
        }
    }
    
    // ================================================
    // STATE / DEBUG
    // ================================================
    
    /**
     * Return current manager state.
     */
    getStatus() {
        return {
            supported: this.isSupported(),
            initialized: this.initialized,
            enabled: this.enabled,
            hasSubscription: !!this.pushSubscription,
            subscribedChannels: this.subscribedChannels.size,
            subscribedNativeChannels: this.subscribedNativeChannels.size,
            permission: typeof Notification !== 'undefined' 
                ? Notification.permission 
                : 'unsupported'
        };
    }
    
    /**
     * Return current configuration.
     */
    getConfig() {
        return { ...CONFIG };
    }
}

// ================================================
// SINGLETON EXPORT
// ================================================

export const relayManager = new RelayManager();
export default relayManager;
