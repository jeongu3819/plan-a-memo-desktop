// @vitest-environment jsdom
/**
 * 링크 DOM 조작 공통 구현 — Description 과 작업노트가 같은 결과를 내는지 잠근다.
 *
 * 특히 `www.google.com` 이 앱 내부 상대경로로 새지 않는지(과거 회귀)를 여기서 막는다.
 */
import {
  describe,
  it,
  expect,
  beforeEach,
  vi,
  afterEach,
  type MockInstance,
} from 'vitest';

import {
  anchorFromEvent,
  anchorFromSelection,
  applyAnchorAttributes,
  autoLinkBeforeCaret,
  openLinkHref,
  unwrapAnchor,
  updateAnchorFromDraft,
} from './richLinkDom';

/** 편집 영역 하나를 만들고 텍스트 끝에 캐럿을 둔다(스페이스/엔터 직전 상태). */
const editorWithCaretAfter = (text: string) => {
  const root = document.createElement('div');
  root.contentEditable = 'true';

  const node = document.createTextNode(text);
  root.appendChild(node);
  document.body.appendChild(root);

  const range = document.createRange();
  range.setStart(node, text.length);
  range.collapse(true);

  const selection = window.getSelection()!;
  selection.removeAllRanges();
  selection.addRange(range);

  return root;
};

beforeEach(() => {
  document.body.innerHTML = '';
});

describe('autoLinkBeforeCaret', () => {
  it('www 로 시작하는 주소는 https 절대 URL 로 링크가 된다 (상대경로 회귀 방지)', () => {
    const root = editorWithCaretAfter('참고 www.google.com');

    expect(autoLinkBeforeCaret(root)).toBe(true);

    const anchor = root.querySelector('a')!;

    // 화면 글자는 사용자가 친 그대로, href 만 보정된다.
    expect(anchor.textContent).toBe('www.google.com');
    expect(anchor.getAttribute('href')).toBe('https://www.google.com');
    expect(anchor.getAttribute('href')!.startsWith('/')).toBe(false);
  });

  it('스킴이 있는 주소는 그대로 쓴다', () => {
    const root = editorWithCaretAfter('https://www.naver.com');

    expect(autoLinkBeforeCaret(root)).toBe(true);
    expect(root.querySelector('a')!.getAttribute('href')).toBe(
      'https://www.naver.com'
    );
  });

  it('이메일은 mailto 로 링크가 된다', () => {
    const root = editorWithCaretAfter('연락 hong@example.com');

    expect(autoLinkBeforeCaret(root)).toBe(true);
    expect(root.querySelector('a')!.getAttribute('href')).toBe(
      'mailto:hong@example.com'
    );
  });

  it('URL 이 아닌 일반 텍스트는 링크로 만들지 않는다', () => {
    const root = editorWithCaretAfter('설계 문서 확인');

    expect(autoLinkBeforeCaret(root)).toBe(false);
    expect(root.querySelector('a')).toBeNull();
  });

  it('맨 도메인(board.tsx 같은 오탐)은 자동 링크 대상이 아니다', () => {
    const root = editorWithCaretAfter('board.tsx');

    expect(autoLinkBeforeCaret(root)).toBe(false);
  });

  it('이미 링크 안에서는 다시 링크를 만들지 않는다', () => {
    const root = document.createElement('div');

    root.innerHTML =
      '<a href="https://www.naver.com">www.naver.com</a>';

    document.body.appendChild(root);

    const textNode = root.querySelector('a')!.firstChild as Text;

    const range = document.createRange();
    range.setStart(textNode, textNode.data.length);
    range.collapse(true);

    const selection = window.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);

    expect(autoLinkBeforeCaret(root)).toBe(false);
    expect(root.querySelectorAll('a')).toHaveLength(1);
  });

  it('새 탭 속성이 항상 함께 붙는다 (저장 sanitizer 가 보존하는 조합)', () => {
    const root = editorWithCaretAfter('www.naver.com');

    autoLinkBeforeCaret(root);

    const anchor = root.querySelector('a')!;

    expect(anchor.getAttribute('target')).toBe('_blank');
    expect(anchor.getAttribute('rel')).toBe('noopener noreferrer');
  });

  it('캐럿은 링크 바깥으로 나가 이어 친 글자가 링크에 빨려들지 않는다', () => {
    const root = editorWithCaretAfter('www.naver.com');

    autoLinkBeforeCaret(root);

    const range = window.getSelection()!.getRangeAt(0);

    expect(range.startContainer.nodeName).not.toBe('#text');
    expect(
      (range.startContainer as HTMLElement).closest?.('a')
    ).toBeFalsy();
  });

  it('root 가 없으면 조용히 아무것도 하지 않는다', () => {
    expect(autoLinkBeforeCaret(null)).toBe(false);
  });
});

describe('openLinkHref', () => {
  // MockInstance 의 제네릭은 vitest 버전에 따라 달라진다(인자 2개 → 함수 타입 1개).
  // 함수 타입 하나만 넘겨 두면 버전이 올라가도 빌드가 깨지지 않는다.
  let openSpy: MockInstance<typeof window.open>;

  beforeEach(() => {
    openSpy = vi
      .spyOn(window, 'open')
      .mockImplementation(() => null);
  });

  afterEach(() => {
    openSpy.mockRestore();
  });

  it('스킴 없는 주소도 https 로 보정해 새 탭에서 연다', () => {
    expect(openLinkHref('www.google.com')).toBe(true);

    expect(openSpy).toHaveBeenCalledWith(
      'https://www.google.com',
      '_blank',
      'noopener,noreferrer'
    );
  });

  it('위험한 스킴은 열지 않는다', () => {
    expect(openLinkHref('javascript:alert(1)')).toBe(false);
    expect(openSpy).not.toHaveBeenCalled();
  });

  it('빈 값도 안전하게 false', () => {
    expect(openLinkHref(null)).toBe(false);
    expect(openLinkHref('')).toBe(false);
  });
});

describe('앵커 조작', () => {
  it('unwrapAnchor 는 링크만 없애고 글자는 남긴다', () => {
    const root = document.createElement('div');

    root.innerHTML =
      '앞 <a href="https://x.com">네이버</a> 뒤';

    unwrapAnchor(root.querySelector('a')!);

    expect(root.querySelector('a')).toBeNull();
    expect(root.textContent).toBe('앞 네이버 뒤');
  });

  it('updateAnchorFromDraft 는 주소와 표시 텍스트를 함께 갱신한다', () => {
    const root = document.createElement('div');

    document.body.appendChild(root);

    root.innerHTML =
      '<a href="https://old.com">옛이름</a>';

    const anchor = root.querySelector('a')!;

    expect(
      updateAnchorFromDraft(
        anchor,
        'https://www.naver.com',
        '네이버'
      )
    ).toBe(true);

    expect(anchor.getAttribute('href')).toBe(
      'https://www.naver.com'
    );
    expect(anchor.textContent).toBe('네이버');
    expect(anchor.getAttribute('rel')).toBe(
      'noopener noreferrer'
    );
  });

  it('이미 사라진 앵커는 갱신하지 않는다', () => {
    const detached = document.createElement('a');

    expect(
      updateAnchorFromDraft(
        detached,
        'https://x.com',
        'x'
      )
    ).toBe(false);
  });

  it('applyAnchorAttributes 는 표시 텍스트를 건드리지 않는다', () => {
    const anchor = document.createElement('a');

    anchor.textContent = '그대로';

    applyAnchorAttributes(anchor, 'https://x.com');

    expect(anchor.textContent).toBe('그대로');
  });

  it('anchorFromEvent 는 편집 영역 밖의 링크를 잡지 않는다', () => {
    const root = document.createElement('div');

    root.innerHTML =
      '<a href="https://in.com">안</a>';

    const outside = document.createElement('a');

    document.body.append(root, outside);

    expect(
      anchorFromEvent(root.querySelector('a'), root)
    ).not.toBeNull();

    expect(
      anchorFromEvent(outside, root)
    ).toBeNull();

    expect(
      anchorFromEvent(null, root)
    ).toBeNull();
  });

  it('anchorFromSelection 은 선택이 걸친 링크를 돌려준다', () => {
    const root = document.createElement('div');

    root.innerHTML =
      '<a href="https://x.com">링크</a>';

    document.body.appendChild(root);

    const textNode =
      root.querySelector('a')!.firstChild as Text;

    const range = document.createRange();
    range.selectNodeContents(textNode);

    const selection = window.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);

    expect(
      anchorFromSelection(root)?.getAttribute('href')
    ).toBe('https://x.com');
  });
});
