/**
 * 메모 검색어 강조.
 *
 *   · 결과 목록의 토막 글 — 문자열을 [일반, 강조] 조각으로 나눠 <mark> 로 그린다(HTML 을 만들지 않는다).
 *   · 열린 메모 본문 — **DOM 을 바꾸지 않는** CSS Custom Highlight API 로 칠한다. 본문 HTML(서식·
 *     표·이미지)이나 편집기 DOM 에 <mark> 를 끼워 넣지 않으므로 저장 내용·Undo·서식에 닿지 않는다.
 *     API 가 없는 브라우저에서는 칠하지 않고, 메모 행 자체 표시(스크롤·테두리)만 남는다.
 */

export interface HighlightPart {
  text: string;
  hit: boolean;
}

/** 검색 단어(서버와 같은 규칙 — 공백으로 나눈 소문자, 중복 제거). */
export function searchTokens(query: string): string[] {
  const out: string[] = [];
  query.toLowerCase().split(/\s+/).forEach(token => {
    if (token && !out.includes(token)) out.push(token);
  });
  return out.slice(0, 5);
}

/** 대소문자 무시로 단어가 걸린 구간들(겹치면 합친다). */
export function matchRanges(text: string, tokens: string[]): Array<[number, number]> {
  const lower = text.toLowerCase();
  const ranges: Array<[number, number]> = [];
  tokens.forEach(token => {
    if (!token) return;
    let from = 0;
    for (;;) {
      const at = lower.indexOf(token, from);
      if (at < 0) break;
      ranges.push([at, at + token.length]);
      from = at + token.length;
    }
  });
  ranges.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const merged: Array<[number, number]> = [];
  ranges.forEach(([start, end]) => {
    const last = merged[merged.length - 1];
    if (last && start <= last[1]) last[1] = Math.max(last[1], end);
    else merged.push([start, end]);
  });
  return merged;
}

export function splitHighlights(text: string, tokens: string[]): HighlightPart[] {
  const parts: HighlightPart[] = [];
  let cursor = 0;
  matchRanges(text, tokens).forEach(([start, end]) => {
    if (start > cursor) parts.push({ text: text.slice(cursor, start), hit: false });
    parts.push({ text: text.slice(start, end), hit: true });
    cursor = end;
  });
  if (cursor < text.length) parts.push({ text: text.slice(cursor), hit: false });
  return parts.length ? parts : [{ text, hit: false }];
}

/**
 * 글자 안에서 서식만 바꾸는 태그 — 앞뒤 글자가 화면에서 붙어 보인다(서버 memo_search_text 와 같은 목록).
 * 그 밖의 요소(문단·줄바꿈·목록·표 칸·이미지·구분선 등)는 경계로 보고 단어를 잇지 않는다.
 */
export const INLINE_TAGS = new Set([
  'SPAN', 'STRONG', 'B', 'EM', 'I', 'U', 'S', 'STRIKE', 'DEL', 'INS', 'A', 'CODE',
  'FONT', 'MARK', 'SMALL', 'SUB', 'SUP', 'ABBR',
]);

interface TextSegment {
  node: Text;
  start: number;
  end: number;
}

/**
 * root 안의 글자를 화면에서 읽히는 대로 이어 붙인 문자열 + 각 text node 의 위치.
 * 인라인 서식 경계는 그대로 잇고, 다른 요소의 시작·끝은 '\n'(어느 node 에도 속하지 않는 자리)으로 띄운다.
 */
export function visibleText(root: Node): { text: string; segments: TextSegment[] } {
  let text = '';
  const segments: TextSegment[] = [];
  const gap = () => {
    if (text && !text.endsWith('\n')) text += '\n';
  };
  const walk = (node: Node) => {
    if (node.nodeType === Node.TEXT_NODE) {
      const value = node.nodeValue || '';
      if (value) {
        segments.push({ node: node as Text, start: text.length, end: text.length + value.length });
        text += value;
      }
      return;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return;
    const inline = INLINE_TAGS.has((node as Element).tagName);
    if (!inline) gap();
    node.childNodes.forEach(walk);
    if (!inline) gap();
  };
  root.childNodes.forEach(walk);
  return { text, segments };
}

/** 단어가 여러 text node(서식 경계)에 걸쳐 있어도 하나의 Range 로 잡는다. */
export function visibleTextRanges(root: Node, tokens: string[]): Range[] {
  const { text, segments } = visibleText(root);
  const locate = (offset: number, isEnd: boolean) => {
    const segment = segments.find(seg => (isEnd ? offset > seg.start && offset <= seg.end : offset >= seg.start && offset < seg.end));
    return segment ? { node: segment.node, offset: offset - segment.start } : null;
  };
  const ranges: Range[] = [];
  matchRanges(text.replace(/\u00a0/g, ' '), tokens).forEach(([start, end]) => {
    const from = locate(start, false);
    const to = locate(end, true);
    if (!from || !to) return;
    const range = document.createRange();
    range.setStart(from.node, from.offset);
    range.setEnd(to.node, to.offset);
    ranges.push(range);
  });
  return ranges;
}

export const MEMO_SEARCH_HIGHLIGHT = 'memo-search-hit';

type HighlightRegistry = { set: (name: string, value: unknown) => void; delete: (name: string) => void };

function registry(): HighlightRegistry | null {
  const css = (globalThis as { CSS?: { highlights?: HighlightRegistry } }).CSS;
  const ctor = (globalThis as { Highlight?: unknown }).Highlight;
  return css?.highlights && typeof ctor === 'function' ? css.highlights : null;
}

export function canHighlightDom(): boolean {
  return registry() !== null;
}

/**
 * root 안의 **읽기 화면** 글자(`[data-testid=personal-memo-content]`)에서 단어를 칠한다.
 * 편집 중인 편집기(contenteditable)는 건드리지 않는다. 칠한 범위 수를 돌려준다.
 */
export function paintDomHighlights(root: HTMLElement | null, tokens: string[]): number {
  const reg = registry();
  if (!reg) return 0;
  if (!root || !tokens.length) {
    reg.delete(MEMO_SEARCH_HIGHLIGHT);
    return 0;
  }
  const ranges: Range[] = [];
  root.querySelectorAll<HTMLElement>('[data-testid="personal-memo-content"]').forEach(view => {
    ranges.push(...visibleTextRanges(view, tokens));
  });
  const Ctor = (globalThis as unknown as { Highlight: new (...r: Range[]) => unknown }).Highlight;
  if (ranges.length) reg.set(MEMO_SEARCH_HIGHLIGHT, new Ctor(...ranges));
  else reg.delete(MEMO_SEARCH_HIGHLIGHT);
  return ranges.length;
}

export function clearDomHighlights(): void {
  registry()?.delete(MEMO_SEARCH_HIGHLIGHT);
}
