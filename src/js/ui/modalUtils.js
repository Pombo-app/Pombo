/**
 * Modal Builder Utilities
 * Template-based modal system for building modal UIs
 */

// ============================================
// TEMPLATE HELPERS
// ============================================

/**
 * Load and clone a template from the DOM
 * @param {string} templateId - ID of the template element (without #)
 * @returns {DocumentFragment} - Cloned template content
 * @throws {Error} - If template not found
 */
function loadTemplate(templateId) {
    const template = document.getElementById(templateId);
    if (!template) {
        throw new Error(`Template not found: ${templateId}`);
    }
    return template.content.cloneNode(true);
}

/**
 * Bind data to elements with data-bind attributes
 * Supports: textContent, value, attribute binding (data-bind-attr)
 * 
 * @param {Element|DocumentFragment} container - Container with data-bind elements
 * @param {Object} data - Key-value pairs to bind
 * @returns {Element|DocumentFragment} - Same container for chaining
 * 
 * @example
 * // HTML: <span data-bind="username"></span>
 * // JS: bindData(modal, { username: 'John' })
 */
export function bindData(container, data) {
    for (const [key, value] of Object.entries(data)) {
        // Find elements with data-bind="key"
        const elements = container.querySelectorAll(`[data-bind="${key}"]`);
        elements.forEach(el => {
            if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') {
                el.value = value ?? '';
            } else {
                el.textContent = value ?? '';
            }
        });
        
        // Find elements with data-bind-attr for attribute binding
        // Format: data-bind-attr="attrName:dataKey"
        const attrElements = container.querySelectorAll(`[data-bind-attr*="${key}"]`);
        attrElements.forEach(el => {
            const bindings = el.getAttribute('data-bind-attr').split(',');
            bindings.forEach(binding => {
                const [attr, dataKey] = binding.trim().split(':');
                if (dataKey === key) {
                    el.setAttribute(attr, value ?? '');
                }
            });
        });
    }
    return container;
}

/**
 * Create a modal from template, bind data, and append to body
 * @param {string} templateId - Template ID
 * @param {Object} data - Data to bind
 * @returns {HTMLElement} - The modal container element
 */
export function createModalFromTemplate(templateId, data = {}) {
    const fragment = loadTemplate(templateId);
    bindData(fragment, data);
    
    // Get the root element (first element child of fragment)
    const modal = fragment.firstElementChild;
    document.body.appendChild(fragment);
    
    return modal;
}

/**
 * Close and remove modal from DOM
 * @param {HTMLElement} modal - Modal element to close
 * @param {Function} callback - Optional callback after removal
 */
export function closeModal(modal, callback = null) {
    if (!modal) return;
    
    // Run any cleanup registered by setupModalCloseHandlers (e.g. the
    // document-level Escape listener) regardless of which path closed the
    // modal — previously the keydown listener leaked unless Escape itself
    // was the close trigger.
    if (typeof modal._modalCleanup === 'function') {
        try { modal._modalCleanup(); } catch (_) { /* cleanup must not block close */ }
        modal._modalCleanup = null;
    }
    
    // Optional fade out animation
    modal.classList.add('opacity-0');
    modal.style.transition = 'opacity 150ms ease-out';
    
    setTimeout(() => {
        if (modal.parentNode) {
            modal.parentNode.removeChild(modal);
        }
        if (callback) callback();
    }, 150);
}

/**
 * Setup standard modal close handlers (close button, backdrop click, Escape key)
 * @param {HTMLElement} modal - Modal element
 * @param {Function} onClose - Callback when modal is closed
 * @param {Object} options - Options { closeOnBackdrop: true, closeOnEscape: true }
 */
export function setupModalCloseHandlers(modal, onClose, options = {}) {
    const { closeOnBackdrop = true, closeOnEscape = true } = options;
    
    // Close button
    const closeBtn = modal.querySelector('[data-close-modal]');
    if (closeBtn) {
        closeBtn.addEventListener('click', () => {
            closeModal(modal, onClose);
        });
    }
    
    // Backdrop click
    if (closeOnBackdrop) {
        modal.addEventListener('click', (e) => {
            if (e.target === modal) {
                closeModal(modal, onClose);
            }
        });
    }
    
    // Escape key — the listener is removed via modal._modalCleanup when the
    // modal closes by ANY path (button, backdrop, Escape or programmatic).
    if (closeOnEscape) {
        modal.dataset.ownEscape = '';
        const escHandler = (e) => {
            // Self-heal: if the modal was removed without going through
            // closeModal, drop the listener instead of acting on a dead node.
            if (!modal.isConnected) {
                document.removeEventListener('keydown', escHandler);
                return;
            }
            if (e.key === 'Escape') {
                closeModal(modal, onClose);
            }
        };
        document.addEventListener('keydown', escHandler);
        const prevCleanup = modal._modalCleanup;
        modal._modalCleanup = () => {
            if (typeof prevCleanup === 'function') prevCleanup();
            document.removeEventListener('keydown', escHandler);
        };
    }
}

/**
 * SVG paths for eye icons
 */
const EYE_OPEN = '<path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M2.036 12.322a1.012 1.012 0 010-.639C3.423 7.51 7.36 4.5 12 4.5c4.638 0 8.573 3.007 9.963 7.178.07.207.07.431 0 .639C20.577 16.49 16.64 19.5 12 19.5c-4.638 0-8.573-3.007-9.963-7.178z"/><path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"/>';
const EYE_CLOSED = '<path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M3.98 8.223A10.477 10.477 0 001.934 12C3.226 16.338 7.244 19.5 12 19.5c.993 0 1.953-.138 2.863-.395M6.228 6.228A10.45 10.45 0 0112 4.5c4.756 0 8.773 3.162 10.065 7.498a10.523 10.523 0 01-4.293 5.774M6.228 6.228L3 3m3.228 3.228l3.65 3.65m7.894 7.894L21 21m-3.228-3.228l-3.65-3.65m0 0a3 3 0 10-4.243-4.243m4.242 4.242L9.88 9.88"/>';

/**
 * Setup password toggle button with icon switching
 * @param {HTMLButtonElement} button - Toggle button
 * @param {HTMLInputElement} input - Password input
 */
export function setupPasswordToggle(button, input) {
    const icon = button.querySelector('svg');
    button.addEventListener('click', () => {
        const isPassword = input.type === 'password';
        input.type = isPassword ? 'text' : 'password';
        if (icon) {
            icon.innerHTML = isPassword ? EYE_CLOSED : EYE_OPEN;
        }
    });
}

/**
 * Helper to query element within modal
 * @param {HTMLElement} modal - Modal element
 * @param {string} selector - CSS selector
 * @returns {HTMLElement|null}
 */
export function $(modal, selector) {
    return modal.querySelector(selector);
}

/**
 * Validate password against standard rules
 * @param {string} password - Password to validate
 * @returns {Object} - { length, upper, lower, number, isValid }
 */
export function validatePasswordRules(password) {
    const result = {
        length: password.length >= 12,
        upper: /[A-Z]/.test(password),
        lower: /[a-z]/.test(password),
        number: /[0-9]/.test(password)
    };
    result.isValid = result.length && result.upper && result.lower && result.number;
    return result;
}

/**
 * SVG icons for password validation UI
 */
export const PASSWORD_ICONS = {
    check: `<svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7"/></svg>`,
    empty: `<svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10" stroke-width="1.5"/></svg>`
};

/**
 * Update a password requirement indicator element
 * @param {HTMLElement} element - The indicator element
 * @param {boolean} isValid - Whether the requirement is met
 * @param {string} text - The requirement text
 */
export function updatePasswordIndicator(element, isValid, text) {
    const icon = isValid ? PASSWORD_ICONS.check : PASSWORD_ICONS.empty;
    element.className = `flex items-center gap-2 ${isValid ? 'text-emerald-400' : 'text-overlay-30'}`;
    element.innerHTML = `${icon} ${text}`;
}

/**
 * Generate password strength indicators HTML
 * @returns {string} - HTML string for password strength UI
 */
export function getPasswordStrengthHtml() {
    return `
        <div id="password-strength" class="mt-3 space-y-1.5 text-xs">
            <div id="check-length" class="flex items-center gap-2 text-overlay-30">
                ${PASSWORD_ICONS.empty}
                At least 12 characters
            </div>
            <div id="check-upper" class="flex items-center gap-2 text-overlay-30">
                ${PASSWORD_ICONS.empty}
                Uppercase letter
            </div>
            <div id="check-lower" class="flex items-center gap-2 text-overlay-30">
                ${PASSWORD_ICONS.empty}
                Lowercase letter
            </div>
            <div id="check-number" class="flex items-center gap-2 text-overlay-30">
                ${PASSWORD_ICONS.empty}
                Number
            </div>
        </div>
    `;
}

/**
 * Setup password strength validation with UI updates
 * @param {HTMLInputElement} passwordInput - Password input element
 * @param {HTMLElement} container - Container with password strength indicators
 * @param {Function} onValidChange - Callback(isValid) called when validity changes
 * @returns {Function} - Manual validate function for external triggers
 */
export function setupPasswordStrengthValidation(passwordInput, container, onValidChange) {
    const checkLength = container.querySelector('#check-length');
    const checkUpper = container.querySelector('#check-upper');
    const checkLower = container.querySelector('#check-lower');
    const checkNumber = container.querySelector('#check-number');
    
    const validate = () => {
        const rules = validatePasswordRules(passwordInput.value);
        
        updatePasswordIndicator(checkLength, rules.length, 'At least 12 characters');
        updatePasswordIndicator(checkUpper, rules.upper, 'Uppercase letter');
        updatePasswordIndicator(checkLower, rules.lower, 'Lowercase letter');
        updatePasswordIndicator(checkNumber, rules.number, 'Number');
        
        if (onValidChange) {
            onValidChange(rules.isValid);
        }
        
        return rules.isValid;
    };
    
    passwordInput.addEventListener('input', validate);
    
    return validate;
}
