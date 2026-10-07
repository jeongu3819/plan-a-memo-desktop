/**
 * [PLAN-A Memo Desktop] Web `api/personalMemos.ts` 의 **타입만**.
 * Desktop 은 Web API 를 부르지 않는다 — 공용 화면 코드가 쓰는 구역/유형 이름만 같게 유지한다.
 */
export type MemoSection = 'main' | 'am' | 'pm';
export type MemoKind = 'checklist' | 'text';
