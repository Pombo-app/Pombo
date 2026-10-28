/**
 * Crypto Worker Pool
 * Manages a pool of Web Workers for parallel cryptographic operations
 * 
 * Features:
 * - Round-robin task distribution
 * - Promise-based API
 * - Automatic initialization
 * - Fallback for browsers without Worker support
 */

import { Logger } from '../logger.js';
import { CONFIG } from '../config.js';

class CryptoWorkerPool {
    // Per-task safety-net timeout. PBKDF2 with 310k iterations can take a few
    // seconds on slow devices, so keep this generous.
    static TASK_TIMEOUT_MS = 30000;

    constructor() {
        // Pool configuration
        this.poolSize = Math.min(navigator.hardwareConcurrency || 2, 4);
        this.workers = [];
        this.pendingTasks = new Map();
        this.taskId = 0;
        this.currentWorker = 0;
        this.initialized = false;
        this.initializing = false;
        this.useFallback = false;
        
        // Track worker ready state
        this.workersReady = 0;
    }
    
    /**
     * Initialize the worker pool
     * Creates workers and waits for them to be ready
     */
    async init() {
        if (this.initialized) return;
        if (this.initializing) {
            // Wait for ongoing initialization
            await this.waitForInit();
            return;
        }
        
        this.initializing = true;
        
        // Check for Worker support
        if (typeof Worker === 'undefined') {
            Logger.warn('Web Workers not supported, using fallback');
            this.useFallback = true;
            this.initialized = true;
            this.initializing = false;
            return;
        }
        
        try {
            // Create worker pool
            const workerPromises = [];
            
            for (let i = 0; i < this.poolSize; i++) {
                // Resolve against the document, not the server root. An absolute
                // '/js/...' only works when the app is deployed at the domain
                // root; served from a subfolder (a local static server, a
                // preview deploy, a reverse proxy) it 404s and the whole pool
                // dies — taking key derivation down with it.
                // index.html already loads its bundles as './js/...'.
                const worker = new Worker(new URL('js/crypto.worker.bundle.js', document.baseURI));
                
                // Set up message handler
                worker.onmessage = (e) => this.handleMessage(e.data, i);
                worker.onerror = (e) => this.handleError(e, i);
                
                // Wait for READY signal
                const readyPromise = new Promise((resolve, reject) => {
                    const timeout = setTimeout(() => {
                        reject(new Error(`Worker ${i} initialization timeout`));
                    }, 5000);
                    
                    const originalHandler = worker.onmessage;
                    worker.onmessage = (e) => {
                        if (e.data.type === 'READY') {
                            clearTimeout(timeout);
                            worker.onmessage = originalHandler;
                            resolve();
                        } else {
                            originalHandler(e);
                        }
                    };
                });
                
                this.workers.push(worker);
                workerPromises.push(readyPromise);
            }
            
            await Promise.all(workerPromises);
            
            this.initialized = true;
            this.initializing = false;
            Logger.info(`Crypto worker pool initialized with ${this.poolSize} workers`);
            
        } catch (error) {
            Logger.error('Failed to initialize worker pool:', error);
            this.useFallback = true;
            this.initialized = true;
            this.initializing = false;
            
            // Terminate any workers that were created
            this.workers.forEach(w => w.terminate());
            this.workers = [];
        }
    }
    
    /**
     * Wait for initialization to complete
     */
    waitForInit() {
        return new Promise((resolve) => {
            const check = () => {
                if (this.initialized) {
                    resolve();
                } else {
                    setTimeout(check, 10);
                }
            };
            check();
        });
    }
    
    /**
     * Get next worker (round-robin)
     * @returns {{ worker: Worker, index: number }}
     */
    getNextWorker() {
        const index = this.currentWorker;
        const worker = this.workers[index];
        this.currentWorker = (this.currentWorker + 1) % this.poolSize;
        return { worker, index };
    }
    
    /**
     * Execute a task on a worker
     * @param {string} type - Task type
     * @param {Object} payload - Task data
     * @returns {Promise} - Resolves with result
     */
    async execute(type, payload) {
        // Ensure pool is initialized
        if (!this.initialized) {
            await this.init();
        }
        
        // Use fallback if workers not available
        if (this.useFallback) {
            return this.executeFallback(type, payload);
        }
        
        return new Promise((resolve, reject) => {
            const id = ++this.taskId;
            const { worker, index } = this.getNextWorker();
            
            // Safety-net timeout: without it, a crashed/hung worker leaves the
            // promise pending forever, silently blocking callers on the auth
            // critical path (deriveStorageKey).
            const timer = setTimeout(() => {
                if (this.pendingTasks.delete(id)) {
                    reject(new Error(`Crypto worker task ${type} timed out after ${CryptoWorkerPool.TASK_TIMEOUT_MS}ms`));
                }
            }, CryptoWorkerPool.TASK_TIMEOUT_MS);
            
            this.pendingTasks.set(id, { resolve, reject, type, workerIndex: index, timer });
            worker.postMessage({ id, type, payload });
        });
    }
    
    /**
     * Handle message from worker
     */
    handleMessage(data, workerIndex) {
        const { id, success, result, error } = data;
        
        const task = this.pendingTasks.get(id);
        if (!task) return;
        
        this.pendingTasks.delete(id);
        clearTimeout(task.timer);
        
        if (success) {
            task.resolve(result);
        } else {
            task.reject(new Error(error));
        }
    }
    
    /**
     * Handle worker error
     * Rejects all tasks pending on the failed worker so callers fail fast
     * instead of hanging on a promise that will never settle.
     */
    handleError(error, workerIndex) {
        Logger.error(`Worker ${workerIndex} error:`, error);
        
        for (const [id, task] of this.pendingTasks) {
            if (task.workerIndex !== workerIndex) continue;
            this.pendingTasks.delete(id);
            clearTimeout(task.timer);
            task.reject(new Error(`Crypto worker ${workerIndex} failed during ${task.type}: ${error?.message || 'worker error'}`));
        }
    }
    
    // ==================== FALLBACK IMPLEMENTATIONS ====================
    // These run on the main thread when Workers aren't available
    
    /**
     * Fallback for executing tasks on main thread
     */
    async executeFallback(type, payload) {
        switch (type) {
            case 'DERIVE_KEY':
                return this.deriveKeyFallback(payload);
                
            case 'ENCRYPT':
                return this.encryptFallback(payload);
                
            case 'DECRYPT':
                return this.decryptFallback(payload);
                
            default:
                throw new Error(`Unknown task type: ${type}`);
        }
    }
    
    async deriveKeyFallback({ password, salt, iterations = CONFIG.crypto.pbkdf2Iterations }) {
        const encoder = new TextEncoder();
        const keyMaterial = await crypto.subtle.importKey(
            'raw', encoder.encode(password), 'PBKDF2', false, ['deriveKey']
        );
        return crypto.subtle.deriveKey(
            { name: 'PBKDF2', salt: new Uint8Array(salt), iterations, hash: 'SHA-256' },
            keyMaterial,
            { name: 'AES-GCM', length: 256 },
            false, ['encrypt', 'decrypt']
        );
    }
    
    async encryptFallback({ plaintext, password, salt, iv }) {
        const key = await this.deriveKeyFallback({ password, salt });
        const encoder = new TextEncoder();
        const ciphertext = await crypto.subtle.encrypt(
            { name: 'AES-GCM', iv: new Uint8Array(iv) },
            key,
            encoder.encode(plaintext)
        );
        
        const combined = new Uint8Array(salt.length + iv.length + ciphertext.byteLength);
        combined.set(new Uint8Array(salt), 0);
        combined.set(new Uint8Array(iv), salt.length);
        combined.set(new Uint8Array(ciphertext), salt.length + iv.length);
        
        return btoa(String.fromCharCode(...combined));
    }
    
    async decryptFallback({ encryptedBase64, password }) {
        const combined = Uint8Array.from(atob(encryptedBase64), c => c.charCodeAt(0));
        const salt = combined.slice(0, 16);
        const iv = combined.slice(16, 28);
        const ciphertext = combined.slice(28);
        
        const key = await this.deriveKeyFallback({ password, salt: Array.from(salt) });
        const plaintext = await crypto.subtle.decrypt(
            { name: 'AES-GCM', iv },
            key,
            ciphertext
        );
        
        return new TextDecoder().decode(plaintext);
    }
    
    // ==================== LIFECYCLE ====================
    
    /**
     * Terminate all workers
     */
    terminate() {
        this.workers.forEach(w => w.terminate());
        this.workers = [];
        // Reject (not just clear) pending tasks so callers don't hang forever
        for (const [id, task] of this.pendingTasks) {
            clearTimeout(task.timer);
            task.reject(new Error(`Crypto worker pool terminated during ${task.type}`));
        }
        this.pendingTasks.clear();
        this.initialized = false;
        this.initializing = false;
        Logger.info('Crypto worker pool terminated');
    }
    
    /**
     * Get pool status
     */
    getStatus() {
        return {
            initialized: this.initialized,
            useFallback: this.useFallback,
            poolSize: this.useFallback ? 0 : this.poolSize,
            pendingTasks: this.pendingTasks.size
        };
    }
}

// Export singleton instance
export const cryptoWorkerPool = new CryptoWorkerPool();
export default cryptoWorkerPool;
