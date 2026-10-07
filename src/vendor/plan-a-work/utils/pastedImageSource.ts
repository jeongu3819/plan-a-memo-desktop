/**
 * 붙여넣은 이미지의 "실제 바이트/표시 가능 여부"를 브라우저에서 확인하는 얇은 층.
 *
 * officePaste(순수 파싱) 와 RichDescriptionEditor(DOM·업로드) 사이의 경계를 지키기 위해
 * 네트워크가 필요한 두 가지만 여기에 둔다. 둘 다 실패를 정상 흐름으로 취급한다 —
 * 실패하면 그 이미지는 본문에 넣지 않고 사용자에게 개수만 알린다.
 */

import { matchesImageSignature } from './officePaste';

const DEFAULT_TIMEOUT_MS = 8000;

/**
 * blob: 주소에서 실제 Blob 을 얻는다.
 *
 * 같은 문서가 만든 blob: 만 읽을 수 있다(우리 편집기에서 복사해 온 이미지가 여기 해당).
 * 다른 탭/문서의 blob: 은 브라우저가 막으므로 null 을 돌려주고, 호출자는 clipboard
 * 바이너리 매칭으로 넘어간다.
 */
export async function fetchBlobUrl(
    url: string,
    timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<Blob | null> {
    if (!/^blob:/i.test(url || '')) return null;
    const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const timer = controller
        ? window.setTimeout(() => controller.abort(), timeoutMs)
        : null;
    try {
        const response = await fetch(url, { signal: controller?.signal });
        if (!response.ok) return null;
        const blob = await response.blob();
        if (!blob.size || !(blob.type || '').toLowerCase().startsWith('image/')) return null;
        return blob;
    } catch {
        // 원본 문서의 blob: 이거나 이미 만료된 주소.
        return null;
    } finally {
        if (timer !== null) window.clearTimeout(timer);
    }
}

/** 브라우저가 직접 내려받을 이미지의 상한. 서버 import 상한과 같은 급으로 둔다. */
const MAX_CLIENT_FETCH_BYTES = 40 * 1024 * 1024;

export type RemoteImageFetchResult =
    | 'ok' | 'invalid_url' | 'unavailable' | 'timeout' | 'cors_or_network_failed'
    | `http_${number}` | 'image_too_large' | 'empty_body' | 'unsupported_content_type'
    | 'invalid_image_signature';

export interface RemoteImageFetchDiagnostic {
    stage: 'browser';
    host: string;
    hasQuery: boolean;
    result: RemoteImageFetchResult;
    mime?: string;
    bytes?: number;
}

function safeRemoteMeta(url: string): { host: string; hasQuery: boolean } {
    try {
        const parsed = new URL(url);
        return { host: parsed.hostname, hasQuery: !!parsed.search };
    } catch {
        return { host: '(invalid)', hasQuery: false };
    }
}

/**
 * 외부 http(s) 이미지를 **이 브라우저가** 직접 내려받는다.
 *
 * 서버 import 보다 먼저 시도하는 이유:
 *   ① 성공하면 왕복이 한 번 줄고, 원본을 그대로 우리 업로드 경로에 태울 수 있다.
 *   ② 서버가 나갈 수 없는 사내망 주소(SSRF 방어로 사설 IP 는 서버에서 차단된다)라도
 *      사용자 브라우저는 볼 수 있다.
 *
 * 사용자의 로그인 쿠키는 보내지 않는다(`credentials: 'omit'`). 즉 네이버 메일처럼
 * 인증이 필요한 이미지는 여기서도 실패하며, 그것이 의도된 동작이다 — 자격증명을
 * 다른 출처로 흘리지 않고, 서버에도 넘기지 않는다.
 *
 * CORS 가 막으면 실패한다. 실패는 정상 흐름이므로 null 을 돌려주고 호출자는 다음
 * 경로(서버 import)로 넘어간다.
 */
export async function fetchRemoteImageBlob(
    url: string,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    onDiagnostic?: (diagnostic: RemoteImageFetchDiagnostic) => void,
): Promise<Blob | null> {
    const meta = safeRemoteMeta(url);
    const report = (result: RemoteImageFetchResult, extra: { mime?: string; bytes?: number } = {}) => {
        onDiagnostic?.({ stage: 'browser', ...meta, result, ...extra });
    };
    if (!/^https?:\/\//i.test(url || '')) {
        report('invalid_url');
        return null;
    }
    if (typeof fetch === 'undefined') {
        report('unavailable');
        return null;
    }
    const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const timer = controller
        ? setTimeout(() => controller.abort(), timeoutMs)
        : null;
    try {
        const response = await fetch(url, {
            mode: 'cors',
            credentials: 'omit',
            referrerPolicy: 'no-referrer',
            signal: controller?.signal,
        });
        if (!response.ok) {
            report(`http_${response.status}`);
            return null;
        }
        const declared = Number(response.headers?.get?.('content-length') || 0);
        if (declared > MAX_CLIENT_FETCH_BYTES) {
            report('image_too_large');
            return null;
        }
        const blob = await response.blob();
        if (!blob.size) {
            report('empty_body');
            return null;
        }
        if (blob.size > MAX_CLIENT_FETCH_BYTES) {
            report('image_too_large', { bytes: blob.size });
            return null;
        }
        const mime = (blob.type || '').toLowerCase().split(';', 1)[0].trim();
        if (!['image/png', 'image/jpeg', 'image/jpg', 'image/webp'].includes(mime)) {
            report('unsupported_content_type', { mime: blob.type || '', bytes: blob.size });
            return null;
        }
        const signature = new Uint8Array(await blob.slice(0, 16).arrayBuffer());
        if (!matchesImageSignature(mime, signature)) {
            report('invalid_image_signature', { mime, bytes: blob.size });
            return null;
        }
        report('ok', { mime, bytes: blob.size });
        return blob;
    } catch (error) {
        // CORS 차단 · 인증 필요 · 네트워크 오류 — 모두 "이 경로로는 못 가져온다" 하나다.
        report((error as { name?: string })?.name === 'AbortError' ? 'timeout' : 'cors_or_network_failed');
        return null;
    } finally {
        if (timer !== null) clearTimeout(timer);
    }
}
