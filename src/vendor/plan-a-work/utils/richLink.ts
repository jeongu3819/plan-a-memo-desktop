/**
 * Description 하이퍼링크 정책 — 단일 출처.
 *
 * 저장 경계는 프론트 `sanitizeTaskDescriptionHtml` 과 백엔드
 * `app/services/task_description.py`(bleach) 두 곳이며, 백엔드가 최종 권한이다.
 * bleach 는 `protocols={"http","https","mailto"}` 만 허용하므로 여기서도 같은 집합만
 * 통과시킨다. 그래야 편집기에서는 보이던 링크가 저장 후 사라지는 일이 없다.
 *
 * 이 모듈은 DOM 을 모르는 순수 함수만 노출한다(단위 테스트 대상).
 */

/** 저장까지 살아남는 프로토콜. 백엔드 bleach 설정과 반드시 같아야 한다. */
export const ALLOWED_LINK_PROTOCOLS = ['http:', 'https:', 'mailto:'] as const;

const DANGEROUS_SCHEME_RE = /^\s*(?:javascript|vbscript|data|file|about|blob)\s*:/i;
/**
 * 스킴이 붙은 형태인가(`foo:` 로 시작).
 * 스킴 이름에 점은 허용하지 않는다. 그렇지 않으면 `intra.company.co.kr:8080` 의
 * 호스트를 스킴으로 오인해 정상 사내 주소가 링크에서 제외된다.
 */
const HAS_SCHEME_RE = /^[a-z][a-z0-9+-]*:/i;
/** 최소한 `a.b` 형태의 호스트 + 알파벳 TLD. */
const BARE_DOMAIN_RE = /^(?:[\w-]+\.)+[a-z]{2,}(?::\d{2,5})?(?:[/?#][^\s]*)?$/i;
const EMAIL_RE = /^[^\s@<>()[\]{}]+@(?:[\w-]+\.)+[a-z]{2,}$/i;

/**
 * 사용자가 입력/붙여넣은 문자열 → 저장 가능한 링크 URL.
 *
 * - `example.com`, `www.example.com` → `https://` 를 붙인다(사용자가 스킴까지 치지 않는다).
 * - `hong@example.com` → `mailto:` 를 붙인다.
 * - `javascript:` · `file:` 등 저장되지 않을 스킴은 null(= 링크로 만들지 않는다).
 * - `/api/...` 같은 앱 내부 상대 경로는 그대로 둔다.
 */
export function normalizeLinkUrl(input?: string | null): string | null {
    const raw = (input || '').trim();
    if (!raw) return null;
    if (DANGEROUS_SCHEME_RE.test(raw)) return null;

    if (HAS_SCHEME_RE.test(raw)) {
        const scheme = raw.slice(0, raw.indexOf(':') + 1).toLowerCase();
        if (!(ALLOWED_LINK_PROTOCOLS as readonly string[]).includes(scheme)) return null;
        // `https://` 뒤에 호스트가 없으면 링크가 아니다.
        if (scheme !== 'mailto:' && !/^https?:\/\/[^\s/]+/i.test(raw)) return null;
        if (scheme === 'mailto:' && !EMAIL_RE.test(raw.slice(7))) return null;
        return raw;
    }
    if (EMAIL_RE.test(raw)) return `mailto:${raw}`;
    // 앱 내부 경로(첨부·이미지 등)는 그대로 유지한다.
    if (/^\/(?!\/)/.test(raw)) return raw;
    if (BARE_DOMAIN_RE.test(raw)) return `https://${raw}`;
    return null;
}

/** 저장된 href 가 지금도 유효한 링크인가(외부 문서에서 들어온 값 검증용). */
export function isAllowedLinkUrl(value?: string | null): boolean {
    return normalizeLinkUrl(value) === (value || '').trim() && !!value;
}

/**
 * 자동 링크 대상 패턴.
 * 스킴이 있거나 `www.` 로 시작하는 것만 잡는다. 맨 도메인(`board.tsx`, `1.5개`)까지
 * 링크로 바꾸면 오탐이 훨씬 많아 사용자가 매번 해제해야 한다.
 */
const AUTOLINK_RE = /(?:https?:\/\/|www\.)[^\s<>"']+|[^\s<>"'()[\]{},;:]+@(?:[\w-]+\.)+[a-z]{2,}/gi;
/** 문장 끝의 구두점은 URL 이 아니다. 닫는 괄호는 짝을 따로 본다. */
const TRAILING_PUNCTUATION_RE = /[.,;:!?"'\]}>]+$/;

/** 매치 문자열에서 URL 이 아닌 꼬리(문장 부호·짝 안 맞는 괄호)를 떼어낸다. */
function trimUrlTail(match: string): string {
    let text = match.replace(TRAILING_PUNCTUATION_RE, '');
    // 위키 주소처럼 URL 안에 괄호가 있을 수 있다. 짝이 맞으면 URL 의 일부로 본다.
    while (text.endsWith(')') && (text.match(/\(/g) || []).length < (text.match(/\)/g) || []).length) {
        text = text.slice(0, -1).replace(TRAILING_PUNCTUATION_RE, '');
    }
    return text;
}

export interface DetectedLink {
    /** 원문에서의 시작 위치. */
    start: number;
    /** 원문에서의 끝 위치(제외). */
    end: number;
    /** 화면에 보이는 문자열. */
    text: string;
    /** href 로 저장할 값. */
    url: string;
}

/** 텍스트 안의 링크 후보를 모두 찾는다. */
export function detectLinks(text?: string | null): DetectedLink[] {
    const source = text || '';
    if (!source) return [];
    const out: DetectedLink[] = [];
    AUTOLINK_RE.lastIndex = 0;
    let match: RegExpExecArray | null = AUTOLINK_RE.exec(source);
    while (match) {
        const trimmed = trimUrlTail(match[0]);
        const url = normalizeLinkUrl(trimmed);
        if (url && trimmed) {
            out.push({ start: match.index, end: match.index + trimmed.length, text: trimmed, url });
        }
        match = AUTOLINK_RE.exec(source);
    }
    return out;
}

/**
 * 캐럿 바로 앞에서 방금 완성된 링크 하나.
 * 스페이스/엔터를 눌렀을 때 직전 단어만 링크로 바꾸기 위한 것이다.
 */
export function findTrailingLink(textBeforeCaret?: string | null): DetectedLink | null {
    const source = textBeforeCaret || '';
    const links = detectLinks(source);
    const last = links[links.length - 1];
    if (!last) return null;
    return last.end === source.length ? last : null;
}

/** 붙여넣은 문자열이 "링크 하나"뿐인가(선택 영역을 링크로 감쌀지 판단). */
export function asSingleLinkUrl(text?: string | null): string | null {
    const raw = (text || '').trim();
    if (!raw || /\s/.test(raw)) return null;
    const url = normalizeLinkUrl(raw);
    if (!url) return null;
    // `https://` 처럼 스킴만 있는 값은 링크로 보지 않는다.
    return detectLinks(raw).length > 0 || /^\/|^mailto:/i.test(url) ? url : null;
}

const HTML_ESCAPES: Record<string, string> = {
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
};

export function escapeHtml(value: string): string {
    return (value || '').replace(/[&<>"']/g, (ch) => HTML_ESCAPES[ch]);
}

/**
 * 링크 앵커 HTML.
 * `target="_blank"` 와 `rel` 은 sanitizer 가 보존하는 조합이라 저장 후에도 유지되고,
 * Description 메일 발송처럼 편집기 밖에서 렌더될 때 새 탭으로 열린다.
 */
export function buildAnchorHtml(url: string, text?: string | null): string {
    const safe = normalizeLinkUrl(url);
    if (!safe) return escapeHtml(text || '');
    const label = (text || '').trim() || url.trim();
    return `<a href="${escapeHtml(safe)}" target="_blank" rel="noopener noreferrer">${escapeHtml(label)}</a>`;
}

/** 평문 → 링크가 걸린 HTML(줄바꿈은 `<br>`). plain text fallback 경로에서 쓴다. */
export function linkifyPlainText(text?: string | null): string {
    const source = text || '';
    if (!source) return '';
    const links = detectLinks(source);
    if (links.length === 0) return escapeHtml(source).replace(/\r?\n/g, '<br>');
    let cursor = 0;
    let html = '';
    links.forEach((link) => {
        html += escapeHtml(source.slice(cursor, link.start));
        html += buildAnchorHtml(link.url, link.text);
        cursor = link.end;
    });
    html += escapeHtml(source.slice(cursor));
    return html.replace(/\r?\n/g, '<br>');
}

/** 팝오버에 보여줄 짧은 라벨(아주 긴 URL 이 화면을 밀지 않도록). */
export function linkDisplayLabel(url?: string | null, maxLength = 48): string {
    const raw = (url || '').replace(/^mailto:/i, '');
    if (raw.length <= maxLength) return raw;
    return `${raw.slice(0, maxLength - 1)}…`;
}
