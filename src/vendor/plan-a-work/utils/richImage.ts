/**
 * [PLAN-A Memo Desktop] Web `utils/richImage.ts` 의 Desktop 판.
 *
 * Web 은 보호 이미지(`/api/personal-memos/images/{id}/download`)를 저장 주소(canonical)로 두고,
 * 화면에서만 Bearer 로 받은 blob URL 을 붙였다가 저장할 때 canonical 로 되돌린다.
 * Desktop 은 같은 구조를 그대로 쓰되 canonical 이 `attachment://<local_attachment_id>` 다.
 *
 *   저장(HTML)  : <img src="attachment://6f1c…">           ← 경로가 아닌 안정된 내부 참조
 *   화면(DOM)   : <img src="http://attachment.localhost/6f1c…" data-canonical-src="attachment://6f1c…">
 *
 * 화면 주소는 Rust 의 `attachment` URI scheme handler 가 저장 폴더 안의 파일만 돌려준다
 * (임의 경로 접근 없음). 절대 경로·file:/// 는 HTML 에 저장되지 않는다.
 *
 * export 이름·의미는 Web 원본과 같다 — 편집기(RichDescriptionEditor)·읽기 화면이 수정 없이 쓴다.
 */

const ATTACHMENT_RE = /^attachment:\/\/([0-9a-f-]{36})$/i;
const DISPLAY_RE = /^(?:https?:\/\/attachment\.localhost|attachment:\/\/localhost)\/([0-9a-f-]{36})(?:[?#].*)?$/i;

function isWindowsLike(): boolean {
    if (typeof navigator === 'undefined') return true;
    return /Windows|Android/i.test(navigator.userAgent || '');
}

/** attachment://<id> → WebView 가 실제로 읽는 주소(Tauri custom protocol). */
export function attachmentDisplayUrl(id: string): string {
    return isWindowsLike()
        ? `http://attachment.localhost/${encodeURIComponent(id)}`
        : `attachment://localhost/${encodeURIComponent(id)}`;
}

/**
 * 저장 HTML → 편집기 DOM 에 넣을 HTML. `innerHTML` 에 넣는 **순간** WebView 가 이미지를 요청하므로,
 * 넣기 전에 attachment://<id> 를 화면 주소로 바꾸고 저장 주소는 data-canonical-src 에 보존한다
 * (넣은 뒤 hydrate 하면 attachment:// 요청이 한 번 실패해 콘솔 오류가 남는다). 저장(serialize)은 그대로 canonical.
 */
export function storedHtmlForDisplay(html: string): string {
    return (html || '').replace(
        /(<img\b[^>]*?\s)src=(["'])attachment:\/\/([0-9a-f-]{36})\2/gi,
        (_match, head: string, quote: string, id: string) =>
            `${head}src=${quote}${attachmentDisplayUrl(id.toLowerCase())}${quote} data-canonical-src=${quote}attachment://${id.toLowerCase()}${quote}`,
    );
}

/** 저장 주소에서 첨부 id. 화면 주소가 섞여 들어와도 같은 id 로 본다. */
export function attachmentIdFromUrl(url: string): string | null {
    const value = (url || '').trim();
    return ATTACHMENT_RE.exec(value)?.[1]?.toLowerCase()
        ?? DISPLAY_RE.exec(value)?.[1]?.toLowerCase()
        ?? null;
}

/** 화면 주소가 섞여 들어와도 저장은 언제나 attachment://<id>. */
function canonicalStoredImageUrl(url: string): string {
    const id = attachmentIdFromUrl(url);
    return id ? `attachment://${id}` : url;
}

/** Web 호환 이름 — Desktop 에는 서버 상대 주소가 없으므로 그대로 둔다. */
export const toAbsoluteAttachmentUrl = (url: string): string => url;

/** 이 URL 이 로컬 첨부(저장 폴더 attachments/)를 가리키는가. */
export function isProtectedImageUrl(url: string): boolean {
    return attachmentIdFromUrl(url) !== null;
}

/** 로컬 첨부 이미지를 Blob 으로(확대 보기·복사 등). */
export async function fetchProtectedImageBlob(url: string): Promise<Blob> {
    const id = attachmentIdFromUrl(url);
    if (!id) throw new Error('not a local attachment');
    const response = await fetch(attachmentDisplayUrl(id));
    if (!response.ok) throw new Error(`attachment load failed: ${response.status}`);
    return response.blob();
}

/** canonical(attachment://) 을 보존하고 화면 주소를 붙인다. */
export async function hydrateProtectedImage(img: HTMLImageElement): Promise<void> {
    const current = img.dataset.canonicalSrc || img.getAttribute('src') || '';
    const id = attachmentIdFromUrl(current);
    if (!id) return;
    img.dataset.canonicalSrc = `attachment://${id}`;
    const display = attachmentDisplayUrl(id);
    if (img.getAttribute('src') !== display) img.setAttribute('src', display);
    img.dataset.imageLoadState = 'loaded';
    if (!img.dataset.attachmentErrorHook) {
        img.dataset.attachmentErrorHook = '1';
        img.addEventListener('error', () => {
            img.dataset.imageLoadState = 'error';
            img.setAttribute('data-image-load-error', 'true');
            img.alt = img.alt || '이미지를 불러올 수 없습니다';
        });
    }
}

export const normalizeImagesInRoot = (root: HTMLElement) => {
    root.querySelectorAll('img').forEach(img => {
        void hydrateProtectedImage(img);
    });
};

/** Web 은 blob URL 을 해제한다. Desktop 화면 주소는 blob 이 아니므로 할 일이 없다. */
export const releaseImagesInRoot = (_root: HTMLElement) => {};

/** 편집기 HTML 직렬화 — 화면 주소가 아니라 저장 주소(attachment://)로. */
export const serializeRichHtml = (root: HTMLElement): string => {
    // [Desktop] 브라우징 컨텍스트가 없는 문서에서 복제·수정한다 — 화면 문서에서 복제한 <img> 의 src 를
    // attachment:// 로 바꾸면(문서에 붙지 않아도) WebView 가 요청을 시작해 콘솔 오류가 남는다.
    const inert = document.implementation.createHTMLDocument('');
    const clone = inert.importNode(root, true) as HTMLElement;
    clone.querySelectorAll('img').forEach((img) => {
        const canonical = img.dataset.canonicalSrc || canonicalStoredImageUrl(img.getAttribute('src') || '');
        if (canonical) img.setAttribute('src', canonical);
        img.removeAttribute('data-canonical-src');
        img.removeAttribute('data-image-load-error');
        img.removeAttribute('data-image-load-state');
        img.removeAttribute('data-image-load-status');
        img.removeAttribute('data-attachment-error-hook');
        img.removeAttribute('loading');
        img.removeAttribute('decoding');
    });
    return clone.innerHTML;
};

/** (Web 원본 그대로) HTML → 미리보기 평문. */
export function descriptionToPreviewText(html?: string | null): string {
    if (!html) return '';
    if (!/<[a-z][\s\S]*>/i.test(html)) return html;
    try {
        // [Desktop] <template> 은 inert — div 에 넣으면(문서에 붙지 않아도) WebView 가 이미지 요청을 시작해
        // attachment:// 로딩 오류가 콘솔에 남는다.
        const tmp = document.createElement('template');
        tmp.innerHTML = html;
        const text = (tmp.content.textContent || '').replace(/\s+/g, ' ').trim();
        if (text) return text;
        if (tmp.content.querySelector('img')) return '🖼 이미지';
        return '';
    } catch {
        return html;
    }
}

/**
 * (Web 원본 그대로) 클립보드 붙여넣기 이미지 압축/리사이즈.
 * - 1MB 미만이면 원본 그대로 (확장자만 보정).
 * - 큰 이미지: 긴 변 1920px 로 축소, JPEG q=0.85 (PNG 알파 감지 시 PNG 유지).
 * - 실패하면 원본 Blob 을 File 로 감싸서 반환 (절대 throw 하지 않음).
 */
export async function compressPastedImage(
    blob: Blob,
    timestamp: number,
    namePrefix = 'paste',
): Promise<File> {
    const SMALL_BYTES = 1024 * 1024;
    const MAX_EDGE = 1920;
    const QUALITY = 0.85;
    const sourceType = blob.type || 'image/png';
    const fallbackExt = sourceType.includes('jpeg') || sourceType.includes('jpg') ? 'jpg' : 'png';
    const fallback = new File([blob], `${namePrefix}-${timestamp}.${fallbackExt}`, { type: sourceType });
    if (blob.size <= SMALL_BYTES) return fallback;
    try {
        const url = URL.createObjectURL(blob);
        try {
            const image = await new Promise<HTMLImageElement>((resolve, reject) => {
                const img = new Image();
                img.onload = () => resolve(img);
                img.onerror = () => reject(new Error('image decode failed'));
                img.src = url;
            });
            const w = image.naturalWidth || image.width;
            const h = image.naturalHeight || image.height;
            if (!w || !h) return fallback;
            const longEdge = Math.max(w, h);
            const scale = longEdge > MAX_EDGE ? MAX_EDGE / longEdge : 1;
            const tw = Math.max(1, Math.round(w * scale));
            const th = Math.max(1, Math.round(h * scale));
            const canvas = document.createElement('canvas');
            canvas.width = tw;
            canvas.height = th;
            const ctx = canvas.getContext('2d');
            if (!ctx) return fallback;
            ctx.drawImage(image, 0, 0, tw, th);
            const isPng = sourceType.includes('png');
            const outType = isPng ? 'image/png' : 'image/jpeg';
            const outExt = isPng ? 'png' : 'jpg';
            const outBlob: Blob | null = await new Promise((resolve) =>
                canvas.toBlob((b) => resolve(b), outType, QUALITY)
            );
            if (!outBlob) return fallback;
            if (outBlob.size >= blob.size) return fallback;
            return new File([outBlob], `${namePrefix}-${timestamp}.${outExt}`, { type: outType });
        } finally {
            URL.revokeObjectURL(url);
        }
    } catch (e) {
        console.warn('compressPastedImage failed, using original:', e);
        return fallback;
    }
}
