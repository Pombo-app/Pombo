/**
 * Tests for ModalManager.js - Modal show/hide and data management
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { modalManager } from '../../src/js/ui/ModalManager.js';

describe('ModalManager', () => {
    beforeEach(() => {
        // Reset pending data
        modalManager.clearPendingData();
        modalManager.deps = {};
        
        // Reset modal stack and onHide callbacks
        modalManager.modalStack = [];
        modalManager._handlingPopState = false;
        modalManager._subStates = [];
        modalManager._swallowNextPop = false;
        modalManager.onHideCallbacks.clear();

        // Mock window.history for history integration
        window.history.pushState = vi.fn();
        window.history.back = vi.fn();
        window.history.go = vi.fn();
        
        // Clear any existing modals
        document.body.innerHTML = '';
    });

    afterEach(() => {
        document.body.innerHTML = '';
        vi.restoreAllMocks();
    });

    /**
     * Helper to create a modal element
     */
    function createModal(id, hidden = true) {
        const modal = document.createElement('div');
        modal.id = id;
        if (hidden) modal.classList.add('hidden');
        document.body.appendChild(modal);
        return modal;
    }

    describe('setDependencies()', () => {
        it('should set dependencies', () => {
            const showNotification = vi.fn();
            modalManager.setDependencies({ showNotification });
            expect(modalManager.deps.showNotification).toBe(showNotification);
        });
        
        it('should merge with existing dependencies', () => {
            modalManager.setDependencies({ dep1: 'value1' });
            modalManager.setDependencies({ dep2: 'value2' });
            expect(modalManager.deps.dep1).toBe('value1');
            expect(modalManager.deps.dep2).toBe('value2');
        });
        
        it('should override existing dependencies', () => {
            modalManager.setDependencies({ dep1: 'old' });
            modalManager.setDependencies({ dep1: 'new' });
            expect(modalManager.deps.dep1).toBe('new');
        });
    });

    describe('show()', () => {
        it('should show a modal by removing hidden class', () => {
            const modal = createModal('test-modal', true);
            expect(modal.classList.contains('hidden')).toBe(true);
            
            modalManager.show('test-modal');
            expect(modal.classList.contains('hidden')).toBe(false);
        });
        
        it('should do nothing if modal not found', () => {
            // Should not throw
            modalManager.show('nonexistent-modal');
        });
        
        it('should clear text inputs when clearInputs option is true', () => {
            const modal = createModal('modal-with-inputs', true);
            const input = document.createElement('input');
            input.type = 'text';
            input.value = 'some value';
            modal.appendChild(input);
            
            modalManager.show('modal-with-inputs', { clearInputs: true });
            expect(input.value).toBe('');
        });
        
        it('should clear checkbox inputs when clearInputs option is true', () => {
            const modal = createModal('modal-with-checkbox', true);
            const checkbox = document.createElement('input');
            checkbox.type = 'checkbox';
            checkbox.checked = true;
            modal.appendChild(checkbox);
            
            modalManager.show('modal-with-checkbox', { clearInputs: true });
            expect(checkbox.checked).toBe(false);
        });
        
        it('should not clear inputs by default', () => {
            const modal = createModal('modal-default', true);
            const input = document.createElement('input');
            input.type = 'text';
            input.value = 'keep this';
            modal.appendChild(input);
            
            modalManager.show('modal-default');
            expect(input.value).toBe('keep this');
        });
        
        it('should focus element when focusElement option is provided', () => {
            const modal = createModal('modal-focus', true);
            const input = document.createElement('input');
            input.id = 'focus-input';
            modal.appendChild(input);
            
            const focusSpy = vi.spyOn(input, 'focus');
            modalManager.show('modal-focus', { focusElement: '#focus-input' });
            expect(focusSpy).toHaveBeenCalled();
        });
        
        it('should handle missing focus element gracefully', () => {
            const modal = createModal('modal-no-focus', true);
            
            // Should not throw
            modalManager.show('modal-no-focus', { focusElement: '#nonexistent' });
        });
    });

    describe('hide()', () => {
        it('should hide a modal by adding hidden class', () => {
            const modal = createModal('visible-modal', false);
            expect(modal.classList.contains('hidden')).toBe(false);
            
            modalManager.hide('visible-modal');
            expect(modal.classList.contains('hidden')).toBe(true);
        });
        
        it('should do nothing if modal not found', () => {
            // Should not throw
            modalManager.hide('nonexistent-modal');
        });
        
        it('should work on already hidden modal', () => {
            const modal = createModal('hidden-modal', true);
            modalManager.hide('hidden-modal');
            expect(modal.classList.contains('hidden')).toBe(true);
        });
    });

    describe('toggle()', () => {
        it('should toggle hidden class on visible modal', () => {
            const modal = createModal('toggle-modal', false);
            
            modalManager.toggle('toggle-modal');
            expect(modal.classList.contains('hidden')).toBe(true);
        });
        
        it('should toggle hidden class on hidden modal', () => {
            const modal = createModal('toggle-modal2', true);
            
            modalManager.toggle('toggle-modal2');
            expect(modal.classList.contains('hidden')).toBe(false);
        });
        
        it('should do nothing if modal not found', () => {
            // Should not throw
            modalManager.toggle('nonexistent-modal');
        });
    });

    describe('isVisible()', () => {
        it('should return true for visible modal', () => {
            createModal('visible', false);
            expect(modalManager.isVisible('visible')).toBe(true);
        });
        
        it('should return false for hidden modal', () => {
            createModal('hidden', true);
            expect(modalManager.isVisible('hidden')).toBe(false);
        });
        
        it('should return falsy for nonexistent modal', () => {
            expect(modalManager.isVisible('nonexistent')).toBeFalsy();
        });
    });

    describe('pending data management', () => {
        describe('setPendingData()', () => {
            it('should store pending data', () => {
                modalManager.setPendingData('key', 'value');
                expect(modalManager.pendingData.key).toBe('value');
            });
            
            it('should store objects', () => {
                const obj = { foo: 'bar', num: 123 };
                modalManager.setPendingData('obj', obj);
                expect(modalManager.pendingData.obj).toEqual(obj);
            });
            
            it('should store arrays', () => {
                const arr = [1, 2, 3];
                modalManager.setPendingData('arr', arr);
                expect(modalManager.pendingData.arr).toEqual(arr);
            });
            
            it('should store null', () => {
                modalManager.setPendingData('null', null);
                expect(modalManager.pendingData.null).toBe(null);
            });
            
            it('should store functions', () => {
                const fn = () => 'test';
                modalManager.setPendingData('callback', fn);
                expect(modalManager.pendingData.callback).toBe(fn);
            });
        });

        describe('getPendingData()', () => {
            it('should retrieve pending data', () => {
                modalManager.setPendingData('test', 'value');
                expect(modalManager.getPendingData('test')).toBe('value');
            });
            
            it('should return undefined for non-existent key', () => {
                expect(modalManager.getPendingData('nonexistent')).toBeUndefined();
            });
        });

        describe('clearPendingData()', () => {
            it('should clear specific key', () => {
                modalManager.setPendingData('key1', 'value1');
                modalManager.setPendingData('key2', 'value2');
                
                modalManager.clearPendingData('key1');
                
                expect(modalManager.getPendingData('key1')).toBeUndefined();
                expect(modalManager.getPendingData('key2')).toBe('value2');
            });
            
            it('should clear all data when no key provided', () => {
                modalManager.setPendingData('key1', 'value1');
                modalManager.setPendingData('key2', 'value2');
                
                modalManager.clearPendingData();
                
                expect(modalManager.pendingData).toEqual({});
            });
        });
    });

    describe('showJoinChannelModal()', () => {
        it('should show modal and clear inputs', () => {
            const modal = createModal('join-modal', true);
            const streamIdInput = document.createElement('input');
            streamIdInput.value = 'old-stream-id';
            const passwordInput = document.createElement('input');
            passwordInput.value = 'old-password';
            const localName = document.createElement('input');
            localName.id = 'join-local-name-input';
            localName.value = 'old-name';
            document.body.appendChild(localName);

            modalManager.showJoinChannelModal(modal, streamIdInput, passwordInput);

            expect(modal.classList.contains('hidden')).toBe(false);
            expect(streamIdInput.value).toBe('');
            expect(passwordInput.value).toBe('');
            expect(localName.value).toBe('');
        });

        it('should handle null parameters gracefully', () => {
            // Should not throw
            modalManager.showJoinChannelModal(null, null, null);
        });
    });

    describe('showJoinClosedChannelModal()', () => {
        it('should show modal and set stream ID', () => {
            const modal = createModal('join-closed-channel-modal', true);
            const idInput = document.createElement('input');
            idInput.id = 'join-closed-stream-id-input';
            const nameInput = document.createElement('input');
            nameInput.id = 'join-closed-name-input';
            nameInput.value = 'existing name';
            document.body.appendChild(idInput);
            document.body.appendChild(nameInput);
            
            modalManager.showJoinClosedChannelModal('0x123abc');
            
            expect(modal.classList.contains('hidden')).toBe(false);
            expect(idInput.value).toBe('0x123abc');
            expect(nameInput.value).toBe('');
        });
        
        it('should work with empty stream ID', () => {
            createModal('join-closed-channel-modal', true);
            const idInput = document.createElement('input');
            idInput.id = 'join-closed-stream-id-input';
            idInput.value = 'preset';
            document.body.appendChild(idInput);
            
            modalManager.showJoinClosedChannelModal();
            
            expect(idInput.value).toBe('');
        });
        
        it('should handle missing elements gracefully', () => {
            // No modal created
            modalManager.showJoinClosedChannelModal('0x123');
            // Should not throw
        });
    });

    describe('showAddContactModal()', () => {
        it('should show modal and set address', () => {
            createModal('add-contact-nickname-modal', true);
            const addressDisplay = document.createElement('span');
            addressDisplay.id = 'add-contact-modal-address';
            const nicknameInput = document.createElement('input');
            nicknameInput.id = 'add-contact-modal-nickname';
            document.body.appendChild(addressDisplay);
            document.body.appendChild(nicknameInput);
            
            const focusSpy = vi.spyOn(nicknameInput, 'focus');
            
            modalManager.showAddContactModal('0xABC123');
            
            expect(addressDisplay.textContent).toBe('0xABC123');
            expect(modalManager.getPendingData('contactAddress')).toBe('0xABC123');
            expect(focusSpy).toHaveBeenCalled();
        });
        
        it('should clear nickname input', () => {
            createModal('add-contact-nickname-modal', true);
            const addressDisplay = document.createElement('span');
            addressDisplay.id = 'add-contact-modal-address';
            const nicknameInput = document.createElement('input');
            nicknameInput.id = 'add-contact-modal-nickname';
            nicknameInput.value = 'old nickname';
            document.body.appendChild(addressDisplay);
            document.body.appendChild(nicknameInput);
            
            modalManager.showAddContactModal('0x123');
            
            expect(nicknameInput.value).toBe('');
        });
        
        it('should return early if elements missing', () => {
            // No elements created
            modalManager.showAddContactModal('0x123');
            expect(modalManager.getPendingData('contactAddress')).toBeUndefined();
        });
    });

    describe('hideAddContactModal()', () => {
        it('should hide modal and clear pending data', () => {
            const modal = createModal('add-contact-nickname-modal', false);
            modalManager.setPendingData('contactAddress', '0x123');
            
            modalManager.hideAddContactModal();
            
            expect(modal.classList.contains('hidden')).toBe(true);
            expect(modalManager.getPendingData('contactAddress')).toBeUndefined();
        });
    });

    describe('showRemoveContactModal()', () => {
        it('should show modal and set address', () => {
            const modal = createModal('remove-contact-modal', true);
            const addressDisplay = document.createElement('span');
            addressDisplay.id = 'remove-contact-modal-address';
            document.body.appendChild(addressDisplay);
            
            modalManager.showRemoveContactModal('0xDEF456');
            
            expect(modal.classList.contains('hidden')).toBe(false);
            expect(addressDisplay.textContent).toBe('0xDEF456');
            expect(modalManager.getPendingData('removeContactAddress')).toBe('0xDEF456');
        });
        
        it('should store callback if provided', () => {
            createModal('remove-contact-modal', true);
            const addressDisplay = document.createElement('span');
            addressDisplay.id = 'remove-contact-modal-address';
            document.body.appendChild(addressDisplay);
            
            const callback = vi.fn();
            modalManager.showRemoveContactModal('0x123', callback);
            
            expect(modalManager.getPendingData('removeContactCallback')).toBe(callback);
        });
        
        it('should handle null callback', () => {
            createModal('remove-contact-modal', true);
            const addressDisplay = document.createElement('span');
            addressDisplay.id = 'remove-contact-modal-address';
            document.body.appendChild(addressDisplay);
            
            modalManager.showRemoveContactModal('0x123', null);
            
            expect(modalManager.getPendingData('removeContactCallback')).toBe(null);
        });
        
        it('should return early if elements missing', () => {
            // No elements
            modalManager.showRemoveContactModal('0x123');
            expect(modalManager.getPendingData('removeContactAddress')).toBeUndefined();
        });
    });

    describe('hideRemoveContactModal()', () => {
        it('should hide modal and clear pending data', () => {
            const modal = createModal('remove-contact-modal', false);
            modalManager.setPendingData('removeContactAddress', '0x123');
            modalManager.setPendingData('removeContactCallback', () => {});
            
            modalManager.hideRemoveContactModal();
            
            expect(modal.classList.contains('hidden')).toBe(true);
            expect(modalManager.getPendingData('removeContactAddress')).toBeUndefined();
            expect(modalManager.getPendingData('removeContactCallback')).toBeUndefined();
        });
    });

    describe('dismissing the top modal', () => {
        const escape = () => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));

        it('Escape closes the top modal only', () => {
            const below = createModal('settings-modal');
            const top = createModal('contacts-modal');
            modalManager.show('settings-modal');
            modalManager.show('contacts-modal');

            escape();

            expect(top.classList.contains('hidden')).toBe(true);
            expect(below.classList.contains('hidden')).toBe(false);
        });

        it('leaves Escape to an open confirm dialog', () => {
            const modal = createModal('contacts-modal');
            createModal('confirm-dialog-modal', false);
            modalManager.show('contacts-modal');

            escape();

            expect(modal.classList.contains('hidden')).toBe(false);
        });

        it('a click on the backdrop closes the top modal, a click inside does not', () => {
            const modal = createModal('contacts-modal');
            const inner = document.createElement('div');
            modal.appendChild(inner);
            modalManager.show('contacts-modal');

            inner.click();
            expect(modal.classList.contains('hidden')).toBe(false);

            modal.click();
            expect(modal.classList.contains('hidden')).toBe(true);
        });
    });

    describe('hideNewChannelModal()', () => {
        it('should hide the new channel modal', () => {
            const modal = createModal('new-channel-modal', false);
            
            modalManager.hideNewChannelModal();
            
            expect(modal.classList.contains('hidden')).toBe(true);
        });
    });

    describe('integration scenarios', () => {
        it('should manage multiple modals independently', () => {
            const modal1 = createModal('modal-1', true);
            const modal2 = createModal('modal-2', true);
            const modal3 = createModal('modal-3', false);
            
            modalManager.show('modal-1');
            modalManager.hide('modal-3');
            
            expect(modal1.classList.contains('hidden')).toBe(false);
            expect(modal2.classList.contains('hidden')).toBe(true);
            expect(modal3.classList.contains('hidden')).toBe(true);
        });
        
        it('should track pending data across multiple modals', () => {
            modalManager.setPendingData('modal1Data', { id: 1 });
            modalManager.setPendingData('modal2Data', { id: 2 });
            
            expect(modalManager.getPendingData('modal1Data')).toEqual({ id: 1 });
            expect(modalManager.getPendingData('modal2Data')).toEqual({ id: 2 });
            
            modalManager.clearPendingData('modal1Data');
            expect(modalManager.getPendingData('modal1Data')).toBeUndefined();
            expect(modalManager.getPendingData('modal2Data')).toEqual({ id: 2 });
        });
    });

    // =========================================
    // HISTORY INTEGRATION TESTS
    // =========================================
    
    describe('history integration', () => {
        describe('historyModals Set', () => {
            it('should contain expected modal IDs', () => {
                expect(modalManager.historyModals.has('new-channel-modal')).toBe(true);
                expect(modalManager.historyModals.has('settings-modal')).toBe(true);
                expect(modalManager.historyModals.has('channel-settings-modal')).toBe(true);
                expect(modalManager.historyModals.has('contacts-modal')).toBe(true);
                expect(modalManager.historyModals.has('join-channel-modal')).toBe(true);
                expect(modalManager.historyModals.has('new-dm-modal')).toBe(true);
            });
            
            it('should not contain non-navigation modals', () => {
                expect(modalManager.historyModals.has('media-lightbox-modal')).toBe(false);
                expect(modalManager.historyModals.has('file-confirm-modal')).toBe(false);
            });
        });

        describe('modalStack', () => {
            it('should start empty', () => {
                expect(modalManager.modalStack).toEqual([]);
            });
            
            it('should add history modal to stack on show', () => {
                createModal('new-channel-modal', true);
                
                modalManager.show('new-channel-modal');
                
                expect(modalManager.modalStack).toContain('new-channel-modal');
            });
            
            it('should not add non-history modal to stack', () => {
                createModal('some-modal', true);
                
                modalManager.show('some-modal');
                
                expect(modalManager.modalStack).not.toContain('some-modal');
            });
            
            it('should not duplicate modal in stack', () => {
                createModal('settings-modal', true);
                
                modalManager.show('settings-modal');
                modalManager.show('settings-modal');
                
                const count = modalManager.modalStack.filter(m => m === 'settings-modal').length;
                expect(count).toBe(1);
            });
            
            it('should remove modal from stack on hide', () => {
                createModal('contacts-modal', false);
                modalManager.modalStack = ['contacts-modal'];
                
                modalManager.hide('contacts-modal');
                
                expect(modalManager.modalStack).not.toContain('contacts-modal');
            });
        });

        describe('show() with history', () => {
            it('should call history.pushState for history modals', () => {
                createModal('new-channel-modal', true);
                
                modalManager.show('new-channel-modal');
                
                expect(window.history.pushState).toHaveBeenCalledWith(
                    { modal: 'new-channel-modal' },
                    ''
                );
            });
            
            it('should not call history.pushState for non-history modals', () => {
                createModal('some-modal', true);
                
                modalManager.show('some-modal');
                
                expect(window.history.pushState).not.toHaveBeenCalled();
            });
            
            it('should not call history.pushState with skipHistory option', () => {
                createModal('settings-modal', true);
                
                modalManager.show('settings-modal', { skipHistory: true });
                
                expect(window.history.pushState).not.toHaveBeenCalled();
                expect(modalManager.modalStack).not.toContain('settings-modal');
            });
            
            it('should not push duplicate state if modal already in stack', () => {
                createModal('contacts-modal', true);
                modalManager.modalStack = ['contacts-modal'];
                
                modalManager.show('contacts-modal');
                
                expect(window.history.pushState).not.toHaveBeenCalled();
            });
        });

        describe('hide() with history', () => {
            it('should call history.back for visible history modals', () => {
                createModal('new-channel-modal', false); // visible
                modalManager.modalStack = ['new-channel-modal'];
                
                modalManager.hide('new-channel-modal');
                
                expect(window.history.back).toHaveBeenCalled();
            });
            
            it('should not call history.back for hidden modals', () => {
                createModal('settings-modal', true); // already hidden
                modalManager.modalStack = ['settings-modal'];
                
                modalManager.hide('settings-modal');
                
                expect(window.history.back).not.toHaveBeenCalled();
            });
            
            it('should not call history.back when _handlingPopState is true', () => {
                createModal('contacts-modal', false);
                modalManager.modalStack = ['contacts-modal'];
                modalManager._handlingPopState = true;
                
                modalManager.hide('contacts-modal');
                
                expect(window.history.back).not.toHaveBeenCalled();
            });
            
            it('should not call history.back for non-history modals', () => {
                createModal('some-modal', false);
                
                modalManager.hide('some-modal');
                
                expect(window.history.back).not.toHaveBeenCalled();
            });
            
            it('should not call history.back with skipHistory option', () => {
                createModal('settings-modal', false); // visible
                modalManager.modalStack = ['settings-modal'];
                
                modalManager.hide('settings-modal', { skipHistory: true });
                
                expect(window.history.back).not.toHaveBeenCalled();
                // Modal should still be hidden and removed from stack
                const modal = document.getElementById('settings-modal');
                expect(modal.classList.contains('hidden')).toBe(true);
                expect(modalManager.modalStack).not.toContain('settings-modal');
            });
            
            it('should still invoke onHide callback with skipHistory option', () => {
                createModal('contacts-modal', false);
                modalManager.modalStack = ['contacts-modal'];
                const callback = vi.fn();
                modalManager.registerOnHide('contacts-modal', callback);
                
                modalManager.hide('contacts-modal', { skipHistory: true });
                
                expect(callback).toHaveBeenCalledTimes(1);
                expect(window.history.back).not.toHaveBeenCalled();
            });
        });

        describe('sub-states inside an open modal', () => {
            const popTo = (state) => window.dispatchEvent(new PopStateEvent('popstate', { state }));

            it('pushes a history step only while the modal is open', () => {
                modalManager.pushSubState('settings-modal', vi.fn());
                expect(window.history.pushState).not.toHaveBeenCalled();

                modalManager.modalStack = ['settings-modal'];
                modalManager.pushSubState('settings-modal', vi.fn());
                expect(window.history.pushState).toHaveBeenCalledWith({ modal: 'settings-modal', sub: true }, '');
            });

            it('Back pops the step and keeps the modal open', () => {
                createModal('settings-modal', false);
                modalManager.modalStack = ['settings-modal'];
                const onPop = vi.fn();
                modalManager.pushSubState('settings-modal', onPop);

                popTo({ modal: 'settings-modal' });

                expect(onPop).toHaveBeenCalledTimes(1);
                expect(document.getElementById('settings-modal').classList.contains('hidden')).toBe(false);
                expect(modalManager.modalStack).toEqual(['settings-modal']);
            });

            it('leaving the step without Back drops its entry and swallows the pop', () => {
                createModal('settings-modal', false);
                modalManager.modalStack = ['settings-modal'];
                const onPop = vi.fn();
                modalManager.pushSubState('settings-modal', onPop);

                modalManager.dropSubState('settings-modal');
                expect(window.history.back).toHaveBeenCalledTimes(1);

                popTo({ modal: 'settings-modal' });
                expect(onPop).not.toHaveBeenCalled();
                expect(document.getElementById('settings-modal').classList.contains('hidden')).toBe(false);
            });

            it('closing the modal goes back past its steps too', () => {
                createModal('settings-modal', false);
                modalManager.modalStack = ['settings-modal'];
                modalManager.pushSubState('settings-modal', vi.fn());

                modalManager.hide('settings-modal');

                expect(window.history.go).toHaveBeenCalledWith(-2);
                expect(modalManager._subStates).toEqual([]);
            });
        });

        describe('_hideWithoutHistory()', () => {
            it('should hide modal without calling history.back', () => {
                createModal('new-channel-modal', false);
                modalManager.modalStack = ['new-channel-modal'];
                
                modalManager._hideWithoutHistory('new-channel-modal');
                
                const modal = document.getElementById('new-channel-modal');
                expect(modal.classList.contains('hidden')).toBe(true);
                expect(modalManager.modalStack).not.toContain('new-channel-modal');
                expect(window.history.back).not.toHaveBeenCalled();
            });
            
            it('should handle missing modal gracefully', () => {
                modalManager.modalStack = ['nonexistent-modal'];
                
                // Should not throw
                modalManager._hideWithoutHistory('nonexistent-modal');
                
                expect(modalManager.modalStack).not.toContain('nonexistent-modal');
            });
        });

        describe('hasOpenHistoryModal()', () => {
            it('should return false when stack is empty', () => {
                expect(modalManager.hasOpenHistoryModal()).toBe(false);
            });
            
            it('should return true when stack has modals', () => {
                modalManager.modalStack = ['settings-modal'];
                expect(modalManager.hasOpenHistoryModal()).toBe(true);
            });
            
            it('should return true for multiple modals', () => {
                modalManager.modalStack = ['settings-modal', 'contacts-modal'];
                expect(modalManager.hasOpenHistoryModal()).toBe(true);
            });
        });

        describe('stacked modals', () => {
            it('should maintain correct stack order', () => {
                createModal('settings-modal', true);
                createModal('contacts-modal', true);
                
                modalManager.show('settings-modal');
                modalManager.show('contacts-modal');
                
                expect(modalManager.modalStack).toEqual(['settings-modal', 'contacts-modal']);
            });
            
            it('should remove correct modal from stack', () => {
                createModal('settings-modal', false);
                createModal('contacts-modal', false);
                modalManager.modalStack = ['settings-modal', 'contacts-modal'];
                
                modalManager.hide('settings-modal');
                
                expect(modalManager.modalStack).toEqual(['contacts-modal']);
            });
        });

        describe('registerOnHide()', () => {
            it('should register callback for modal', () => {
                const callback = vi.fn();
                modalManager.registerOnHide('test-modal', callback);
                
                expect(modalManager.onHideCallbacks.get('test-modal')).toBe(callback);
            });
            
            it('should override previous callback for same modal', () => {
                const callback1 = vi.fn();
                const callback2 = vi.fn();
                
                modalManager.registerOnHide('test-modal', callback1);
                modalManager.registerOnHide('test-modal', callback2);
                
                expect(modalManager.onHideCallbacks.get('test-modal')).toBe(callback2);
            });
        });

        describe('onHide callback invocation', () => {
            it('should invoke callback when modal is hidden via hide()', () => {
                createModal('settings-modal', false);
                const callback = vi.fn();
                modalManager.registerOnHide('settings-modal', callback);
                
                modalManager.hide('settings-modal');
                
                expect(callback).toHaveBeenCalledTimes(1);
            });
            
            it('should invoke callback when modal is hidden via _hideWithoutHistory()', () => {
                createModal('settings-modal', false);
                const callback = vi.fn();
                modalManager.registerOnHide('settings-modal', callback);
                
                modalManager._hideWithoutHistory('settings-modal');
                
                expect(callback).toHaveBeenCalledTimes(1);
            });
            
            it('should not invoke callback when modal was already hidden', () => {
                createModal('contacts-modal', true); // already hidden
                const callback = vi.fn();
                modalManager.registerOnHide('contacts-modal', callback);
                
                modalManager.hide('contacts-modal');
                
                expect(callback).not.toHaveBeenCalled();
            });
            
            it('should not invoke callback for unregistered modal', () => {
                createModal('some-modal', false);
                const callback = vi.fn();
                modalManager.registerOnHide('other-modal', callback);
                
                modalManager.hide('some-modal');
                
                expect(callback).not.toHaveBeenCalled();
            });
            
            it('should handle missing callback gracefully', () => {
                createModal('test-modal', false);
                // No callback registered
                
                // Should not throw
                modalManager.hide('test-modal');
            });
        });
    });
});
