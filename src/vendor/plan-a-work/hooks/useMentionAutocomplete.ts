import { useCallback, useMemo, useRef, useState } from 'react';
import {
  MENTION_QUERY_RE,
  MENTION_SELECTOR,
  buildMentionTokenHtml,
  filterMentionCandidates,
  markMentionTokensAtomic,
  type MentionCandidate,
} from '../utils/mentionMarkup';

/**
 * contentEditable 본문 안의 표준 @멘션 자동완성.
 *
 * 이 훅은 **편집기 DOM 을 소유하지 않는다** — root ref 와 후보 목록만 받고, 토큰을 넣은 뒤
 * 편집기에게 "본문이 바뀌었다"(onCommit)고 알린다. 그래서 Description 편집기의 이미지·표·
 * 링크 파이프라인을 건드리지 않고 얹을 수 있다.
 *
 * 설계상 지키는 두 가지:
 *  1) 후보가 없거나 dropdown 이 닫혀 있으면 **키 입력을 가로채지 않는다.** Enter 는 언제나
 *     원래대로 줄바꿈이어야 한다(멘션 때문에 기존 입력이 깨지면 안 된다).
 *  2) 토큰 삽입은 execCommand 한 번 = undo 한 단계. Ctrl+Z 로 토큰 전체가 되돌아간다.
 */

export interface MentionAutocomplete {
  /** dropdown 을 띄워야 하는가(후보 0명 안내 포함). */
  open: boolean;
  /** 캐럿 위치 — Popper 의 virtual anchor 로 쓴다. */
  anchorRect: DOMRect | null;
  query: string;
  suggestions: MentionCandidate[];
  /** 후보 자체가 없음(= 이 Task 에 담당자가 없음). 안내 문구 분기용. */
  hasCandidates: boolean;
  highlight: number;
  setHighlight: (index: number) => void;
  select: (candidate: MentionCandidate) => void;
  close: () => void;
  /** 입력/캐럿 이동 후 호출. '@질의' 상태를 다시 계산한다. */
  refresh: () => void;
  /** true 를 반환하면 이 키는 멘션이 처리했다는 뜻(호출부가 preventDefault). */
  handleKeyDown: (event: React.KeyboardEvent) => boolean;
}

const MAX_SUGGESTIONS = 8;

interface QueryContext {
  node: Text;
  /** '@' 문자의 offset */
  atOffset: number;
  /** 캐럿 offset */
  caretOffset: number;
}

function caretRectOf(range: Range): DOMRect | null {
  const rect = range.getBoundingClientRect();
  if (rect.width || rect.height || rect.top || rect.left) return rect;
  // 빈(collapsed) range 는 브라우저에 따라 0 rect 를 준다 — 주변 요소로 대체한다.
  const parent = range.startContainer.parentElement;
  return parent ? parent.getBoundingClientRect() : null;
}

export function useMentionAutocomplete(options: {
  editorRef: React.RefObject<HTMLElement | null>;
  /** undefined = 이 편집기에서는 멘션 기능 자체를 쓰지 않는다. */
  candidates?: MentionCandidate[];
  disabled?: boolean;
  onCommit: () => void;
}): MentionAutocomplete {
  const { editorRef, candidates, disabled, onCommit } = options;
  const enabled = !disabled && Array.isArray(candidates);

  const [query, setQuery] = useState<string | null>(null);
  const [anchorRect, setAnchorRect] = useState<DOMRect | null>(null);
  const [highlight, setHighlight] = useState(0);
  const contextRef = useRef<QueryContext | null>(null);

  const close = useCallback(() => {
    contextRef.current = null;
    setQuery(null);
    setAnchorRect(null);
    setHighlight(0);
  }, []);

  const suggestions = useMemo(() => {
    if (query == null || !candidates) return [];
    return filterMentionCandidates(candidates, query).slice(0, MAX_SUGGESTIONS);
  }, [query, candidates]);

  const refresh = useCallback(() => {
    if (!enabled) return;
    const root = editorRef.current;
    const selection = window.getSelection();
    if (!root || !selection || selection.rangeCount === 0 || !selection.isCollapsed) {
      close();
      return;
    }
    const range = selection.getRangeAt(0);
    const node = range.startContainer;
    if (!root.contains(node) || node.nodeType !== Node.TEXT_NODE) {
      close();
      return;
    }
    // 이미 만들어진 토큰 안에서는 새 멘션을 시작하지 않는다.
    if (node.parentElement?.closest(MENTION_SELECTOR)) {
      close();
      return;
    }
    const before = (node.textContent || '').slice(0, range.startOffset);
    const matched = before.match(MENTION_QUERY_RE);
    if (!matched) {
      close();
      return;
    }
    const previous = contextRef.current;
    const next: QueryContext = {
      node: node as Text,
      atOffset: range.startOffset - matched[1].length - 1,
      caretOffset: range.startOffset,
    };
    contextRef.current = next;
    setQuery(matched[1]);
    setAnchorRect(caretRectOf(range));
    // 같은 '@질의' 를 다시 계산했을 뿐이면 선택 위치를 유지한다. 이게 없으면
    // ArrowDown 뒤의 keyup 이 다시 refresh 를 돌려 highlight 가 0 으로 튄다.
    if (!previous || previous.node !== next.node || previous.atOffset !== next.atOffset
        || previous.caretOffset !== next.caretOffset) {
      setHighlight(0);
    }
  }, [enabled, editorRef, close]);

  const select = useCallback((candidate: MentionCandidate) => {
    const context = contextRef.current;
    const root = editorRef.current;
    if (!context || !root) {
      close();
      return;
    }
    const range = document.createRange();
    try {
      // '@질의' 를 통째로 토큰으로 교체한다(사용자가 친 글자는 남기지 않는다).
      range.setStart(context.node, context.atOffset);
      range.setEnd(context.node, context.caretOffset);
    } catch {
      close();
      return;
    }
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);

    // 토큰 뒤에는 이어서 쓸 수 있도록 공백 한 칸. 일반 space 는 토큰 경계에서
    // 잘려 보일 수 있어 nbsp 를 쓴다(MENTION_QUERY_RE 도 nbsp 를 경계로 인정한다).
    const html = `${buildMentionTokenHtml(candidate.userId, candidate.name)}&nbsp;`;
    let inserted = false;
    try {
      inserted = document.execCommand('insertHTML', false, html);
    } catch {
      inserted = false;
    }
    if (!inserted) {
      const template = document.createElement('template');
      template.innerHTML = html;
      const fragment = template.content;
      const lastNode = fragment.lastChild;
      range.deleteContents();
      range.insertNode(fragment);
      if (lastNode) {
        range.setStartAfter(lastNode);
        range.collapse(true);
        selection?.removeAllRanges();
        selection?.addRange(range);
      }
    }
    markMentionTokensAtomic(root);
    close();
    onCommit();
  }, [editorRef, close, onCommit]);

  // 후보가 하나도 없어도(= 담당자 없음) 안내를 보여줘야 하므로 query 만으로 연다.
  const open = enabled && query != null;

  const handleKeyDown = useCallback((event: React.KeyboardEvent): boolean => {
    if (!open) return false;
    if (event.key === 'Escape') {
      close();
      return true;
    }
    if (suggestions.length === 0) {
      // 고를 후보가 없으면 어떤 키도 가로채지 않는다 — Enter 는 그대로 줄바꿈.
      if (event.key === 'Enter') close();
      return false;
    }
    if (event.key === 'ArrowDown') {
      setHighlight(h => (h + 1) % suggestions.length);
      return true;
    }
    if (event.key === 'ArrowUp') {
      setHighlight(h => (h - 1 + suggestions.length) % suggestions.length);
      return true;
    }
    if (event.key === 'Enter' || event.key === 'Tab') {
      select(suggestions[Math.min(highlight, suggestions.length - 1)]);
      return true;
    }
    return false;
  }, [open, suggestions, highlight, select, close]);

  return {
    open,
    anchorRect,
    query: query || '',
    suggestions,
    hasCandidates: !!candidates && candidates.length > 0,
    highlight,
    setHighlight,
    select,
    close,
    refresh,
    handleKeyDown,
  };
}

export default useMentionAutocomplete;
