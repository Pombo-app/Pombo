/**
 * Crypto Worker
 * Offloads heavy cryptographic operations from the main thread:
 * - PBKDF2 key derivation (310k iterations)
 * - AES-GCM encryption/decryption
 * 
 * This file is bundled by Webpack as a separate entry point
 */

import { CONFIG } from '../config.js';

// Single source of truth for PBKDF2 iterations — hardcoding this in multiple
// places risks silent decrypt failures if the values ever drift apart.
const PBKDF2_ITERATIONS = CONFIG.crypto.pbkdf2Iterations;

// Text encoder/decoder for string operations
const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

/**
 * Message handler - receives tasks from main thread
 */
self.onmessage = async (e) => {
    const { id, type, payload } = e.data;
    
    try {
        let result;
        
        switch (type) {
            case 'DERIVE_KEY':
                result = await deriveKey(payload);
                break;
                
            case 'ENCRYPT':
                result = await encrypt(payload);
                break;
                
            case 'DECRYPT':
                result = await decrypt(payload);
                break;
                
            case 'PING':
                result = 'PONG';
                break;
                
            default:
                throw new Error(`Unknown task type: ${type}`);
        }
        
        self.postMessage({ id, success: true, result });
    } catch (error) {
        self.postMessage({ id, success: false, error: error.message });
    }
};

// ==================== KEY DERIVATION (PBKDF2) ====================

/**
 * Derive encryption key from password using PBKDF2
 * This is very CPU-intensive: 310k iterations
 */
async function deriveKey({ password, salt, iterations = PBKDF2_ITERATIONS }) {
    // Convert salt from array back to Uint8Array
    const saltArray = new Uint8Array(salt);
    
    // Import password as key material
    const keyMaterial = await crypto.subtle.importKey(
        'raw',
        textEncoder.encode(password),
        'PBKDF2',
        false,
        ['deriveKey']
    );
    
    // Derive AES-GCM key
    const key = await crypto.subtle.deriveKey(
        {
            name: 'PBKDF2',
            salt: saltArray,
            iterations: iterations,
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

// ==================== AES-GCM ENCRYPTION ====================

/**
 * Encrypt plaintext using AES-GCM
 * Returns base64-encoded string: salt + iv + ciphertext
 */
async function encrypt({ plaintext, password, salt, iv }) {
    // Convert arrays back to Uint8Array
    const saltArray = new Uint8Array(salt);
    const ivArray = new Uint8Array(iv);
    
    // Derive key from password
    const key = await deriveKey({ password, salt, iterations: PBKDF2_ITERATIONS });
    
    // Encrypt the plaintext
    const plaintextBuffer = textEncoder.encode(plaintext);
    const ciphertext = await crypto.subtle.encrypt(
        {
            name: 'AES-GCM',
            iv: ivArray
        },
        key,
        plaintextBuffer
    );
    
    // Combine salt + iv + ciphertext
    const combined = new Uint8Array(
        saltArray.length + ivArray.length + ciphertext.byteLength
    );
    combined.set(saltArray, 0);
    combined.set(ivArray, saltArray.length);
    combined.set(new Uint8Array(ciphertext), saltArray.length + ivArray.length);
    
    // Convert to base64
    return arrayBufferToBase64(combined);
}

/**
 * Decrypt base64-encoded ciphertext using AES-GCM
 * Input format: salt (16) + iv (12) + ciphertext
 */
async function decrypt({ encryptedBase64, password }) {
    // Decode base64
    const combined = base64ToArrayBuffer(encryptedBase64);
    
    // Extract salt, iv, and ciphertext
    const salt = combined.slice(0, 16);
    const iv = combined.slice(16, 28);
    const ciphertext = combined.slice(28);
    
    // Derive key from password
    const key = await deriveKey({ password, salt: Array.from(salt), iterations: PBKDF2_ITERATIONS });
    
    // Decrypt the ciphertext
    const plaintextBuffer = await crypto.subtle.decrypt(
        {
            name: 'AES-GCM',
            iv: iv
        },
        key,
        ciphertext
    );
    
    // Convert to string
    return textDecoder.decode(plaintextBuffer);
}

// ==================== UTILITY FUNCTIONS ====================

/**
 * Convert ArrayBuffer to Base64 string
 */
function arrayBufferToBase64(buffer) {
    let binary = '';
    const bytes = new Uint8Array(buffer);
    for (let i = 0; i < bytes.length; i++) {
        binary += String.fromCharCode(bytes[i]);
    }
    return btoa(binary);
}

/**
 * Convert Base64 string to Uint8Array
 */
function base64ToArrayBuffer(base64) {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
        bytes[i] = binary.charCodeAt(i);
    }
    return bytes;
}

// Signal that worker is ready
self.postMessage({ type: 'READY' });
