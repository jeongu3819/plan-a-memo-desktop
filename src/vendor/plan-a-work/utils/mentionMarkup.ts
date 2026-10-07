/**
 * Rich content 안의 @멘션 토큰 markup 계약 (프론트 쪽 본문).
 *
 * 백엔드 `app/services/mention_markup.py` 와 **같은 계약**이어야 한다. 한쪽만 바꾸면
 * 편집기에서는 보이던 멘션이 저장 후 사라지거나(또는 그 반대) 알림 대상이 어긋난다.
 *
 *     <span class="mention" data-mention-user-id="123">@개발자1</span>
 *
 * identity 는 **user_id** 다. 화면에 보이는 이름은 표시용 사본일 뿐이라, 사용자가 이름을
 * 바꿔도 멘션 대상은 바뀌지 않는다. 그래서 대상 추출은 언제나 data 속성만 본다 —
 * 본문에 사람이 직접 타이핑한 "@내일까지" 같은 평범한 문장은 멘션이 아니다.
 */

export const MENTION_ATTR = 'data-mention-user-id';
export const MENTION_CLASS = 'mention';
export const MENTION_SELECTOR = `span[${MENTION_ATTR}]`;

/** 멘션 후보 1명. Description 에서는 **해당 Task 의 담당자**만 후보가 된다. */
export interface MentionCandidate {
  userId: number;
  /** 화면에 보이는 이름(토큰 본문). username 이 없으면 loginid. */
  name: string;
  loginid?: string | null;
  deptname?: string | null;
  mail?: string | null;
  avatarColor?: string | null;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** 편집기에 삽입할 토큰 HTML. 표시 이름은 항상 escape 한다. */
export function buildMentionTokenHtml(userId: number, displayName: string): string {
  const label = escapeHtml(`@${displayName}`.replace(/\s+/g, ' ').trim());
  return `<span class="${MENTION_CLASS}" ${MENTION_ATTR}="${Math.trunc(userId)}">${label}</span>`;
}

export function isMentionElement(element: Element | null | undefined): boolean {
  if (!element || element.tagName !== 'SPAN') return false;
  const raw = (element.getAttribute(MENTION_ATTR) || '').trim();
  return /^\d{1,12}$/.test(raw) && Number(raw) > 0;
}

export function mentionUserIdOf(element: Element | null | undefined): number | null {
  if (!isMentionElement(element)) return null;
  return Number((element as Element).getAttribute(MENTION_ATTR));
}

const MENTION_ID_RE = new RegExp(`${MENTION_ATTR}\\s*=\\s*(?:"(\\d{1,12})"|'(\\d{1,12})'|(\\d{1,12}))`, 'gi');

/** 본문에 남아 있는 멘션 토큰의 user_id 를 등장 순서대로, 중복 없이 반환한다. */
export function extractMentionUserIds(html?: string | null): number[] {
  if (!html) return [];
  const out: number[] = [];
  const seen = new Set<number>();
  MENTION_ID_RE.lastIndex = 0;
  let match = MENTION_ID_RE.exec(html);
  while (match) {
    const id = Number(match[1] || match[2] || match[3]);
    if (id > 0 && !seen.has(id)) {
      seen.add(id);
      out.push(id);
    }
    match = MENTION_ID_RE.exec(html);
  }
  return out;
}

/**
 * 멘션 토큰을 편집 중에만 atomic 하게 만든다(저장되는 HTML 에는 남지 않는다).
 *
 * contenteditable="false" 는 sanitizer 가 떨어뜨리는 편집기 전용 상태다. 이미지의
 * tabindex 와 같은 취급 — DOM 에 다시 그릴 때마다 붙여 준다. 이것이 있어야 Backspace
 * 한 번에 토큰 전체가 지워지고, 토큰 가운데를 고쳐 identity 가 깨지는 일이 없다.
 */
export function markMentionTokensAtomic(root: HTMLElement | null): void {
  if (!root) return;
  root.querySelectorAll(MENTION_SELECTOR).forEach((node) => {
    if (!isMentionElement(node)) return;
    const el = node as HTMLElement;
    if (el.getAttribute('contenteditable') !== 'false') el.setAttribute('contenteditable', 'false');
  });
}

/**
 * 캐럿 앞의 "@질의" 를 찾는 정규식.
 * 줄 처음이거나 공백 뒤의 '@' 만 멘션 시작으로 본다(메일 주소 중간의 @ 는 제외).
 * U+00A0(nbsp)를 escape 로 쓰는 이유: 토큰 뒤에 넣는 공백이 nbsp 라, 리터럴로 적으면
 * 소스에 눈에 보이지 않는 문자가 남는다.
 */
export const MENTION_QUERY_RE = /(?:^|[\s\u00A0])@([^\s\u00A0@]{0,30})$/;

/** 이름/Knox ID/부서로 후보를 좁힌다. 담당자 picker 와 같은 느슨한 부분일치 규칙. */
export function filterMentionCandidates(
  candidates: MentionCandidate[],
  query: string,
): MentionCandidate[] {
  const q = (query || '').trim().toLowerCase();
  if (!q) return candidates;
  return candidates.filter((c) =>
    (c.name || '').toLowerCase().includes(q)
    || (c.loginid || '').toLowerCase().includes(q)
    || (c.deptname || '').toLowerCase().includes(q));
}
