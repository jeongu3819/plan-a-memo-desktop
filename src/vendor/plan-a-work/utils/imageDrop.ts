/**
 * 외부(메일 · Jira · 웹페이지)에서 Drag 해 온 이미지 분류 — 단일 출처.
 *
 * 왜 필요한가:
 *   메일이나 Jira 에 보이는 이미지를 마우스로 끌어다 놓으면 브라우저가 **실제 파일 대신**
 *   주소만 넘겨줄 때가 많다. 그 주소를 그대로 `<img src>` 에 저장하면
 *
 *     · blob:  → 원본 탭이 닫히는 순간 만료
 *     · cid:   → 메일 클라이언트 밖에서는 해석 불가
 *     · file:  → 다른 사람 PC 에는 없는 경로
 *     · 인증 URL → 로그인 쿠키가 없는 다른 사용자에게는 403
 *
 *   전부 "액박"이 된다. 그래서 Drop 시점에 **실제 이미지 파일을 확보할 수 있는지**를
 *   먼저 판단하고, 확보한 것만 기존 인라인 이미지 업로드 파이프라인에 태운다.
 *
 * 이 모듈은 순수 함수만 노출한다(에디터 DOM 도 네트워크도 건드리지 않는다).
 * 업로드·삽입·안내는 호출자(RichDescriptionEditor)가 담당한다.
 */

import { decodeDataUrlImage, imageContentKey } from './officePaste';

/** 확보 경로. 숫자가 작을수록 우선한다(같은 이미지가 여러 형식으로 올 때의 승자). */
export type DroppedImageSource = 'file' | 'data-url' | 'remote-url';

const SOURCE_PRIORITY: Record<DroppedImageSource, number> = {
    file: 0,
    'data-url': 1,
    'remote-url': 2,
};

export interface DroppedImage {
    source: DroppedImageSource;
    /** 같은 Drop 안에서 중복 삽입을 막는 키. */
    key: string;
    /** `file`/`data-url` 은 바로 업로드할 수 있다. */
    file?: File;
    /** `remote-url` 은 서버 import 를 거쳐야 한다. */
    url?: string;
}

/** 브라우저가 파일을 주지 않아 복구할 수 없는 참조. 절대 본문에 넣지 않는다. */
export type UnrecoverableReason = 'blob' | 'cid' | 'local-file' | 'unsupported';

export interface UnrecoverableImage {
    reason: UnrecoverableReason;
    url: string;
}

export interface ImageDropAnalysis {
    /** 우선순위·중복 정리가 끝난 최종 목록. */
    images: DroppedImage[];
    unrecoverable: UnrecoverableImage[];
    /** 이미지가 조금이라도 관련된 Drop 인가(아니면 브라우저 기본 동작에 맡긴다). */
    hasImagePayload: boolean;
    /** 이미지 외에 같이 넘어온 텍스트(이미지가 하나도 없을 때만 쓴다). */
    text: string;
    html: string;
}

const IMAGE_EXTENSION_RE = /\.(?:png|jpe?g|gif|webp|bmp|avif|svg)(?:[?#].*)?$/i;
const DATA_IMAGE_RE = /^\s*data:image\//i;

/** 업로드 파일 이름은 사용자에게 그대로 보이므로 최소한만 정리한다. */
function safeFileName(base: string, extension: string): string {
    const stem = (base || 'dropped-image').replace(/[\\/:*?"<>|\s]+/g, '-').slice(0, 60);
    return `${stem || 'dropped-image'}.${extension}`;
}

function extensionForMime(mime: string): string {
    if (mime === 'image/jpeg' || mime === 'image/jpg') return 'jpg';
    return mime.replace('image/', '') || 'png';
}

/** `data:image/...;base64,...` → 업로드용 File. 검증에 실패하면 null. */
export function dataUrlToFile(src: string, timestamp: number, index: number): { file: File; key: string } | null {
    const decoded = decodeDataUrlImage(src);
    if (!decoded) return null;
    // ArrayBuffer 뷰를 그대로 넘기면 SharedArrayBuffer 타입 이슈가 있어 복사본을 만든다.
    const copy = new Uint8Array(decoded.bytes);
    const name = safeFileName(`dropped-${timestamp}-${index}`, extensionForMime(decoded.mime));
    return {
        file: new File([copy], name, { type: decoded.mime }),
        // 내용 기반 키 — 같은 이미지가 여러 번 들어와도 한 번만 올라간다.
        key: `data:${imageContentKey(copy)}`,
    };
}

/** 주소만 보고 이미지로 볼 수 있는가(uri-list/plain text 처럼 근거가 약한 입력용). */
export function looksLikeImageUrl(value: string): boolean {
    const url = (value || '').trim();
    if (!/^https?:\/\//i.test(url)) return false;
    return IMAGE_EXTENSION_RE.test(url);
}

function classifyUnrecoverable(src: string): UnrecoverableReason | null {
    const value = (src || '').trim().toLowerCase();
    if (!value) return null;
    if (value.startsWith('blob:')) return 'blob';
    if (value.startsWith('cid:')) return 'cid';
    if (value.startsWith('file:')) return 'local-file';
    if (value.startsWith('http://') || value.startsWith('https://')) return null;
    if (DATA_IMAGE_RE.test(value)) return null;
    // about:blank, javascript:, 외부 문서 기준 상대경로 등.
    return 'unsupported';
}

function parseUriList(value: string): string[] {
    return (value || '')
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line && !line.startsWith('#'));
}

/**
 * Drop 한 번을 분석한다.
 *
 * 우선순위는 §8 그대로: 실제 File → HTML 안의 data:image → 허용된 http(s) URL →
 * 복구 불가. 같은 이미지가 여러 형식으로 함께 오면 **가장 확실한 경로 하나만** 남긴다.
 */
export function analyzeImageDrop(
    dataTransfer: DataTransfer | null | undefined,
    timestamp: number = Date.now(),
): ImageDropAnalysis {
    const html = dataTransfer?.getData('text/html') || '';
    const text = dataTransfer?.getData('text/plain') || '';
    const uriList = parseUriList(dataTransfer?.getData('text/uri-list') || '');

    const byKey = new Map<string, DroppedImage>();
    const unrecoverable: UnrecoverableImage[] = [];
    const seenUnrecoverable = new Set<string>();

    const add = (image: DroppedImage) => {
        const existing = byKey.get(image.key);
        if (existing && SOURCE_PRIORITY[existing.source] <= SOURCE_PRIORITY[image.source]) return;
        byKey.set(image.key, image);
    };
    const addUnrecoverable = (reason: UnrecoverableReason, url: string) => {
        const key = `${reason}:${url}`;
        if (seenUnrecoverable.has(key)) return;
        seenUnrecoverable.add(key);
        unrecoverable.push({ reason, url });
    };

    // ── 1순위: 실제 이미지 File ──
    const files = Array.from(dataTransfer?.files || [])
        .filter((file) => (file.type || '').toLowerCase().startsWith('image/'));
    files.forEach((file) => {
        add({
            source: 'file',
            key: `file:${file.name}:${file.size}:${file.lastModified}`,
            file,
        });
    });
    const hasRealFiles = files.length > 0;

    // ── 2·3순위: HTML 안의 이미지 ──
    let htmlImageCount = 0;
    if (html && /<img/i.test(html)) {
        const doc = new DOMParser().parseFromString(html, 'text/html');
        const imgs = Array.from(doc.body?.querySelectorAll('img') || []);
        htmlImageCount = imgs.length;
        imgs.forEach((img, index) => {
            const src = (img.getAttribute('src') || '').trim();
            if (!src) return;
            if (DATA_IMAGE_RE.test(src)) {
                const decoded = dataUrlToFile(src, timestamp, index);
                // Base64 원문은 절대 본문/DB 에 남기지 않는다. 못 읽으면 그냥 버린다.
                if (decoded) add({ source: 'data-url', key: decoded.key, file: decoded.file });
                else addUnrecoverable('unsupported', 'data:image');
                return;
            }
            const reason = classifyUnrecoverable(src);
            if (reason) {
                addUnrecoverable(reason, src);
                return;
            }
            // 실제 파일이 이미 있으면 같은 이미지를 URL 로 또 가져오지 않는다(§12 중복 방지).
            if (hasRealFiles) return;
            add({ source: 'remote-url', key: `url:${src}`, url: src });
        });
    }

    // ── uri-list / plain text 의 이미지 주소 ──
    if (!hasRealFiles) {
        const candidates = uriList.length > 0 ? uriList : (text ? [text.trim()] : []);
        candidates.forEach((candidate) => {
            const reason = classifyUnrecoverable(candidate);
            if (reason && reason !== 'unsupported') {
                addUnrecoverable(reason, candidate);
                return;
            }
            if (DATA_IMAGE_RE.test(candidate)) {
                const decoded = dataUrlToFile(candidate, timestamp, byKey.size);
                if (decoded) add({ source: 'data-url', key: decoded.key, file: decoded.file });
                return;
            }
            if (!looksLikeImageUrl(candidate)) return;
            add({ source: 'remote-url', key: `url:${candidate}`, url: candidate });
        });
    }

    const images = Array.from(byKey.values());
    return {
        images,
        unrecoverable,
        // 이미지와 무관한 텍스트 Drag 는 브라우저 기본 동작이 더 낫다.
        hasImagePayload: images.length > 0 || unrecoverable.length > 0 || htmlImageCount > 0,
        text,
        html,
    };
}

/** 안내 문구용 — 왜 못 가져왔는지 사용자 언어로. */
export function unrecoverableDropMessage(items: UnrecoverableImage[]): string {
    const reasons = new Set(items.map((item) => item.reason));
    const lines: string[] = [];
    if (reasons.has('cid')) {
        lines.push('· 메일 본문에 삽입된 이미지(cid:)는 메일 프로그램 밖에서는 주소로 가져올 수 없습니다.');
    }
    if (reasons.has('blob')) {
        lines.push('· 원본 페이지가 임시로 만든 주소(blob:)라 저장해도 곧 사라집니다.');
    }
    if (reasons.has('local-file')) {
        lines.push('· 내 PC 경로(file:)는 다른 사람에게 보이지 않습니다.');
    }
    if (reasons.has('unsupported')) {
        lines.push('· 이 이미지의 주소 형식은 저장할 수 없습니다.');
    }
    return lines.join('\n');
}
