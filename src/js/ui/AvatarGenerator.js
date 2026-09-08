/**
 * Avatar Generator v3
 * Generates deterministic SVG avatars based on Ethereum addresses
 * Organic blob shapes with face layer (pareidolia)
 * 5 eyes × 6 mouths × 4 expressions = 120 unique face personalities
 */

import { CONFIG } from '../config.js';
import { escapeAttr } from './utils.js';

// ==========================================
// Constants 
// ==========================================

// Blob A configuration (Primary Mass)
const BLOB_A = {
    irregularityBase: 0.50, irregularityRange: 0.50,  // 50-100%
    spikinessBase: 0.50, spikinessRange: 0.30,        // 50-80%
    scaleBase: 0.90, scaleRange: 0.50                 // 90-140%
};

// Blob B configuration (Secondary Mass)
const BLOB_B = {
    irregularityBase: 0.50, irregularityRange: 0.50,  // 50-100%
    spikinessBase: 0.50, spikinessRange: 0.50,        // 50-100%
    scaleBase: 0.20, scaleRange: 0.29,                // 20-49%
    overlapBase: 0.50, overlapRange: 0.50             // 50-100%
};

// Smoothness (Catmull-Rom curve tension)
const SMOOTHNESS = 0.30;  // 30% smooth corners

// HSL Background spectrum
const BG_COLOR = {
    hueMin: 0, hueMax: 360,      // Full spectrum
    satMin: 35, satMax: 50,      // 35-50% saturation
    lightMin: 10, lightMax: 15   // 10-15% lightness (dark backgrounds)
};

// HSL Shape spectrum
const SHAPE_COLOR = {
    hueMin: 0, hueMax: 360,      // Full spectrum (for independent mode)
    satMin: 40, satMax: 55,      // 40-55% saturation
    lightMin: 45, lightMax: 65   // 45-65% lightness
};

// Color harmony
const COLOR_HARMONY = {
    mode: 'analogous',           // analogous colors (±40°)
    variation: 50                // ±50° variation
};

// Face layer configuration
const FACE = {
    eyeSize: 0.12,               // 12% of avatar
    eyeDistance: 0.26,           // 26% from center
    eyeHeight: 0.38,             // 38% from top
    mouthHeight: 0.58,           // 58% from top
    opacity: 1.0,                // 100% opacity
    color: 'bg'                  // Use background color
};

// Frame (internal border with background color)
const FRAME_WIDTH = 0.06;        // 6% of avatar size

// Face feature types
const EYE_TYPES = ['dot', 'round', 'oval', 'sleepy', 'blink'];
const MOUTH_TYPES = ['smile', 'grin', 'grinDark', 'smirk', 'neutral', 'line'];
const EXPRESSIONS = ['normal', 'tilt', 'happy', 'curious'];

// ==========================================
// Core Utility Functions
// ==========================================

/**
 * Hash a string to a number
 */
function hashString(str) {
    let hash = 0;
    if (!str) return hash;
    for (let i = 0; i < str.length; i++) {
        const char = str.charCodeAt(i);
        hash = ((hash << 5) - hash) + char;
        hash = hash & hash;
    }
    return Math.abs(hash);
}

/**
 * Simple seeded PRNG (mulberry32)
 */
function createRng(seed) {
    return function() {
        let t = seed += 0x6D2B79F5;
        t = Math.imul(t ^ t >>> 15, t | 1);
        t ^= t + Math.imul(t ^ t >>> 7, t | 61);
        return ((t ^ t >>> 14) >>> 0) / 4294967296;
    };
}

/**
 * Clamp a value between min and max
 */
function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
}

// ==========================================
// Color Functions
// ==========================================

/**
 * Convert HSL to hex color
 */
function hslToHex(h, s, l) {
    s /= 100;
    l /= 100;
    const a = s * Math.min(l, 1 - l);
    const f = n => {
        const k = (n + h / 30) % 12;
        const color = l - a * Math.max(Math.min(k - 3, 9 - k, 1), -1);
        return Math.round(255 * color).toString(16).padStart(2, '0');
    };
    return `#${f(0)}${f(8)}${f(4)}`;
}

/**
 * Generate a color from HSL spectrum
 */
function generateColorFromSpectrum(rng, hueMin, hueMax, satMin, satMax, lightMin, lightMax) {
    let hue;
    if (hueMin <= hueMax) {
        hue = hueMin + rng() * (hueMax - hueMin);
    } else {
        // Wrap around (e.g., 350-30 goes through red)
        const range = (360 - hueMin) + hueMax;
        const h = rng() * range;
        hue = h < (360 - hueMin) ? hueMin + h : h - (360 - hueMin);
    }
    const sat = satMin + rng() * (satMax - satMin);
    const light = lightMin + rng() * (lightMax - lightMin);
    return { hex: hslToHex(hue, sat, light), hue, sat, light };
}

/**
 * Generate harmonic color based on base hue
 */
function generateHarmonicColor(rng, baseHue, satMin, satMax, lightMin, lightMax) {
    const v = (rng() - 0.5) * 2 * COLOR_HARMONY.variation;
    
    let hueOffset;
    switch (COLOR_HARMONY.mode) {
        case 'complementary':
            hueOffset = 180 + v;
            break;
        case 'analogous':
            hueOffset = (rng() > 0.5 ? 40 : -40) + v;
            break;
        case 'triadic':
            hueOffset = (rng() > 0.5 ? 120 : 240) + v;
            break;
        case 'split':
            hueOffset = (rng() > 0.5 ? 150 : -150) + v;
            break;
        case 'independent':
        default:
            // Independent mode: use shape spectrum directly
            return generateColorFromSpectrum(
                rng,
                SHAPE_COLOR.hueMin, SHAPE_COLOR.hueMax,
                satMin, satMax,
                lightMin, lightMax
            ).hex;
    }
    
    const hue = (baseHue + hueOffset + 360) % 360;
    const sat = satMin + rng() * (satMax - satMin);
    const light = lightMin + rng() * (lightMax - lightMin);
    return hslToHex(hue, sat, light);
}

// ==========================================
// Shape Generation
// ==========================================

/**
 * Build a closed path from points with optional smoothing (Catmull-Rom)
 */
function buildClosedPathFromPoints(points, smoothness = 0) {
    if (smoothness <= 0) {
        const pathParts = points.map((p, i) =>
            (i === 0 ? 'M' : 'L') + p.x.toFixed(2) + ',' + p.y.toFixed(2)
        );
        pathParts.push('Z');
        return pathParts.join(' ');
    }

    const n = points.length;
    let path = `M${points[0].x.toFixed(2)},${points[0].y.toFixed(2)}`;

    for (let i = 0; i < n; i++) {
        const p0 = points[(i - 1 + n) % n];
        const p1 = points[i];
        const p2 = points[(i + 1) % n];
        const p3 = points[(i + 2) % n];

        const tension = 1 - smoothness * 0.5;
        const t = tension / 6;

        const cp1x = p1.x + (p2.x - p0.x) * t;
        const cp1y = p1.y + (p2.y - p0.y) * t;
        const cp2x = p2.x - (p3.x - p1.x) * t;
        const cp2y = p2.y - (p3.y - p1.y) * t;

        path += ` C${cp1x.toFixed(2)},${cp1y.toFixed(2)} ${cp2x.toFixed(2)},${cp2y.toFixed(2)} ${p2.x.toFixed(2)},${p2.y.toFixed(2)}`;
    }

    return path;
}

/**
 * Generate an organic blob path using sine waves
 */
function generateBlobPath(rng, cx, cy, radius, options = {}) {
    const sampleCount = options.sampleCount ?? 18;
    const amp1 = options.amp1 ?? 0.14;
    const amp2 = options.amp2 ?? 0.08;
    const freq1 = options.freq1 ?? (3 + Math.floor(rng() * 3));
    const freq2 = options.freq2 ?? (5 + Math.floor(rng() * 3));
    const phase1 = options.phase1 ?? rng() * Math.PI * 2;
    const phase2 = options.phase2 ?? rng() * Math.PI * 2;
    const rotation = options.rotation ?? rng() * Math.PI * 2;
    const smoothness = options.smoothness ?? 0.85;
    const points = [];

    for (let i = 0; i < sampleCount; i++) {
        const theta = rotation + (i / sampleCount) * Math.PI * 2;
        const wave = 1 + amp1 * Math.sin(freq1 * theta + phase1) + amp2 * Math.sin(freq2 * theta + phase2);
        const currentRadius = radius * wave;
        points.push({
            x: cx + Math.cos(theta) * currentRadius,
            y: cy + Math.sin(theta) * currentRadius
        });
    }

    return buildClosedPathFromPoints(points, smoothness);
}

/**
 * Generate the complete shape (2 organic blobs)
 */
function generateShape(rng, cx, cy, size) {
    const margin = size * 0.08;
    const usableRadius = (size / 2) - margin;
    
    // Calculate parameters from constants
    const scaleA = clamp(BLOB_A.scaleBase + rng() * BLOB_A.scaleRange, 0.45, 1.25);
    const scaleB = clamp(BLOB_B.scaleBase + rng() * BLOB_B.scaleRange, 0.35, 1.1);
    const irregularityA = BLOB_A.irregularityBase + rng() * BLOB_A.irregularityRange;
    const irregularityB = BLOB_B.irregularityBase + rng() * BLOB_B.irregularityRange;
    const spikinessA = BLOB_A.spikinessBase + rng() * BLOB_A.spikinessRange;
    const spikinessB = BLOB_B.spikinessBase + rng() * BLOB_B.spikinessRange;
    const smoothness = clamp(SMOOTHNESS + 0.45, 0.45, 0.95);
    const overlapFactor = BLOB_B.overlapBase + rng() * BLOB_B.overlapRange;

    const radiusA = usableRadius * scaleA * 0.82;
    const radiusB = usableRadius * scaleB * 0.72;
    const offsetDistance = usableRadius * clamp(0.46 - overlapFactor * 0.28, 0.06, 0.24);
    const offsetAngle = rng() * Math.PI * 2;
    const cxB = cx + Math.cos(offsetAngle) * offsetDistance;
    const cyB = cy + Math.sin(offsetAngle) * offsetDistance;

    const pathA = generateBlobPath(rng, cx, cy, radiusA, {
        amp1: clamp(0.06 + irregularityA * 0.45, 0.05, 0.24),
        amp2: clamp(0.04 + spikinessA * 0.22, 0.03, 0.16),
        smoothness,
        sampleCount: 20
    });
    const pathB = generateBlobPath(rng, cxB, cyB, radiusB, {
        amp1: clamp(0.06 + irregularityB * 0.42, 0.05, 0.22),
        amp2: clamp(0.04 + spikinessB * 0.20, 0.03, 0.14),
        smoothness,
        sampleCount: 18
    });

    return { path: pathA + ' ' + pathB };
}

// ==========================================
// Face Generation (Pareidolia Layer)
// ==========================================

/**
 * Convert hex to RGB
 */
function hexToRgb(hex) {
    const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
    return result ? {
        r: parseInt(result[1], 16),
        g: parseInt(result[2], 16),
        b: parseInt(result[3], 16)
    } : null;
}

/**
 * Get luminance of a hex color
 */
function getLuminance(hex) {
    const rgb = hexToRgb(hex);
    if (!rgb) return 0.5;
    const [r, g, b] = [rgb.r, rgb.g, rgb.b].map(v => {
        v /= 255;
        return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
    });
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/**
 * Create layout variation for face positioning
 */
function createFaceLayoutVariation(rng, size, expression) {
    const variation = {
        faceShiftX: (rng() - 0.5) * size * 0.05,
        faceShiftY: (rng() - 0.5) * size * 0.03,
        mouthShiftX: (rng() - 0.5) * size * 0.04,
        mouthShiftY: (rng() - 0.5) * size * 0.025,
        eyeSpread: 0.92 + rng() * 0.18,
        eyeTiltOffset: (rng() - 0.5) * size * 0.018
    };

    if (expression === 'happy') {
        variation.mouthShiftY += size * 0.005;
    }

    if (expression === 'curious') {
        variation.eyeTiltOffset *= 1.25;
    }

    return variation;
}

/**
 * Create variation for eye rendering
 */
function createEyeVariation(type, side, rng, expression) {
    const variation = {
        radiusScale: 0.88 + rng() * 0.24,
        archHeight: 0.65 + rng() * 0.65,
        archWidth: 0.90 + rng() * 0.25,
        tilt: (rng() - 0.5) * 0.7,
        pupilScale: 0.28 + rng() * 0.16
    };

    if (expression === 'happy') {
        variation.archHeight += 0.15;
    }

    if (side === 'right') {
        variation.tilt *= -1;
    }

    return variation;
}

/**
 * Create variation for mouth rendering
 */
function createMouthVariation(type, rng, expression) {
    const variation = {
        widthScale: 0.9 + rng() * 0.3,
        tilt: (rng() - 0.5) * 0.9,
        curveDepth: 0.7 + rng() * 0.9,
        openScale: 0.8 + rng() * 0.8,
        topLift: rng() * 0.45
    };

    if (expression === 'happy') {
        variation.curveDepth += 0.2;
    }

    if (expression === 'tilt') {
        variation.tilt *= 1.25;
    }

    if (type === 'neutral' || type === 'line') {
        variation.curveDepth *= 0.4;
    }

    return variation;
}

/**
 * Generate eye SVG element
 */
function generateEye(type, x, y, radius, color, opacity, variant = {}) {
    const r = radius * (variant.radiusScale ?? 1);
    const eyeTilt = variant.tilt ?? 0;
    const archHeight = variant.archHeight ?? 0.8;
    const archWidth = variant.archWidth ?? 1;
    const pupilScale = variant.pupilScale ?? 0.35;
    const leftX = x - r * archWidth;
    const rightX = x + r * archWidth;
    const leftY = y - r * 0.18 * eyeTilt;
    const rightY = y + r * 0.18 * eyeTilt;
    
    switch (type) {
        case 'dot':
            return `<circle cx="${x}" cy="${y}" r="${r}" fill="${color}" opacity="${opacity}"/>`;
            
        case 'round':
            return `<circle cx="${x}" cy="${y}" r="${r}" fill="${color}" opacity="${opacity}"/>
                    <circle cx="${x}" cy="${y}" r="${r * pupilScale}" fill="${color === '#1a1a24' ? '#f0f0f5' : '#1a1a24'}" opacity="${opacity}"/>`;
            
        case 'oval':
            return `<ellipse cx="${x}" cy="${y}" rx="${r * 0.7}" ry="${r}" fill="${color}" opacity="${opacity}"/>`;
            
        case 'sleepy':
            return `<line x1="${leftX}" y1="${leftY}" x2="${rightX}" y2="${rightY}" stroke="${color}" stroke-width="${r * 0.8}" stroke-linecap="round" opacity="${opacity}"/>`;
            
        case 'blink':
            return `<path d="M${leftX} ${leftY} Q${x} ${y - r * archHeight} ${rightX} ${rightY}" fill="none" stroke="${color}" stroke-width="${r * 0.6}" stroke-linecap="round" opacity="${opacity}"/>`;
            
        default:
            return `<circle cx="${x}" cy="${y}" r="${r}" fill="${color}" opacity="${opacity}"/>`;
    }
}

/**
 * Generate mouth SVG element
 */
function generateMouth(type, x, y, width, height, color, opacity, variant = {}) {
    const w = width;
    const h = height;
    const widthScale = variant.widthScale ?? 1;
    const tilt = variant.tilt ?? 0;
    const curveDepth = variant.curveDepth ?? 1;
    const openScale = variant.openScale ?? 1;
    const topLift = variant.topLift ?? 0;
    const leftY = y - h * 0.25 * tilt;
    const rightY = y + h * 0.25 * tilt;
    
    switch (type) {
        case 'smile':
            return `<path d="M${x - w * widthScale} ${leftY} Q${x} ${y + h * (1.8 + curveDepth)} ${x + w * widthScale} ${rightY}" fill="none" stroke="${color}" stroke-width="${h * 0.7}" stroke-linecap="round" opacity="${opacity}"/>`;
            
        case 'grin':
            // Subtle grin - limited width and curvature for mature look
            return `<path d="M${x - w * 0.95 * widthScale} ${y - h * (0.08 + topLift * 0.2) - h * 0.15 * tilt} Q${x} ${y + h * (1.6 + curveDepth * 0.5)} ${x + w * 0.95 * widthScale} ${y - h * (0.08 + topLift * 0.2) + h * 0.15 * tilt}" fill="none" stroke="${color}" stroke-width="${h * 0.65}" stroke-linecap="round" opacity="${opacity}"/>`;
            
        case 'grinDark':
            const gdw = w * (0.9 + widthScale * 0.35);
            const gdh = h * (1.5 + openScale * 1.0);
            const leftTopY = y - gdh * (0.18 + topLift * 0.25) - h * 0.18 * tilt;
            const leftBottomY = y + gdh * (0.45 + openScale * 0.12) - h * 0.10 * tilt;
            const rightTopY = y - gdh * (0.10 + topLift * 0.12) + h * 0.12 * tilt;
            const rightBottomY = y + gdh * (0.38 + openScale * 0.10) + h * 0.14 * tilt;
            const bellyY = y + gdh * (0.95 + curveDepth * 0.18);
            return `<path d="M${x - gdw} ${leftTopY} L${x - gdw} ${leftBottomY} Q${x} ${bellyY} ${x + gdw} ${rightBottomY} L${x + gdw} ${rightTopY} Z" fill="${color}" opacity="${opacity * 0.9}"/>`;
            
        case 'smirk':
            return `<path d="M${x - w * 0.8 * widthScale} ${y + h * (0.30 - tilt * 0.25)} Q${x} ${y + h * (1.10 + curveDepth * 0.55)} ${x + w * 0.8 * widthScale} ${y - h * (0.30 + tilt * 0.45)}" fill="none" stroke="${color}" stroke-width="${h * 0.6}" stroke-linecap="round" opacity="${opacity}"/>`;
            
        case 'neutral':
            return `<line x1="${x - w * 0.8 * widthScale}" y1="${leftY}" x2="${x + w * 0.8 * widthScale}" y2="${rightY}" stroke="${color}" stroke-width="${h * 0.7}" stroke-linecap="round" opacity="${opacity}"/>`;
            
        case 'line':
            return `<path d="M${x - w * 0.6 * widthScale} ${leftY - h * 0.2} Q${x} ${y + h * (0.7 + curveDepth * 0.5)} ${x + w * 0.6 * widthScale} ${rightY - h * 0.2}" fill="none" stroke="${color}" stroke-width="${h * 0.6}" stroke-linecap="round" opacity="${opacity}"/>`;
            
        default:
            return '';
    }
}

/**
 * Generate face SVG elements
 */
function generateFace(rng, size, bgColor) {
    // Procedural face features from seed
    const eyeType = EYE_TYPES[Math.floor(rng() * EYE_TYPES.length)];
    const mouthType = MOUTH_TYPES[Math.floor(rng() * MOUTH_TYPES.length)];
    const expression = EXPRESSIONS[Math.floor(rng() * EXPRESSIONS.length)];
    
    // Calculate face color based on setting
    let faceColorHex;
    if (FACE.color === 'auto') {
        const bgLum = getLuminance(bgColor);
        faceColorHex = bgLum > 0.5 ? '#1a1a24' : '#f0f0f5';
    } else if (FACE.color === 'light') {
        faceColorHex = '#f0f0f5';
    } else if (FACE.color === 'dark') {
        faceColorHex = '#1a1a24';
    } else {
        // 'bg' - use background color
        faceColorHex = bgColor;
    }
    
    const opacity = FACE.opacity;
    const cx = size / 2;
    const cy = size / 2;
    
    // Eye positions
    const eyeRadius = size * FACE.eyeSize / 2;
    const eyeSpacing = size * FACE.eyeDistance / 2;
    const eyeY = size * FACE.eyeHeight;
    const layoutVariant = createFaceLayoutVariation(rng, size, expression);
    
    // Expression modifiers
    let tiltAngle = 0;
    let eyeOffsetY = 0;
    let mouthWidthMod = 1;
    
    switch (expression) {
        case 'tilt':
            tiltAngle = (rng() > 0.5 ? 1 : -1) * (5 + rng() * 10);
            break;
        case 'happy':
            eyeOffsetY = -size * 0.02;
            mouthWidthMod = 1.2;
            break;
        case 'curious':
            eyeOffsetY = (rng() > 0.5 ? 1 : -1) * size * 0.015;
            break;
    }
    
    let faceElements = '';
    
    // Generate eyes with layout variation
    const leftEyeX = cx - eyeSpacing * layoutVariant.eyeSpread + layoutVariant.faceShiftX;
    const rightEyeX = cx + eyeSpacing * layoutVariant.eyeSpread + layoutVariant.faceShiftX;
    const leftEyeY = eyeY + layoutVariant.faceShiftY + layoutVariant.eyeTiltOffset + (expression === 'curious' ? eyeOffsetY : 0);
    const rightEyeY = eyeY + layoutVariant.faceShiftY - layoutVariant.eyeTiltOffset + (expression === 'curious' ? -eyeOffsetY : 0);
    
    // Create eye variations
    const leftEyeVariant = createEyeVariation(eyeType, 'left', rng, expression);
    const rightEyeVariant = createEyeVariation(eyeType, 'right', rng, expression);
    
    faceElements += generateEye(eyeType, leftEyeX, leftEyeY, eyeRadius, faceColorHex, opacity, leftEyeVariant);
    faceElements += generateEye(eyeType, rightEyeX, rightEyeY, eyeRadius, faceColorHex, opacity, rightEyeVariant);
    
    // Generate mouth with variation
    const mouthY = size * FACE.mouthHeight + layoutVariant.mouthShiftY;
    const mouthWidth = size * 0.15 * mouthWidthMod;
    const mouthVariant = createMouthVariation(mouthType, rng, expression);
    faceElements += generateMouth(mouthType, cx + layoutVariant.mouthShiftX, mouthY, mouthWidth, eyeRadius * 1.0, faceColorHex, opacity, mouthVariant);
    
    // Wrap with rotation if tilted
    if (tiltAngle !== 0) {
        return `<g transform="rotate(${tiltAngle.toFixed(1)} ${cx} ${cy})" opacity="${opacity}">${faceElements}</g>`;
    }
    
    return faceElements;
}

// ==========================================
// Main Avatar Generation
// ==========================================

/**
 * Generate a deterministic avatar SVG based on an Ethereum address
 * @param {string} address - Ethereum address (0x...)
 * @param {number} size - Avatar size in pixels
 * @param {number} borderRadius - Border radius (0-1, percentage of size)
 * @returns {string} - SVG string
 */
export function generateAvatar(address, size = 32, borderRadius = 0.2) {
    if (!address || typeof address !== 'string') {
        address = '0x0000000000000000000000000000000000000000';
    }
    
    const normalizedAddress = getEffectiveAddress(address);
    const seed = hashString(normalizedAddress);
    const rng = createRng(seed);
    
    // Generate background color from HSL spectrum
    const bgResult = generateColorFromSpectrum(
        rng,
        BG_COLOR.hueMin, BG_COLOR.hueMax,
        BG_COLOR.satMin, BG_COLOR.satMax,
        BG_COLOR.lightMin, BG_COLOR.lightMax
    );
    const bgColor = bgResult.hex;
    
    // Generate shape color with color harmony
    const shapeColor = generateHarmonicColor(
        rng,
        bgResult.hue,
        SHAPE_COLOR.satMin, SHAPE_COLOR.satMax,
        SHAPE_COLOR.lightMin, SHAPE_COLOR.lightMax
    );
    
    const cx = size / 2;
    const cy = size / 2;
    
    // Generate organic blob shape (using separate RNG for shape geometry)
    const shapeRng = createRng(seed ^ 0x51f15eed);
    const { path } = generateShape(shapeRng, cx, cy, size);
    
    // Random rotation
    const rotation = Math.floor(shapeRng() * 360);
    const rx = size * borderRadius;
    
    // Face layer with separate RNG for deterministic face independent of shape
    const faceRng = createRng((seed ^ 0x51f15eed) + 0xFACE);
    const faceElement = generateFace(faceRng, size, bgColor);
    
    // Base ID for clip path (deterministic, based on seed)
    // Unique suffix is added by getAvatar() to prevent DOM conflicts
    const clipId = `avatar-clip-${seed.toString(36)}`;
    
    // Frame element (internal border with background color)
    const fw = size * FRAME_WIDTH;
    const innerSize = size - fw * 2;
    const frameElement = `<path d="M0,0 h${size} v${size} h-${size} Z M${fw},${fw} v${innerSize} h${innerSize} v-${innerSize} Z" fill="${bgColor}" fill-rule="evenodd"/>`;
    
    // SVG with fixed dimensions matching the requested size
    // CSS will handle scaling to container if needed
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" width="${size}" height="${size}" style="display:block">
        <defs>
            <clipPath id="${clipId}">
                <rect width="${size}" height="${size}" rx="${rx}"/>
            </clipPath>
        </defs>
        <g clip-path="url(#${clipId})">
            <rect width="${size}" height="${size}" fill="${bgColor}"/>
            <g transform="rotate(${rotation} ${cx} ${cy})">
                <path d="${path}" fill="${shapeColor}"/>
            </g>
            ${faceElement}
            ${frameElement}
        </g>
    </svg>`;
}

/**
 * Generate avatar as a data URI for use in img src
 */
export function generateAvatarDataUri(address, size = 32, borderRadius = 0.2) {
    const svg = generateAvatar(address, size, borderRadius);
    return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

// ==========================================
// Address Normalization
// ==========================================

/**
 * Get the effective seed address for avatar generation.
 */
function getEffectiveAddress(address) {
    if (!address) return address;
    return address.toLowerCase();
}

// ==========================================
// Cache System
// ==========================================

const avatarCache = new Map();
const MAX_CACHE_SIZE = 200;

/**
 * Replace clipPath ID in cached SVG with a unique one
 * This prevents DOM conflicts when same avatar appears multiple times
 */
function makeClipIdUnique(svg) {
    const uniqueId = Math.random().toString(36).substring(2, 8);
    // Replace the clipPath ID and reference with unique version
    return svg.replace(
        /id="(avatar-clip-[^"]+)"/g,
        `id="$1-${uniqueId}"`
    ).replace(
        /url\(#(avatar-clip-[^)]+)\)/g,
        `url(#$1-${uniqueId})`
    );
}

/**
 * Get cached avatar or generate new one
 * Each call returns SVG with unique clipPath ID to prevent DOM conflicts
 */
export function getAvatar(address, size = 32, borderRadius = 0.2) {
    const effectiveAddr = getEffectiveAddress(address);
    const key = `${effectiveAddr}-${size}-${borderRadius}`;
    
    let svg;
    if (avatarCache.has(key)) {
        svg = avatarCache.get(key);
    } else {
        svg = generateAvatar(address, size, borderRadius);
        
        if (avatarCache.size >= MAX_CACHE_SIZE) {
            const firstKey = avatarCache.keys().next().value;
            avatarCache.delete(firstKey);
        }
        
        avatarCache.set(key, svg);
    }
    
    // Always return with unique clipPath ID to prevent DOM conflicts
    return makeClipIdUnique(svg);
}

/**
 * Clear avatar cache
 */
export function clearAvatarCache() {
    avatarCache.clear();
}

/**
 * Get the color associated with an address (matches avatar shape color)
 * Use this for username colors to maintain consistency with avatars
 */
export function getAddressColor(address) {
    if (!address || typeof address !== 'string') {
        return '#6C5DD3'; // Default purple
    }
    
    const normalizedAddress = getEffectiveAddress(address);
    const seed = hashString(normalizedAddress);
    const rng = createRng(seed);
    
    // Generate bg hue first (same sequence as in generateAvatar)
    const bgResult = generateColorFromSpectrum(
        rng,
        BG_COLOR.hueMin, BG_COLOR.hueMax,
        BG_COLOR.satMin, BG_COLOR.satMax,
        BG_COLOR.lightMin, BG_COLOR.lightMax
    );
    
    // Return shape color with harmony (same sequence as generateAvatar)
    return generateHarmonicColor(
        rng,
        bgResult.hue,
        SHAPE_COLOR.satMin, SHAPE_COLOR.satMax,
        SHAPE_COLOR.lightMin, SHAPE_COLOR.lightMax
    );
}

// ==========================================
// ENS Avatar Support
// ==========================================

/**
 * Whether the viewer allows ENS avatar images at all. Rendering one hands the
 * reader's IP to whatever host the record points at, so the setting has to be
 * honoured everywhere an avatar is drawn — including the pre-unlock modals,
 * which is why it is read from the plain mirror rather than from secureStorage.
 * @returns {boolean}
 */
function ensAvatarsEnabled() {
    try {
        return localStorage.getItem(CONFIG.storageKeys.ensAvatarsEnabled) !== '0';
    } catch (e) {
        return true;
    }
}

/**
 * Get avatar HTML that uses ENS avatar image if available, with SVG fallback.
 * Returns an <img> if avatarUrl is provided, otherwise the generated SVG.
 * The <img> has onerror fallback to the generated SVG.
 * @param {string} address - Ethereum address
 * @param {number} size - Avatar size in pixels
 * @param {number} borderRadius - Border radius ratio
 * @param {string|null} avatarUrl - ENS avatar URL (or null for SVG only)
 * @returns {string} - HTML string (<img> or <svg>)
 */
export function getAvatarHtml(address, size = 32, borderRadius = 0.2, avatarUrl = null) {
    const svgFallback = getAvatar(address, size, borderRadius);
    if (!avatarUrl || !ensAvatarsEnabled()) return svgFallback;

    // Sanitize URL - only allow https: and data: schemes
    if (!avatarUrl.startsWith('https://') && !avatarUrl.startsWith('data:')) {
        return svgFallback;
    }
    // Store SVG fallback in data attribute; global error listener handles swap.
    // escapeAttr on the URL: the scheme check above is a prefix test, so a
    // record like `https://x" onerror=…` would otherwise break out of src.
    return `<img src="${escapeAttr(avatarUrl)}" alt="" width="${size}" height="${size}" class="ens-avatar" data-fallback="${encodeURIComponent(svgFallback)}" style="width:100%;height:100%;object-fit:cover;display:block;" />`;
}

/**
 * Replace one rendered ENS avatar with the generated one it carries.
 * @param {HTMLImageElement} img
 */
function swapToFallback(img) {
    if (!img.dataset.fallback) return;
    const wrapper = document.createElement('span');
    wrapper.innerHTML = decodeURIComponent(img.dataset.fallback);
    img.replaceWith(wrapper.firstChild);
}

/**
 * Downgrade every ENS avatar already on screen to its generated fallback.
 * Turning the setting off has to take effect on the views behind the settings
 * modal, which hold <img> tags rendered while it was still on.
 */
export function downgradeEnsAvatars() {
    if (typeof document === 'undefined') return;
    document.querySelectorAll('img.ens-avatar').forEach(swapToFallback);
}

// Global delegated error handler for ENS avatar images (CSP-safe)
if (typeof document !== 'undefined') {
    document.addEventListener('error', (e) => {
        const img = e.target;
        if (img.tagName === 'IMG' && img.classList.contains('ens-avatar')) {
            swapToFallback(img);
        }
    }, true);
}

// ==========================================
// Exports
// ==========================================

export const avatarGenerator = {
    generate: generateAvatar,
    generateDataUri: generateAvatarDataUri,
    get: getAvatar,
    getHtml: getAvatarHtml,
    clearCache: clearAvatarCache,
    getColor: getAddressColor,
};
