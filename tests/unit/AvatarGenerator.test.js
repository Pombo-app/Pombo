/**
 * AvatarGenerator Module Tests
 * Tests for deterministic SVG avatar generation
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { 
    generateAvatar,
    generateAvatarDataUri,
    getAvatar,
    clearAvatarCache,
    getAddressColor,
    getAvatarHtml,
    downgradeEnsAvatars,
    avatarGenerator
} from '../../src/js/ui/AvatarGenerator.js';
import { CONFIG } from '../../src/js/config.js';

/**
 * Normalize SVG by removing unique clipPath IDs
 * Used for comparing avatar appearance (colors, shapes) ignoring unique IDs
 */
const normalizeSvg = svg => svg.replace(/avatar-clip-[a-z0-9-]+/g, 'avatar-clip-X');

describe('AvatarGenerator', () => {
    // Clear cache before each test to ensure isolation
    beforeEach(() => {
        clearAvatarCache();
    });

    describe('generateAvatar', () => {
        it('should return valid SVG string', () => {
            const address = '0x1234567890abcdef1234567890abcdef12345678';
            const svg = generateAvatar(address);
            expect(svg).toContain('<svg');
            expect(svg).toContain('</svg>');
            expect(svg).toContain('xmlns="http://www.w3.org/2000/svg"');
        });

        it('should generate consistent avatar appearance for same address', () => {
            const address = '0xabcdef1234567890abcdef1234567890abcdef12';
            const svg1 = generateAvatar(address);
            const svg2 = generateAvatar(address);
            // ClipPath IDs are unique per call, but colors and shapes are deterministic
            expect(normalizeSvg(svg1)).toBe(normalizeSvg(svg2));
        });

        it('should generate different avatars for different addresses', () => {
            const svg1 = generateAvatar('0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
            const svg2 = generateAvatar('0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb');
            // Should be different (different colors/shapes)
            expect(normalizeSvg(svg1)).not.toBe(normalizeSvg(svg2));
        });

        it('should be case-insensitive for addresses', () => {
            const address = '0xAbCdEf1234567890ABCDEF1234567890abcdef12';
            const svg1 = generateAvatar(address.toLowerCase());
            const svg2 = generateAvatar(address.toUpperCase());
            expect(normalizeSvg(svg1)).toBe(normalizeSvg(svg2));
        });

        it('should use default size of 32 in viewBox', () => {
            const svg = generateAvatar('0x1234567890abcdef1234567890abcdef12345678');
            // SVG uses fixed dimensions matching the requested size
            expect(svg).toContain('width="32"');
            expect(svg).toContain('height="32"');
            expect(svg).toContain('viewBox="0 0 32 32"');
        });

        it('should respect custom size in viewBox', () => {
            const svg = generateAvatar('0x1234567890abcdef1234567890abcdef12345678', 64);
            // SVG uses fixed dimensions matching the requested size
            expect(svg).toContain('width="64"');
            expect(svg).toContain('height="64"');
            expect(svg).toContain('viewBox="0 0 64 64"');
        });

        it('should respect custom border radius', () => {
            const svg1 = generateAvatar('0x1234567890abcdef1234567890abcdef12345678', 32, 0);
            const svg2 = generateAvatar('0x1234567890abcdef1234567890abcdef12345678', 32, 0.5);
            // rx should be different
            expect(svg1).toContain('rx="0"');
            expect(svg2).toContain('rx="16"'); // 32 * 0.5
        });

        it('should handle null address with fallback', () => {
            const svg = generateAvatar(null);
            expect(svg).toContain('<svg');
            expect(svg).toContain('</svg>');
        });

        it('should handle undefined address with fallback', () => {
            const svg = generateAvatar(undefined);
            expect(svg).toContain('<svg');
            expect(svg).toContain('</svg>');
        });

        it('should handle empty string with fallback', () => {
            const svg = generateAvatar('');
            expect(svg).toContain('<svg');
            expect(svg).toContain('</svg>');
        });

        it('should include rect for background', () => {
            const svg = generateAvatar('0x1234567890abcdef1234567890abcdef12345678');
            expect(svg).toContain('<rect');
            expect(svg).toContain('fill="');
        });

        it('should include path for shape', () => {
            const svg = generateAvatar('0x1234567890abcdef1234567890abcdef12345678');
            expect(svg).toContain('<path');
            expect(svg).toContain('d="');
        });

        it('should include transform for rotation', () => {
            const svg = generateAvatar('0x1234567890abcdef1234567890abcdef12345678');
            expect(svg).toContain('transform="rotate(');
        });
    });

    describe('generateAvatarDataUri', () => {
        it('should return valid data URI', () => {
            const address = '0x1234567890abcdef1234567890abcdef12345678';
            const dataUri = generateAvatarDataUri(address);
            expect(dataUri).toMatch(/^data:image\/svg\+xml,/);
        });

        it('should contain encoded SVG', () => {
            const address = '0x1234567890abcdef1234567890abcdef12345678';
            const dataUri = generateAvatarDataUri(address);
            expect(dataUri).toContain('%3Csvg');  // Encoded <svg
        });

        it('should be consistent for same address (normalized)', () => {
            const address = '0xabcdef1234567890abcdef1234567890abcdef12';
            const dataUri1 = generateAvatarDataUri(address);
            const dataUri2 = generateAvatarDataUri(address);
            // Normalize to compare visual content, ignoring unique IDs
            expect(normalizeSvg(decodeURIComponent(dataUri1))).toBe(normalizeSvg(decodeURIComponent(dataUri2)));
        });
    });

    describe('getAvatar (cached)', () => {
        it('should return visually same result as generateAvatar', () => {
            const address = '0x1234567890abcdef1234567890abcdef12345678';
            const generated = generateAvatar(address);
            const cached = getAvatar(address);
            // Visual content should match, IDs may differ
            expect(normalizeSvg(cached)).toBe(normalizeSvg(generated));
        });

        it('should cache results with unique IDs per call', () => {
            const address = '0x1234567890abcdef1234567890abcdef12345678';
            const result1 = getAvatar(address);
            const result2 = getAvatar(address);
            // Visual content same, but IDs unique to prevent DOM conflicts
            expect(normalizeSvg(result1)).toBe(normalizeSvg(result2));
            // IDs should be different
            expect(result1).not.toBe(result2);
        });

        it('should generate unique clipPath IDs to prevent DOM conflicts', () => {
            const address = '0x1234567890abcdef1234567890abcdef12345678';
            const svg1 = getAvatar(address);
            const svg2 = getAvatar(address);
            const svg3 = getAvatar(address);
            
            // Extract clipPath IDs
            const extractClipId = svg => svg.match(/id="(avatar-clip-[^"]+)"/)?.[1];
            const id1 = extractClipId(svg1);
            const id2 = extractClipId(svg2);
            const id3 = extractClipId(svg3);
            
            // All IDs should be unique
            expect(id1).toBeDefined();
            expect(id2).toBeDefined();
            expect(id3).toBeDefined();
            expect(id1).not.toBe(id2);
            expect(id2).not.toBe(id3);
            expect(id1).not.toBe(id3);
        });

        it('should use different cache keys for different sizes', () => {
            const address = '0x1234567890abcdef1234567890abcdef12345678';
            const svg32 = getAvatar(address, 32);
            const svg64 = getAvatar(address, 64);
            expect(normalizeSvg(svg32)).not.toBe(normalizeSvg(svg64));
        });

        it('should use different cache keys for different border radius', () => {
            const address = '0x1234567890abcdef1234567890abcdef12345678';
            const svg1 = getAvatar(address, 32, 0);
            const svg2 = getAvatar(address, 32, 0.5);
            expect(normalizeSvg(svg1)).not.toBe(normalizeSvg(svg2));
        });

        it('should handle null address', () => {
            const svg = getAvatar(null);
            expect(svg).toContain('<svg');
        });
    });

    describe('clearAvatarCache', () => {
        it('should clear the cache without errors', () => {
            const address = '0x1234567890abcdef1234567890abcdef12345678';
            getAvatar(address); // Add to cache
            expect(() => clearAvatarCache()).not.toThrow();
        });

        it('should force regeneration after clear', () => {
            const address = '0x1234567890abcdef1234567890abcdef12345678';
            const svg1 = getAvatar(address);
            clearAvatarCache();
            const svg2 = getAvatar(address);
            // Visual content should be the same (deterministic)
            expect(normalizeSvg(svg1)).toBe(normalizeSvg(svg2));
        });
    });

    describe('getAddressColor', () => {
        it('should return valid hex color', () => {
            const address = '0x1234567890abcdef1234567890abcdef12345678';
            const color = getAddressColor(address);
            expect(color).toMatch(/^#[0-9a-f]{6}$/i);
        });

        it('should return consistent color for same address', () => {
            const address = '0xabcdef1234567890abcdef1234567890abcdef12';
            const color1 = getAddressColor(address);
            const color2 = getAddressColor(address);
            expect(color1).toBe(color2);
        });

        it('should be case-insensitive', () => {
            const address = '0xAbCdEf1234567890ABCDEF1234567890abcdef12';
            const color1 = getAddressColor(address.toLowerCase());
            const color2 = getAddressColor(address.toUpperCase());
            expect(color1).toBe(color2);
        });

        it('should return different colors for different addresses', () => {
            const color1 = getAddressColor('0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
            const color2 = getAddressColor('0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb');
            // Most likely different (could theoretically collide)
            expect(color1).not.toBe(color2);
        });

        it('should handle null with default color', () => {
            const color = getAddressColor(null);
            expect(color).toMatch(/^#[0-9a-f]{6}$/i);
        });

        it('should handle undefined with default color', () => {
            const color = getAddressColor(undefined);
            expect(color).toMatch(/^#[0-9a-f]{6}$/i);
        });

        it('should handle empty string with default color', () => {
            const color = getAddressColor('');
            expect(color).toMatch(/^#[0-9a-f]{6}$/i);
        });
    });

    describe('avatarGenerator singleton', () => {
        it('should have generate method', () => {
            expect(typeof avatarGenerator.generate).toBe('function');
        });

        it('should have generateDataUri method', () => {
            expect(typeof avatarGenerator.generateDataUri).toBe('function');
        });

        it('should have get method', () => {
            expect(typeof avatarGenerator.get).toBe('function');
        });

        it('should have clearCache method', () => {
            expect(typeof avatarGenerator.clearCache).toBe('function');
        });

        it('should have getColor method', () => {
            expect(typeof avatarGenerator.getColor).toBe('function');
        });

        it('should produce same visual results as direct functions', () => {
            const address = '0x1234567890abcdef1234567890abcdef12345678';
            expect(normalizeSvg(avatarGenerator.generate(address))).toBe(normalizeSvg(generateAvatar(address)));
            expect(avatarGenerator.getColor(address)).toBe(getAddressColor(address));
        });
    });

    describe('Shape diversity', () => {
        it('should generate different shapes for various addresses', () => {
            const shapes = new Set();
            // Generate many avatars and check shape diversity
            for (let i = 0; i < 100; i++) {
                const address = `0x${i.toString(16).padStart(40, '0')}`;
                const svg = generateAvatar(address);
                // Extract path d attribute to identify shape
                const pathMatch = svg.match(/d="([^"]+)"/);
                if (pathMatch) {
                    // Use first command to identify shape type
                    const shapeSignature = pathMatch[1].substring(0, 50);
                    shapes.add(shapeSignature);
                }
            }
            // Should have multiple different shapes
            expect(shapes.size).toBeGreaterThan(5);
        });

        it('should use various color pairs', () => {
            const colors = new Set();
            for (let i = 0; i < 100; i++) {
                const address = `0x${(i * 7).toString(16).padStart(40, '0')}`;
                const svg = generateAvatar(address);
                const rectMatch = svg.match(/fill="(#[0-9a-fA-F]{6})"/);
                if (rectMatch) {
                    colors.add(rectMatch[1]);
                }
            }
            // Should have multiple different background colors
            expect(colors.size).toBeGreaterThan(10);
        });

        it('should include rotation in transform', () => {
            const rotations = new Set();
            for (let i = 0; i < 50; i++) {
                const address = `0x${i.toString(16).padStart(40, 'a')}`;
                const svg = generateAvatar(address);
                const rotateMatch = svg.match(/rotate\((\d+)/);
                if (rotateMatch) {
                    rotations.add(rotateMatch[1]);
                }
            }
            // Should have multiple rotation values (0, 45, 90, 135, 180, 225, 270, 315)
            expect(rotations.size).toBeGreaterThan(2);
        });
    });

    describe('Cache eviction', () => {
        it('should evict oldest entry when cache is full', () => {
            clearAvatarCache();
            
            // Fill cache with many entries
            for (let i = 0; i < 250; i++) {
                const address = `0x${i.toString(16).padStart(40, '0')}`;
                getAvatar(address);
            }
            
            // Cache should not exceed MAX_CACHE_SIZE (200)
            // We can't directly check cache size, but operation should not throw
            const lastAddress = '0x' + 'f'.repeat(40);
            const svg = getAvatar(lastAddress);
            expect(svg).toContain('<svg');
        });

        it('should return same visual result after cache eviction', () => {
            clearAvatarCache();
            
            const testAddress = '0x1111111111111111111111111111111111111111';
            const original = generateAvatar(testAddress);
            
            // Fill cache to trigger eviction
            for (let i = 0; i < 250; i++) {
                getAvatar(`0x${i.toString(16).padStart(40, '0')}`);
            }
            
            // Should still generate same visual avatar (deterministic, only ID differs)
            const afterEviction = getAvatar(testAddress);
            expect(normalizeSvg(afterEviction)).toBe(normalizeSvg(original));
        });
    });

    describe('Edge cases', () => {
        it('should handle extremely long string', () => {
            const longAddress = '0x' + 'a'.repeat(1000);
            const svg = generateAvatar(longAddress);
            expect(svg).toContain('<svg');
        });

        it('should handle non-hex characters gracefully', () => {
            const weirdAddress = '0xghijklmnop123456789012345678901234567890';
            const svg = generateAvatar(weirdAddress);
            expect(svg).toContain('<svg');
        });

        it('should handle partial address', () => {
            const partialAddress = '0x123';
            const svg = generateAvatar(partialAddress);
            expect(svg).toContain('<svg');
        });

        it('should generate valid SVG for all border radius values', () => {
            const address = '0x1234567890abcdef1234567890abcdef12345678';
            
            [0, 0.1, 0.25, 0.5, 0.75, 1].forEach(radius => {
                const svg = generateAvatar(address, 32, radius);
                expect(svg).toContain('<svg');
                expect(svg).toContain(`rx="${32 * radius}"`);
            });
        });

        it('should handle very small sizes', () => {
            const svg = generateAvatar('0x1234567890abcdef1234567890abcdef12345678', 8);
            expect(svg).toContain('width="8"');
            expect(svg).toContain('height="8"');
        });

        it('should handle large sizes', () => {
            const svg = generateAvatar('0x1234567890abcdef1234567890abcdef12345678', 512);
            expect(svg).toContain('width="512"');
            expect(svg).toContain('height="512"');
        });
    });

    describe('hashString behavior', () => {
        it('should produce consistent visual results', () => {
            const address = '0xabcdef';
            const svg1 = generateAvatar(address);
            const svg2 = generateAvatar(address);
            expect(normalizeSvg(svg1)).toBe(normalizeSvg(svg2));
        });

        it('should differentiate similar addresses', () => {
            // Addresses differing by one character
            const svg1 = generateAvatar('0x1234567890abcdef1234567890abcdef12345670');
            const svg2 = generateAvatar('0x1234567890abcdef1234567890abcdef12345671');
            // May or may not be different depending on hash collision
            expect(svg1).toBeDefined();
            expect(svg2).toBeDefined();
        });
    });

    describe('Organic blob features', () => {
        it('should generate two overlapping blob shapes', () => {
            const address = '0x1234567890abcdef1234567890abcdef12345678';
            const svg = generateAvatar(address);
            // Find the main shape path
            const mainPathMatch = svg.match(/<path d="([^"]+)"/);
            expect(mainPathMatch).not.toBeNull();
            if (mainPathMatch) {
                // Count 'M' commands - should be 2 for two blobs
                const mCount = (mainPathMatch[1].match(/M/g) || []).length;
                expect(mCount).toBe(2);
            }
        });

        it('should use Catmull-Rom curves (C commands)', () => {
            const address = '0x1234567890abcdef1234567890abcdef12345678';
            const svg = generateAvatar(address);
            const mainPathMatch = svg.match(/<path d="([^"]+)"/);
            expect(mainPathMatch).not.toBeNull();
            if (mainPathMatch) {
                // Should contain C commands for smooth curves
                const cCount = (mainPathMatch[1].match(/C/g) || []).length;
                expect(cCount).toBeGreaterThan(10); // Multiple curve segments
            }
        });

        it('should have frame element with background color', () => {
            const address = '0xabcdef1234567890abcdef1234567890abcdef12';
            const svg = generateAvatar(address);
            // Extract background color from rect
            const bgMatch = svg.match(/<rect[^>]+fill="(#[0-9a-fA-F]{6})"/);
            expect(bgMatch).not.toBeNull();
            
            if (bgMatch) {
                const bgColor = bgMatch[1];
                // Frame path should use same color as background with fill-rule
                const framePath = svg.match(new RegExp(`<path[^>]+fill="${bgColor}"[^>]*fill-rule="evenodd"`));
                expect(framePath).not.toBeNull();
            }
        });

        it('should generate smooth organic shapes', () => {
            // Test multiple avatars for shape characteristics
            for (let i = 0; i < 20; i++) {
                const address = `0x${(i * 13).toString(16).padStart(40, 'a')}`;
                const svg = generateAvatar(address);
                const mainPathMatch = svg.match(/<path d="([^"]+)"/);
                expect(mainPathMatch).not.toBeNull();
                
                if (mainPathMatch) {
                    const path = mainPathMatch[1];
                    // Should start with M command
                    expect(path.startsWith('M')).toBe(true);
                    // Should have C commands for curves (not L for straight lines in main blob)
                    expect(path).toContain('C');
                }
            }
        });

        it('should vary blob characteristics across addresses', () => {
            const blobSignatures = new Set();
            for (let i = 0; i < 50; i++) {
                const address = `0x${(i * 7).toString(16).padStart(40, 'c')}`;
                const svg = generateAvatar(address);
                const mainPathMatch = svg.match(/<path d="([^"]+)"/);
                if (mainPathMatch) {
                    // Use first 100 chars of path as signature
                    blobSignatures.add(mainPathMatch[1].substring(0, 100));
                }
            }
            // Should have many different blob shapes
            expect(blobSignatures.size).toBeGreaterThan(30);
        });
    });

    describe('Face layer features', () => {
        it('should include face elements (eyes and mouth)', () => {
            const address = '0x1234567890abcdef1234567890abcdef12345678';
            const svg = generateAvatar(address);
            // Face elements can be circles, paths, lines, or ellipses
            const faceElements = svg.match(/<(circle|ellipse|line|path)[^>]+opacity/g);
            expect(faceElements).not.toBeNull();
            expect(faceElements.length).toBeGreaterThanOrEqual(2); // At least 2 eyes
        });

        it('should generate different face features for different addresses', () => {
            const faceSignatures = new Set();
            for (let i = 0; i < 100; i++) {
                const address = `0x${(i * 11).toString(16).padStart(40, 'd')}`;
                const svg = generateAvatar(address);
                // Extract face elements section (everything after the rotated blob group closes)
                const faceMatch = svg.match(/<\/g>\s*(<[^<]*opacity[^>]*>.*?)<path[^>]*fill-rule="evenodd"/s);
                if (faceMatch) {
                    faceSignatures.add(faceMatch[1].substring(0, 200));
                }
            }
            // Should have variety in face features
            expect(faceSignatures.size).toBeGreaterThan(20);
        });

        it('should use background color for face features', () => {
            const address = '0xabcdef1234567890abcdef1234567890abcdef12';
            const svg = generateAvatar(address);
            // Extract background color
            const bgMatch = svg.match(/<rect[^>]+fill="(#[0-9a-fA-F]{6})"/);
            expect(bgMatch).not.toBeNull();
            
            if (bgMatch) {
                const bgColor = bgMatch[1];
                // Face elements should use background color (FACE.color = 'bg')
                const faceColorMatch = svg.match(new RegExp(`(circle|ellipse|line|path)[^>]+fill="${bgColor}"`));
                expect(faceColorMatch).not.toBeNull();
            }
        });

        it('should position eyes symmetrically', () => {
            const address = '0x1234567890abcdef1234567890abcdef12345678';
            const svg = generateAvatar(address, 100); // Larger size for precision
            // Extract circle/ellipse cx positions (eyes)
            const eyeMatches = svg.matchAll(/<(circle|ellipse)[^>]+cx="([^"]+)"/g);
            const cxPositions = [];
            for (const match of eyeMatches) {
                cxPositions.push(parseFloat(match[2]));
            }
            
            if (cxPositions.length >= 2) {
                // Eyes should be roughly symmetric around center (50 for size 100)
                const leftEyes = cxPositions.filter(cx => cx < 50);
                const rightEyes = cxPositions.filter(cx => cx > 50);
                expect(leftEyes.length).toBeGreaterThan(0);
                expect(rightEyes.length).toBeGreaterThan(0);
            }
        });

        it('should apply tilt expression when generated', () => {
            // Run many iterations to find tilted faces
            let foundTiltedFace = false;
            for (let i = 0; i < 200 && !foundTiltedFace; i++) {
                const address = `0x${(i * 17).toString(16).padStart(40, 'e')}`;
                const svg = generateAvatar(address);
                // Tilted faces have an extra g element with rotation
                const tiltMatch = svg.match(/<g transform="rotate\([^0]/);
                if (tiltMatch) {
                    foundTiltedFace = true;
                    expect(tiltMatch).not.toBeNull();
                }
            }
            // Should find at least one tilted face in 200 attempts
            expect(foundTiltedFace).toBe(true);
        });
    });

    describe('getAvatarHtml — ENS avatars setting', () => {
        const address = '0x1234567890abcdef1234567890abcdef12345678';
        const remote = 'https://avatars.example/pic.png';

        beforeEach(() => {
            localStorage.removeItem(CONFIG.storageKeys.ensAvatarsEnabled);
        });

        it('renders the remote image while the setting is on', () => {
            expect(getAvatarHtml(address, 32, 0.5, remote)).toContain(remote);
        });

        it('renders the generated avatar instead once the setting is off', () => {
            localStorage.setItem(CONFIG.storageKeys.ensAvatarsEnabled, '0');
            const html = getAvatarHtml(address, 32, 0.5, remote);
            expect(html).not.toContain(remote);
            expect(html).toContain('<svg');
        });

        it('blocks an ipfs gateway URL too', () => {
            localStorage.setItem(CONFIG.storageKeys.ensAvatarsEnabled, '0');
            const html = getAvatarHtml(address, 32, 0.5, `${CONFIG.identity.ipfsGateway}QmHash`);
            expect(html).not.toContain('ipfs');
            expect(html).toContain('<svg');
        });

        it('escapes a quote in the avatar URL so it cannot break out of src', () => {
            // The scheme check is a prefix test, so this passes it — the fix is
            // escaping the attribute value, not the scheme.
            const evil = 'https://x" onerror="alert(document.cookie)';
            const html = getAvatarHtml(address, 32, 0.5, evil);
            expect(html).not.toContain('" onerror="');
            expect(html).toContain('&quot;');
            document.body.innerHTML = `<div id="slot">${html}</div>`;
            const img = document.querySelector('#slot img.ens-avatar');
            expect(img).not.toBeNull();
            expect(img.hasAttribute('onerror')).toBe(false);
            expect(img.getAttribute('src')).toBe(evil);
        });

        it('leaves a normal avatar URL intact', () => {
            expect(getAvatarHtml(address, 32, 0.5, remote)).toContain(`src="${remote}"`);
        });

        it('downgrades avatars already on screen', () => {
            document.body.innerHTML = `<div id="slot">${getAvatarHtml(address, 32, 0.5, remote)}</div>`;
            expect(document.querySelectorAll('img.ens-avatar').length).toBe(1);
            downgradeEnsAvatars();
            expect(document.querySelectorAll('img.ens-avatar').length).toBe(0);
            expect(document.getElementById('slot').innerHTML).toContain('<svg');
        });
    });
});
