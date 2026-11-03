import { LIST_STYLE_ATTR } from './richTextFormatting';

/**
 * Rich 본문 목록의 화면 규칙 (단일 출처) — Description · 작업노트 · 메모(편집/읽기) 공용.
 *
 * 상위 → 하위 목록 한 단계 = 14px(글자 크기와 무관하게 고정). 문서 편집기 기본값(40px)처럼 깊게 밀지 않는다.
 * 첫 단계 목록의 왼쪽은 들여쓰기가 아니라 '번호가 들어갈 자리'(1.25em)다 — 메모 편집기는 왼쪽 여백이 0 인 스크롤
 * 영역이라 14px 로 줄이면 '1)' '①' 앞부분이 잘린다(2026-10-19 사용자 결정: 하위 단계만 14px).
 * 번호와 글자 사이 간격(li 2px + 표기 접미사)은 따로이며 이 값들과 상관없다.
 * 기호는 목록 바깥(outside)에 서므로 긴 줄이 넘어가도 기호 아래가 아니라 글자 시작 위치에 맞춰 줄바꿈된다.
 * 번호 표기를 고르지 않은 하위 번호 목록은 '1)' 로 보인다(effectiveListStyle 과 같은 규칙).
 * 고른 표기(ol[data-list-style])는 index.css 의 전역 규칙이 정한다.
 */
export const RICH_LIST_INDENT = '14px';
/** 첫 단계 목록의 번호 자리. */
export const RICH_LIST_MARKER_GUTTER = '1.25em';

/**
 * 두 자리 번호('10.' '21.')는 기호가 넓어 번호 자리(1.25em) 안에 다 들어가지 않는다 — 스크롤 편집기(메모·작업노트)에서는
 * 앞자리가 잘린다. 두 자리 번호가 실제로 나오는 목록(1. / 1) 은 10번째 항목부터, ① 은 ⑳ 다음 21번째부터)만
 * 기호 자리를 조금 더 둔다. 그보다 짧은 목록은 지금 모양 그대로다.
 */
export const RICH_LIST_WIDE_INDENT = `calc(${RICH_LIST_MARKER_GUTTER} + 0.5em)`;
// 이어쓴 번호 목록(ol[start], continuedListStart)은 시작 번호만큼 빨리 두 자리가 된다 — start=s 면 (11-s) 번째 항목이 '10.',
// start 가 두 자리 이상이면 처음부터.
const ONE_DIGIT_STARTS = [2, 3, 4, 5, 6, 7, 8, 9];
export const richListWideSelector = (prefix = '&') => [
    `ol:not([${LIST_STYLE_ATTR}="circled"]):has(> li:nth-of-type(10))`,
    `ol[${LIST_STYLE_ATTR}="circled"]:has(> li:nth-of-type(21))`,
    ...ONE_DIGIT_STARTS.map(start =>
        `ol:not([${LIST_STYLE_ATTR}="circled"])[start="${start}"]:has(> li:nth-of-type(${11 - start}))`),
    `ol:not([${LIST_STYLE_ATTR}="circled"])[start]:not(${[0, 1, ...ONE_DIGIT_STARTS].map(n => `[start="${n}"]`).join(', ')})`,
].map(selector => `${prefix} ${selector}`).join(', ');

export const richListSx = {
    '& ul, & ol': { margin: '0 0 4px', paddingLeft: RICH_LIST_MARKER_GUTTER, listStylePosition: 'outside' },
    // 하위 목록(브라우저 들여쓰기는 <ol><li/><ol>…</ol></ol> 처럼 li 의 형제로도 만든다)은 위아래 여백 없이, 한 단계 14px.
    '& :is(ul, ol) :is(ul, ol)': { margin: 0, paddingLeft: RICH_LIST_INDENT },
    '& ul': { listStyleType: 'disc' },
    '& :is(ul, ol) ul': { listStyleType: 'circle' },
    '& ol': { listStyleType: 'decimal' },
    [`& :is(ul, ol) ol:not([${LIST_STYLE_ATTR}])`]: { listStyleType: 'rich-paren' },
    '& li': { margin: 0, paddingLeft: '2px' },
    [richListWideSelector()]: { paddingLeft: RICH_LIST_WIDE_INDENT },
} as const;
