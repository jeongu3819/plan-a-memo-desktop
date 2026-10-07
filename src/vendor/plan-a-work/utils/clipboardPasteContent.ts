/** Capability-based clipboard collection shared by Description paste paths. */
import { OFFICE_PASTE_LIMITS, matchesImageSignature } from './officePaste';

const SUPPORTED_IMAGE_MIMES = new Set(['image/png', 'image/jpeg', 'image/jpg', 'image/webp']);
const MAX_CLIPBOARD_IMAGES = 50;
const MAX_TEXT_BYTES = OFFICE_PASTE_LIMITS.maxHtmlChars * 4;
const MAX_RTF_BYTES = 90 * 1024 * 1024;
const MAX_IMAGE_BYTES = OFFICE_PASTE_LIMITS.maxImageBytes;

export interface ClipboardEventContent {
    html: string;
    plainText: string;
    rtf: string;
    uriList: string;
    images: File[];
    imageItemCount: number;
}

export interface AsyncClipboardBlobMetadata {
    item: number;
    type: string;
    size: number;
}

export interface AsyncClipboardContent {
    itemTypes: string[][];
    blobs: AsyncClipboardBlobMetadata[];
    customTypes: string[];
    html: string;
    plainText: string;
    rtf: string;
    uriList: string;
    images: File[];
}

export interface ClipboardItemLike {
    types: readonly string[];
    getType: (type: string) => Promise<Blob>;
}

export function shouldReadAsyncClipboard(input: {
    html: string;
    rtf: string;
    eventImageCount: number;
}): boolean {
    return input.eventImageCount > 0
        || /<img\b/i.test(input.html || '')
        || /\{\\pict\b/i.test(input.rtf || '');
}

function getDataSafely(clipboard: DataTransfer | null | undefined, type: string): string {
    try {
        return clipboard?.getData(type) || '';
    } catch {
        return '';
    }
}

/** Must run synchronously inside the paste event; DataTransfer items expire after await. */
export function collectClipboardEventContent(
    clipboard: DataTransfer | null | undefined,
): ClipboardEventContent {
    const items = Array.from(clipboard?.items || []);
    const imageItems = items.filter(item => SUPPORTED_IMAGE_MIMES.has((item.type || '').toLowerCase()));
    const images = imageItems
        .map(item => item.getAsFile())
        .filter((file): file is File => !!file);
    // DataTransfer.files generally mirrors image items. Treat items as the
    // authoritative ordered list; use files only in browsers that expose no
    // image item at all. This avoids duplicate insertion without collapsing
    // two legitimate same-name/same-size images.
    if (images.length === 0) {
        Array.from(clipboard?.files || []).forEach((file) => {
            if (SUPPORTED_IMAGE_MIMES.has((file.type || '').toLowerCase())) images.push(file);
        });
    }
    return {
        html: getDataSafely(clipboard, 'text/html'),
        plainText: getDataSafely(clipboard, 'text/plain'),
        rtf: getDataSafely(clipboard, 'text/rtf'),
        uriList: getDataSafely(clipboard, 'text/uri-list'),
        images,
        imageItemCount: imageItems.length,
    };
}

function extensionForMime(mime: string): string {
    if (mime === 'image/jpeg' || mime === 'image/jpg') return 'jpg';
    if (mime === 'image/webp') return 'webp';
    return 'png';
}

function blobArrayBuffer(blob: Blob): Promise<ArrayBuffer> {
    if (typeof blob.arrayBuffer === 'function') return blob.arrayBuffer();
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result as ArrayBuffer);
        reader.onerror = () => reject(reader.error || new Error('clipboard blob read failed'));
        reader.readAsArrayBuffer(blob);
    });
}

async function verifiedImageFile(blob: Blob, declaredType: string, order: number): Promise<File | null> {
    const mime = (declaredType || blob.type || '').toLowerCase();
    if (!SUPPORTED_IMAGE_MIMES.has(mime) || !blob.size || blob.size > MAX_IMAGE_BYTES) return null;
    const bytes = new Uint8Array(await blobArrayBuffer(blob.slice(0, 16)));
    const normalizedMime = mime === 'image/jpg' ? 'image/jpeg' : mime;
    if (!matchesImageSignature(normalizedMime, bytes)) return null;
    return new File([blob], `async-clipboard-${order}.${extensionForMime(normalizedMime)}`, {
        type: normalizedMime,
    });
}

async function boundedText(blob: Blob, maxBytes: number): Promise<string> {
    const portion = blob.slice(0, Math.min(blob.size, maxBytes));
    if (typeof portion.text === 'function') return portion.text();
    return new TextDecoder().decode(await blobArrayBuffer(portion));
}

/**
 * Read Async Clipboard types once, preserving only supported text and verified
 * image data. Unknown/custom MIME values are represented by type and byte size
 * metadata only; their payload is never logged or inserted.
 */
export async function readAsyncClipboardContent(
    readItems?: () => Promise<ClipboardItemLike[]>,
): Promise<AsyncClipboardContent> {
    const defaultRead = async (): Promise<ClipboardItemLike[]> => {
        const clipboard = navigator?.clipboard as Clipboard & {
            read?: () => Promise<ClipboardItemLike[]>;
        };
        if (!clipboard?.read) throw new DOMException('Async Clipboard read unavailable', 'NotSupportedError');
        return clipboard.read();
    };
    const items = await (readItems || defaultRead)();
    const result: AsyncClipboardContent = {
        itemTypes: items.map(item => Array.from(item.types || []).map(String)),
        blobs: [],
        customTypes: [],
        html: '',
        plainText: '',
        rtf: '',
        uriList: '',
        images: [],
    };
    let imageOrder = 0;
    let acceptedImageBytes = 0;
    for (let itemIndex = 0; itemIndex < items.length; itemIndex += 1) {
        const item = items[itemIndex];
        for (const rawType of Array.from(item.types || [])) {
            const type = String(rawType).toLowerCase();
            let blob: Blob;
            try {
                blob = await item.getType(rawType);
            } catch {
                continue;
            }
            result.blobs.push({ item: itemIndex, type, size: blob.size });
            if (SUPPORTED_IMAGE_MIMES.has(type)
                && result.images.length < MAX_CLIPBOARD_IMAGES
                && acceptedImageBytes + blob.size <= MAX_IMAGE_BYTES) {
                const file = await verifiedImageFile(blob, type, imageOrder);
                imageOrder += 1;
                if (file) {
                    result.images.push(file);
                    acceptedImageBytes += file.size;
                }
            } else if (type === 'text/html' && !result.html) {
                result.html = await boundedText(blob, MAX_TEXT_BYTES);
            } else if (type === 'text/plain' && !result.plainText) {
                result.plainText = await boundedText(blob, MAX_TEXT_BYTES);
            } else if (type === 'text/rtf' && !result.rtf) {
                result.rtf = await boundedText(blob, MAX_RTF_BYTES);
            } else if (type === 'text/uri-list' && !result.uriList) {
                result.uriList = await boundedText(blob, MAX_TEXT_BYTES);
            } else if (!type.startsWith('image/') && !type.startsWith('text/')) {
                if (!result.customTypes.includes(type)) result.customTypes.push(type);
            }
        }
    }
    return result;
}

export async function readAsyncClipboardContentSafely(
    readItems?: () => Promise<ClipboardItemLike[]>,
): Promise<{ content: AsyncClipboardContent; permissionDenied: boolean }> {
    try {
        return { content: await readAsyncClipboardContent(readItems), permissionDenied: false };
    } catch (error: unknown) {
        const name = (error as { name?: string })?.name || '';
        return {
            content: emptyAsyncClipboardContent(),
            permissionDenied: name === 'NotAllowedError' || name === 'SecurityError',
        };
    }
}

export function emptyAsyncClipboardContent(): AsyncClipboardContent {
    return {
        itemTypes: [], blobs: [], customTypes: [], html: '', plainText: '', rtf: '', uriList: '', images: [],
    };
}
