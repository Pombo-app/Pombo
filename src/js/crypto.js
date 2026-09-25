/**
 * Crypto Module
 * Uses Web Crypto API (native) for AES-GCM encryption
 * Used for password-based encrypted channels
 */

import { CONFIG } from './config.js';

class CryptoManager {
    constructor() {
        this.textEncoder = new TextEncoder();
        this.textDecoder = new TextDecoder();
        
        // LRU cache for derived keys (avoids expensive PBKDF2 re-derivation)
        this.keyCache = new Map();
        this.maxCacheSize = 10;
    }

    /**
     * Generate cache key from password and salt
     * @param {string} password 
     * @param {Uint8Array} salt 
     * @returns {string}
     */
    getCacheKey(password, salt) {
        // Simple hash: password + salt as hex
        const saltHex = Array.from(salt).map(b => b.toString(16).padStart(2, '0')).join('');
        return `${password}:${saltHex}`;
    }

    /**
     * Get cached key or derive new one
     * @param {string} password 
     * @param {Uint8Array} salt 
     * @returns {Promise<CryptoKey>}
     */
    async getCachedKey(password, salt) {
        const cacheKey = this.getCacheKey(password, salt);
        
        if (this.keyCache.has(cacheKey)) {
            // Move to end (LRU)
            const key = this.keyCache.get(cacheKey);
            this.keyCache.delete(cacheKey);
            this.keyCache.set(cacheKey, key);
            return key;
        }
        
        // Derive new key (expensive operation)
        const key = await this.deriveKeyInternal(password, salt);
        
        // Add to cache with LRU eviction
        if (this.keyCache.size >= this.maxCacheSize) {
            // Remove oldest entry (first in Map)
            const firstKey = this.keyCache.keys().next().value;
            this.keyCache.delete(firstKey);
        }
        this.keyCache.set(cacheKey, key);
        
        return key;
    }

    /**
     * Derive encryption key from password using PBKDF2
     * @param {string} password - The password
     * @param {Uint8Array} salt - Salt for key derivation
     * @returns {Promise<CryptoKey>} - Derived key
     */
    async deriveKey(password, salt) {
        return this.getCachedKey(password, salt);
    }

    /**
     * Internal key derivation (no cache)
     * @param {string} password - The password
     * @param {Uint8Array} salt - Salt for key derivation
     * @returns {Promise<CryptoKey>} - Derived key
     */
    async deriveKeyInternal(password, salt) {
        const passwordBuffer = this.textEncoder.encode(password);

        // Import password as key material
        const keyMaterial = await crypto.subtle.importKey(
            'raw',
            passwordBuffer,
            'PBKDF2',
            false,
            ['deriveKey']
        );

        // Derive AES-GCM key
        const key = await crypto.subtle.deriveKey(
            {
                name: 'PBKDF2',
                salt: salt,
                iterations: CONFIG.crypto.pbkdf2Iterations,
                hash: 'SHA-256'
            },
            keyMaterial,
            {
                name: 'AES-GCM',
                length: 256
            },
            false,
            ['encrypt', 'decrypt']
        );

        return key;
    }

    /**
     * Generate a random salt
     * @returns {Uint8Array} - 16 byte salt
     */
    generateSalt() {
        return crypto.getRandomValues(new Uint8Array(16));
    }

    /**
     * Generate a random IV (Initialization Vector)
     * @returns {Uint8Array} - 12 byte IV
     */
    generateIV() {
        return crypto.getRandomValues(new Uint8Array(12));
    }

    /**
     * Encrypt message with AES-GCM
     * @param {string} plaintext - Message to encrypt
     * @param {string} password - Password for encryption
     * @returns {Promise<string>} - Base64 encoded encrypted data
     */
    async encrypt(plaintext, password) {
        try {
            // Generate salt and IV
            const salt = this.generateSalt();
            const iv = this.generateIV();

            // Derive key from password
            const key = await this.deriveKey(password, salt);

            // Encrypt the message
            const plaintextBuffer = this.textEncoder.encode(plaintext);
            const ciphertext = await crypto.subtle.encrypt(
                {
                    name: 'AES-GCM',
                    iv: iv
                },
                key,
                plaintextBuffer
            );

            // Combine salt + iv + ciphertext
            const combined = new Uint8Array(
                salt.length + iv.length + ciphertext.byteLength
            );
            combined.set(salt, 0);
            combined.set(iv, salt.length);
            combined.set(new Uint8Array(ciphertext), salt.length + iv.length);

            // Convert to base64
            return this.arrayBufferToBase64(combined);
        } catch (error) {
            console.error('Encryption failed:', error);
            throw error;
        }
    }

    /**
     * Decrypt message with AES-GCM
     * @param {string} encryptedBase64 - Base64 encoded encrypted data
     * @param {string} password - Password for decryption
     * @returns {Promise<string>} - Decrypted plaintext
     */
    async decrypt(encryptedBase64, password) {
        try {
            // Decode base64
            const combined = this.base64ToArrayBuffer(encryptedBase64);

            // Extract salt, iv, and ciphertext
            const salt = combined.slice(0, 16);
            const iv = combined.slice(16, 28);
            const ciphertext = combined.slice(28);

            // Derive key from password
            const key = await this.deriveKey(password, salt);

            // Decrypt the message
            const plaintextBuffer = await crypto.subtle.decrypt(
                {
                    name: 'AES-GCM',
                    iv: iv
                },
                key,
                ciphertext
            );

            // Convert to string
            return this.textDecoder.decode(plaintextBuffer);
        } catch (error) {
            console.error('Decryption failed:', error);
            throw error;
        }
    }

    /**
     * Length of what encrypt() returns for a plaintext of this many UTF-8
     * bytes: base64 over salt, iv, ciphertext and GCM tag. Deterministic, so
     * sizing a payload does not pay a key derivation.
     * @param {number} plaintextBytes
     * @returns {number}
     */
    encryptedLength(plaintextBytes) {
        return 4 * Math.ceil((16 + 12 + plaintextBytes + 16) / 3);
    }

    /**
     * Encrypt JSON object
     * @param {Object} obj - Object to encrypt
     * @param {string} password - Password for encryption
     * @returns {Promise<string>} - Encrypted base64 string
     */
    async encryptJSON(obj, password) {
        const json = JSON.stringify(obj);
        return await this.encrypt(json, password);
    }

    /**
     * Decrypt to JSON object
     * @param {string} encryptedBase64 - Encrypted base64 string
     * @param {string} password - Password for decryption
     * @returns {Promise<Object>} - Decrypted object
     */
    async decryptJSON(encryptedBase64, password) {
        const json = await this.decrypt(encryptedBase64, password);
        return JSON.parse(json);
    }

    /**
     * Encrypt binary data (Uint8Array) with AES-GCM
     * Returns Uint8Array (salt + iv + ciphertext) for zero-copy binary transport
     * @param {Uint8Array} data - Binary data to encrypt
     * @param {string} password - Password for encryption
     * @returns {Promise<Uint8Array>} - Encrypted binary (salt[16] + iv[12] + ciphertext)
     */
    async encryptBinary(data, password) {
        const salt = this.generateSalt();
        const iv = this.generateIV();
        const key = await this.deriveKey(password, salt);

        const ciphertext = await crypto.subtle.encrypt(
            { name: 'AES-GCM', iv },
            key,
            data
        );

        const combined = new Uint8Array(salt.length + iv.length + ciphertext.byteLength);
        combined.set(salt, 0);
        combined.set(iv, salt.length);
        combined.set(new Uint8Array(ciphertext), salt.length + iv.length);
        return combined;
    }

    /**
     * Decrypt binary data (Uint8Array) with AES-GCM
     * @param {Uint8Array} encrypted - Encrypted binary (salt[16] + iv[12] + ciphertext)
     * @param {string} password - Password for decryption
     * @returns {Promise<Uint8Array>} - Decrypted binary data
     */
    async decryptBinary(encrypted, password) {
        const salt = encrypted.slice(0, 16);
        const iv = encrypted.slice(16, 28);
        const ciphertext = encrypted.slice(28);

        const key = await this.deriveKey(password, salt);

        const plaintext = await crypto.subtle.decrypt(
            { name: 'AES-GCM', iv },
            key,
            ciphertext
        );

        return new Uint8Array(plaintext);
    }

    /**
     * Encrypt binary data with a pre-derived AES-GCM key.
     *
     * Used by Persistent File Sharing: the per-message salt of encryptBinary()
     * would force one PBKDF2 derivation (310k iterations) per chunk — minutes of
     * pure key derivation on a large file. Instead the engine derives ONE key per
     * file via deriveKey(password, fileSalt) (the salt travels in the signed
     * announce) and seals every chunk with it. IV stays random per chunk.
     *
     * Wire format: [12B iv][ciphertext+authTag] — no salt on the wire, matching
     * the DM binary format in dmCrypto.js.
     *
     * @param {Uint8Array} data - Binary data to encrypt
     * @param {CryptoKey} key - AES-GCM key from deriveKey()
     * @returns {Promise<Uint8Array>} - iv + ciphertext
     */
    async encryptBinaryWithKey(data, key) {
        const iv = this.generateIV();
        const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, data);
        const combined = new Uint8Array(iv.length + ciphertext.byteLength);
        combined.set(iv, 0);
        combined.set(new Uint8Array(ciphertext), iv.length);
        return combined;
    }

    /**
     * Decrypt binary data sealed by encryptBinaryWithKey.
     * @param {Uint8Array} encrypted - [12B iv][ciphertext+authTag]
     * @param {CryptoKey} key - AES-GCM key from deriveKey()
     * @returns {Promise<Uint8Array>} - Decrypted binary data
     */
    async decryptBinaryWithKey(encrypted, key) {
        if (!(encrypted instanceof Uint8Array) || encrypted.byteLength < 28) {
            throw new Error(`Invalid encrypted binary: expected ≥28 bytes (12B IV + 16B tag), got ${encrypted?.byteLength ?? 0}`);
        }
        const iv = encrypted.slice(0, 12);
        const ciphertext = encrypted.slice(12);
        const plaintext = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ciphertext);
        return new Uint8Array(plaintext);
    }

    /**
     * Convert ArrayBuffer to Base64
     * @param {ArrayBuffer|Uint8Array} buffer - Buffer to convert
     * @returns {string} - Base64 string
     */
    arrayBufferToBase64(buffer) {
        const bytes = new Uint8Array(buffer);
        let binary = '';
        for (let i = 0; i < bytes.length; i++) {
            binary += String.fromCharCode(bytes[i]);
        }
        return btoa(binary);
    }

    /**
     * Convert Base64 to ArrayBuffer
     * @param {string} base64 - Base64 string
     * @returns {Uint8Array} - Array buffer
     */
    base64ToArrayBuffer(base64) {
        const binary = atob(base64);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) {
            bytes[i] = binary.charCodeAt(i);
        }
        return bytes;
    }

    /**
     * Hash a string with SHA-256 (useful for generating stream IDs)
     * @param {string} input - String to hash
     * @returns {Promise<string>} - Hex string of hash
     */
    async sha256(input) {
        const buffer = this.textEncoder.encode(input);
        const hashBuffer = await crypto.subtle.digest('SHA-256', buffer);
        const hashArray = Array.from(new Uint8Array(hashBuffer));
        return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
    }

    /**
     * Generate random hex string
     * @param {number} length - Length in bytes
     * @returns {string} - Random hex string
     */
    generateRandomHex(length = 16) {
        const bytes = crypto.getRandomValues(new Uint8Array(length));
        return Array.from(bytes)
            .map(b => b.toString(16).padStart(2, '0'))
            .join('');
    }

    /**
     * Clear the key cache (call on logout/channel leave)
     */
    clearCache() {
        this.keyCache.clear();
    }

    /**
     * Get cache statistics for debugging
     * @returns {Object}
     */
    getCacheStats() {
        return {
            size: this.keyCache.size,
            maxSize: this.maxCacheSize
        };
    }
}

// Export singleton instance
export const cryptoManager = new CryptoManager();
