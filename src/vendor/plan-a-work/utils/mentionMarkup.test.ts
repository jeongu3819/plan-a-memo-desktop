// @vitest-environment jsdom
/**
 * @멘션 토큰 계약 — 편집기와 저장 사이에서 깨지면 안 되는 것들.
 *
 * 특히 확인하는 것: span 을 sanitizer 허용 목록에 넣었다고 해서 **붙여넣은 Word span 까지
 * 살아나면 안 된다**. 살아남는 span 은 data-mention-user-id 를 가진 토큰 하나뿐이다.
 */
import { describe, expect, it } from 'vitest';

import {
  MENTION_QUERY_RE,
  buildMentionTokenHtml,
  extractMentionUserIds,
  filterMentionCandidates,
  isMentionElement,
  markMentionTokensAtomic,
  type MentionCandidate,
} from './mentionMarkup';
import { sanitizeTaskDescriptionHtml } from './taskDescription';

const token = (id: number, name: string) => buildMentionTokenHtml(id, name);

describe('토큰 생성/추출', () => {
  it('identity 는 user_id 이고 표시 이름은 escape 된다', () => {
    const html = token(12, '<img src=x onerror=1>개발자');
    expect(html).toContain('data-mention-user-id="12"');
    expect(html).not.toContain('<img');
    expect(html).toContain('&lt;img');
  });

  it('같은 사용자를 여러 번 멘션해도 대상은 1명이다(등장 순서 유지)', () => {
    expect(extractMentionUserIds(`${token(3, 'A')} 본문 ${token(3, 'A')} ${token(9, 'B')}`))
      .toEqual([3, 9]);
  });

  it('토큰이 아닌 "@문자열" 은 멘션이 아니다', () => {
    expect(extractMentionUserIds('<p>@내일까지 부탁드립니다</p>')).toEqual([]);
    expect(extractMentionUserIds('<span data-mention-user-id="abc">@x</span>')).toEqual([]);
    expect(extractMentionUserIds(null)).toEqual([]);
  });
});

describe('sanitizer', () => {
  const html = (value: string) => sanitizeTaskDescriptionHtml(value).html;

  it('멘션 토큰은 살아남는다', () => {
    const out = html(`<p>확인 ${token(7, '개발자1')} 부탁</p>`);
    expect(out).toContain('data-mention-user-id="7"');
    expect(out).toContain('@개발자1');
  });

  it('일반 span 은 허용 색상만 보존하고 Office class 는 제거한다', () => {
    const out = html('<p><span style="color:red" class="MsoNormal">워드</span> 본문</p>');
    expect(out).toBe('<p><span style="color: red;">워드</span> 본문</p>');
    expect(html('<p><span class="MsoNormal" style="font-family:Calibri">워드</span> 본문</p>'))
      .toBe('<p>워드 본문</p>');
  });

  it('편집기 전용 상태(contenteditable)는 저장되지 않는다', () => {
    const out = html('<p><span class="mention" data-mention-user-id="5" contenteditable="false">@A</span></p>');
    expect(out).not.toContain('contenteditable');
    expect(out).toContain('data-mention-user-id="5"');
  });

  it('토큰 옆의 이미지/링크/표는 그대로 보존된다', () => {
    const out = html(
      `<p><img src="/api/images/1.webp" style="width: 320px"></p>`
      + `<p>${token(4, 'A')} <a href="https://example.com">링크</a></p>`
      + '<table><tbody><tr><td>셀</td></tr></tbody></table>',
    );
    expect(out).toContain('<img src="/api/images/1.webp"');
    expect(out).toContain('width: 320px');
    expect(out).toContain('href="https://example.com"');
    expect(out).toContain('<td>셀</td>');
    expect(out).toContain('data-mention-user-id="4"');
  });

  it('script/onerror 는 여전히 제거된다', () => {
    const out = html('<p><script>alert(1)</script><span data-mention-user-id="1" onclick="x()">@A</span></p>');
    expect(out).not.toContain('script');
    expect(out).not.toContain('onclick');
  });
});

describe('편집 중 atomic 표시', () => {
  it('DOM 에 그려진 토큰에만 contenteditable=false 를 붙인다', () => {
    const root = document.createElement('div');
    root.innerHTML = `<p>${token(1, 'A')}<span>보통 span</span></p>`;
    markMentionTokensAtomic(root);
    const spans = Array.from(root.querySelectorAll('span'));
    expect(spans.map(s => s.getAttribute('contenteditable'))).toEqual(['false', null]);
    expect(isMentionElement(spans[0])).toBe(true);
    expect(isMentionElement(spans[1])).toBe(false);
  });
});

describe('후보 검색', () => {
  const candidates: MentionCandidate[] = [
    { userId: 1, name: '개발자1', loginid: 'devone', deptname: '플랫폼' },
    { userId: 2, name: '테스트1', loginid: 'qa1', deptname: '품질' },
    { userId: 3, name: '테스트2', loginid: 'qa2', deptname: '품질' },
  ];

  it('@ 뒤 입력으로 이름/ID/부서를 좁힌다', () => {
    expect(filterMentionCandidates(candidates, '테').map(c => c.userId)).toEqual([2, 3]);
    expect(filterMentionCandidates(candidates, 'devone').map(c => c.userId)).toEqual([1]);
    expect(filterMentionCandidates(candidates, '').map(c => c.userId)).toEqual([1, 2, 3]);
  });
});

describe('캐럿 앞 @질의 인식', () => {
  it.each([
    ['@', ''],
    ['확인 @테', '테'],
    [' @q', 'q'],
  ])('%j 는 멘션 시작이다', (input, expected) => {
    expect(input.match(MENTION_QUERY_RE)?.[1]).toBe(expected);
  });

  it.each(['user@example.com', '확인 @테 부탁', '@'.padEnd(40, 'x')])(
    '%j 는 멘션 시작이 아니다',
    (input) => {
      expect(MENTION_QUERY_RE.test(input)).toBe(false);
    },
  );
});
