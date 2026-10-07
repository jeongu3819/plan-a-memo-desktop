/**
 * 하이퍼링크의 **DOM 조작** 공통 구현.
 *
 * URL 정책(정규화·프로토콜 보정·자동 링크 탐지)은 `utils/richLink.ts` 가 유일한 출처이고,
 * 이 파일은 그 결정을 contentEditable 위에 적용하는 방법만 담는다. Description
 * (RichDescriptionEditor)과 작업노트(WorkNoteModal)는 편집기 구조가 서로 다르지만
 * "무엇이 링크이고 어떤 href 로 저장되는가"는 완전히 같아야 한다 — 두 곳에 각자
 * 파서를 두면 한쪽만 고쳐지고 `www.google.com` 이 다시 상대경로로 새는 식으로 갈라진다.
 *
 * 모든 함수는 root(편집 영역 element)를 인자로 받는 순수 DOM 헬퍼다. React state 를
 * 만지지 않으므로 어느 편집기에서든 그대로 쓸 수 있다.
 */

import { findTrailingLink, normalizeLinkUrl } from './richLink';

/** 링크 앵커에 항상 붙는 속성 — 저장 sanitizer 가 보존하는 조합이다. */
export const applyAnchorAttributes = (anchor: HTMLAnchorElement, url: string): void => {
    anchor.setAttribute('href', url);
    anchor.setAttribute('target', '_blank');
    anchor.setAttribute('rel', 'noopener noreferrer');
};

/**
 * 캐럿 바로 앞에서 방금 완성된 URL 을 링크로 바꾼다(스페이스/엔터 시점).
 *
 * @returns 실제로 링크를 만들었으면 true. 호출부는 이때만 저장을 트리거하면 된다.
 */
export const autoLinkBeforeCaret = (root: HTMLElement | null): boolean => {
    const selection = window.getSelection();
    if (!root || !selection || selection.rangeCount === 0 || !selection.isCollapsed) return false;
    const range = selection.getRangeAt(0);
    const node = range.startContainer;
    if (node.nodeType !== 3 || !root.contains(node)) return false;
    const textNode = node as Text;
    if (textNode.parentElement?.closest('a')) return false; // 이미 링크 안이다
    const found = findTrailingLink(textNode.data.slice(0, range.startOffset));
    if (!found) return false;
    const linkRange = document.createRange();
    linkRange.setStart(textNode, found.start);
    linkRange.setEnd(textNode, found.end);
    const anchor = document.createElement('a');
    applyAnchorAttributes(anchor, found.url);
    try {
        linkRange.surroundContents(anchor);
    } catch {
        return false; // 선택이 여러 노드에 걸치면 자동 링크는 포기한다
    }
    // 캐럿을 링크 바깥으로 빼야 이어서 친 글자가 링크에 빨려 들어가지 않는다.
    const after = document.createRange();
    after.setStartAfter(anchor);
    after.collapse(true);
    selection.removeAllRanges();
    selection.addRange(after);
    return true;
};

/** 앵커를 없애고 안의 텍스트만 남긴다(링크 제거 — 글자는 지우지 않는다). */
export const unwrapAnchor = (anchor: HTMLAnchorElement): void => {
    const parent = anchor.parentNode;
    if (!parent) return;
    while (anchor.firstChild) parent.insertBefore(anchor.firstChild, anchor);
    parent.removeChild(anchor);
};

/**
 * 저장된 href 를 실제로 연다.
 * `www.example.com` 처럼 스킴이 없는 값도 여기서 같은 정책으로 보정되므로,
 * 앱 내부 상대경로(PLAN-A `/…`)로 잘못 열리는 일이 없다.
 *
 * @returns 열지 못했으면 false(호출부가 안내 문구를 띄운다).
 */
export const openLinkHref = (href?: string | null): boolean => {
    const url = normalizeLinkUrl(href);
    if (!url) return false;
    if (/^mailto:/i.test(url)) {
        window.location.href = url;
        return true;
    }
    window.open(url, '_blank', 'noopener,noreferrer');
    return true;
};

/** 이벤트가 편집 영역 안의 앵커에서 일어났는가. 아니면 null. */
export const anchorFromEvent = (
    target: EventTarget | null,
    root: HTMLElement | null,
): HTMLAnchorElement | null => {
    if (!(target instanceof HTMLElement) || !root) return null;
    const anchor = target.closest('a');
    return anchor instanceof HTMLAnchorElement && root.contains(anchor) ? anchor : null;
};

/** 지금 선택 영역이 걸쳐 있는 앵커(있으면). Ctrl+K 로 기존 링크를 편집할 때 쓴다. */
export const anchorFromSelection = (root: HTMLElement | null): HTMLAnchorElement | null => {
    const selection = window.getSelection();
    if (!root || !selection || selection.rangeCount === 0) return null;
    const node = selection.getRangeAt(0).commonAncestorContainer;
    if (!root.contains(node)) return null;
    const element = node.nodeType === 1 ? (node as HTMLElement) : node.parentElement;
    const anchor = element?.closest('a');
    return anchor instanceof HTMLAnchorElement ? anchor : null;
};

/** 링크 편집 Dialog 가 다루는 값. */
export interface LinkDraft {
    /** 화면에 보일 문자열. 비우면 주소가 그대로 보인다. */
    text: string;
    /** 사용자가 입력한 주소(정규화 전 원문). */
    url: string;
    /** 기존 링크를 고치는 중이면 그 앵커. 새로 넣는 중이면 null. */
    editing: HTMLAnchorElement | null;
}

/**
 * 기존 앵커를 draft 대로 갱신한다.
 * @returns 실제로 갱신했으면 true(앵커가 이미 DOM 에서 사라졌으면 false).
 */
export const updateAnchorFromDraft = (
    anchor: HTMLAnchorElement,
    url: string,
    label: string,
): boolean => {
    if (!anchor.isConnected) return false;
    applyAnchorAttributes(anchor, url);
    if (label !== anchor.textContent) anchor.textContent = label;
    return true;
};
