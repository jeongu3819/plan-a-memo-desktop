/**
 * HTML → plain text helpers (DOM 비의존, 순수 문자열 처리).
 *
 * VOC 본문/관리자 메모/댓글, CSV 작업노트 등에서 사용자가 입력하거나 저장된 값에
 * <div>, <br>, &nbsp; 같은 HTML 태그/엔티티가 섞여 있어도 사용자에게는
 * 깨진 문자 없이 깔끔한 텍스트로 보이도록 정리한다.
 *
 * - 브라우저 DOM 을 쓰지 않으므로 프론트(렌더링)와 파서(importParser) 양쪽에서 공용으로 사용 가능.
 * - HTML 렌더링이 꼭 필요한 곳은 별도의 sanitize 레이어(sanitizeVocHtml)를 쓰고,
 *   이 모듈은 "plain text 로 변환" 용도에 집중한다.
 */

const NAMED_ENTITIES: Record<string, string> = {
  nbsp: ' ',
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  '#39': "'",
};

/** &nbsp; &amp; &#39; &#x27; 등 HTML 엔티티를 실제 문자로 디코드. */
export function decodeHtmlEntities(input: string): string {
  if (!input) return '';
  return input.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/g, (m, ent: string) => {
    if (ent[0] === '#') {
      const isHex = ent[1] === 'x' || ent[1] === 'X';
      const code = isHex ? parseInt(ent.slice(2), 16) : parseInt(ent.slice(1), 10);
      if (Number.isFinite(code) && code > 0) {
        try {
          return String.fromCodePoint(code);
        } catch {
          return m;
        }
      }
      return m;
    }
    const key = ent.toLowerCase();
    return Object.prototype.hasOwnProperty.call(NAMED_ENTITIES, key) ? NAMED_ENTITIES[key] : m;
  });
}

/**
 * HTML 문자열을 plain text 로 변환.
 * - <br>, </p>, </div>, </li>, <h*>, <tr> 등 블록/줄바꿈 태그는 줄바꿈으로 치환
 * - 그 외 모든 태그는 제거
 * - HTML 엔티티는 디코드
 * - 과도한 공백/빈 줄은 정리
 *
 * 태그가 전혀 없는 순수 텍스트는 (엔티티 디코드 외) 거의 그대로 통과한다.
 */
export function stripHtmlToText(html: string): string {
  if (!html) return '';
  let s = html;

  // 블록/줄바꿈을 만드는 태그 → 개행
  s = s.replace(/<\s*br\s*\/?\s*>/gi, '\n');
  s = s.replace(/<\s*\/\s*(p|div|li|tr|h[1-6]|blockquote)\s*>/gi, '\n');
  s = s.replace(/<\s*(p|div|li|tr|h[1-6]|blockquote)\b[^>]*>/gi, '\n');

  // 남은 모든 태그 제거 (정상적인 <tag ...> 형태만 — 단독 '<' 는 보존)
  s = s.replace(/<\/?[a-zA-Z][^>]*>/g, '');

  s = decodeHtmlEntities(s);

  // 공백/빈 줄 정리: 줄 끝 공백 제거, 3줄 이상 연속 개행은 2줄로 축소
  s = s
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  return s;
}

/** 목록 preview 등 짧게 보여줄 때: plain text 로 변환 후 개행을 공백으로, 길이 제한. */
export function htmlToPreviewText(html: string, maxLen = 140): string {
  const text = stripHtmlToText(html).replace(/\s+/g, ' ').trim();
  if (text.length <= maxLen) return text;
  return text.slice(0, maxLen).trimEnd() + '…';
}

/** plain text 를 안전한 HTML 로 escape (저장/렌더 공용). */
export function escapeHtml(input: string): string {
  if (!input) return '';
  return input
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
