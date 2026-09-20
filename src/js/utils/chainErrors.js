/**
 * Chain Error Parser
 * Robust error parsing for blockchain/ethers.js errors
 * Uses regex patterns for resilience against library updates
 */

/**
 * Error patterns for chain error detection
 * Each pattern has regex tests and corresponding error info
 */
const ERROR_PATTERNS = [
    {
        type: 'INSUFFICIENT_FUNDS',
        patterns: [
            /INSUFFICIENT_FUNDS/i,
            /insufficient\s*funds/i,
            /not\s*enough\s*balance/i,
            /balance\s*too\s*low/i,
            /sender\s*doesn.*have\s*enough\s*funds/i
        ],
        isGasError: true,
        message: 'Not enough POL for the network fee'
    },
    {
        type: 'CALL_EXCEPTION',
        patterns: [
            /CALL_EXCEPTION/i,
            /execution\s*reverted/i,
            /transaction\s*reverted/i,
            /revert/i
        ],
        isGasError: true,
        message: 'The transaction was rejected on chain'
    },
    {
        type: 'NETWORK_ERROR',
        patterns: [
            /NETWORK_ERROR/i,
            /SERVER_ERROR/i,
            /network\s*error/i,
            /timeout/i,
            /ECONNREFUSED/i,
            /ETIMEDOUT/i,
            /fetch\s*failed/i,
            /connection\s*refused/i
        ],
        isGasError: false,
        message: 'Network error, try again'
    },
    {
        type: 'USER_REJECTED',
        patterns: [
            /ACTION_REJECTED/i,
            /user\s*rejected/i,
            /user\s*denied/i,
            /rejected\s*by\s*user/i,
            /code[:\s]*4001/i
        ],
        isGasError: false,
        message: 'Transaction cancelled'
    },
    {
        type: 'NONCE_ERROR',
        patterns: [
            /nonce\s*too\s*(low|high)/i,
            /NONCE_EXPIRED/i,
            /REPLACEMENT_UNDERPRICED/i,
            /already\s*known/i
        ],
        isGasError: false,
        message: 'Transaction conflict, try again'
    },
    {
        type: 'GAS_LIMIT',
        patterns: [
            /gas\s*limit/i,
            /out\s*of\s*gas/i,
            /intrinsic\s*gas\s*too\s*low/i
        ],
        isGasError: true,
        message: 'The transaction ran out of gas'
    }
];

/**
 * Parse a blockchain/ethers.js error and return structured info
 * @param {Error} error - The error to parse
 * @returns {{ type: string, isGasError: boolean, message: string }}
 */
export function parseChainError(error) {
    // Build a combined string from all error properties for pattern matching
    const errorText = [
        error.code,
        error.message,
        error.reason?.code,
        error.reason,
        error.data?.message,
        JSON.stringify(error.error || {})
    ].filter(Boolean).join(' ');

    // Test against all patterns
    for (const { type, patterns, isGasError, message } of ERROR_PATTERNS) {
        for (const pattern of patterns) {
            if (pattern.test(errorText)) {
                return { type, isGasError, message };
            }
        }
    }

    // Check for numeric error codes (e.g., JSON-RPC error codes)
    const numericCode = error.code;
    if (numericCode === 4001 || numericCode === -32000) {
        return {
            type: 'USER_REJECTED',
            isGasError: false,
            message: 'Transaction cancelled'
        };
    }

    // Unknown error - return original message
    return {
        type: 'UNKNOWN',
        isGasError: false,
        message: error.message || 'An unknown error occurred'
    };
}

/**
 * Check if an error is retryable (temporary failure)
 * @param {Error} error - The error to check
 * @returns {boolean}
 */
export function isRetryableError(error) {
    const { type } = parseChainError(error);
    // Network errors and nonce conflicts are typically retryable
    return type === 'NETWORK_ERROR' || type === 'NONCE_ERROR';
}

/**
 * Get user-friendly error message
 * @param {Error} error - The error to parse
 * @returns {string}
 */
export function getErrorMessage(error) {
    return parseChainError(error).message;
}
