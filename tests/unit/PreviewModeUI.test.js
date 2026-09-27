import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../../src/js/logger.js', () => ({
    Logger: {
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn()
    }
}));

vi.mock('../../src/js/streamr.js', () => ({
    STREAM_CONFIG: {
        MESSAGE_STREAM: { MESSAGES: 0, CONTROL: 1 }
    }
}));

import { previewModeUI } from '../../src/js/ui/PreviewModeUI.js';

describe('PreviewModeUI', () => {
    let deps;

    beforeEach(() => {
        deps = {
            streamrController: {
                fetchOlderHistory: vi.fn()
            },
            identityManager: {
                verifyMessage: vi.fn().mockResolvedValue({ valid: true, trustLevel: 1 })
            },
            chatAreaUI: {
                renderMessages: vi.fn()
            },
            mediaHandler: {
                attachLightboxListeners: vi.fn()
            },
            reactionManager: {
                handleIncomingReaction: vi.fn()
            }
        };

        previewModeUI.previewChannel = null;
        previewModeUI.setDependencies(deps);
        previewModeUI.setUIController({
            attachReactionListeners: vi.fn(),
            elements: {
                messagesArea: null
            },
            showNotification: vi.fn(),
            openChatView: vi.fn()
        });
    });

    it('should fetch preview pagination from both content and control partitions', async () => {
        previewModeUI.previewChannel = {
            streamId: 'preview-stream',
            password: null,
            messages: [],
            _pendingOverrides: new Map(),
            loadingHistory: false,
            oldestTimestamp: 1000,
            hasMoreHistory: true
        };

        deps.streamrController.fetchOlderHistory.mockImplementation(async (_streamId, partition) => {
            if (partition === 0) {
                return {
                    messages: [
                        { id: 'msg-1', text: 'hello', sender: '0x1', timestamp: 900 }
                    ],
                    hasMore: false
                };
            }
            return {
                messages: [
                    { type: 'delete', targetId: 'msg-1', account: '0x1', timestamp: 950 }
                ],
                hasMore: false
            };
        });

        const result = await previewModeUI.loadMorePreviewHistory();

        expect(deps.streamrController.fetchOlderHistory).toHaveBeenCalledTimes(2);
        expect(deps.streamrController.fetchOlderHistory).toHaveBeenNthCalledWith(1, 'preview-stream', 0, 1000, 30, null);
        expect(deps.streamrController.fetchOlderHistory).toHaveBeenNthCalledWith(2, 'preview-stream', 1, 1000, 30, null);
        expect(previewModeUI.previewChannel.messages).toEqual([]);
        expect(result).toEqual({ loaded: 1, hasMore: false });
    });

    it('does not take a page whose overrides did not come back', async () => {
        previewModeUI.previewChannel = {
            streamId: 'preview-stream',
            password: null,
            messages: [],
            _pendingOverrides: new Map(),
            loadingHistory: false,
            oldestTimestamp: 1000,
            hasMoreHistory: true
        };
        deps.streamrController.fetchOlderHistory.mockImplementation(async (_streamId, partition) => (
            partition === 0
                ? { messages: [{ id: 'msg-1', text: 'hello', sender: '0x1', timestamp: 900 }], hasMore: false }
                : { messages: [], hasMore: false, failed: true }
        ));

        const result = await previewModeUI.loadMorePreviewHistory();

        expect(previewModeUI.previewChannel.messages).toEqual([]);
        expect(previewModeUI.previewChannel.oldestTimestamp).toBe(1000);
        expect(previewModeUI.previewChannel.loadingHistory).toBe(false);
        expect(result).toEqual({ loaded: 0, hasMore: true });
    });
});