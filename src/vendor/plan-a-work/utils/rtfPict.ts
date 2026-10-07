/**
 * Minimal RTF inline-image extraction for clipboard paste.
 *
 * This is deliberately not an RTF renderer. It only accepts hex encoded
 * `\\pict` groups that explicitly declare PNG or JPEG, applies hard count/size
 * limits, and verifies the decoded magic bytes before returning a File.
 */
import { matchesImageSignature } from './officePaste';

export const RTF_PICT_LIMITS = {
    maxImages: 30,
    maxImageBytes: 40 * 1024 * 1024,
    maxTotalBytes: 40 * 1024 * 1024,
    maxRtfChars: 90 * 1024 * 1024,
} as const;

export interface RtfPictLimits {
    maxImages: number;
    maxImageBytes: number;
    maxTotalBytes: number;
    maxRtfChars: number;
}

export interface RtfPictImage {
    file: File;
    mime: 'image/png' | 'image/jpeg';
    order: number;
    width?: number;
    height?: number;
}

export interface RtfPictExtraction {
    images: RtfPictImage[];
    pictCount: number;
    rejectedCount: number;
    limitExceeded: 'rtf_size' | 'image_count' | 'image_bytes' | null;
}

interface RtfGroup {
    source: string;
    end: number;
}

/** Find one balanced RTF group, ignoring braces escaped as `\\{` / `\\}`. */
function readBalancedGroup(rtf: string, start: number): RtfGroup | null {
    let depth = 0;
    for (let index = start; index < rtf.length; index += 1) {
        const char = rtf[index];
        if (char === '\\') {
            const next = rtf[index + 1];
            if (next === '\\' || next === '{' || next === '}') index += 1;
            continue;
        }
        if (char === '{') depth += 1;
        else if (char === '}') {
            depth -= 1;
            if (depth === 0) return { source: rtf.slice(start, index + 1), end: index + 1 };
        }
    }
    return null;
}

/** Number only; safe for DEV diagnostics because it never retains pict data. */
export function countRtfPictBlocks(rtf?: string | null): number {
    if (!rtf) return 0;
    return (rtf.match(/\{\\pict\b/gi) || []).length;
}

function controlNumber(group: string, word: string): number | undefined {
    const match = new RegExp(`\\\\${word}(-?\\d+)\\b`, 'i').exec(group);
    if (!match) return undefined;
    const value = Number(match[1]);
    return Number.isFinite(value) && value > 0 ? value : undefined;
}

/**
 * Remove RTF control words while retaining only literal hexadecimal payload.
 * Numeric control arguments (for example `\\picwgoal1440`) are skipped with
 * their control word and therefore cannot be mistaken for image bytes.
 */
function pictHex(group: string, maxHexChars: number): string | null {
    const pictAt = group.search(/\\pict\b/i);
    if (pictAt < 0) return '';
    let index = pictAt + '\\pict'.length;
    const chunks: string[] = [];
    let chunkStart = -1;
    let hexLength = 0;
    let nestedDepth = 0;
    const flush = (end: number) => {
        if (chunkStart < 0) return;
        const chunk = group.slice(chunkStart, end);
        chunks.push(chunk);
        hexLength += chunk.length;
        chunkStart = -1;
    };
    while (index < group.length - 1) {
        const char = group[index];
        if (char === '{') {
            flush(index);
            nestedDepth += 1;
            index += 1;
            continue;
        }
        if (char === '}') {
            flush(index);
            if (nestedDepth > 0) nestedDepth -= 1;
            index += 1;
            continue;
        }
        if (char === '\\') {
            flush(index);
            index += 1;
            if (group[index] === "'") {
                index += 3; // escaped RTF character, never pict hex
                continue;
            }
            if (/[a-z]/i.test(group[index] || '')) {
                while (/[a-z]/i.test(group[index] || '')) index += 1;
                if (group[index] === '-') index += 1;
                while (/\d/.test(group[index] || '')) index += 1;
                if (group[index] === ' ') index += 1;
                continue;
            }
            index += 1; // control symbol
            continue;
        }
        if (nestedDepth === 0 && /[0-9a-f]/i.test(char)) {
            if (chunkStart < 0) chunkStart = index;
        } else {
            flush(index);
        }
        if (hexLength > maxHexChars) return null;
        index += 1;
    }
    flush(index);
    if (hexLength > maxHexChars) return null;
    return chunks.join('');
}

function decodeHex(hex: string): Uint8Array | null {
    if (!hex || hex.length % 2 !== 0) return null;
    const bytes = new Uint8Array(hex.length / 2);
    for (let index = 0; index < bytes.length; index += 1) {
        const value = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
        if (!Number.isFinite(value)) return null;
        bytes[index] = value;
    }
    return bytes;
}

export function extractRtfPictImages(
    rtf?: string | null,
    limits: Partial<RtfPictLimits> = {},
): RtfPictExtraction {
    const source = rtf || '';
    const policy = { ...RTF_PICT_LIMITS, ...limits };
    const pictCount = countRtfPictBlocks(source);
    const images: RtfPictImage[] = [];
    let rejectedCount = 0;
    let totalBytes = 0;
    let limitExceeded: RtfPictExtraction['limitExceeded'] = null;

    if (source.length > policy.maxRtfChars) {
        return { images, pictCount, rejectedCount: pictCount, limitExceeded: 'rtf_size' };
    }

    const startPattern = /\{\\pict\b/gi;
    let start: RegExpExecArray | null;
    let order = 0;
    while ((start = startPattern.exec(source)) !== null) {
        if (order >= policy.maxImages) {
            limitExceeded = 'image_count';
            rejectedCount += Math.max(0, pictCount - order);
            break;
        }
        const balanced = readBalancedGroup(source, start.index);
        order += 1;
        if (!balanced) {
            rejectedCount += 1;
            continue;
        }
        startPattern.lastIndex = balanced.end;
        const isPng = /\\pngblip\b/i.test(balanced.source);
        const isJpeg = /\\jpegblip\b/i.test(balanced.source);
        if (isPng === isJpeg) {
            rejectedCount += 1;
            continue;
        }
        const mime: RtfPictImage['mime'] = isPng ? 'image/png' : 'image/jpeg';
        const hex = pictHex(balanced.source, policy.maxImageBytes * 2);
        if (hex === null) {
            rejectedCount += 1;
            limitExceeded = 'image_bytes';
            continue;
        }
        const byteLength = Math.floor(hex.length / 2);
        if (!byteLength || byteLength > policy.maxImageBytes
            || totalBytes + byteLength > policy.maxTotalBytes) {
            rejectedCount += 1;
            limitExceeded = 'image_bytes';
            continue;
        }
        const bytes = decodeHex(hex);
        if (!bytes || !matchesImageSignature(mime, bytes)) {
            rejectedCount += 1;
            continue;
        }
        totalBytes += bytes.length;
        const extension = mime === 'image/png' ? 'png' : 'jpg';
        const fileBytes = new Uint8Array(bytes.length);
        fileBytes.set(bytes);
        images.push({
            file: new File([fileBytes], `rtf-pict-${order}.${extension}`, { type: mime }),
            mime,
            order: order - 1,
            width: controlNumber(balanced.source, 'picw'),
            height: controlNumber(balanced.source, 'pich'),
        });
    }

    return { images, pictCount, rejectedCount, limitExceeded };
}
