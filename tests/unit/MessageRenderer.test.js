/**
 * Tests for MessageRenderer.js - Message rendering and content handling
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { messageRenderer } from '../../src/js/ui/MessageRenderer.js';

describe('MessageRenderer', () => {
    beforeEach(() => {
        // Reset dependencies
        messageRenderer.deps = {};
        document.body.innerHTML = '';
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    describe('setDependencies()', () => {
        it('should set dependencies', () => {
            const getCurrentAddress = vi.fn();
            messageRenderer.setDependencies({ getCurrentAddress });
            expect(messageRenderer.deps.getCurrentAddress).toBe(getCurrentAddress);
        });
        
        it('should merge dependencies', () => {
            messageRenderer.setDependencies({ dep1: 'a' });
            messageRenderer.setDependencies({ dep2: 'b' });
            expect(messageRenderer.deps.dep1).toBe('a');
            expect(messageRenderer.deps.dep2).toBe('b');
        });
    });

    describe('isEmojiOnly()', () => {
        it('should return false for empty text', () => {
            expect(messageRenderer.isEmojiOnly('')).toBe(false);
            expect(messageRenderer.isEmojiOnly(null)).toBe(false);
            expect(messageRenderer.isEmojiOnly(undefined)).toBe(false);
        });
        
        it('should return false for plain text', () => {
            expect(messageRenderer.isEmojiOnly('hello')).toBe(false);
            expect(messageRenderer.isEmojiOnly('Hello World')).toBe(false);
        });
        
        it('should return "true" for 1-3 emojis', () => {
            expect(messageRenderer.isEmojiOnly('😀')).toBe('true');
            expect(messageRenderer.isEmojiOnly('😀😀')).toBe('true');
            expect(messageRenderer.isEmojiOnly('😀😀😀')).toBe('true');
        });
        
        it('should return "many" for 4+ emojis', () => {
            expect(messageRenderer.isEmojiOnly('😀😀😀😀')).toBe('many');
            expect(messageRenderer.isEmojiOnly('😀😀😀😀😀')).toBe('many');
            expect(messageRenderer.isEmojiOnly('🎉🎊🎁🎈🎀')).toBe('many');
        });
        
        it('should return false for mixed text and emojis', () => {
            expect(messageRenderer.isEmojiOnly('hello 😀')).toBe(false);
            expect(messageRenderer.isEmojiOnly('😀 world')).toBe(false);
            expect(messageRenderer.isEmojiOnly('hi 👋 there')).toBe(false);
        });
        
        it('should handle emojis with spaces', () => {
            expect(messageRenderer.isEmojiOnly('😀 😀')).toBe('true');
            expect(messageRenderer.isEmojiOnly('😀  😀  😀')).toBe('true');
        });
        
        it('should handle complex emojis', () => {
            // Skin tone modifiers
            expect(messageRenderer.isEmojiOnly('👍🏻')).toBe('true');
            // Flag emojis
            expect(messageRenderer.isEmojiOnly('🇵🇹')).toBe('true');
        });
        
        it('should return false for numbers and special characters', () => {
            expect(messageRenderer.isEmojiOnly('123')).toBe(false);
            expect(messageRenderer.isEmojiOnly('!@#')).toBe(false);
            expect(messageRenderer.isEmojiOnly('😀123')).toBe(false);
        });
    });

    describe('wrapInlineEmojis()', () => {
        it('should wrap single emoji', () => {
            const result = messageRenderer.wrapInlineEmojis('Hello 😀 World');
            expect(result).toContain('<span class="inline-emoji">😀</span>');
            expect(result).toContain('Hello');
            expect(result).toContain('World');
        });
        
        it('should wrap multiple emojis', () => {
            const result = messageRenderer.wrapInlineEmojis('😀 test 🎉');
            expect(result).toContain('<span class="inline-emoji">😀</span>');
            expect(result).toContain('<span class="inline-emoji">🎉</span>');
        });
        
        it('should preserve text without emojis', () => {
            const result = messageRenderer.wrapInlineEmojis('Hello World');
            expect(result).toBe('Hello World');
        });
        
        it('should handle empty string', () => {
            expect(messageRenderer.wrapInlineEmojis('')).toBe('');
        });

        it('should not wrap emojis inside a tag', () => {
            const result = messageRenderer.wrapInlineEmojis('<a href="https://example.com/a😀b">https://example.com/a😀b</a>');
            expect(result).toContain('href="https://example.com/a😀b"');
            expect(result).toContain('>https://example.com/a<span class="inline-emoji">😀</span>b</a>');
        });

        it('should keep a link with an emoji in the URL intact', () => {
            const html = messageRenderer.renderMessageContent({ type: 'text', text: 'https://example.com/a😀b' });
            const host = document.createElement('div');
            host.innerHTML = html;
            const anchor = host.querySelector('a');
            expect(anchor.getAttribute('href')).toBe('https://example.com/a😀b');
            expect(anchor.textContent).toBe('https://example.com/a😀b');
        });
    });

    describe('formatFileSize()', () => {
        it('should format bytes', () => {
            expect(messageRenderer.formatFileSize(0)).toBe('0 B');
            expect(messageRenderer.formatFileSize(100)).toBe('100 B');
            expect(messageRenderer.formatFileSize(1023)).toBe('1023 B');
        });
        
        it('should format kilobytes', () => {
            expect(messageRenderer.formatFileSize(1024)).toBe('1.0 KB');
            expect(messageRenderer.formatFileSize(1536)).toBe('1.5 KB');
            expect(messageRenderer.formatFileSize(10240)).toBe('10.0 KB');
        });
        
        it('should format megabytes', () => {
            expect(messageRenderer.formatFileSize(1024 * 1024)).toBe('1.00 MB');
            expect(messageRenderer.formatFileSize(1024 * 1024 * 5.5)).toBe('5.50 MB');
            expect(messageRenderer.formatFileSize(1024 * 1024 * 100)).toBe('100.00 MB');
        });
        
        it('should format gigabytes', () => {
            expect(messageRenderer.formatFileSize(1024 * 1024 * 1024)).toBe('1.00 GB');
            expect(messageRenderer.formatFileSize(1024 * 1024 * 1024 * 2.5)).toBe('2.50 GB');
        });
    });

    describe('renderDateSeparator()', () => {
        it('should render "Today" for today\'s date', () => {
            const today = new Date();
            const result = messageRenderer.renderDateSeparator(today);
            expect(result).toContain('Today');
            expect(result).toContain('date-separator');
            expect(result).toContain('date-pill');
        });
        
        it('should render "Yesterday" for yesterday\'s date', () => {
            const yesterday = new Date();
            yesterday.setDate(yesterday.getDate() - 1);
            const result = messageRenderer.renderDateSeparator(yesterday);
            expect(result).toContain('Yesterday');
        });
        
        it('should render month and day for this year', () => {
            const date = new Date();
            date.setMonth(0); // January
            date.setDate(15);
            // Only test if it's not today/yesterday
            const today = new Date();
            if (date.toDateString() !== today.toDateString()) {
                const result = messageRenderer.renderDateSeparator(date);
                expect(result).toContain('January 15');
                expect(result).not.toContain(date.getFullYear().toString());
            }
        });
        
        it('should include year for past years', () => {
            const date = new Date();
            date.setFullYear(date.getFullYear() - 1);
            date.setMonth(5); // June
            date.setDate(20);
            const result = messageRenderer.renderDateSeparator(date);
            expect(result).toContain('June 20');
            expect(result).toContain((date.getFullYear()).toString());
        });
    });

    describe('renderReactions()', () => {
        it('should return empty container when no reactions', () => {
            messageRenderer.setDependencies({ getMessageReactions: () => null });
            const result = messageRenderer.renderReactions('msg-1', false);
            expect(result).toContain('reactions-container');
            expect(result).toContain('data-reactions-for="msg-1"');
            expect(result).not.toContain('reaction-badge');
        });
        
        it('should return empty container when empty reactions', () => {
            messageRenderer.setDependencies({ getMessageReactions: () => ({}) });
            const result = messageRenderer.renderReactions('msg-1', false);
            expect(result).not.toContain('reaction-badge');
        });
        
        it('should render reaction badges', () => {
            messageRenderer.setDependencies({
                getMessageReactions: () => ({
                    '👍': ['0x123', '0x456'],
                    '❤️': ['0x789']
                }),
                getCurrentAddress: () => '0x000'
            });
            
            const result = messageRenderer.renderReactions('msg-1', false);
            expect(result).toContain('reaction-badge');
            expect(result).toContain('👍');
            expect(result).toContain('2'); // count
            expect(result).toContain('❤️');
            expect(result).toContain('1'); // count
        });
        
        it('should mark user-reacted badges', () => {
            messageRenderer.setDependencies({
                getMessageReactions: () => ({
                    '👍': ['0x123', '0xabc']
                }),
                getCurrentAddress: () => '0xABC' // Case-insensitive match
            });
            
            const result = messageRenderer.renderReactions('msg-1', false);
            expect(result).toContain('user-reacted');
        });
        
        it('should not mark when user has not reacted', () => {
            messageRenderer.setDependencies({
                getMessageReactions: () => ({
                    '👍': ['0x123']
                }),
                getCurrentAddress: () => '0xDEF'
            });
            
            const result = messageRenderer.renderReactions('msg-1', false);
            expect(result).not.toContain('user-reacted');
        });
        
        it('should skip reactions with empty user list', () => {
            messageRenderer.setDependencies({
                getMessageReactions: () => ({
                    '👍': [],
                    '❤️': ['0x123']
                }),
                getCurrentAddress: () => '0x000'
            });
            
            const result = messageRenderer.renderReactions('msg-1', false);
            // Should not have badge for 👍 since no users
            const thumbsMatch = result.match(/data-emoji="👍"/g);
            expect(thumbsMatch).toBeNull();
        });
    });

    describe('renderReplyPreview()', () => {
        it('should return empty string when no replyTo', () => {
            expect(messageRenderer.renderReplyPreview(null)).toBe('');
            expect(messageRenderer.renderReplyPreview(undefined)).toBe('');
        });
        
        it('should render reply preview with sender name', () => {
            const replyTo = {
                id: 'reply-123',
                sender: '0x123',
                senderName: 'Alice',
                text: 'Original message'
            };
            
            const result = messageRenderer.renderReplyPreview(replyTo);
            expect(result).toContain('reply-preview');
            expect(result).toContain('Alice');
            expect(result).toContain('Original message');
            expect(result).toContain('data-reply-to-id="reply-123"');
        });
        
        it('should use formatted address when no sender name', () => {
            const replyTo = {
                id: 'reply-123',
                sender: '0x1234567890abcdef',
                text: 'Message'
            };
            
            const result = messageRenderer.renderReplyPreview(replyTo);
            // Should contain truncated address
            expect(result).toContain('0x123');
        });
        
        it('should truncate long text', () => {
            const replyTo = {
                id: 'reply-123',
                sender: '0x123',
                senderName: 'Bob',
                text: 'A'.repeat(100)
            };
            
            const result = messageRenderer.renderReplyPreview(replyTo);
            expect(result).toContain('...');
            expect(result).not.toContain('A'.repeat(100));
        });
        
        it('should show [Message] for empty text', () => {
            const replyTo = {
                id: 'reply-123',
                sender: '0x123',
                senderName: 'Charlie',
                text: ''
            };
            
            const result = messageRenderer.renderReplyPreview(replyTo);
            expect(result).toContain('[Message]');
        });
        
        it('should sanitize display name', () => {
            const replyTo = {
                id: 'reply-123',
                sender: '0x123',
                senderName: '<script>alert(1)</script>',
                text: 'Safe text'
            };
            
            const result = messageRenderer.renderReplyPreview(replyTo);
            expect(result).not.toContain('<script>');
        });
        
        it('should truncate long sender name to 18 chars with ellipsis', () => {
            const replyTo = {
                id: 'reply-123',
                sender: '0x123',
                senderName: 'AVeryLongDisplayNameThatExceeds',
                text: 'Hello'
            };
            
            const result = messageRenderer.renderReplyPreview(replyTo);
            expect(result).toContain('AVeryLongDisplayNa...');
            expect(result).not.toContain('AVeryLongDisplayNameThatExceeds');
        });
        
        it('should not truncate sender name at exactly 18 chars', () => {
            const replyTo = {
                id: 'reply-123',
                sender: '0x123',
                senderName: 'ExactlyEighteenCh',
                text: 'Hello'
            };
            
            const result = messageRenderer.renderReplyPreview(replyTo);
            expect(result).toContain('ExactlyEighteenCh');
            expect(result).not.toContain('ExactlyEighteenCh...');
        });
    });

    describe('renderMessageContent()', () => {
        beforeEach(() => {
            messageRenderer.setDependencies({
                getYouTubeEmbedsEnabled: () => true,
                getImage: () => null,
                getCurrentChannel: () => null
            });
        });
        
        it('should render text message', () => {
            const msg = { type: 'text', text: 'Hello World' };
            const result = messageRenderer.renderMessageContent(msg);
            expect(result).toContain('Hello World');
        });
        
        it('should escape HTML in text', () => {
            const msg = { type: 'text', text: '<script>alert(1)</script>' };
            const result = messageRenderer.renderMessageContent(msg);
            expect(result).not.toContain('<script>');
            expect(result).toContain('&lt;script&gt;');
        });
        
        it('should convert newlines to br tags', () => {
            const msg = { type: 'text', text: 'Line 1\nLine 2' };
            const result = messageRenderer.renderMessageContent(msg);
            expect(result).toContain('<br>');
        });
        
        it('should linkify URLs', () => {
            const msg = { type: 'text', text: 'Check https://example.com' };
            const result = messageRenderer.renderMessageContent(msg);
            expect(result).toContain('href="https://example.com"');
        });
        
        it('should wrap emojis', () => {
            const msg = { type: 'text', text: 'Hello 😀' };
            const result = messageRenderer.renderMessageContent(msg);
            expect(result).toContain('inline-emoji');
        });
        
        it('should handle missing type as text', () => {
            const msg = { text: 'No type specified' };
            const result = messageRenderer.renderMessageContent(msg);
            expect(result).toContain('No type specified');
        });
        
        it('should show loading for unavailable image', () => {
            messageRenderer.setDependencies({
                getImage: () => null,
                getCurrentChannel: () => ({ streamId: 'ch-123' }),
                loadImageFromLedger: vi.fn()
            });
            
            const msg = { type: 'image', imageId: 'img-123' };
            const result = messageRenderer.renderMessageContent(msg);
            expect(result).toContain('Loading image');
            expect(result).toContain('data-image-id="img-123"');
        });
    });

    describe('renderImageContent()', () => {
        it('should render image from cache', () => {
            const imageData = 'data:image/png;base64,ABC123';
            messageRenderer.setDependencies({
                getImage: () => imageData,
                registerMedia: () => 'media-123',
                cacheImage: vi.fn()
            });
            
            const msg = { type: 'image', imageId: 'img-1' };
            const result = messageRenderer.renderImageContent(msg);
            
            expect(result).toContain('<img');
            expect(result).toContain(`src="${imageData}"`);
            expect(result).toContain('data-media-id="media-123"');
            expect(result).toContain('lightbox-trigger');
        });
        
        it('should use embedded imageData and cache it', () => {
            const cacheImage = vi.fn();
            messageRenderer.setDependencies({
                getImage: () => null,
                cacheImage,
                registerMedia: () => 'media-456'
            });
            
            const msg = { 
                type: 'image', 
                imageId: 'img-2',
                imageData: 'data:image/jpeg;base64,XYZ'
            };
            const result = messageRenderer.renderImageContent(msg);
            
            expect(cacheImage).toHaveBeenCalledWith('img-2', 'data:image/jpeg;base64,XYZ');
            expect(result).toContain('<img');
        });
        
        it('should show error for invalid media registration', () => {
            messageRenderer.setDependencies({
                getImage: () => 'data:image/png;base64,test',
                registerMedia: () => null
            });
            
            const msg = { type: 'image', imageId: 'img-3' };
            const result = messageRenderer.renderImageContent(msg);
            
            expect(result).toContain('Invalid image data');
        });
    });

    describe('buildMessageHTML()', () => {
        beforeEach(() => {
            messageRenderer.setDependencies({
                getMessageReactions: () => ({}),
                getCurrentAddress: () => '0x000',
                getYouTubeEmbedsEnabled: () => true
            });
        });
        
        it('should build message HTML for own message', () => {
            const msg = {
                id: 'msg-1',
                sender: '0xABC',
                text: 'Hello',
                type: 'text'
            };
            
            const result = messageRenderer.buildMessageHTML(
                msg, true, '12:00', { html: '' }, 'Alice'
            );
            
            expect(result).toContain('own-message');
            expect(result).toContain('data-msg-id="msg-1"');
            expect(result).toContain('Hello');
            expect(result).toContain('12:00');
        });

        it('shows an erase from storage in progress on a hidden message until it answers', () => {
            const base = { id: 'msg-hidden', sender: '0xDEF', text: 'spam', type: 'text', _hidden: true };

            const erasing = messageRenderer.buildMessageHTML(
                { ...base, _erasing: true }, false, '12:00', { html: '' }, 'Bob'
            );
            expect(erasing).toContain('Hidden by moderation<span class="message-erasing');

            const erased = messageRenderer.buildMessageHTML(
                { ...base, _erased: true }, false, '12:00', { html: '' }, 'Bob'
            );
            expect(erased).toContain('Hidden · erased from storage');
            expect(erased).not.toContain('message-erasing');

            const hidden = messageRenderer.buildMessageHTML(base, false, '12:00', { html: '' }, 'Bob');
            expect(hidden).toContain('Hidden by moderation</div>');
            expect(hidden).not.toContain('message-erasing');
        });

        it('says where an unsettled publish stands', () => {
            const base = { id: 'msg-state', sender: '0xABC', text: 'Hello', type: 'text' };

            const pending = messageRenderer.buildMessageHTML(
                { ...base, pending: true }, true, '12:00', { html: '' }, 'Alice'
            );
            expect(pending).toContain('message-entry own-message');
            expect(pending).toContain(' message-pending"');
            expect(pending).toContain('sending…');
            expect(pending).not.toContain('message-retry');

            const failed = messageRenderer.buildMessageHTML(
                { ...base, failed: true, failError: 'No epoch key' }, true, '12:00', { html: '' }, 'Alice'
            );
            expect(failed).toContain(' message-failed"');
            expect(failed).toContain('Not sent');
            expect(failed).toContain('title="No epoch key"');
            expect(failed).toContain('class="message-retry text-xs text-red-400" data-msg-id="msg-state"');
            expect(failed).not.toContain('sending…');

            const sent = messageRenderer.buildMessageHTML(base, true, '12:00', { html: '' }, 'Alice');
            expect(sent).not.toContain('message-status');
            expect(sent).not.toContain('message-pending');
            expect(sent).not.toContain('message-failed');

            const undelivered = messageRenderer.buildMessageHTML(
                { ...base, failed: true, undelivered: true, failError: 'Not delivered: the storage node did not record this message' },
                true, '12:00', { html: '' }, 'Alice'
            );
            expect(undelivered).toContain(' message-failed"');
            expect(undelivered).toContain('>Not delivered</span>');
            expect(undelivered).toContain('class="message-retry text-xs text-red-400" data-msg-id="msg-state"');

            const delivered = messageRenderer.buildMessageHTML({ ...base, delivered: true }, true, '12:00', { html: '' }, 'Alice');
            expect(delivered).toContain(' message-delivered"');
            expect(delivered).not.toContain('message-status');
        });
        
        it('should build message HTML for other\'s message', () => {
            const msg = {
                id: 'msg-2',
                sender: '0xDEF',
                text: 'Hi there',
                type: 'text'
            };
            
            const result = messageRenderer.buildMessageHTML(
                msg, false, '13:00', { html: '<span>✓</span>' }, 'Bob'
            );
            
            expect(result).toContain('other-message');
            expect(result).toContain('Hi there');
            expect(result).toContain('Bob');
        });
        
        it('should truncate long display name to 18 chars with ellipsis', () => {
            const msg = {
                id: 'msg-trunc',
                sender: '0xDEF',
                text: 'Hello',
                type: 'text'
            };
            
            const result = messageRenderer.buildMessageHTML(
                msg, false, '13:00', { html: '' }, 'AVeryLongDisplayNameThatExceeds'
            );
            
            expect(result).toContain('AVeryLongDisplayNa...');
            expect(result).not.toContain('AVeryLongDisplayNameThatExceeds');
        });
        
        it('should not truncate display name at exactly 18 chars', () => {
            const msg = {
                id: 'msg-exact',
                sender: '0xDEF',
                text: 'Hello',
                type: 'text'
            };
            
            const result = messageRenderer.buildMessageHTML(
                msg, false, '13:00', { html: '' }, 'ExactlyEighteenCh'
            );
            
            expect(result).toContain('ExactlyEighteenCh');
            expect(result).not.toContain('ExactlyEighteenCh...');
        });
        
        it('should include reply and react buttons', () => {
            const msg = { id: 'msg-3', sender: '0x1', text: 'Test' };
            
            const result = messageRenderer.buildMessageHTML(
                msg, false, '14:00', { html: '' }, 'User'
            );
            
            expect(result).toContain('reply-btn');
            expect(result).toContain('react-btn');
            expect(result).toContain('data-msg-id="msg-3"');
        });
        
        it('should include avatar in group open HTML for other\'s sender', () => {
            // Avatars now live at the group level, not per-message, since each
            // run of consecutive messages from the same sender shares a single
            // sticky avatar rendered by buildMessageGroupOpenHTML().
            const result = messageRenderer.buildMessageGroupOpenHTML({
                sender: '0x123',
                isOwn: false,
                ensAvatarUrl: null
            });

            expect(result).toContain('message-group');
            expect(result).toContain('message-group-avatar-rail');
            expect(result).toContain('message-avatar');
            expect(result).toContain('<svg'); // Avatar SVG
        });
        
        it('should add emoji-only attribute for emoji messages', () => {
            const msg = { id: 'msg-5', sender: '0x1', text: '😀😀', type: 'text' };
            
            const result = messageRenderer.buildMessageHTML(
                msg, false, '16:00', { html: '' }, 'User'
            );
            
            expect(result).toContain('data-emoji-only="true"');
        });
        
        it('should show invalid signature warning', () => {
            const msg = {
                id: 'msg-6',
                sender: '0x1',
                text: 'Suspicious',
                verified: { valid: false },
                signature: 'invalid-sig'
            };
            
            const result = messageRenderer.buildMessageHTML(
                msg, false, '17:00', { html: '' }, 'User'
            );
            
            expect(result).toContain('Invalid signature');
        });
        
        it('should include reply preview when present', () => {
            const msg = {
                id: 'msg-7',
                sender: '0x1',
                text: 'Reply text',
                replyTo: {
                    id: 'original-msg',
                    sender: '0x2',
                    senderName: 'Original',
                    text: 'Original text'
                }
            };
            
            const result = messageRenderer.buildMessageHTML(
                msg, false, '18:00', { html: '' }, 'User'
            );
            
            expect(result).toContain('reply-preview');
            expect(result).toContain('Original');
        });
        
        it('should apply group class', () => {
            const msg = { id: 'msg-8', sender: '0x1', text: 'Test' };
            
            const result = messageRenderer.buildMessageHTML(
                msg, false, '19:00', { html: '' }, 'User', 'msg-group-middle'
            );
            
            expect(result).toContain('msg-group-middle');
        });
        
        it('should apply spacing class', () => {
            const msg = { id: 'msg-9', sender: '0x1', text: 'Test' };
            
            const result = messageRenderer.buildMessageHTML(
                msg, false, '20:00', { html: '' }, 'User', 'msg-group-single', 'SINGLE', 'msg-spacing-large'
            );
            
            expect(result).toContain('msg-spacing-large');
        });
        
        it('should use timestamp as fallback for msgId', () => {
            const msg = { timestamp: 12345, sender: '0x1', text: 'Test' };
            
            const result = messageRenderer.buildMessageHTML(
                msg, false, '21:00', { html: '' }, 'User'
            );
            
            expect(result).toContain('data-msg-id="12345"');
        });

        it('should show (edited) badge when message._edited is true', () => {
            const msg = {
                id: 'msg-edited',
                sender: '0x1',
                text: 'Updated text',
                _edited: true
            };

            const result = messageRenderer.buildMessageHTML(
                msg, true, '22:00', { html: '' }, 'User'
            );

            expect(result).toContain('(edited)');
            expect(result).toContain('message-edited');
        });

        it('should NOT show (edited) badge when _edited is false/absent', () => {
            const msg = {
                id: 'msg-normal',
                sender: '0x1',
                text: 'Normal text'
            };

            const result = messageRenderer.buildMessageHTML(
                msg, true, '22:00', { html: '' }, 'User'
            );

            expect(result).not.toContain('(edited)');
            expect(result).not.toContain('message-edited');
        });
    });

    describe('renderFileBubble()', () => {
        const pdf = (extra = {}) => ({
            type: 'file_announce',
            metadata: {
                fileId: 'doc-1',
                fileName: 'report.pdf',
                fileType: 'application/pdf',
                fileSize: 5 * 1024 * 1024,
                pieceHashes: ['h0'],
                ...extra
            }
        });

        it('renders a file row rather than the video panel', () => {
            messageRenderer.setDependencies({
                getFileUrl: () => null, getCurrentAddress: () => '0x1', isSeeding: () => false
            });

            const result = messageRenderer.renderVideoContent(pdf());

            expect(result).toContain('report.pdf');
            expect(result).toContain('download-file-btn');
            // The 16:9 player shell belongs to videos only
            expect(result).not.toContain('aspect-ratio: 16/9');
        });

        it('shows transferred, total and speed while downloading', () => {
            messageRenderer.setDependencies({
                getFileUrl: () => null,
                getCurrentAddress: () => '0x1',
                isSeeding: () => false,
                isDownloading: () => true,
                getDownloadProgress: () => ({
                    percent: 40, received: 4, total: 10,
                    fileSize: 5 * 1024 * 1024, bytesPerSec: 348160
                })
            });

            const result = messageRenderer.renderVideoContent(pdf());

            expect(result).toContain('2.00 MB of 5.00 MB');
            expect(result).toContain('340.0 KB/s');
            expect(result).toContain('width: 40%');
            // The bar carries the busy state now: the spinner is gone and the
            // download button is withdrawn entirely while a transfer runs
            expect(result).not.toContain('download-file-btn');
            expect(result).not.toContain('animate-spin');
        });

        it('omits the rate until one is measured', () => {
            messageRenderer.setDependencies({
                getFileUrl: () => null,
                getCurrentAddress: () => '0x1',
                isSeeding: () => false,
                isDownloading: () => true,
                getDownloadProgress: () => ({
                    percent: 10, received: 1, total: 10,
                    fileSize: 5 * 1024 * 1024, bytesPerSec: null
                })
            });

            const result = messageRenderer.renderVideoContent(pdf());

            expect(result).toContain('of 5.00 MB');
            expect(result).not.toContain('B/s');
        });

        it('makes the filename the link once the file is held locally', () => {
            messageRenderer.setDependencies({
                getFileUrl: () => 'blob:doc', getCurrentAddress: () => '0x1', isSeeding: () => true
            });

            const result = messageRenderer.renderVideoContent(pdf());

            // The name itself is the link; a separate Save button is noise
            expect(result).toContain('blob:doc');
            expect(result).toContain('download="report.pdf"');
            expect(result).not.toContain('>Save<');
            expect(result).not.toContain('download-file-btn');
        });

        it('marks the icon green and says seeding once the file is here', () => {
            messageRenderer.setDependencies({
                getFileUrl: () => 'blob:doc', getCurrentAddress: () => '0x1', isSeeding: () => true
            });

            const result = messageRenderer.renderVideoContent(pdf());

            expect(result).toContain('text-green-400/70');
            expect(result).toContain('seeding...');
        });

        it('leaves the icon neutral and says nothing about seeding while unavailable', () => {
            messageRenderer.setDependencies({
                getFileUrl: () => null, getCurrentAddress: () => '0x1', isSeeding: () => false
            });

            const result = messageRenderer.renderVideoContent(pdf());

            expect(result).not.toContain('text-green-400/70');
            expect(result).not.toContain('seeding...');
        });

        it('shows upload rate and leecher count while seeding', () => {
            messageRenderer.setDependencies({
                getFileUrl: () => 'blob:doc', getCurrentAddress: () => '0x1', isSeeding: () => true
            });

            const result = messageRenderer.renderVideoContent(pdf());

            expect(result).toContain('data-upload-speed="doc-1"');
            expect(result).toContain('data-leecher-count="doc-1"');
        });

        it('omits serving stats when we do not hold the file', () => {
            messageRenderer.setDependencies({
                getFileUrl: () => null, getCurrentAddress: () => '0x1', isSeeding: () => false
            });

            const result = messageRenderer.renderVideoContent(pdf());

            expect(result).not.toContain('data-upload-speed');
            expect(result).not.toContain('data-leecher-count');
        });

        it('escapes quotes in the download filename attribute', () => {
            messageRenderer.setDependencies({
                getFileUrl: () => 'blob:doc', getCurrentAddress: () => '0x1', isSeeding: () => false
            });

            const result = messageRenderer.renderVideoContent(pdf({ fileName: 'a" onload="alert(1)' }));

            expect(result).not.toContain('onload="alert(1)"');
        });
    });

    describe('formatSpeed()', () => {
        it('scales the unit to the rate', () => {
            expect(messageRenderer.formatSpeed(512)).toBe('512 B/s');
            expect(messageRenderer.formatSpeed(2048)).toBe('2.0 KB/s');
            expect(messageRenderer.formatSpeed(5 * 1048576)).toBe('5.00 MB/s');
        });

        it('renders nothing when there is no rate to show', () => {
            expect(messageRenderer.formatSpeed(null)).toBe('');
            expect(messageRenderer.formatSpeed(0)).toBe('');
            expect(messageRenderer.formatSpeed(undefined)).toBe('');
        });
    });

    describe('renderVideoContent()', () => {
        it('should return escaped text if no metadata', () => {
            const msg = { type: 'file_announce', text: 'Video shared' };
            const result = messageRenderer.renderVideoContent(msg);
            expect(result).toBe('Video shared');
        });
        
        it('should sanitize metadata', () => {
            messageRenderer.setDependencies({
                getFileUrl: () => null,
                getCurrentAddress: () => '0x123'
            });
            
            const msg = {
                type: 'file_announce',
                metadata: {
                    fileId: 'file-123',
                    fileName: '<script>hack</script>.mp4',
                    fileType: 'video/mp4',
                    fileSize: 1024
                }
            };
            
            const result = messageRenderer.renderVideoContent(msg);
            expect(result).not.toContain('<script>');
        });
        
        // A lean record restored from our own sync: naming only, no piece hashes, so
        // there is nothing to fetch and the download affordance must not be offered.
        it('should show the placeholder when there are no piece hashes', () => {
            messageRenderer.setDependencies({
                getFileUrl: () => null,
                getCurrentAddress: () => '0x123',
                isSeeding: () => false
            });

            const result = messageRenderer.renderVideoContent({
                type: 'file_announce',
                metadata: {
                    fileId: 'file-lean-1',
                    fileName: 'holiday.mp4',
                    fileType: 'video/mp4',
                    fileSize: 5000000
                }
            });

            expect(result).toContain('not on this device');
            expect(result).toContain('holiday.mp4');
            expect(result).toContain('data-file-id="file-lean-1"');
            // Must not offer an action that could only fail
            expect(result).not.toContain('download-file-btn');
            expect(result).not.toContain('data-progress-overlay');
        });

        // Non-video types go to the file bubble in every state, including this one —
        // it renders its own unavailable treatment rather than the video placeholder
        it('should route unavailable non-video files to the file bubble', () => {
            messageRenderer.setDependencies({
                getFileUrl: () => null,
                getCurrentAddress: () => '0x123',
                isSeeding: () => false
            });

            const result = messageRenderer.renderVideoContent({
                type: 'file_announce',
                metadata: {
                    fileId: 'file-lean-2',
                    fileName: 'report.pdf',
                    fileType: 'application/pdf',
                    fileSize: 2048
                }
            });

            expect(result).toContain('report.pdf');
            expect(result).toContain('not on this device');
            expect(result).not.toContain('download-file-btn');
        });

        // The same device still holding the file must get the real bubble back,
        // not the placeholder — that is the whole point of keeping the naming.
        it('should prefer the real player over the placeholder when the file is local', () => {
            messageRenderer.setDependencies({
                getFileUrl: () => 'blob:local-copy',
                getCurrentAddress: () => '0x123',
                isSeeding: () => true,
                isVideoPlayable: () => true,
                registerMedia: () => 'media-1'
            });

            const result = messageRenderer.renderVideoContent({
                type: 'file_announce',
                metadata: {
                    fileId: 'file-lean-3',
                    fileName: 'holiday.mp4',
                    fileType: 'video/mp4',
                    fileSize: 5000000
                }
            });

            expect(result).toContain('blob:local-copy');
            expect(result).not.toContain('not on this device');
        });

        it('should escape quotes in the placeholder filename attribute', () => {
            messageRenderer.setDependencies({
                getFileUrl: () => null,
                getCurrentAddress: () => '0x123',
                isSeeding: () => false
            });

            const result = messageRenderer.renderVideoContent({
                type: 'file_announce',
                metadata: {
                    fileId: 'file-lean-4',
                    fileName: 'a" onmouseover="alert(1)',
                    fileType: 'video/mp4',
                    fileSize: 10
                }
            });

            expect(result).not.toContain('onmouseover="alert(1)"');
        });

        it('should show download panel when video not available', () => {
            messageRenderer.setDependencies({
                getFileUrl: () => null,
                getCurrentAddress: () => '0x123',
                isSeeding: () => false
            });
            
            const msg = {
                type: 'file_announce',
                metadata: {
                    fileId: 'file-456',
                    pieceHashes: ['h0'],
                    fileName: 'video.mp4',
                    fileType: 'video/mp4',
                    fileSize: 5000000
                }
            };
            
            const result = messageRenderer.renderVideoContent(msg);
            expect(result).toContain('download-file-btn');
            expect(result).toContain('data-file-id="file-456"');
            expect(result).toContain('video.mp4');
        });

        it('should show downloading state with progress when download is active', () => {
            messageRenderer.setDependencies({
                getFileUrl: () => null,
                getCurrentAddress: () => '0x123',
                isSeeding: () => false,
                isDownloading: () => true,
                getDownloadProgress: () => ({ percent: 45, received: 9, total: 20, fileSize: 10485760 })
            });
            
            const msg = {
                type: 'file_announce',
                metadata: {
                    fileId: 'file-dl-1',
                    pieceHashes: ['h0'],
                    fileName: 'movie.mp4',
                    fileType: 'video/mp4',
                    fileSize: 10485760
                }
            };
            
            const result = messageRenderer.renderVideoContent(msg);
            // Progress overlay should be visible (no 'hidden' class)
            expect(result).not.toMatch(/data-progress-overlay="file-dl-1"[^>]*class="hidden/);
            // Should show percentage
            expect(result).toContain('45%');
            // Progress bar should reflect percentage
            expect(result).toContain('width: 45%');
            // Download button should be disabled
            expect(result).toContain('disabled');
            expect(result).toContain('cursor-not-allowed');
            // Play icon hidden, loading icon visible
            expect(result).toMatch(/download-play-icon[^"]*hidden/);
            expect(result).not.toMatch(/download-loading-icon[^"]*hidden/);
            // Should show MB progress
            expect(result).toContain('/ 10.0 MB');
        });

        it('should show idle state when not downloading and no URL', () => {
            messageRenderer.setDependencies({
                getFileUrl: () => null,
                getCurrentAddress: () => '0x123',
                isSeeding: () => false,
                isDownloading: () => false,
                getDownloadProgress: () => null
            });
            
            const msg = {
                type: 'file_announce',
                metadata: {
                    fileId: 'file-idle-1',
                    pieceHashes: ['h0'],
                    fileName: 'clip.mp4',
                    fileType: 'video/mp4',
                    fileSize: 2048000
                }
            };
            
            const result = messageRenderer.renderVideoContent(msg);
            // Progress overlay should be hidden
            expect(result).toMatch(/data-progress-overlay="file-idle-1"[^>]*class="hidden/);
            // Button should NOT be disabled
            expect(result).not.toContain('disabled');
            // Play icon visible
            expect(result).not.toMatch(/download-play-icon[^"]*hidden/);
            // Loading icon hidden
            expect(result).toMatch(/download-loading-icon[^"]*hidden/);
        });

        it('should fallback gracefully when isDownloading dep is not wired', () => {
            messageRenderer.setDependencies({
                getFileUrl: () => null,
                getCurrentAddress: () => '0x123',
                isSeeding: () => false
                // isDownloading and getDownloadProgress NOT provided
            });
            
            const msg = {
                type: 'file_announce',
                metadata: {
                    fileId: 'file-compat-1',
                    pieceHashes: ['h0'],
                    fileName: 'old.mp4',
                    fileType: 'video/mp4',
                    fileSize: 1024000
                }
            };
            
            const result = messageRenderer.renderVideoContent(msg);
            // Should render normal idle state (backward compatible)
            expect(result).toMatch(/data-progress-overlay="file-compat-1"[^>]*class="hidden/);
            expect(result).not.toContain('disabled');
        });
    });
});
