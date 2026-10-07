/**
 * Office(Word/PowerPoint/Excel/Outlook) 및 일반 웹 HTML 붙여넣기 정규화 — 단일 출처.
 *
 * 왜 필요한가:
 *   Word/PPT 클립보드 HTML 은 "페이지 레이아웃"을 그대로 들고 온다. 고정 행 높이,
 *   spacer 열, 빈 문단(`<p><o:p>&nbsp;</o:p></p>`), 태그 사이의 줄바꿈·들여쓰기가
 *   그대로 남으면 Description 안에서 화면 절반짜리 빈 공간이 된다.
 *   (Description 에디터는 legacy plain-text 를 위해 `white-space: pre-wrap` 이라
 *    태그 사이 줄바꿈이 **실제 빈 줄로 렌더된다** — 이것이 가장 큰 원인이다.)
 *
 * 무엇을 하지 않는가:
 *   - Word 를 브라우저에 재현하지 않는다. 픽셀 단위 레이아웃 보존은 목표가 아니다.
 *   - 원본 폰트·레이아웃은 가져오지 않는다. 굵게/밑줄/색/크기 preset 및 기존 셀 서식만
 *     공통 richTextFormatting 계약으로 정리하고 FE/BE sanitizer 가 다시 검증한다.
 *
 * 이 모듈은 순수 함수만 노출한다(에디터 DOM 을 건드리지 않는다). 호출자는 결과 HTML 을
 * 이미지 업로드까지 끝낸 뒤 **한 번에** 삽입해, 실패해도 기존 본문이 남게 한다.
 */

import { normalizeLinkUrl } from './richLink';
import { normalizeRichText, normalizeTableSpans, officeTextRules } from './richTextFormatting';
import {
    COL_WIDTH_ATTR,
    RESIZABLE_TABLE_ATTR,
    TABLE_SIZING_LIMITS,
    clampColWidth,
} from './tableResize';

export const OFFICE_PASTE_LIMITS = {
    /** 클립보드 HTML 원문 길이(문자). Word 한 페이지가 보통 100KB 내외. */
    maxHtmlChars: 3_000_000,
    /** 파싱 후 엘리먼트 개수. 브라우저가 멈추지 않는 선. */
    maxNodes: 12_000,
    /** 표 셀 총 개수. */
    maxTableCells: 5_000,
    /** 본문에 포함된 Base64 이미지의 총 바이트. */
    maxImageBytes: 40 * 1024 * 1024,
} as const;

export type OfficePasteLimit = 'html_size' | 'node_count' | 'table_cells' | 'image_bytes';

/** 본문에서 뽑아낸 Base64 이미지 1장(= 업로드 1회 단위). */
export interface OfficePasteImage {
    /** placeholder `<img data-office-image-ref>` 와 연결되는 키. */
    ref: string;
    mime: string;
    bytes: Uint8Array;
    /** 같은 이미지를 두 번 업로드하지 않기 위한 내용 기반 키. */
    contentKey: string;
    /** 본문에 등장한 순서(0-based). 이미지 개수 상한을 앞에서부터 적용할 때 쓴다. */
    order: number;
}

/**
 * 주소만 있고 바이트가 없는 이미지 — 호출자가 실제 데이터를 확보해야 한다.
 *
 * - `internal`: 이미 우리 서버에 저장된 이미지(우리 편집기에서 복사한 경우). 주소만 옮기면 된다.
 * - `remote`  : http(s) 외부 주소. 서버 import 로 내부 이미지로 만든다.
 * - `binary`  : blob:/file:/cid: — 주소로는 절대 복구할 수 없다.
 *               같은 붙여넣기의 clipboard 이미지 item 과 순서로 짝지어 바이트를 얻는다.
 */
export type PendingImageKind = 'internal' | 'remote' | 'binary';

export interface PendingPasteImage {
    /** placeholder `<img data-office-image-ref>` 와 연결되는 키. */
    ref: string;
    kind: PendingImageKind;
    /** internal/remote 는 그대로 쓸 수 있는 주소, binary 는 원본 참조(안내·진단용). */
    url: string;
    /** 같은 img 에서 찾은 공개 URL 대체 후보. 첫 URL 실패 시 한 번만 이어서 시도한다. */
    fallbackUrls?: string[];
    /** binary 인 이유(사용자 안내 문구용). */
    reason?: 'blob' | 'cid' | 'local-file' | 'clipboard-only';
    /** 본문에 등장한 순서(0-based). clipboard 이미지 순서 매칭의 기준. */
    order: number;
    /** 파일명 힌트(소문자). clipboard 이미지와 이름으로 짝지을 때만 쓴다. */
    nameHint?: string;
    /** 선언된 MIME 힌트(`contentType=` 질의값 또는 확장자). */
    mimeHint?: string;
}

export interface OfficePasteStats {
    removedEmptyBlocks: number;
    removedSpacerRows: number;
    removedSpacerColumns: number;
    unwrappedLayoutTables: number;
    removedEmptyTables: number;
    reorderedAbsoluteGroups: number;
    duplicateImageCount: number;
    tableCount: number;
    nodeCount: number;
}

export interface OfficePasteResult {
    /** Office 계열 클립보드로 판정됐는지(안내 문구 결정용). */
    isOffice: boolean;
    /**
     * 정규화된 HTML. 이미지는 하나도 `src` 를 갖지 않는다 —
     * data:/http(s)/blob:/file:/cid: 무엇이든 placeholder `<img data-office-image-ref>` 로만 남는다.
     * 그래서 이 HTML 을 그대로 삽입해도 임시 주소가 본문에 저장될 수 없다.
     */
    html: string;
    /** 본문에 Base64 로 들어 있어 바로 업로드할 수 있는 고유 이미지 목록(중복 제거됨). */
    images: OfficePasteImage[];
    /** 주소만 확보된 이미지들(내부 주소 / 외부 http(s) / clipboard 바이너리 필요). */
    pendingImages: PendingPasteImage[];
    /** 주소 형식 자체가 잘못돼(깨진 data URL, about:, 상대경로) 참조를 버린 이미지 수. */
    unrecoverableImageCount: number;
    /** 텍스트/표/이미지 중 하나라도 남았는지. false 면 구조 복구 실패. */
    hasMeaningfulContent: boolean;
    /** 한도를 넘어 변환을 포기한 이유(있으면 html 은 빈 문자열). */
    limitExceeded: OfficePasteLimit | null;
    stats: OfficePasteStats;
}

const emptyStats = (): OfficePasteStats => ({
    removedEmptyBlocks: 0,
    removedSpacerRows: 0,
    removedSpacerColumns: 0,
    unwrappedLayoutTables: 0,
    removedEmptyTables: 0,
    reorderedAbsoluteGroups: 0,
    duplicateImageCount: 0,
    tableCount: 0,
    nodeCount: 0,
});

/** 내용까지 통째로 버리는 태그(스타일/스크립트/폼/Office 메타). */
const DROP_WITH_CONTENT = new Set([
    'SCRIPT', 'STYLE', 'META', 'LINK', 'TITLE', 'BASE', 'NOSCRIPT',
    'IFRAME', 'OBJECT', 'EMBED', 'SVG', 'CANVAS', 'AUDIO', 'VIDEO',
    'FORM', 'INPUT', 'BUTTON', 'SELECT', 'TEXTAREA', 'MAP', 'AREA',
    // 열 너비만 담고 있어 Description 에서는 의미가 없다.
    'COL', 'COLGROUP',
    // Word/Excel 의 XML island.
    'XML',
]);

/** 빈 상태면 지워도 되는 블록. LI 는 목록 구조라 항상 제거(빈 항목은 의미 없음). */
const COLLAPSIBLE_BLOCK = new Set([
    'P', 'DIV', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6',
    'SECTION', 'ARTICLE', 'HEADER', 'FOOTER', 'ASIDE', 'MAIN', 'CENTER',
]);

/** 비어 있으면 항상 지우는 블록(간격 유지 목적이 아님). */
const ALWAYS_DROP_WHEN_EMPTY = new Set(['LI', 'UL', 'OL', 'BLOCKQUOTE']);

const CONTENT_ELEMENTS = 'img,table,hr,pre,code';

const ALLOWED_IMAGE_MIME = new Set([
    'image/png', 'image/jpeg', 'image/jpg', 'image/gif', 'image/webp', 'image/bmp',
]);

/** 레이아웃 목적 스타일 — 남으면 빈 공간의 원인이 된다. */
const LAYOUT_STYLE_PROPERTIES = [
    'height', 'min-height', 'max-height',
    'width', 'min-width', 'max-width',
    'position', 'top', 'left', 'right', 'bottom',
    'float', 'clear',
    'margin', 'margin-top', 'margin-bottom', 'margin-left', 'margin-right',
    'padding', 'padding-top', 'padding-bottom', 'padding-left', 'padding-right',
    'line-height', 'page-break-before', 'page-break-after', 'page-break-inside',
    'text-indent', 'mso-line-height-rule', 'mso-height-source', 'mso-element',
];

/** 고정 크기를 만드는 HTML 속성. */
const LAYOUT_ATTRIBUTES = [
    'width', 'height', 'cellpadding', 'cellspacing', 'border', 'bgcolor',
    'valign', 'align', 'hspace', 'vspace', 'nowrap',
];

// ──────────────────────── 클립보드 HTML 파싱 ────────────────────────

/** `<tr>`/`<td>` 같은 표 조각이 들어 있는가(래퍼 `<table>` 없이 올 수 있다). */
const TABLE_FRAGMENT_TAG_RE = /<\s*(?:tr|td|th|tbody|thead|tfoot|colgroup|col)\b/i;

/**
 * 클립보드 HTML → Document.  **표 조각을 잃지 않는 것**이 이 함수의 존재 이유다.
 *
 * Excel(그리고 웹페이지에서 표의 일부만 선택한 경우)은 `<table>` 껍데기 없이
 * `<tr>`/`<td>` 만 클립보드에 올릴 때가 있다(CF_HTML 의 StartFragment~EndFragment 가
 * `<table>` 안쪽을 가리키기 때문). 이 조각을 그대로 HTML 파서에 넣으면 파서는
 * "in body" 규칙에 따라 `<tr>`/`<td>` **시작 태그를 무시**하고 셀 안의 글자만 남긴다.
 *   입력: `<tr><td>항목</td><td>내용</td></tr>`
 *   결과: `항목내용`            ← 표가 통째로 사라진다
 *
 * 브라우저·Excel 버전에 따라 전체 문서가 오기도 하고 조각만 오기도 해서, 같은 코드가
 * PC 마다 다르게 보이는 원인이 된다. 그래서 표가 사라진 경우에만 `<table>` 로 감싸
 * 다시 읽는다(감싸도 표 밖 내용은 파서가 표 앞으로 밀어내 살려 준다 — foster parenting).
 */
export function parsePastedHtml(source: string): Document {
    const doc = new DOMParser().parseFromString(source || '', 'text/html');
    const body = doc.body;
    if (!body) return doc;
    if (body.querySelector('table')) return doc;
    if (!TABLE_FRAGMENT_TAG_RE.test(source || '')) return doc;

    const repaired = new DOMParser().parseFromString(`<table>${source}</table>`, 'text/html');
    const repairedBody = repaired.body;
    // 감싼 결과에 실제로 셀이 생겼을 때만 채택한다(빈 표를 만들어 내지 않는다).
    if (!repairedBody?.querySelector('td,th')) return doc;
    // `<head>` 의 `<style>`(Excel 서식 클래스)은 원본 파싱 결과에만 있으므로 옮겨 온다.
    Array.from(doc.querySelectorAll('style')).forEach((styleEl) => {
        repaired.body?.appendChild(styleEl.cloneNode(true));
    });
    return repaired;
}

// ────────────────────────────── 감지 ──────────────────────────────

/** Word/Excel/PowerPoint/Outlook 이 만든 HTML 인가. */
export function isOfficeHtml(html?: string | null): boolean {
    const source = html || '';
    if (!source) return false;
    return (
        /class="?Mso/i.test(source)
        || /\bmso-[a-z-]+\s*:/i.test(source)
        || /urn:schemas-microsoft-com/i.test(source)
        || /<\/?o:p\b/i.test(source)
        || /<!--\s*\[if [^\]]*(?:mso|vml)/i.test(source)
        || /\bProgId\b\s*=?\s*["']?(?:Word|Excel|PowerPoint)/i.test(source)
        || /content=["']?(?:Word|Excel|PowerPoint)\.(?:Document|Sheet|Slide)/i.test(source)
    );
}

// ────────────────────────────── 이미지 유틸 ──────────────────────────────

/** 내용 기반 키(업로드 중복 방지용). 암호학 용도가 아니라 FNV-1a 로 충분하다. */
export function imageContentKey(bytes: Uint8Array): string {
    let h1 = 0x811c9dc5;
    let h2 = 0x01000193;
    for (let i = 0; i < bytes.length; i += 1) {
        h1 ^= bytes[i];
        h1 = Math.imul(h1, 0x01000193) >>> 0;
        h2 = (h2 + bytes[i]) >>> 0;
        h2 = Math.imul(h2, 0x85ebca6b) >>> 0;
    }
    return `${bytes.length}:${h1.toString(16)}${h2.toString(16)}`;
}

function base64ToBytes(base64: string): Uint8Array | null {
    const compact = base64.replace(/\s+/g, '');
    if (!compact || !/^[A-Za-z0-9+/]+={0,2}$/.test(compact)) return null;
    try {
        const binary = atob(compact);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
        return bytes;
    } catch {
        return null;
    }
}

/** 선언된 MIME 과 실제 파일 시그니처가 맞는지 확인한다. */
export function matchesImageSignature(mime: string, bytes: Uint8Array): boolean {
    const at = (i: number) => bytes[i];
    if (bytes.length < 4) return false;
    if (mime === 'image/png') {
        return at(0) === 0x89 && at(1) === 0x50 && at(2) === 0x4e && at(3) === 0x47;
    }
    if (mime === 'image/jpeg' || mime === 'image/jpg') {
        return at(0) === 0xff && at(1) === 0xd8 && at(2) === 0xff;
    }
    if (mime === 'image/gif') {
        return at(0) === 0x47 && at(1) === 0x49 && at(2) === 0x46 && at(3) === 0x38;
    }
    if (mime === 'image/webp') {
        if (bytes.length < 12) return false;
        return (
            at(0) === 0x52 && at(1) === 0x49 && at(2) === 0x46 && at(3) === 0x46
            && at(8) === 0x57 && at(9) === 0x45 && at(10) === 0x42 && at(11) === 0x50
        );
    }
    if (mime === 'image/bmp') return at(0) === 0x42 && at(1) === 0x4d;
    return false;
}

/** `data:image/...;base64,...` 를 검증된 바이트로 변환. 실패하면 null. */
export function decodeDataUrlImage(src: string): { mime: string; bytes: Uint8Array } | null {
    const match = /^\s*data:\s*([a-z0-9.+-]+\/[a-z0-9.+-]+)\s*;([^,]*)base64\s*,([\s\S]*)$/i.exec(src || '');
    if (!match) return null;
    const mime = match[1].toLowerCase();
    if (!ALLOWED_IMAGE_MIME.has(mime)) return null;
    const bytes = base64ToBytes(match[3]);
    if (!bytes || bytes.length === 0) return null;
    if (!matchesImageSignature(mime, bytes)) return null;
    return { mime: mime === 'image/jpg' ? 'image/jpeg' : mime, bytes };
}

/** 업로드용 File 로 변환(기존 인라인 이미지 정책을 그대로 태우기 위해). */
export function officeImageToFile(image: OfficePasteImage, timestamp: number, index: number): File {
    const ext = image.mime === 'image/jpeg' ? 'jpg' : image.mime.replace('image/', '');
    // ArrayBuffer 뷰를 그대로 넘기면 SharedArrayBuffer 타입 이슈가 있어 복사본을 만든다.
    const copy = new Uint8Array(image.bytes);
    return new File([copy], `office-paste-${timestamp}-${index}.${ext}`, { type: image.mime });
}

// ────────────────────────────── 단계별 정리 ──────────────────────────────

function removeCommentNodes(root: Element): void {
    const doc = root.ownerDocument;
    const walker = doc.createTreeWalker(root, 128 /* NodeFilter.SHOW_COMMENT */);
    const comments: Node[] = [];
    while (walker.nextNode()) comments.push(walker.currentNode);
    comments.forEach((node) => node.parentNode?.removeChild(node));
}

function dropDisallowedElements(root: Element): void {
    Array.from(root.querySelectorAll('*')).forEach((el) => {
        if (!el.isConnected) return;
        const tag = el.tagName.toUpperCase();
        if (DROP_WITH_CONTENT.has(tag)) {
            el.remove();
            return;
        }
        // `<o:p>` 는 Word 가 빈 문단을 만들 때 쓰는 껍데기라 통째로 버린다.
        if (tag === 'O:P' || tag.startsWith('O:')) {
            el.remove();
            return;
        }
        // v:shape(VML), w:sdt 등 나머지 Office namespace 태그는 내용만 남긴다.
        if (tag.includes(':')) {
            el.replaceWith(...Array.from(el.childNodes));
        }
    });
}

function parseLengthPx(value: string): number | null {
    const match = /^(-?\d+(?:\.\d+)?)\s*(px|pt|in|cm|mm)?$/i.exec((value || '').trim());
    if (!match) return null;
    const n = parseFloat(match[1]);
    const unit = (match[2] || 'px').toLowerCase();
    const factor = unit === 'pt' ? 96 / 72 : unit === 'in' ? 96 : unit === 'cm' ? 96 / 2.54 : unit === 'mm' ? 96 / 25.4 : 1;
    return n * factor;
}

/**
 * PowerPoint 처럼 절대 좌표로 배치된 형제들을 "읽는 순서"(위→아래, 같으면 왼→오른쪽)로
 * 재배열한다. 좌표 자체는 뒤에서 스타일과 함께 제거된다.
 */
function reorderAbsolutePositioned(root: Element, stats: OfficePasteStats): void {
    const parents = new Set<Element>();
    Array.from(root.querySelectorAll('[style*="absolute"]')).forEach((el) => {
        const style = (el.getAttribute('style') || '').toLowerCase();
        if (!/position\s*:\s*absolute/.test(style)) return;
        if (el.parentElement) parents.add(el.parentElement);
    });
    parents.forEach((parent) => {
        const children = Array.from(parent.children);
        const positioned = children.filter((el) =>
            /position\s*:\s*absolute/.test((el.getAttribute('style') || '').toLowerCase()));
        if (positioned.length < 2) return;
        const keyed = positioned.map((el, index) => {
            const style = el.getAttribute('style') || '';
            const top = parseLengthPx(/(?:^|;)\s*top\s*:\s*([^;]+)/i.exec(style)?.[1] || '') ?? 0;
            const left = parseLengthPx(/(?:^|;)\s*left\s*:\s*([^;]+)/i.exec(style)?.[1] || '') ?? 0;
            return { el, top, left, index };
        });
        const sorted = [...keyed].sort((a, b) =>
            (a.top - b.top) || (a.left - b.left) || (a.index - b.index));
        if (sorted.every((item, i) => item.index === keyed[i].index)) return;
        // 첫 요소 자리에 marker 를 두고 그 앞에 순서대로 넣는다.
        // (anchor 를 직접 쓰면 anchor 자신이 밀려 순서가 뒤집힌다.)
        const marker = parent.ownerDocument.createTextNode('');
        parent.insertBefore(marker, positioned[0]);
        sorted.forEach((item) => parent.insertBefore(item.el, marker));
        marker.remove();
        stats.reorderedAbsoluteGroups += 1;
    });
}

interface CollectImagesOutcome {
    images: OfficePasteImage[];
    pending: PendingPasteImage[];
    unrecoverable: number;
    duplicates: number;
    totalBytes: number;
}

/** 우리 서버가 발급한 인라인 이미지 주소인가(= 다시 업로드할 필요가 없는 이미지). */
const INTERNAL_IMAGE_PATH_RE = /^\/api\/spaces\/\d+\/images\/[^/?#]+\/download(?:[?#].*)?$/i;

/**
 * 이 앱이 저장한 이미지 주소면 root-relative 형태로 정규화해서 돌려준다.
 *
 * 우리 편집기에서 복사한 HTML 은 `src` 가 임시 blob: 주소이고 실제 주소는
 * `data-canonical-src` 에 들어 있다(richImage.hydrateProtectedImage 참고).
 * 그래서 두 값을 모두 본다 — 앱 안에서의 복사·붙여넣기는 재업로드 없이 그대로 이어진다.
 */
export function internalImageUrl(value?: string | null): string | null {
    const raw = (value || '').trim();
    if (!raw) return null;
    if (INTERNAL_IMAGE_PATH_RE.test(raw)) return raw;
    if (!/^https?:\/\//i.test(raw)) return null;
    try {
        const parsed = new URL(raw);
        const path = `${parsed.pathname}${parsed.search}`;
        return INTERNAL_IMAGE_PATH_RE.test(path) ? path : null;
    } catch {
        return null;
    }
}

interface SrcsetCandidate { url: string; score: number }

/** srcset 을 큰/선명한 후보부터 읽는다. clipboard HTML 에서는 currentSrc 를 읽을 수 없다. */
function rankedSrcsetUrls(value?: string | null): string[] {
    return (value || '').split(',')
        .map((part, index): SrcsetCandidate | null => {
            const [url, descriptor = ''] = part.trim().split(/\s+/, 2);
            if (!url) return null;
            const width = /^(\d+(?:\.\d+)?)w$/i.exec(descriptor)?.[1];
            const density = /^(\d+(?:\.\d+)?)x$/i.exec(descriptor)?.[1];
            const score = width ? Number(width) : density ? Number(density) * 10_000 : -index;
            return { url, score };
        })
        .filter((item): item is SrcsetCandidate => !!item)
        .sort((a, b) => b.score - a.score)
        .map(item => item.url);
}

/**
 * 이 `<img>` 가 가리킬 수 있는 주소 후보들 — 등장 순서대로.
 *
 * 왜 `src` 하나로 부족한가:
 *   요즘 웹페이지는 `src` 에 1x1 투명 placeholder 를 넣고 실제 주소는 `data-src` /
 *   `data-original` / `srcset` 에 둔다(lazy loading). 복사 시점에 아직 실제 이미지가
 *   로드되지 않았다면 `src` 만 보고는 "빈 이미지"로 판단하게 된다.
 */
export function imageSourceCandidates(img: Element): string[] {
    const anchor = img.closest('a[href]');
    const linkedOriginal = anchor && anchor.querySelectorAll('img').length === 1
        ? anchor.getAttribute('href')
        : null;
    const srcset = rankedSrcsetUrls(img.getAttribute('srcset'));
    const values = [
        // clipboard HTML 에 currentSrc 는 없으므로, descriptor상 가장 선명한 srcset 후보를
        // 현재 화면 후보의 근사치로 먼저 본다. 실제 티스토리 payload에서 이 후보만 CORS가 열려 있었다.
        srcset[0],
        img.getAttribute('src'),
        img.getAttribute('data-origin'),
        img.getAttribute('data-original'),
        img.getAttribute('data-src'),
        img.getAttribute('data-lazy-src'),
        ...srcset.slice(1),
        img.getAttribute('data-noscript-src'),
        ...rankedSrcsetUrls(img.getAttribute('data-noscript-srcset')),
        linkedOriginal,
    ];
    const seen = new Set<string>();
    const candidates: string[] = [];
    values.forEach((value) => {
        const trimmed = (value || '').trim();
        if (!trimmed || seen.has(trimmed)) return;
        seen.add(trimmed);
        candidates.push(trimmed);
    });
    return candidates;
}

/** noscript fallback 이미지를 기존 img 의 후보로 승격하고, 짝이 없으면 그 자리에 복원한다. */
function promoteNoscriptImages(root: Element): void {
    Array.from(root.querySelectorAll('noscript')).forEach((noscript) => {
        const source = noscript.textContent || noscript.innerHTML || '';
        if (!/<img\b/i.test(source)) return;
        const fallbackDoc = new DOMParser().parseFromString(source, 'text/html');
        const fallbacks = Array.from(fallbackDoc.body?.querySelectorAll('img') || []);
        fallbacks.forEach((fallback) => {
            let previous = noscript.previousElementSibling;
            if (previous && previous.tagName !== 'IMG') previous = previous.querySelector('img:last-of-type');
            if (previous?.tagName === 'IMG') {
                const src = fallback.getAttribute('src');
                const srcset = fallback.getAttribute('srcset');
                if (src) previous.setAttribute('data-noscript-src', src);
                if (srcset) previous.setAttribute('data-noscript-srcset', srcset);
                return;
            }
            noscript.parentNode?.insertBefore(root.ownerDocument.importNode(fallback, true), noscript);
        });
    });
}

/**
 * 주소에서 파일명/타입 힌트를 뽑는다 — clipboard 이미지와 짝지을 때의 **근거**다.
 * 주소 자체는 남기지 않는다(인증 주소의 query string 은 자격증명이다).
 */
export function imageSourceHints(src: string): { nameHint?: string; mimeHint?: string } {
    const raw = (src || '').trim();
    if (!raw || /^data:/i.test(raw)) return {};
    let path = raw;
    let query = '';
    const queryIndex = raw.search(/[?#]/);
    if (queryIndex >= 0) {
        path = raw.slice(0, queryIndex);
        query = raw.slice(queryIndex + 1);
    }
    const hints: { nameHint?: string; mimeHint?: string } = {};
    // `?filename=회의록.png` 처럼 메일 서비스가 붙여 주는 이름.
    const fromQuery = /(?:^|[&;])(?:filename|fileName|name)=([^&;]+)/.exec(query)?.[1];
    const basename = decodeURIComponentSafe(fromQuery || path.split('/').pop() || '');
    if (basename && /\.[a-z0-9]{2,5}$/i.test(basename)) hints.nameHint = basename.toLowerCase();
    const declaredType = decodeURIComponentSafe(
        /(?:^|[&;])(?:contentType|content_type|mimeType|type)=([^&;]+)/.exec(query)?.[1] || '',
    ).toLowerCase();
    if (/^image\/[a-z0-9.+-]+$/.test(declaredType)) hints.mimeHint = declaredType;
    else {
        const ext = /\.([a-z0-9]{2,5})$/i.exec(hints.nameHint || '')?.[1]?.toLowerCase();
        const byExt: Record<string, string> = {
            png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg',
            gif: 'image/gif', webp: 'image/webp', bmp: 'image/bmp',
        };
        if (ext && byExt[ext]) hints.mimeHint = byExt[ext];
    }
    return hints;
}

function decodeURIComponentSafe(value: string): string {
    try {
        return decodeURIComponent(value || '');
    } catch {
        return value || '';
    }
}

/** 주소로는 복구할 수 없지만 clipboard 에 바이트가 함께 왔을 수 있는 참조. */
function binaryOnlyReason(src: string): PendingPasteImage['reason'] | null {
    const value = (src || '').trim().toLowerCase();
    if (value.startsWith('blob:')) return 'blob';
    if (value.startsWith('cid:')) return 'cid';
    if (value.startsWith('file:')) return 'local-file';
    return null;
}

/** width/height 속성만으로 판단하는 spacer(바이트가 없어 헤더를 볼 수 없는 이미지용). */
function isDeclaredSpacer(width: number, height: number): boolean {
    return width > 0 && height > 0 && width <= 2 && height <= 2;
}

/** 헤더에서 실제 픽셀 크기를 읽는다(모르면 null). spacer 판정 근거로만 쓴다. */
export function readImageDimensions(
    mime: string,
    bytes: Uint8Array,
): { width: number; height: number } | null {
    const view = (offset: number, length: number, littleEndian = false): number => {
        let value = 0;
        for (let i = 0; i < length; i += 1) {
            const byte = bytes[offset + (littleEndian ? i : length - 1 - i)];
            value += byte * 256 ** i;
        }
        return value;
    };
    if (mime === 'image/png' && bytes.length >= 24) {
        return { width: view(16, 4), height: view(20, 4) };
    }
    if (mime === 'image/gif' && bytes.length >= 10) {
        return { width: view(6, 2, true), height: view(8, 2, true) };
    }
    if (mime === 'image/bmp' && bytes.length >= 26) {
        return { width: view(18, 4, true), height: view(22, 4, true) };
    }
    return null;
}

/** Word/Outlook 이 간격 확보용으로 넣는 1x1 투명 이미지인가. */
function isTinySpacerImage(el: Element, mime: string, bytes: Uint8Array): boolean {
    const w = parseInt(el.getAttribute('width') || '0', 10);
    const h = parseInt(el.getAttribute('height') || '0', 10);
    if (w > 0 && h > 0 && w <= 2 && h <= 2) return true;
    const intrinsic = readImageDimensions(mime, bytes);
    return !!intrinsic && intrinsic.width <= 2 && intrinsic.height <= 2;
}

/**
 * 본문 이미지 정리 — **모든** `<img>` 를 placeholder 로 바꾼다.
 *
 * 혼합 붙여넣기(텍스트+표+이미지)에서 이미지만 액박이 되던 원인이 여기였다.
 * 예전에는 data:image 만 업로드 대상으로 뽑고, http(s) 는 원본 주소를 그대로 남기고,
 * blob:/file:/cid: 는 조용히 지웠다. 그래서 "주소는 있는데 이 브라우저·이 사용자에게는
 * 열리지 않는 이미지"가 그대로 본문에 저장됐다.
 *
 * 이제는 어떤 형태든 `src` 를 떼어내고 ref 만 남긴다. 실제 바이트/주소를 확보하는 책임은
 * 호출자(RichDescriptionEditor)에게 있고, 확보하지 못한 ref 는 applyUploadedImages 가
 * 통째로 지운다 → 깨진 img 가 본문에 남을 수 없다.
 *
 * 여기서 바로 버리는 것은 "내용이 아닌 것"뿐이다: 1x1 추적/spacer 픽셀, 깨진 data URL,
 * 해석할 수 없는 주소(about:, javascript:, 외부 문서 기준 상대경로).
 */
function collectImages(root: Element): CollectImagesOutcome {
    const images: OfficePasteImage[] = [];
    const pending: PendingPasteImage[] = [];
    const byContent = new Map<string, OfficePasteImage>();
    const unrecoverable = 0;
    let duplicates = 0;
    let totalBytes = 0;
    let refSeq = 0;
    let order = 0;

    /** src 를 떼고 ref 만 남긴다. 이 시점 이후 본문에는 임시 주소가 존재하지 않는다. */
    const toPlaceholder = (img: Element, ref: string) => {
        [
            'src', 'srcset', 'data-canonical-src', 'data-origin', 'data-original',
            'data-src', 'data-lazy-src', 'data-noscript-src', 'data-noscript-srcset',
        ].forEach(name => img.removeAttribute(name));
        img.setAttribute('data-office-image-ref', ref);
    };

    Array.from(root.querySelectorAll('img')).forEach((img) => {
        const canonical = (img.getAttribute('data-canonical-src') || '').trim();
        const altText = (img.getAttribute('alt') || '').trim().toLowerCase();
        const declaredWidth = parseInt(img.getAttribute('width') || '0', 10);
        const declaredHeight = parseInt(img.getAttribute('height') || '0', 10);
        // 높이는 CSS(height:auto)가 결정한다. 폭만 상식적인 범위에서 유지해 원래
        // 크기감을 살린다.
        img.removeAttribute('height');
        if (!(declaredWidth > 0 && declaredWidth <= 1200)) img.removeAttribute('width');

        const currentOrder = order;
        order += 1;
        const candidates = imageSourceCandidates(img);

        const hasAlternateSource = [
            'data-origin', 'data-original', 'data-src', 'data-lazy-src',
            'srcset', 'data-noscript-src', 'data-noscript-srcset',
        ].some(name => !!img.getAttribute(name)?.trim());
        // lazy image 는 src placeholder 때문에 1x1 로 선언돼도 다른 속성에 실제 주소가 있다.
        if (isDeclaredSpacer(declaredWidth, declaredHeight) && !hasAlternateSource) {
            img.remove();
            return;
        }
        if (isDeclaredSpacer(declaredWidth, declaredHeight)) img.removeAttribute('width');

        // ── 이미 우리 서버에 저장된 이미지 — 재업로드 없이 주소만 옮긴다 ──
        // (우리 편집기에서 복사하면 src 는 임시 blob:, 실제 주소는 data-canonical-src 에 있다)
        const internal = internalImageUrl(canonical)
            || candidates.map(internalImageUrl).find(Boolean) || null;
        if (internal) {
            const ref = `office-image-${refSeq += 1}`;
            pending.push({ ref, kind: 'internal', url: internal, order: currentOrder });
            toPlaceholder(img, ref);
            return;
        }

        // data:image 는 공개 URL 보다 강한 자체 포함 바이트다. 속성 순서와 무관하게 먼저 본다.
        let spacerOnly = false;
        for (const src of candidates.filter(value => /^data:/i.test(value))) {
            const decoded = decodeDataUrlImage(src);
            if (!decoded) continue; // 깨진 data URL — 다음 후보로
            if (isTinySpacerImage(img, decoded.mime, decoded.bytes)) {
                // Word/Outlook 의 1x1 spacer, lazy-load placeholder — 내용이 아니다.
                spacerOnly = true;
                continue;
            }
            const contentKey = imageContentKey(decoded.bytes);
            let entry = byContent.get(contentKey);
            if (entry) {
                duplicates += 1;
            } else {
                entry = {
                    ref: `office-image-${refSeq += 1}`,
                    mime: decoded.mime,
                    bytes: decoded.bytes,
                    contentKey,
                    order: currentOrder,
                };
                byContent.set(contentKey, entry);
                images.push(entry);
                totalBytes += decoded.bytes.length;
            }
            toPlaceholder(img, entry.ref);
            return;
        }

        const remoteCandidates = candidates.filter(src => /^https?:\/\//i.test(src));
        if (remoteCandidates.length > 0) {
            const src = remoteCandidates[0];
            const hints = imageSourceHints(src);
            if (!hints.nameHint && /\.[a-z0-9]{2,5}$/i.test(altText)) hints.nameHint = altText;
            const ref = `office-image-${refSeq += 1}`;
            pending.push({
                ref,
                kind: 'remote',
                url: src,
                fallbackUrls: remoteCandidates.slice(1),
                order: currentOrder,
                ...hints,
            });
            toPlaceholder(img, ref);
            return;
        }

        // blob: / file: / cid: — 주소로는 못 가져오지만 clipboard 에 바이트가 왔을 수 있다.
        for (const src of candidates) {
            const reason = binaryOnlyReason(src);
            if (reason) {
                const hints = imageSourceHints(src);
                if (!hints.nameHint && /\.[a-z0-9]{2,5}$/i.test(altText)) hints.nameHint = altText;
                const ref = `office-image-${refSeq += 1}`;
                pending.push({ ref, kind: 'binary', url: src, reason, order: currentOrder, ...hints });
                toPlaceholder(img, ref);
                return;
            }
        }

        // src가 없거나 깨진/상대 주소뿐이어도 Clipboard/RTF에 별도 바이너리가 있을 수
        // 있다. 모든 img 위치를 placeholder로 보존한 뒤, 실제 바이트가 끝내 없을 때만
        // 그 자리 하나를 제거한다. spacer뿐인 경우는 내용이 아니므로 즉시 버린다.
        if (!spacerOnly) {
            const ref = `office-image-${refSeq += 1}`;
            const fallbackHints = candidates.length > 0 ? imageSourceHints(candidates[0]) : {};
            if (!fallbackHints.nameHint && /\.[a-z0-9]{2,5}$/i.test(altText)) {
                fallbackHints.nameHint = altText;
            }
            pending.push({
                ref,
                kind: 'binary',
                url: candidates[0] || '',
                reason: 'clipboard-only',
                order: currentOrder,
                ...fallbackHints,
            });
            toPlaceholder(img, ref);
            return;
        }
        img.remove();
    });

    return { images, pending, unrecoverable, duplicates, totalBytes };
}

/**
 * 링크 정리.
 * Word 는 목차 앵커(`#_Toc…`)나 로컬 파일 링크(`file:///…`)도 함께 보낸다. 저장되지 않을
 * href 는 앵커를 풀어 텍스트만 남기고, 살아남는 링크에는 새 탭 속성을 붙인다.
 */
function normalizeAnchors(root: Element): void {
    Array.from(root.querySelectorAll('a')).forEach((anchor) => {
        const url = normalizeLinkUrl(anchor.getAttribute('href'));
        Array.from(anchor.attributes).forEach((attr) => {
            if (!['href', 'target', 'rel'].includes(attr.name.toLowerCase())) {
                anchor.removeAttribute(attr.name);
            }
        });
        if (!url) {
            anchor.replaceWith(...Array.from(anchor.childNodes));
            return;
        }
        anchor.setAttribute('href', url);
        anchor.setAttribute('target', '_blank');
        anchor.setAttribute('rel', 'noopener noreferrer');
    });
}

const PRESERVE_WHITESPACE_TAGS = new Set(['PRE', 'CODE', 'TEXTAREA']);

/**
 * 태그 사이 줄바꿈/들여쓰기 제거 + 텍스트 내부 공백 축약.
 *
 * Description 에디터는 legacy plain text 를 위해 `white-space: pre-wrap` 이다.
 * Word 가 예쁘게 줄바꿈해 보낸 HTML 을 그대로 넣으면 그 줄바꿈이 전부 빈 줄로 보인다.
 */
function normalizeWhitespace(root: Element, isOffice: boolean): void {
    const doc = root.ownerDocument;
    const walker = doc.createTreeWalker(root, 4 /* NodeFilter.SHOW_TEXT */);
    const textNodes: Text[] = [];
    while (walker.nextNode()) textNodes.push(walker.currentNode as Text);

    textNodes.forEach((node) => {
        const parent = node.parentElement;
        if (parent && parent.closest('pre,code,textarea')) return;
        if (parent && PRESERVE_WHITESPACE_TAGS.has(parent.tagName)) return;
        let text = node.data;
        // 개행/탭은 Description 안에서 의미가 없다(문단 구분은 블록 태그가 한다).
        text = text.replace(/[\r\n\t]+/g, ' ').replace(/ {2,}/g, ' ');
        if (isOffice) {
            // Word 는 들여쓰기를 nbsp 로 채운다. 2개 이상 연속이면 레이아웃 잔재로 본다.
            text = text.replace(/\u00a0{2,}/g, ' ');
        }
        if (isBlankText(text)) {
            // 공백만 남은 노드: 블록 사이면 삭제, 인라인 사이면 공백 1칸.
            const prev = node.previousSibling;
            const next = node.nextSibling;
            const between = (n: Node | null) =>
                !n || (n.nodeType === 1 && isBlockElement(n as Element));
            if (between(prev) || between(next)) {
                node.remove();
                return;
            }
            node.data = ' ';
            return;
        }
        node.data = text;
    });
}

const BLOCK_TAGS = new Set([
    'P', 'DIV', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'UL', 'OL', 'LI',
    'TABLE', 'THEAD', 'TBODY', 'TFOOT', 'TR', 'TD', 'TH', 'BLOCKQUOTE',
    'PRE', 'HR', 'BR', 'SECTION', 'ARTICLE', 'CENTER', 'FIGURE',
]);

function isBlockElement(el: Element): boolean {
    return BLOCK_TAGS.has(el.tagName.toUpperCase());
}

function isBlankText(value: string): boolean {
    return !/\S/.test(value || '');
}

/** 시각적으로 아무것도 없는 요소인가(빈 문단·빈 셀 판정의 공통 규칙). */
function isVisuallyEmpty(el: Element): boolean {
    if (el.querySelector(CONTENT_ELEMENTS)) return false;
    return isBlankText(el.textContent || '');
}

// ────────────────────────────── 표 ──────────────────────────────

interface GridCell {
    el: HTMLTableCellElement;
    row: number;
    col: number;
    colSpan: number;
    rowSpan: number;
}

function ownRows(table: Element): HTMLTableRowElement[] {
    return Array.from(table.querySelectorAll('tr'))
        .filter((row) => row.closest('table') === table) as HTMLTableRowElement[];
}

function ownCells(row: Element): HTMLTableCellElement[] {
    return Array.from(row.children)
        .filter((c) => c.tagName === 'TD' || c.tagName === 'TH') as HTMLTableCellElement[];
}

/** rowspan/colspan 을 펼친 좌표 격자. 잘못 지우는 사고를 막기 위한 근거 자료. */
function buildGrid(rows: HTMLTableRowElement[]): { grid: (GridCell | null)[][]; columns: number } {
    const grid: (GridCell | null)[][] = rows.map(() => []);
    let columns = 0;
    rows.forEach((row, r) => {
        let c = 0;
        ownCells(row).forEach((cell) => {
            while (grid[r][c]) c += 1;
            const colSpan = Math.max(1, Math.min(64, parseInt(cell.getAttribute('colspan') || '1', 10) || 1));
            const rowSpan = Math.max(1, Math.min(64, parseInt(cell.getAttribute('rowspan') || '1', 10) || 1));
            const entry: GridCell = { el: cell, row: r, col: c, colSpan, rowSpan };
            for (let dr = 0; dr < rowSpan && r + dr < rows.length; dr += 1) {
                for (let dc = 0; dc < colSpan; dc += 1) {
                    grid[r + dr][c + dc] = entry;
                }
            }
            c += colSpan;
            columns = Math.max(columns, c);
        });
    });
    return { grid, columns };
}

/**
 * 표 정리.
 * - 모든 셀이 비어 있고 병합에 관여하지 않는 행·열만 spacer 로 보고 제거한다.
 * - 1행 1열짜리 표는 Word 의 레이아웃 껍데기이므로 내용만 남긴다.
 * - 내용이 하나도 없는 표는 통째로 제거한다.
 *
 * 색/테두리는 sanitizer 가 어차피 지우므로 판정 근거로 쓰지 않는다. 즉 "빈 회색 띠"는
 * Description 에서 빈 공간일 뿐이라 제거 대상이다.
 */
function cleanTables(root: Element, stats: OfficePasteStats): void {
    // 문서 순서의 역순 = 중첩된 안쪽 표부터 처리.
    const tables = Array.from(root.querySelectorAll('table')).reverse();
    stats.tableCount = tables.length;

    tables.forEach((table) => {
        if (!table.isConnected) return;
        const rows = ownRows(table);
        if (rows.length === 0) {
            if (isVisuallyEmpty(table)) {
                table.remove();
                stats.removedEmptyTables += 1;
            }
            return;
        }
        const { grid, columns } = buildGrid(rows);

        // ── 빈 열 제거 ──
        const removableColumns: number[] = [];
        for (let c = 0; c < columns; c += 1) {
            let removable = columns > 1;
            for (let r = 0; r < rows.length && removable; r += 1) {
                const cell = grid[r][c];
                if (!cell) continue; // 격자 구멍은 판단 근거가 없다 → 유지
                if (cell.colSpan > 1 || cell.rowSpan > 1 || cell.col !== c) removable = false;
                else if (!isVisuallyEmpty(cell.el)) removable = false;
            }
            if (removable) removableColumns.push(c);
        }
        if (removableColumns.length < columns) {
            const removed = new Set<Element>();
            removableColumns.forEach((c) => {
                rows.forEach((_row, r) => {
                    const cell = grid[r][c];
                    if (cell && !removed.has(cell.el)) {
                        removed.add(cell.el);
                        cell.el.remove();
                    }
                });
            });
            stats.removedSpacerColumns += removableColumns.length;
        }

        // ── 빈 행 제거 ──
        rows.forEach((row, r) => {
            const cells = ownCells(row);
            if (cells.length === 0) {
                row.remove();
                stats.removedSpacerRows += 1;
                return;
            }
            const involvedInRowspan = grid[r].some(
                (cell) => cell && (cell.rowSpan > 1 || cell.row !== r),
            );
            if (involvedInRowspan) return;
            if (cells.every((cell) => isVisuallyEmpty(cell))) {
                row.remove();
                stats.removedSpacerRows += 1;
            }
        });

        // ── 레이아웃 껍데기(1행 1열) 풀기 ──
        const remainingRows = ownRows(table);
        if (remainingRows.length === 1) {
            const cells = ownCells(remainingRows[0]);
            if (cells.length === 1) {
                table.replaceWith(...Array.from(cells[0].childNodes));
                stats.unwrappedLayoutTables += 1;
                return;
            }
        }
        if (remainingRows.length === 0 || isVisuallyEmpty(table)) {
            table.remove();
            stats.removedEmptyTables += 1;
        }
    });
}

// ─────────────────────── 표 열 너비(원본 → 저장 계약) ───────────────────────

/**
 * 원본 표의 열 너비를 **이 앱의 저장 계약**(`<col data-col-width>`)으로 옮긴다.
 *
 * 왜 셀에 `width` 를 남기지 않는가:
 *   열 너비는 이미 사용자가 드래그로 조절할 수 있고(useDescriptionTableResize),
 *   그 값은 `data-col-width` 숫자 하나로만 저장·검증된다(FE/BE 공통). 붙여넣은 표만
 *   inline width 를 따로 쓰면 "드래그로 바꾼 너비"와 "원본 너비" 두 개의 진실이 생겨
 *   저장·재조회에서 어긋난다. 그래서 원본 너비도 같은 계약에 실어 준다 —
 *   붙여넣는 순간부터 드래그·자동 맞춤·초기화가 전부 그대로 동작한다.
 *
 * 열이 삭제될 수 있으므로(빈 spacer 열 정리) 계산은 두 단계다:
 *   ① 정리 **전**: 각 열의 시작 셀에 원본 너비를 임시 속성으로 적어 둔다.
 *   ② 정리 **후**: 살아남은 첫 행에서 다시 읽어 colgroup 을 만든다.
 */
const SOURCE_COL_WIDTH_ATTR = 'data-source-col-width';
/** 백분율 너비를 px 로 옮길 때 기준으로 삼는 편집 영역 폭(대략치). */
const NOMINAL_EDITOR_WIDTH_PX = 720;

function parseWidthPx(value: string | null | undefined, total = NOMINAL_EDITOR_WIDTH_PX): number | null {
    const raw = (value || '').trim();
    if (!raw) return null;
    const percent = /^(\d+(?:\.\d+)?)\s*%$/.exec(raw);
    if (percent) return (parseFloat(percent[1]) / 100) * total;
    const px = parseLengthPx(raw);
    return px !== null && px > 0 ? px : null;
}

/** `<col>`/셀에서 열 너비를 읽어 열 시작 셀에 임시로 적어 둔다(정리 전에 실행). */
function markSourceColumnWidths(root: Element): void {
    Array.from(root.querySelectorAll('table')).forEach((table) => {
        const widths: (number | null)[] = [];
        let index = 0;
        Array.from(table.querySelectorAll('col')).forEach((col) => {
            if (col.closest('table') !== table) return;
            const span = Math.max(1, Math.min(64, parseInt(col.getAttribute('span') || '1', 10) || 1));
            const style = col.getAttribute('style') || '';
            // 이 앱의 편집기(Description · 작업노트 · 메모)에서 온 표는 저장 계약 숫자를 그대로 믿는다.
            // 저장본을 그대로 복사한 HTML(작업노트 '전체 복사' 등)에는 inline width 가 없다.
            const width = clampColWidth(col.getAttribute(COL_WIDTH_ATTR))
                ?? parseWidthPx(/(?:^|;)\s*width\s*:\s*([^;]+)/i.exec(style)?.[1])
                ?? parseWidthPx(col.getAttribute('width'));
            for (let i = 0; i < span; i += 1) {
                widths[index] = width;
                index += 1;
            }
        });

        const rows = ownRows(table);
        if (rows.length === 0) return;
        // `<col>` 이 없으면 셀의 선언 폭을 쓴다(Word/웹 표가 이렇게 온다). 병합(colspan) 셀은 열 하나의
        // 폭이 아니므로 건너뛰고, 그 열은 **다른 행의 병합 안 된 셀**에서 채운다 — 첫 행에 병합 머리글이
        // 있는 표(흔한 Word 표)도 열 너비·표 위치가 살아난다.
        const { grid } = buildGrid(rows);
        grid.forEach((row) => row.forEach((entry, column) => {
            if (!entry || entry.colSpan !== 1 || entry.col !== column || widths[column] != null) return;
            const style = entry.el.getAttribute('style') || '';
            widths[column] = parseWidthPx(/(?:^|;)\s*width\s*:\s*([^;]+)/i.exec(style)?.[1])
                ?? parseWidthPx(entry.el.getAttribute('width'));
        }));

        rows.forEach((row) => {
            let column = 0;
            ownCells(row).forEach((cell) => {
                const colSpan = Math.max(1, Math.min(64, parseInt(cell.getAttribute('colspan') || '1', 10) || 1));
                const width = colSpan === 1 ? widths[column] : null;
                if (width != null) cell.setAttribute(SOURCE_COL_WIDTH_ATTR, String(Math.round(width)));
                column += colSpan;
            });
        });
    });
}

/**
 * 남은 표에 `<colgroup><col data-col-width>` 를 만들어 준다(정리 후에 실행).
 * 모든 열의 너비를 알 때만 적용한다 — 일부만 아는 fixed 레이아웃은 원본보다 나쁘다.
 */
function applySourceColumnWidths(root: Element): void {
    Array.from(root.querySelectorAll('table')).forEach((table) => {
        const rows = ownRows(table);
        const columns = rows.length > 0 ? buildGrid(rows).columns : 0;
        const widths: (number | null)[] = new Array(columns).fill(null);
        rows.forEach((row) => {
            let column = 0;
            ownCells(row).forEach((cell) => {
                const colSpan = Math.max(1, Math.min(64, parseInt(cell.getAttribute('colspan') || '1', 10) || 1));
                const declared = parseInt(cell.getAttribute(SOURCE_COL_WIDTH_ATTR) || '', 10);
                if (colSpan === 1 && Number.isFinite(declared) && widths[column] == null) {
                    widths[column] = declared;
                }
                column += colSpan;
            });
        });

        const complete = columns > 0 && widths.every((width) => width != null);
        if (complete) {
            const clamped = widths.map((width) => Math.max(
                TABLE_SIZING_LIMITS.minColWidth,
                Math.min(TABLE_SIZING_LIMITS.maxColWidth, Math.round(width as number)),
            ));
            const doc = table.ownerDocument;
            Array.from(table.querySelectorAll('colgroup')).forEach((group) => {
                if (group.closest('table') === table) group.remove();
            });
            const colgroup = doc.createElement('colgroup');
            clamped.forEach((width) => {
                const col = doc.createElement('col');
                col.setAttribute(COL_WIDTH_ATTR, String(width));
                colgroup.appendChild(col);
            });
            table.insertBefore(colgroup, table.firstChild);
            // 저장 계약상 "지정된 열 너비를 가진 표" 표시. 편집기가 이 값을 다시 px 로 펼치고,
            // 편집 폭보다 넓으면 표만 가로 스크롤한다(문단·이미지는 제자리).
            table.setAttribute(RESIZABLE_TABLE_ATTR, 'true');
        }
        Array.from(table.querySelectorAll(`[${SOURCE_COL_WIDTH_ATTR}]`)).forEach((cell) => {
            cell.removeAttribute(SOURCE_COL_WIDTH_ATTR);
        });
    });
}

// ─────────────────────── 표 셀 서식(배경색·정렬·굵기) ───────────────────────

/**
 * 왜 이 단계가 필요한가:
 *   Excel 은 셀 서식을 `<style>` 블록의 클래스(`.xl65 {background:#FFFF00}`)로 보낸다.
 *   우리는 `<style>` 을 통째로 버리므로(스크립트/폰트/페이지 레이아웃 유입 차단), 그
 *   전에 **표에 필요한 세 가지만** 뽑아 인라인으로 옮겨 두어야 색·정렬·굵기가 살아남는다.
 *
 * 왜 세 가지뿐인가:
 *   Description 은 문서가 아니다. 폰트·테두리·행 높이·열 너비까지 재현하면 편집기
 *   레이아웃이 원본 문서에 끌려간다(그래서 나머지는 stripLayoutStyles 가 지운다).
 *   여기서 살리는 것은 "내용의 의미"가 담기는 값뿐이다 — 강조 배경, 정렬, 굵기.
 */
export interface CellStyleRules {
    /** 클래스 이름(소문자) → 선언. */
    byClass: Map<string, CellStyleDecls>;
    /** 태그 이름(소문자) → 선언. */
    byTag: Map<string, CellStyleDecls>;
}

export interface CellStyleDecls {
    background?: string;
    color?: string;
    textAlign?: string;
    verticalAlign?: string;
    fontStyle?: string;
    textDecoration?: string;
    /** border, border-top/right/bottom/left → 정규화된 값. */
    border?: Partial<Record<'all' | 'top' | 'right' | 'bottom' | 'left', string>>;
    bold?: boolean;
}

const EXCLUDED_COLOR_KEYWORDS = new Set([
    'transparent', 'inherit', 'initial', 'unset', 'none', 'auto', 'currentcolor', 'windowtext',
]);

/** 저장까지 살아남을 수 있는 색 표기만. (sanitizer 가 뒤에서 한 번 더 검증한다) */
export function safeCssColor(value?: string | null): string | null {
    const raw = (value || '').trim().toLowerCase().replace(/\s*!important$/, '');
    if (!raw || EXCLUDED_COLOR_KEYWORDS.has(raw)) return null;
    if (/^#[0-9a-f]{3}$/.test(raw) || /^#[0-9a-f]{6}$/.test(raw)) return raw;
    if (/^rgba?\(\s*[\d.]+\s*,\s*[\d.]+\s*,\s*[\d.]+\s*(?:,\s*[\d.]+\s*)?\)$/.test(raw)) {
        return raw.replace(/\s+/g, '');
    }
    if (/^[a-z]{3,20}$/.test(raw)) return raw; // yellow, white … CSS 이름 색
    return null;
}

/** `background: #FFFF00 none repeat` 같은 축약형에서 색만. */
function colorFromShorthand(value?: string | null): string | null {
    const tokens = (value || '').trim().split(/\s+/);
    for (const token of tokens) {
        const color = safeCssColor(token);
        if (color) return color;
    }
    // rgb(...) 는 공백으로 쪼개지므로 통째로 한 번 더 본다.
    return safeCssColor(value);
}

export function safeTextAlign(value?: string | null): string | null {
    const raw = (value || '').trim().toLowerCase().replace(/\s*!important$/, '');
    if (['left', 'center', 'right', 'justify'].includes(raw)) return raw;
    // Excel 전용 값 — 버리면 왼쪽으로 보인다(가운데 정렬 표가 일부 왼쪽으로 바뀌던 원인).
    //   centerAcross / center-across = '선택 영역의 가운데로', distributed = '균등 분할'.
    if (/^center-?across(?:-?selection)?$/.test(raw) || raw === 'distributed') return 'center';
    return null;
}

export function safeVerticalAlign(value?: string | null): string | null {
    const raw = (value || '').trim().toLowerCase().replace(/\s*!important$/, '');
    return ['top', 'middle', 'bottom', 'baseline'].includes(raw) ? raw : null;
}

const BORDER_STYLE_KEYWORDS = ['none', 'hidden', 'solid', 'dashed', 'dotted', 'double'];
/** 테두리 굵기 상한 — 원본을 살리되 편집기를 뒤덮지는 않게. */
const MAX_BORDER_WIDTH_PX = 5;

/**
 * `.5pt solid windowtext` → `1px solid` 처럼 **안전한 값만** 남긴다.
 * 길이는 px 로 환산하고, 해석할 수 없는 색(windowtext 등 시스템 색)은 뺀다
 * (색을 빼면 글자색을 따라가므로 원본과 가장 가깝다).
 */
export function safeBorderValue(value?: string | null): string | null {
    const raw = (value || '').trim().toLowerCase().replace(/\s*!important$/, '');
    if (!raw) return null;
    if (raw === 'none' || raw === '0' || raw === 'hidden') return 'none';
    let width: number | null = null;
    let style: string | null = null;
    let color: string | null = null;
    for (const token of raw.split(/\s+/)) {
        if (!token) continue;
        if (BORDER_STYLE_KEYWORDS.includes(token)) {
            style = token;
            continue;
        }
        const px = parseLengthPx(token);
        if (px !== null && width === null) {
            width = Math.max(0, Math.min(MAX_BORDER_WIDTH_PX, Math.round(px)));
            continue;
        }
        if (color === null) color = safeCssColor(token);
    }
    if (style === 'none' || style === 'hidden') return 'none';
    if (width === 0) return 'none';
    if (!style && width === null) return null;
    const parts = [`${width ?? 1}px`, style || 'solid'];
    if (color) parts.push(color);
    return parts.join(' ');
}

function isBoldWeight(value?: string | null): boolean {
    const raw = (value || '').trim().toLowerCase();
    if (raw === 'bold' || raw === 'bolder') return true;
    const numeric = parseInt(raw, 10);
    return Number.isFinite(numeric) && numeric >= 600;
}

const BORDER_SIDES: Record<string, 'top' | 'right' | 'bottom' | 'left'> = {
    'border-top': 'top',
    'border-right': 'right',
    'border-bottom': 'bottom',
    'border-left': 'left',
};

/** 선언 문자열(`a:b; c:d`) → 표에서 살릴 수 있는 값만. */
function parseCellDecls(cssText: string): CellStyleDecls {
    const decls: CellStyleDecls = {};
    (cssText || '').split(';').forEach((part) => {
        const index = part.indexOf(':');
        if (index < 0) return;
        const name = part.slice(0, index).trim().toLowerCase();
        const value = part.slice(index + 1).trim();
        if (name === 'background-color' || name === 'background') {
            const color = name === 'background' ? colorFromShorthand(value) : safeCssColor(value);
            if (color) decls.background = color;
        } else if (name === 'color') {
            const color = safeCssColor(value);
            if (color) decls.color = color;
        } else if (name === 'text-align') {
            const align = safeTextAlign(value);
            if (align) decls.textAlign = align;
        } else if (name === 'vertical-align') {
            const align = safeVerticalAlign(value);
            if (align) decls.verticalAlign = align;
        } else if (name === 'font-style') {
            if (/^(?:italic|oblique)$/i.test(value.trim())) decls.fontStyle = 'italic';
        } else if (name === 'text-decoration' || name === 'text-decoration-line') {
            const decoration = /line-through/i.test(value)
                ? 'line-through'
                : /underline/i.test(value) ? 'underline' : null;
            if (decoration) decls.textDecoration = decoration;
        } else if (name === 'font-weight') {
            if (isBoldWeight(value)) decls.bold = true;
        } else if (name === 'border' || BORDER_SIDES[name]) {
            const border = safeBorderValue(value);
            if (border) {
                decls.border = { ...(decls.border || {}), [BORDER_SIDES[name] || 'all']: border };
            }
        }
    });
    return decls;
}

/**
 * 문서의 `<style>` 블록에서 표 셀 서식만 뽑는다.
 * 정규식 파서다 — CSS 를 구현하는 것이 목적이 아니라 Excel/Word 가 실제로 쓰는
 * `.xl65 { … }` / `td { … }` 형태만 읽으면 된다. 해석하지 못한 규칙은 그냥 버린다.
 */
export function extractCellStyleRules(doc: Document): CellStyleRules {
    const byClass = new Map<string, CellStyleDecls>();
    const byTag = new Map<string, CellStyleDecls>();
    const merge = (map: Map<string, CellStyleDecls>, key: string, decls: CellStyleDecls) => {
        if (!hasCellFormatting(decls)) return;
        map.set(key, { ...(map.get(key) || {}), ...decls });
    };

    Array.from(doc.querySelectorAll('style')).forEach((styleEl) => {
        // Office 는 규칙 전체를 <!-- --> 로 감싼다(첫 규칙 선택자가 깨지지 않게 벗긴다).
        const css = (styleEl.textContent || '').replace(/\/\*[\s\S]*?\*\//g, '').replace(/<!--|-->/g, '');
        const ruleRe = /([^{}]+)\{([^{}]*)\}/g;
        let match: RegExpExecArray | null;
        while ((match = ruleRe.exec(css)) !== null) {
            const selectorText = match[1].trim();
            // @media/@page 등의 블록은 건너뛴다(중첩 블록은 해석하지 않는다).
            if (!selectorText || selectorText.startsWith('@')) continue;
            const decls = parseCellDecls(match[2]);
            if (!hasCellFormatting(decls)) continue;
            selectorText.split(',').forEach((selector) => {
                const token = selector.trim().toLowerCase();
                const classMatch = /^(?:[a-z0-9]+)?\.([a-z0-9_-]+)$/.exec(token);
                if (classMatch) {
                    merge(byClass, classMatch[1], decls);
                    return;
                }
                if (/^(td|th|table|tr)$/.test(token)) merge(byTag, token, decls);
            });
        }
    });
    return { byClass, byTag };
}

function hasCellFormatting(decls: CellStyleDecls): boolean {
    return !!(
        decls.background || decls.color || decls.textAlign || decls.verticalAlign
        || decls.fontStyle || decls.textDecoration || decls.border || decls.bold
    );
}

/**
 * 저장되는 셀 `style` 의 허용 property — FE sanitizer(utils/taskDescription.ts)와
 * BE sanitizer(app/services/task_description.py)가 **같은 목록**을 써야 한다.
 * 한쪽만 넓으면 붙여넣은 직후에는 보이다가 저장 후 사라진다.
 */
export const CELL_STYLE_PROPERTIES = [
    'background-color', 'color', 'text-align', 'vertical-align',
    'font-style', 'text-decoration',
    'border', 'border-top', 'border-right', 'border-bottom', 'border-left',
] as const;

/** 셀 style 문자열 → 정책에 맞게 다시 쓴 문자열(허용 property + 검증된 값만). */
export function sanitizeCellStyleText(styleText?: string | null): string {
    return cellStyleText(parseCellDecls(styleText || ''));
}

/** 셀에 남길 선언 → `style` 문자열(FE/BE sanitizer 가 허용하는 property 만). */
export function cellStyleText(decls: CellStyleDecls): string {
    const parts: string[] = [];
    if (decls.background) parts.push(`background-color: ${decls.background}`);
    if (decls.color) parts.push(`color: ${decls.color}`);
    if (decls.textAlign) parts.push(`text-align: ${decls.textAlign}`);
    if (decls.verticalAlign) parts.push(`vertical-align: ${decls.verticalAlign}`);
    if (decls.fontStyle) parts.push(`font-style: ${decls.fontStyle}`);
    if (decls.textDecoration) parts.push(`text-decoration: ${decls.textDecoration}`);
    const border = decls.border || {};
    if (border.all) parts.push(`border: ${border.all}`);
    (['top', 'right', 'bottom', 'left'] as const).forEach((side) => {
        if (border[side]) parts.push(`border-${side}: ${border[side]}`);
    });
    return parts.join('; ');
}

/**
 * 표 셀 서식을 인라인으로 고정한다(배경색·글자색·정렬·세로정렬·기울임·밑줄·테두리·굵기).
 *
 * 우선순위는 CSS 와 같다: 태그 규칙 < 클래스 규칙 < 표현용 속성 < 인라인 style.
 * 굵기는 style 로 남기지 않고 `<strong>` 으로 감싼다 — sanitizer 정책을 바꾸지 않고도
 * 저장·재조회까지 그대로 살아남는 유일한 표현이기 때문이다.
 *
 * 일부러 가져오지 않는 것: 폭·높이·padding·white-space·폰트.
 * 폭은 `<col data-col-width>` 계약이 따로 담고, 나머지는 원본 문서의 레이아웃 잔재라
 * Description 안에서 빈 공간·잘림을 만든다(이 파이프라인이 생긴 이유가 그것이다).
 */
function applyCellFormatting(root: Element, rules: CellStyleRules): void {
    Array.from(root.querySelectorAll('th,td')).forEach((cell) => {
        // 태그 규칙(`td { … }`)은 사용자의 선택이 아니라 문서 기본값이다. Excel 은 여기에
        // 언제나 `border:none; color:black; white-space:nowrap` 을 넣는데, 그것을 그대로
        // 받으면 서식을 지정한 적 없는 표까지 테두리가 사라진다 → 강조 값만 받아들인다.
        const tagRule = rules.byTag.get(cell.tagName.toLowerCase());
        const decls: CellStyleDecls = tagRule
            ? { background: tagRule.background, bold: tagRule.bold }
            : {};
        (cell.getAttribute('class') || '').split(/\s+/).forEach((name) => {
            const fromClass = rules.byClass.get(name.trim().toLowerCase());
            if (fromClass) Object.assign(decls, fromClass);
        });
        const bgcolorAttr = safeCssColor(cell.getAttribute('bgcolor'));
        if (bgcolorAttr) decls.background = bgcolorAttr;
        const alignAttr = safeTextAlign(cell.getAttribute('align'));
        if (alignAttr) decls.textAlign = alignAttr;
        const valignAttr = safeVerticalAlign(cell.getAttribute('valign'));
        if (valignAttr) decls.verticalAlign = valignAttr;
        Object.assign(decls, parseCellDecls(cell.getAttribute('style') || ''));

        const style = cellStyleText(decls);
        if (style) cell.setAttribute('style', style);
        else cell.removeAttribute('style');

        if (decls.bold && /\S/.test(cell.textContent || '') && !cell.querySelector('b,strong')) {
            const strong = cell.ownerDocument.createElement('strong');
            while (cell.firstChild) strong.appendChild(cell.firstChild);
            cell.appendChild(strong);
        }
    });
}

// ────────────────────────────── 빈 블록 ──────────────────────────────

type ChildKind = 'blank-block' | 'content' | 'ignorable';

function classifyChild(node: Node): ChildKind {
    if (node.nodeType === 3) {
        return isBlankText((node as Text).data) ? 'ignorable' : 'content';
    }
    if (node.nodeType !== 1) return 'ignorable';
    const el = node as Element;
    const tag = el.tagName.toUpperCase();
    if (tag === 'BR') return 'ignorable';
    if (ALWAYS_DROP_WHEN_EMPTY.has(tag) && isVisuallyEmpty(el)) return 'blank-block';
    if (COLLAPSIBLE_BLOCK.has(tag) && isVisuallyEmpty(el)) return 'blank-block';
    return 'content';
}

/**
 * 빈 문단 정리.
 * - 셀 안, 그리고 앞이나 뒤에 내용이 없는 빈 문단은 전부 제거한다.
 * - 내용 사이의 연속된 빈 문단은 1개(`<p><br></p>`)로 줄인다.
 *   → 사용자가 의도한 빈 줄은 남고, Word 가 만든 레이아웃용 빈 문단은 사라진다.
 */
function collapseEmptyBlocks(root: Element, stats: OfficePasteStats): void {
    const visit = (parent: Element) => {
        Array.from(parent.children).forEach((child) => visit(child));

        const insideCell = parent.tagName === 'TD' || parent.tagName === 'TH'
            || !!parent.closest('td,th');
        const nodes = Array.from(parent.childNodes);
        const kinds = nodes.map(classifyChild);
        const hasContentBefore: boolean[] = [];
        const hasContentAfter: boolean[] = [];
        let seen = false;
        kinds.forEach((kind) => {
            hasContentBefore.push(seen);
            if (kind === 'content') seen = true;
        });
        seen = false;
        for (let i = kinds.length - 1; i >= 0; i -= 1) {
            hasContentAfter[i] = seen;
            if (kinds[i] === 'content') seen = true;
        }

        nodes.forEach((node, index) => {
            if (kinds[index] !== 'blank-block') return;
            const el = node as Element;
            const tag = el.tagName.toUpperCase();
            const isFirstOfRun = index === 0 || kinds[index - 1] !== 'blank-block';
            const keepAsBlankLine = !insideCell
                && !ALWAYS_DROP_WHEN_EMPTY.has(tag)
                && isFirstOfRun
                && hasContentBefore[index]
                && hasContentAfter[index];
            if (keepAsBlankLine) {
                if (tag === 'P') {
                    el.innerHTML = '<br>';
                } else {
                    const p = el.ownerDocument.createElement('p');
                    p.innerHTML = '<br>';
                    el.replaceWith(p);
                }
                return;
            }
            el.remove();
            stats.removedEmptyBlocks += 1;
        });
    };
    visit(root);
}

/** `<br>` 이 3개 이상 이어지면 빈 줄 1개 분량(2개)까지만 남긴다. */
function collapseBrRuns(root: Element): void {
    Array.from(root.querySelectorAll('br')).forEach((br) => {
        if (!br.isConnected) return;
        let run = 1;
        let cursor: Node | null = br.nextSibling;
        const extra: Element[] = [];
        while (cursor) {
            if (cursor.nodeType === 3 && isBlankText((cursor as Text).data)) {
                cursor = cursor.nextSibling;
                continue;
            }
            if (cursor.nodeType === 1 && (cursor as Element).tagName === 'BR') {
                run += 1;
                if (run > 2) extra.push(cursor as Element);
                cursor = cursor.nextSibling;
                continue;
            }
            break;
        }
        extra.forEach((el) => el.remove());
    });
}

/** 고정 크기·절대 위치·페이지 여백 등 레이아웃 스타일과 속성을 제거한다. */
function stripLayoutStyles(root: Element): void {
    Array.from(root.querySelectorAll('*')).forEach((el) => {
        const tag = el.tagName.toUpperCase();
        LAYOUT_ATTRIBUTES.forEach((name) => {
            if (tag === 'IMG' && name === 'width') return; // 이미지 표시 크기는 유지
            el.removeAttribute(name);
        });
        const style = el.getAttribute('style');
        if (!style) return;
        if (tag === 'IMG') return; // 이미지 style width/height 는 sanitizer 가 판단
        const kept = style
            .split(';')
            .map((decl) => decl.trim())
            .filter((decl) => {
                if (!decl) return false;
                const name = decl.split(':')[0].trim().toLowerCase();
                if (name.startsWith('mso-')) return false;
                return !LAYOUT_STYLE_PROPERTIES.includes(name);
            });
        if (kept.length) el.setAttribute('style', kept.join('; '));
        else el.removeAttribute('style');
    });
}

// ─────────────────────── Word 목록 · 표 위치 · Excel 열/행 서식 ───────────────────────

const MSO_LIST_RE = /mso-list\s*:\s*l(\d+)\s+level(\d+)/i;
const MSO_LIST_IGNORE_SELECTOR = 'span[style*="mso-list"]';

function nextElementSkippingBlank(el: Element): Element | null {
    let node = el.nextSibling;
    while (node && ((node.nodeType === 3 && !(node.textContent || '').trim()) || node.nodeType === 8)) {
        node = node.nextSibling;
    }
    return node instanceof Element ? node : null;
}

function isWordListParagraph(el: Element | null): el is Element {
    return !!el && /^(P|H[1-6])$/.test(el.tagName) && MSO_LIST_RE.test(el.getAttribute('style') || '');
}

/** Word 가 붙인 번호/글머리 표식(`<span style='mso-list:Ignore'>1.</span>`)을 떼어 내고 그 글자를 돌려준다. */
function takeWordListMarker(paragraph: Element): string {
    let marker = '';
    paragraph.querySelectorAll(MSO_LIST_IGNORE_SELECTOR).forEach((span) => {
        if (!/mso-list\s*:\s*ignore/i.test(span.getAttribute('style') || '')) return;
        marker += span.textContent || '';
        let wrapper: Element | null = span.parentElement;
        span.remove();
        // 표식만 감싸던 빈 껍데기(span lang=…)도 지운다.
        while (wrapper && wrapper !== paragraph && !(wrapper.textContent || '').trim() && !wrapper.querySelector('img')) {
            const parent: Element | null = wrapper.parentElement;
            wrapper.remove();
            wrapper = parent;
        }
    });
    return marker.replace(/\s+/g, ' ').trim();
}

/** 번호 목록 표식인가(1. · 1) · (1) · a. · iv. · 가. · ①). 글머리 기호(·, •, o, §)는 아니다. */
function isOrderedMarker(marker: string): boolean {
    return /^[([]?(?:\d{1,3}|[a-z]|[ivxlcdm]{1,6}|[가-힣])[.)\]]$/i.test(marker)
        || /^\d{1,3}$/.test(marker) || /^[①-⑳]$/.test(marker);
}

/**
 * Word 의 "가짜 목록"(번호를 글자로 박은 문단 + mso-list 스타일)을 진짜 `<ol>/<ul>` 로 바꾼다.
 * 이대로 두면 번호가 본문 글자로 남고 들여쓰기가 사라진다. 수준(levelN)은 중첩 목록이 된다.
 * 문단의 class/style 은 목록 항목으로 옮긴다 — Word 규칙이 `li.MsoListParagraph…` 도 함께 적어
 * 보내므로 글자 크기·색 추출(officeTextRules)이 그대로 동작한다.
 */
export function convertWordLists(root: Element): void {
    const doc = root.ownerDocument;
    const done = new Set<Element>();
    Array.from(root.querySelectorAll('p, h1, h2, h3, h4, h5, h6')).forEach((first) => {
        if (done.has(first) || !isWordListParagraph(first)) return;
        const run: Element[] = [];
        for (let node: Element | null = first; isWordListParagraph(node); node = nextElementSkippingBlank(node)) {
            run.push(node);
            done.add(node);
        }
        type Level = { level: number; list: Element };
        const stack: Level[] = [];
        let listId = '';
        run.forEach((paragraph) => {
            const match = MSO_LIST_RE.exec(paragraph.getAttribute('style') || '')!;
            const level = Math.max(1, Math.min(9, Number(match[2]) || 1));
            const marker = takeWordListMarker(paragraph);
            const tag = isOrderedMarker(marker) ? 'ol' : 'ul';
            // 다른 목록(l0 → l1)이 이어 붙어 있으면 새 목록으로 시작한다.
            if (level === 1 && match[1] !== listId) stack.length = 0;
            listId = level === 1 ? match[1] : listId;
            while (stack.length && level < stack[stack.length - 1].level) stack.pop();
            if (!stack.length || level > stack[stack.length - 1].level) {
                const list = doc.createElement(tag);
                const start = /^\d{1,3}/.exec(marker);
                if (tag === 'ol' && start && Number(start[0]) > 1) list.setAttribute('start', start[0]);
                if (stack.length) {
                    const parent = stack[stack.length - 1].list;
                    const host = parent.lastElementChild || parent.appendChild(doc.createElement('li'));
                    host.appendChild(list);
                } else {
                    paragraph.before(list);
                }
                stack.push({ level, list });
            }
            const item = doc.createElement('li');
            const cls = paragraph.getAttribute('class');
            if (cls) item.setAttribute('class', cls);
            const style = (paragraph.getAttribute('style') || '').split(';')
                .filter((decl) => !/^\s*(?:mso-list|margin|text-indent)/i.test(decl)).join(';');
            if (style.trim()) item.setAttribute('style', style);
            const align = paragraph.getAttribute('align');
            if (align) item.setAttribute('align', align);
            item.append(...Array.from(paragraph.childNodes));
            // 제목(h1~h6) 목록은 굵기를 잃지 않도록 제목 태그를 항목 안에 남긴다.
            if (/^H[1-6]$/.test(paragraph.tagName)) {
                const heading = doc.createElement(paragraph.tagName.toLowerCase());
                heading.append(...Array.from(item.childNodes));
                item.appendChild(heading);
            }
            stack[stack.length - 1].list.appendChild(item);
            paragraph.remove();
        });
    });
}

/**
 * 표 **자체의 위치**(Word 가운데/오른쪽 정렬 표)를 `data-align` 으로 옮긴다 — 스타일·래퍼가
 * 지워지기 전에. 셀 안 글자 정렬(td data-align)과는 따로 저장된다.
 *   `<table align=center>` · `margin-left/right:auto` · Word 의 `<div align=center><table>` · `<center>`
 */
export function markTableAlignment(root: Element): void {
    Array.from(root.querySelectorAll('table')).forEach((table) => {
        const style = table.getAttribute('style') || '';
        const autoLeft = /(?:^|;)\s*margin-left\s*:\s*auto/i.test(style);
        const autoRight = /(?:^|;)\s*margin-right\s*:\s*auto/i.test(style);
        let align = (table.getAttribute('align') || '').trim().toLowerCase();
        if (!/^(center|right)$/.test(align)) align = autoLeft && autoRight ? 'center' : autoLeft ? 'right' : '';
        const parent = table.parentElement;
        if (!align && parent && parent !== root && /^(DIV|CENTER)$/.test(parent.tagName)
            && Array.from(parent.children).every((child) => child === table)) {
            const parentAlign = parent.tagName === 'CENTER' ? 'center'
                : (parent.getAttribute('align')
                    || /(?:^|;)\s*text-align\s*:\s*(\w+)/i.exec(parent.getAttribute('style') || '')?.[1] || '').toLowerCase();
            if (/^(center|right)$/.test(parentAlign)) {
                align = parentAlign;
                // 래퍼의 정렬은 '표 위치' 였다 — 남겨 두면 셀 글자까지 가운데로 물려받는다(Word 와 다르다).
                if (parent.tagName === 'CENTER') {
                    parent.replaceWith(...Array.from(parent.childNodes));
                } else {
                    parent.removeAttribute('align');
                    const rest = (parent.getAttribute('style') || '').split(';')
                        .filter((decl) => !/^\s*text-align\s*:/i.test(decl)).join(';');
                    if (rest.trim()) parent.setAttribute('style', rest); else parent.removeAttribute('style');
                }
            }
        }
        if (align) table.setAttribute('data-align', align);
    });
}

/**
 * Excel 의 열 서식(`<col class=xl66>`)·행 서식(`<tr class=xl67>`)을 **자기 서식이 없는 셀**에
 * 물려준다. 서식을 가진 셀(class 있음)은 Excel 에서도 자기 서식이 전부라 건드리지 않는다.
 * 빈 열 정리(cleanTables) 전에 실행해야 열 번호가 원본과 맞는다.
 */
export function inheritExcelColumnRowClasses(root: Element): void {
    Array.from(root.querySelectorAll('table')).forEach((table) => {
        const colClasses: (string | null)[] = [];
        Array.from(table.querySelectorAll('col')).forEach((col) => {
            if (col.closest('table') !== table) return;
            const span = Math.max(1, Math.min(64, parseInt(col.getAttribute('span') || '1', 10) || 1));
            for (let i = 0; i < span; i += 1) colClasses.push(col.getAttribute('class'));
        });
        const rows = ownRows(table);
        if (!rows.length) return;
        const { grid } = buildGrid(rows);
        rows.forEach((row, r) => {
            const rowClass = row.getAttribute('class');
            ownCells(row).forEach((cell) => {
                if (cell.getAttribute('class')) return;
                const place = grid[r].find((entry) => entry?.el === cell);
                const inherited = rowClass || (place ? colClasses[place.col] : null);
                if (inherited) cell.setAttribute('class', inherited);
            });
        });
    });
}

// ────────────────────────────── 진입점 ──────────────────────────────

const limitResult = (
    isOffice: boolean,
    limitExceeded: OfficePasteLimit,
    stats: OfficePasteStats,
): OfficePasteResult => ({
    isOffice,
    html: '',
    images: [],
    pendingImages: [],
    unrecoverableImageCount: 0,
    hasMeaningfulContent: false,
    limitExceeded,
    stats,
});

/**
 * 클립보드 HTML → Description 에 넣을 수 있는 반응형 HTML.
 *
 * 반환된 html 에는 Base64 가 없다. 이미지는 `images` 로 따로 나오고 본문에는
 * `<img data-office-image-ref="...">` placeholder 만 남으므로, 호출자가 업로드에
 * 성공한 뒤 내부 URL 로 바꿔 **한 번에** 삽입할 수 있다.
 */
export function normalizeOfficePasteHtml(html?: string | null): OfficePasteResult {
    const source = html || '';
    const isOffice = isOfficeHtml(source);
    const stats = emptyStats();

    if (!source.trim()) {
        return {
            isOffice, html: '', images: [], pendingImages: [], unrecoverableImageCount: 0,
            hasMeaningfulContent: false, limitExceeded: null, stats,
        };
    }
    if (source.length > OFFICE_PASTE_LIMITS.maxHtmlChars) {
        return limitResult(isOffice, 'html_size', stats);
    }

    const doc = parsePastedHtml(source);
    const body = doc.body;
    if (!body) {
        return {
            isOffice, html: '', images: [], pendingImages: [], unrecoverableImageCount: 0,
            hasMeaningfulContent: false, limitExceeded: null, stats,
        };
    }

    // `<style>` 과 `<col>` 은 곧 버려진다. 표 서식과 열 너비는 그 전에 건져 둔다.
    const cellStyleRules = extractCellStyleRules(doc);
    const textRules = officeTextRules(doc);
    markSourceColumnWidths(body);
    // 열 서식(<col class>)도 같은 이유로 지금 셀에 옮긴다(col 은 다음 단계에서 버려진다).
    inheritExcelColumnRowClasses(body);

    // noscript 는 곧 제거되므로 그 안의 실제 lazy-image 주소를 먼저 기존 img 후보로 옮긴다.
    promoteNoscriptImages(body);
    removeCommentNodes(body);
    dropDisallowedElements(body);
    // 스타일·정렬 래퍼·열 서식은 곧 정리된다 — 그 전에 목록·표 위치·열/행 서식을 옮겨 둔다.
    convertWordLists(body);
    markTableAlignment(body);

    stats.nodeCount = body.querySelectorAll('*').length;
    if (stats.nodeCount > OFFICE_PASTE_LIMITS.maxNodes) {
        return limitResult(isOffice, 'node_count', stats);
    }
    if (body.querySelectorAll('td,th').length > OFFICE_PASTE_LIMITS.maxTableCells) {
        return limitResult(isOffice, 'table_cells', stats);
    }

    normalizeRichText(body, { paste: true, rules: textRules });
    normalizeTableSpans(body);

    reorderAbsolutePositioned(body, stats);

    const imageOutcome = collectImages(body);
    if (imageOutcome.totalBytes > OFFICE_PASTE_LIMITS.maxImageBytes) {
        return limitResult(isOffice, 'image_bytes', stats);
    }
    stats.duplicateImageCount = imageOutcome.duplicates;

    normalizeAnchors(body);
    normalizeWhitespace(body, isOffice);
    cleanTables(body, stats);
    applyCellFormatting(body, cellStyleRules);
    applySourceColumnWidths(body);
    collapseEmptyBlocks(body, stats);
    collapseBrRuns(body);
    stripLayoutStyles(body);

    const hasMeaningfulContent = !isVisuallyEmpty(body);

    return {
        isOffice,
        html: hasMeaningfulContent ? body.innerHTML : '',
        images: imageOutcome.images,
        pendingImages: imageOutcome.pending,
        unrecoverableImageCount: imageOutcome.unrecoverable,
        hasMeaningfulContent,
        limitExceeded: null,
        stats,
    };
}

/**
 * 정규화 결과가 "이미지 한 장짜리"인지.
 * 웹페이지에서 이미지 하나만 복사하면 text/html 과 클립보드 이미지가 함께 온다.
 * 이때는 기존처럼 클립보드 이미지를 업로드하는 편이 안전하다(외부 URL 을 남기지 않음).
 */
export function isSingleImageHtml(result: OfficePasteResult): boolean {
    if (!result.hasMeaningfulContent) return false;
    const doc = new DOMParser().parseFromString(result.html, 'text/html');
    const body = doc.body;
    if (!body) return false;
    if (body.querySelectorAll('img').length !== 1) return false;
    if (body.querySelector('table')) return false;
    return isBlankText(body.textContent || '');
}

/**
 * Make placeholder refs unique to one editor paste transaction.
 *
 * The parser is intentionally deterministic, so separate calls start again at
 * `office-image-1`. Namespacing at the editor boundary prevents a late upload
 * from touching placeholders created by a later paste.
 */
export function namespaceOfficePasteImages(
    result: OfficePasteResult,
    namespace: string,
): OfficePasteResult {
    const prefix = (namespace || 'paste').replace(/[^a-z0-9_-]/gi, '-').slice(0, 80);
    const refMap = new Map<string, string>();
    const namespaced = (ref: string): string => {
        const existing = refMap.get(ref);
        if (existing) return existing;
        const next = `${prefix}-${ref}`;
        refMap.set(ref, next);
        return next;
    };
    const doc = new DOMParser().parseFromString(result.html || '', 'text/html');
    Array.from(doc.body?.querySelectorAll('img[data-office-image-ref]') || []).forEach((img) => {
        const ref = img.getAttribute('data-office-image-ref') || '';
        if (ref) img.setAttribute('data-office-image-ref', namespaced(ref));
    });
    return {
        ...result,
        html: doc.body?.innerHTML || result.html,
        images: result.images.map(image => ({ ...image, ref: namespaced(image.ref) })),
        pendingImages: result.pendingImages.map(image => ({ ...image, ref: namespaced(image.ref) })),
    };
}

// ─────────────────── 이미지 자리 표식(삽입을 이미지보다 먼저 하기 위한 장치) ───────────────────
//
// 텍스트·표는 이미지 업로드를 기다리지 않고 **먼저** 삽입해야 한다. 그런데 삽입 전에
// 거치는 sanitizer 는 "src 가 없거나 임시 주소인 img" 를 지우도록 되어 있다(저장 안전).
// 그래서 sanitizer 를 지나는 동안에는 이미지 자리를 **텍스트 표식**으로 바꿔 둔다 —
// sanitizer 는 텍스트를 건드리지 않으므로 자리와 순서가 그대로 살아남는다.
// (sanitizer 에 예외를 뚫지 않는다: 예외를 뚫으면 그 예외가 저장까지 흘러간다)

const SENTINEL_OPEN = '\uE000';
const SENTINEL_CLOSE = '\uE001';

/** 이미지 자리 → 텍스트 표식. 반환된 refs 의 순서가 곧 본문 등장 순서다. */
export function extractImagePlaceholders(html: string): { html: string; refs: string[] } {
    const doc = new DOMParser().parseFromString(html || '', 'text/html');
    const body = doc.body;
    if (!body) return { html: html || '', refs: [] };
    const refs: string[] = [];
    Array.from(body.querySelectorAll('img[data-office-image-ref]')).forEach((img) => {
        const ref = img.getAttribute('data-office-image-ref') || '';
        const index = refs.length;
        refs.push(ref);
        // alt 는 복원할 때 되살린다(원본이 준 설명을 잃지 않기 위해).
        const alt = img.getAttribute('alt') || '';
        const marker = doc.createTextNode(`${SENTINEL_OPEN}${index}|${alt}${SENTINEL_CLOSE}`);
        img.replaceWith(marker);
    });
    return { html: body.innerHTML, refs };
}

/**
 * 텍스트 표식 → 업로드 대기 `<img>`.
 *
 * `acceptedRefs` 에 없는 자리(개수 상한 초과)는 표식만 지우고 이미지를 만들지 않는다.
 * 만들어진 img 는 임시 src 를 쓰므로 sanitizer 를 다시 지나면 사라진다 —
 * 즉 업로드 중에 저장해도 깨진 이미지가 저장되지 않는다.
 */
export function restoreImagePlaceholders(
    html: string,
    refs: string[],
    acceptedRefs: Set<string>,
    pendingSrc: string,
): string {
    const doc = new DOMParser().parseFromString(html || '', 'text/html');
    const body = doc.body;
    if (!body) return html || '';
    const walker = doc.createTreeWalker(body, 4 /* SHOW_TEXT */);
    const textNodes: Text[] = [];
    while (walker.nextNode()) textNodes.push(walker.currentNode as Text);

    const pattern = /\uE000(\d+)\|([^\uE001]*)\uE001/g;
    textNodes.forEach((node) => {
        const text = node.data;
        if (!text.includes(SENTINEL_OPEN)) return;
        const fragment = doc.createDocumentFragment();
        let cursor = 0;
        let match: RegExpExecArray | null;
        pattern.lastIndex = 0;
        while ((match = pattern.exec(text)) !== null) {
            if (match.index > cursor) {
                fragment.appendChild(doc.createTextNode(text.slice(cursor, match.index)));
            }
            cursor = match.index + match[0].length;
            const ref = refs[Number(match[1])];
            if (!ref || !acceptedRefs.has(ref)) continue; // 자리만 없앤다
            const img = doc.createElement('img');
            img.setAttribute('src', pendingSrc);
            img.setAttribute('data-office-image-ref', ref);
            img.setAttribute('data-upload-state', 'pending');
            img.setAttribute('alt', match[2] || '이미지를 가져오는 중');
            fragment.appendChild(img);
        }
        if (cursor < text.length) fragment.appendChild(doc.createTextNode(text.slice(cursor)));
        node.replaceWith(fragment);
    });
    return body.innerHTML;
}

/**
 * placeholder 를 실제 이미지 URL 로 바꾸고, 확보하지 못한 이미지는 자리째 지운다.
 *
 * 여기서 지워지는 자리가 곧 "액박이 될 뻔한 이미지"다. 임시 주소(blob:/file:/cid:)나
 * 열리지 않는 외부 주소는 이 단계를 통과할 수 없다 — 지도에 없으면 남지 않는다.
 */
export function applyUploadedImages(
    html: string,
    uploadedByRef: Map<string, string>,
): { html: string; droppedImageCount: number } {
    const doc = new DOMParser().parseFromString(html || '', 'text/html');
    const body = doc.body;
    if (!body) return { html: html || '', droppedImageCount: 0 };
    let dropped = 0;
    Array.from(body.querySelectorAll('img[data-office-image-ref]')).forEach((img) => {
        const ref = img.getAttribute('data-office-image-ref') || '';
        const url = uploadedByRef.get(ref);
        img.removeAttribute('data-office-image-ref');
        if (!url) {
            img.remove();
            dropped += 1;
            return;
        }
        img.setAttribute('src', url);
        if (!img.getAttribute('alt')) img.setAttribute('alt', '붙여넣은 이미지');
    });
    // 이미지가 빠지면서 껍데기만 남은 블록을 한 번 더 정리한다.
    const stats = emptyStats();
    collapseEmptyBlocks(body, stats);
    return { html: body.innerHTML, droppedImageCount: dropped };
}

/** 한도 초과 사유별 사용자 안내. */
export function officePasteLimitMessage(limit: OfficePasteLimit): string {
    const reason = limit === 'image_bytes'
        ? '이미지 용량이 너무 큽니다.'
        : limit === 'table_cells'
            ? '표가 너무 큽니다.'
            : '문서 구조가 너무 큽니다.';
    return `이 문서는 Description 에 바로 붙여넣기에는 너무 큽니다(${reason}) `
        + '텍스트만 붙여넣거나, 원본은 파일로 첨부해주세요.';
}
