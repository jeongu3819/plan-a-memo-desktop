/**
 * Rich Text 편집 영역(contentEditable)에 공통으로 붙는 속성.
 *
 * 왜 필요한가 — 브라우저의 native 맞춤법 검사 때문이다.
 * `contentEditable` 요소는 별도 지정이 없으면 `spellcheck` 를 켠 것으로 동작한다.
 * 그러면 `www.naver.com` 처럼 사전에 없는 문자열 아래에 **빨간 물결선**이 그려진다.
 * 이것은 우리가 그린 것이 아니라 브라우저가 그리는 표시(spelling-error)이며,
 * CSS `text-decoration` 으로 만들어진 것이 아니라서 CSS 로 덮을 수도 없다
 * (덮으려 하면 링크의 정상 밑줄까지 같이 지워진다).
 *
 * 사용자 입장에서는 링크를 제대로 만들었는데도 오타처럼 보인다. 그래서 편집 표면
 * 자체에서 끈다.
 *
 * ⚠️ 앱 전체 입력에 적용하지 않는다. 프로젝트 이름·검색창·일반 메모의 맞춤법 검사는
 * 사용자에게 도움이 되므로 그대로 둔다. 여기 대상은 링크와 서식이 함께 사는
 * Description / 작업노트 편집 표면뿐이다.
 *
 * 링크의 **정상 밑줄**(anchor underline)과는 무관하다 — 그것은 우리 CSS 이고 그대로 남는다.
 */
export const RICH_TEXT_SURFACE_PROPS = {
    spellCheck: false,
} as const;
