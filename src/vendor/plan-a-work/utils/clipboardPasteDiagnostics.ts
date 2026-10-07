/**
 * 붙여넣기 payload 진단 — **개발 환경 전용**.
 *
 * 왜 필요한가:
 *   같은 페이지를 같은 방식으로 복사해도 PC 마다 클립보드 내용이 다르다. 브라우저·OS·
 *   메일 클라이언트·확장 프로그램에 따라 `text/html` 안의 `<img src>` 가 data: 였다가
 *   blob: 였다가 인증이 필요한 http(s) 주소이기도 하고, 이미지 바이너리(`files`)가
 *   함께 오기도 하고 오지 않기도 한다. 붙여넣기 결과가 PC 마다 달라지는 원인은 거의
 *   항상 여기다 — 코드가 아니라 **입력**이 다르다.
 *
 *   그래서 "무엇이 왔는가"를 사용자 PC 에서 그대로 확인할 수 있어야 한다.
 *
 * 무엇을 남기지 않는가(중요):
 *   이미지 바이트, 원본 HTML, 텍스트 내용, 쿠키, 주소 전체 — 아무것도 남기지 않는다.
 *   주소는 **형태(scheme)** 로만 센다. 인증 이미지 주소의 query string 은 그 자체가
 *   자격증명이라 개발 콘솔에도 찍지 않는다.
 *
 * 일반 개발 화면에서도 기본값은 비활성이다. Vite 개발 환경이면서
 * `VITE_ENABLE_PASTE_DIAGNOSTICS=true`를 명시한 QA 세션에서만 수집·출력한다.
 * 운영 빌드에서는 이 플래그와 무관하게 항상 비활성이다.
 */

import type { AsyncClipboardContent } from './clipboardPasteContent';
import { countRtfPictBlocks } from './rtfPict';

/** 이미지 주소의 형태. 실제 주소는 절대 담지 않는다. */
export type PastedImageSrcKind =
    | 'data'
    | 'blob'
    | 'file'
    | 'cid'
    | 'http'
    | 'https'
    | 'relative'
    | 'other'
    | 'none';

export interface ClipboardPayloadReport {
    /** clipboardData.types 그대로(MIME 이름뿐이라 내용이 없다). */
    types: string[];
    /** items 의 kind/type 조합별 개수. */
    items: { kind: string; type: string; size: number }[];
    fileCount: number;
    /** files 의 MIME 목록(파일명은 담지 않는다). */
    fileTypes: string[];
    fileSizes: number[];
    hasHtml: boolean;
    htmlLength: number;
    hasPlainText: boolean;
    plainTextLength: number;
    hasRtf: boolean;
    rtfLength: number;
    rtfPictCount: number;
    hasUriList: boolean;
    uriListLength: number;
    /** text/html 안의 `<img>` 개수. */
    imgCount: number;
    /** src 형태별 개수. */
    srcKinds: Record<PastedImageSrcKind, number>;
    /** src 가 못 쓰는 값일 때 대신 볼 수 있는 속성이 있었는가. */
    altSourceAttrs: {
        srcset: number;
        dataSrc: number;
        dataOrigin: number;
        dataOriginal: number;
        dataLazySrc: number;
        dataCanonical: number;
    };
    /** 1x1 등 장식/추적 픽셀로 보이는 img 수(width/height 속성 기준). */
    declaredSpacerCount: number;
    tableCount: number;
    hasStartFragment: boolean;
    hasEndFragment: boolean;
}

export interface AsyncClipboardPayloadReport {
    itemCount: number;
    itemTypes: string[][];
    customTypes: string[];
    blobs: { item: number; type: string; size: number }[];
    imageBlobCount: number;
    imageBlobTypes: string[];
    hasHtml: boolean;
    htmlLength: number;
    hasPlainText: boolean;
    plainTextLength: number;
    hasRtf: boolean;
    rtfLength: number;
    rtfPictCount: number;
    hasUriList: boolean;
    uriListLength: number;
}

export function classifyImageSrc(src?: string | null): PastedImageSrcKind {
    const value = (src || '').trim().toLowerCase();
    if (!value) return 'none';
    if (value.startsWith('data:')) return 'data';
    if (value.startsWith('blob:')) return 'blob';
    if (value.startsWith('file:')) return 'file';
    if (value.startsWith('cid:')) return 'cid';
    if (value.startsWith('https:')) return 'https';
    if (value.startsWith('http:')) return 'http';
    if (value.startsWith('/') || value.startsWith('./') || value.startsWith('../')) return 'relative';
    return 'other';
}

const emptySrcKinds = (): Record<PastedImageSrcKind, number> => ({
    data: 0, blob: 0, file: 0, cid: 0, http: 0, https: 0, relative: 0, other: 0, none: 0,
});

/**
 * clipboard 이벤트 → 내용이 없는 메타데이터.
 *
 * 순수 함수다. 호출자가 `text/html` 을 이미 읽어 두었으면 그대로 넘긴다(같은 이벤트에서
 * getData 를 두 번 호출하지 않기 위해).
 */
export function describeClipboardPayload(
    clipboard: DataTransfer | null | undefined,
    html: string,
    plainText: string,
    rtf = '',
    uriList = '',
): ClipboardPayloadReport {
    const types = Array.from(clipboard?.types || []).map(String);
    const items = Array.from(clipboard?.items || []).map(item => ({
        kind: item.kind || '',
        type: item.type || '',
        size: item.kind === 'file' && typeof item.getAsFile === 'function'
            ? (item.getAsFile()?.size || 0)
            : 0,
    }));
    const files = Array.from(clipboard?.files || []);

    const report: ClipboardPayloadReport = {
        types,
        items,
        fileCount: files.length,
        fileTypes: files.map(file => file.type || 'unknown'),
        fileSizes: files.map(file => file.size),
        hasHtml: !!html,
        htmlLength: html.length,
        hasPlainText: !!plainText,
        plainTextLength: plainText.length,
        hasRtf: !!rtf,
        rtfLength: rtf.length,
        rtfPictCount: countRtfPictBlocks(rtf),
        hasUriList: !!uriList,
        uriListLength: uriList.length,
        imgCount: 0,
        srcKinds: emptySrcKinds(),
        altSourceAttrs: {
            srcset: 0, dataSrc: 0, dataOrigin: 0, dataOriginal: 0, dataLazySrc: 0, dataCanonical: 0,
        },
        declaredSpacerCount: 0,
        tableCount: 0,
        hasStartFragment: /<!--\s*StartFragment\s*-->/i.test(html),
        hasEndFragment: /<!--\s*EndFragment\s*-->/i.test(html),
    };

    if (!html || typeof DOMParser === 'undefined') return report;
    let doc: Document;
    try {
        doc = new DOMParser().parseFromString(html, 'text/html');
    } catch {
        return report;
    }
    const body = doc.body;
    if (!body) return report;

    report.tableCount = body.querySelectorAll('table').length;
    Array.from(body.querySelectorAll('img')).forEach((img) => {
        report.imgCount += 1;
        report.srcKinds[classifyImageSrc(img.getAttribute('src'))] += 1;
        if (img.getAttribute('srcset')) report.altSourceAttrs.srcset += 1;
        if (img.getAttribute('data-src')) report.altSourceAttrs.dataSrc += 1;
        if (img.getAttribute('data-origin')) report.altSourceAttrs.dataOrigin += 1;
        if (img.getAttribute('data-original')) report.altSourceAttrs.dataOriginal += 1;
        if (img.getAttribute('data-lazy-src')) report.altSourceAttrs.dataLazySrc += 1;
        if (img.getAttribute('data-canonical-src')) report.altSourceAttrs.dataCanonical += 1;
        const width = parseInt(img.getAttribute('width') || '0', 10);
        const height = parseInt(img.getAttribute('height') || '0', 10);
        if (width > 0 && height > 0 && width <= 2 && height <= 2) report.declaredSpacerCount += 1;
    });
    return report;
}

/** Async Clipboard report with MIME names and byte sizes only. */
export function describeAsyncClipboardPayload(
    content: AsyncClipboardContent,
): AsyncClipboardPayloadReport {
    const imageBlobs = content.blobs.filter(blob => blob.type.startsWith('image/'));
    return {
        itemCount: content.itemTypes.length,
        itemTypes: content.itemTypes.map(types => [...types]),
        customTypes: [...content.customTypes],
        blobs: content.blobs.map(blob => ({ ...blob })),
        imageBlobCount: imageBlobs.length,
        imageBlobTypes: imageBlobs.map(blob => blob.type),
        hasHtml: !!content.html,
        htmlLength: content.html.length,
        hasPlainText: !!content.plainText,
        plainTextLength: content.plainText.length,
        hasRtf: !!content.rtf,
        rtfLength: content.rtf.length,
        rtfPictCount: countRtfPictBlocks(content.rtf),
        hasUriList: !!content.uriList,
        uriListLength: content.uriList.length,
    };
}

// ─────────────────── 익명화된 구조 스냅샷(개발 환경 전용) ───────────────────
//
// 붙여넣기 문제는 "그 PC 의 클립보드가 무엇을 줬는가" 를 알아야 고칠 수 있는데, 원본
// HTML 에는 업무 내용·이름·주소가 들어 있어 그대로 공유할 수 없다. 그래서 **구조만**
// 남긴 스냅샷을 만든다: 태그·중첩·표 크기·서식 property 이름까지만 담고, 글자는 길이로,
// 주소는 형태로 바꾼다. 이 문자열은 그대로 회귀 테스트 fixture 로 옮길 수 있다.

const STRUCTURE_ATTRS = ['colspan', 'rowspan', 'span', 'width', 'height', 'align', 'valign'];
const MAX_STRUCTURE_NODES = 400;
const MAX_STRUCTURE_DEPTH = 12;

function describeAttributes(el: Element): string {
    const parts: string[] = [];
    STRUCTURE_ATTRS.forEach((name) => {
        const value = el.getAttribute(name);
        if (value) parts.push(`${name}=${value.trim().slice(0, 12)}`);
    });
    if (el.getAttribute('class')) parts.push('class');
    const style = el.getAttribute('style');
    if (style) {
        // 값은 담지 않는다. property 이름만으로도 "무엇이 왔는가" 는 충분히 알 수 있다.
        const names = style.split(';')
            .map((decl) => decl.split(':')[0].trim().toLowerCase())
            .filter(Boolean)
            .slice(0, 8);
        if (names.length) parts.push(`style(${names.join(',')})`);
    }
    if (el.tagName === 'IMG') parts.push(`src:${classifyImageSrc(el.getAttribute('src'))}`);
    return parts.length ? ` ${parts.join(' ')}` : '';
}

/** 클립보드 HTML → 내용이 없는 구조 스냅샷(그대로 공유·fixture 화 가능). */
export function anonymizeClipboardHtml(html: string): string {
    if (!html || typeof DOMParser === 'undefined') return '';
    let doc: Document;
    try {
        doc = new DOMParser().parseFromString(html, 'text/html');
    } catch {
        return '';
    }
    const lines: string[] = [];
    let nodes = 0;
    const walk = (node: Node, depth: number) => {
        if (nodes >= MAX_STRUCTURE_NODES || depth > MAX_STRUCTURE_DEPTH) return;
        node.childNodes.forEach((child) => {
            if (nodes >= MAX_STRUCTURE_NODES) return;
            if (child.nodeType === 3) {
                const text = (child.textContent || '').trim();
                if (!text) return;
                nodes += 1;
                lines.push(`${'  '.repeat(depth)}#text(${text.length})`);
                return;
            }
            if (child.nodeType === 8) {
                // StartFragment/EndFragment 는 구조 판단의 핵심 단서라 이름만 남긴다.
                const value = (child.nodeValue || '').trim().slice(0, 20);
                if (/fragment/i.test(value)) {
                    nodes += 1;
                    lines.push(`${'  '.repeat(depth)}<!--${value}-->`);
                }
                return;
            }
            if (child.nodeType !== 1) return;
            const el = child as Element;
            nodes += 1;
            lines.push(`${'  '.repeat(depth)}<${el.tagName.toLowerCase()}${describeAttributes(el)}>`);
            if (el.tagName === 'STYLE') {
                // selector에도 사용자/문서 식별자가 들어갈 수 있으므로 이름조차 남기지 않는다.
                const ruleCount = Math.min(100, ((el.textContent || '').match(/\{/g) || []).length);
                lines.push(`${'  '.repeat(depth + 1)}style-rules(${ruleCount})`);
                return;
            }
            walk(el, depth + 1);
        });
    };
    walk(doc.documentElement || doc, 0);
    if (nodes >= MAX_STRUCTURE_NODES) lines.push('… (생략)');
    return lines.join('\n');
}

export interface SafeRemoteImageDiagnostic {
    stage: 'browser' | 'backend';
    host: string;
    hasQuery: boolean;
    result: string;
    status?: number;
    code?: string;
    mime?: string;
    bytes?: number;
}

export type PasteImageFinalState =
    | 'pending'
    | 'resolved'
    | 'failed'
    | 'intentionally_skipped';

/**
 * 붙여넣기 이미지 한 자리의 익명 상태다. ref/URL/본문은 의도적으로 넣지 않는다.
 * index 는 같은 붙여넣기 안의 문서 순서(1부터 시작)일 뿐 영구 식별자가 아니다.
 */
export interface PasteImageDiagnostic {
    index: number;
    sourceDiscovered: string;
    candidateCount: number;
    browserFetch?: 'not_started' | 'started' | 'success' | 'failed';
    blobMime?: string;
    blobBytes?: number;
    compression?: 'not_started' | 'started' | 'success' | 'failed';
    compressedMime?: string;
    compressedBytes?: number;
    uploadStarted: boolean;
    uploadResult?: string;
    internalUrlReceived: boolean;
    placeholderFound?: boolean;
    placeholderReplaced?: boolean;
    final: PasteImageFinalState;
    reason?: string;
}

export interface PasteDiagnosticsSnapshot {
    clipboardEvent: ClipboardPayloadReport;
    asyncClipboard?: AsyncClipboardPayloadReport;
    remote: SafeRemoteImageDiagnostic[];
    matchedImages: number;
    resolvedImages: number;
    failedImages: number;
    pendingImages?: number;
    intentionallySkippedImages?: number;
    imageRefs?: PasteImageDiagnostic[];
}

export function shouldEnablePasteDiagnostics(
    isDevelopment: boolean,
    explicitlyEnabled?: string,
): boolean {
    return isDevelopment && explicitlyEnabled === 'true';
}

export function isPasteDiagnosticsEnabled(): boolean {
    return shouldEnablePasteDiagnostics(
        import.meta.env.DEV,
        import.meta.env.VITE_ENABLE_PASTE_DIAGNOSTICS,
    );
}

/** URL 본문/query 를 버리고 진단에 허용되는 origin 메타데이터만 만든다. */
export function safeRemoteImageLocation(url: string): { host: string; hasQuery: boolean } {
    try {
        const parsed = new URL(url);
        return { host: parsed.hostname, hasQuery: !!parsed.search };
    } catch {
        return { host: '(invalid)', hasQuery: false };
    }
}

/** 사용자가 그대로 복사해 전달할 수 있는 개인정보 없는 붙여넣기 진단 문자열. */
export function formatPasteDiagnostics(snapshot: PasteDiagnosticsSnapshot): string {
    const event = snapshot.clipboardEvent;
    const asyncReport = snapshot.asyncClipboard;
    const imageItems = event.items.filter(item => item.kind === 'file' && item.type.startsWith('image/'));
    const files = event.fileTypes.map((type, index) => `${type} ${event.fileSizes[index] || 0} bytes`);
    const asyncTypes = asyncReport?.itemTypes.map(types => types.join('|')).join(', ') || '(none)';
    const asyncImages = asyncReport?.blobs
        .filter(blob => blob.type.startsWith('image/'))
        .map(blob => `${blob.type} ${blob.size} bytes`) || [];
    const sourceKinds = Object.entries(event.srcKinds).map(([kind, count]) => `${kind}=${count}`).join(', ');
    const attrs = event.altSourceAttrs;
    const lines = [
        '[paste diagnostics]',
        `clipboardEvent.types: ${event.types.join(', ') || '(none)'}`,
        `clipboardEvent.items: ${event.items.map(item => `${item.kind}/${item.type || 'unknown'}${item.size ? `/${item.size}` : ''}`).join(', ') || '(none)'}`,
        `clipboardEvent.imageItems: ${imageItems.length}`,
        `clipboardEvent.files: ${files.join(', ') || '0'}`,
        `clipboardEvent.text/html: ${event.hasHtml ? `${event.htmlLength} chars` : 'absent'}`,
        `clipboardEvent.text/plain: ${event.hasPlainText ? `${event.plainTextLength} chars` : 'absent'}`,
        `clipboardEvent.text/rtf: ${event.hasRtf ? `${event.rtfLength} chars, pict=${event.rtfPictCount}` : 'absent'}`,
        `clipboardEvent.text/uri-list: ${event.hasUriList ? `${event.uriListLength} chars` : 'absent'}`,
        `asyncClipboard.types: ${asyncTypes}`,
        `asyncClipboard.images: ${asyncImages.join(', ') || '0'}`,
        `asyncClipboard.text/rtf: ${asyncReport?.hasRtf ? `${asyncReport.rtfLength} chars, pict=${asyncReport.rtfPictCount}` : 'absent'}`,
        `html.images: ${event.imgCount}`,
        `html.tables: ${event.tableCount}`,
        `html.imageSources: ${sourceKinds}`,
        `html.srcset: ${attrs.srcset}`,
        `html.lazySources: ${attrs.dataOrigin + attrs.dataOriginal + attrs.dataSrc + attrs.dataLazySrc}`,
        `html.sourceAttrs: data-origin=${attrs.dataOrigin}, data-original=${attrs.dataOriginal}, data-src=${attrs.dataSrc}, data-lazy-src=${attrs.dataLazySrc}`,
        `matchedImages: ${snapshot.matchedImages}`,
        `resolvedImages: ${snapshot.resolvedImages}`,
        `failedImages: ${snapshot.failedImages}`,
        `pendingImages: ${snapshot.pendingImages ?? 0}`,
        `intentionallySkippedImages: ${snapshot.intentionallySkippedImages ?? 0}`,
    ];
    (snapshot.imageRefs || []).forEach((item) => {
        lines.push(
            `imageRef.${item.index}: source_discovered=${item.sourceDiscovered}`
            + ` candidate_count=${item.candidateCount}`
            + ` browser_fetch=${item.browserFetch || 'not_applicable'}`
            + `${item.blobMime ? ` blob_mime=${item.blobMime}` : ''}`
            + `${item.blobBytes !== undefined ? ` blob_bytes=${item.blobBytes}` : ''}`
            + ` compression=${item.compression || 'not_started'}`
            + `${item.compressedMime ? ` compressed_mime=${item.compressedMime}` : ''}`
            + `${item.compressedBytes !== undefined ? ` compressed_bytes=${item.compressedBytes}` : ''}`
            + ` upload_started=${item.uploadStarted ? 'true' : 'false'}`
            + ` upload_result=${item.uploadResult || 'not_started'}`
            + ` internal_url_received=${item.internalUrlReceived ? 'true' : 'false'}`
            + ` placeholder_found=${item.placeholderFound === undefined ? 'not_checked' : item.placeholderFound ? 'true' : 'false'}`
            + ` placeholder_replaced=${item.placeholderReplaced === undefined ? 'not_checked' : item.placeholderReplaced ? 'true' : 'false'}`
            + ` final=${item.final}`
            + `${item.reason ? ` reason=${item.reason}` : ''}`,
        );
    });
    snapshot.remote.forEach((attempt, index) => {
        lines.push(
            `remoteFetch.${index + 1}: stage=${attempt.stage} host=${attempt.host} query=${attempt.hasQuery ? 'yes' : 'no'} result=${attempt.result}`
            + `${attempt.status ? ` status=${attempt.status}` : ''}`
            + `${attempt.code ? ` code=${attempt.code}` : ''}`
            + `${attempt.mime ? ` mime=${attempt.mime}` : ''}`
            + `${attempt.bytes ? ` bytes=${attempt.bytes}` : ''}`,
        );
    });
    return lines.join('\n');
}

/** 명시적으로 진단을 켠 개발 환경에서만 콘솔에 남긴다. */
export function logClipboardPayload(
    clipboard: DataTransfer | null | undefined,
    html: string,
    plainText: string,
    rtf = '',
    uriList = '',
): void {
    if (!isPasteDiagnosticsEnabled()) return;
    // 내용이 아니라 "형태"만 찍는다 — 주소·바이트·본문은 담기지 않는다.
    console.info(
        '[paste] clipboard payload',
        describeClipboardPayload(clipboard, html, plainText, rtf, uriList),
    );
    if (html) {
        // 그대로 복사해 회귀 테스트 fixture 로 옮길 수 있는 구조 스냅샷.
        console.info('[paste] structure (anonymized)\n' + anonymizeClipboardHtml(html));
    }
}


/** Same explicit DEV opt-in policy as the ClipboardEvent diagnostics above. */
export function logAsyncClipboardPayload(content: AsyncClipboardContent): void {
    if (!isPasteDiagnosticsEnabled()) return;
    console.info('[paste] async clipboard payload', describeAsyncClipboardPayload(content));
}
