import { describe, expect, it } from 'vitest';
import { conflictReason, remoteTitle } from '../features/sync/conflictText';

describe('비교 화면 문구는 서버 Conflict 의 실제 출처를 따른다', () => {
  it('source=web — Web 이 늦게 저장한 제안(서버 현재는 이 PC 가 먼저 저장한 내용)', () => {
    expect(conflictReason({ source: 'web', firstLink: false })).toContain('늦게 저장');
    expect(remoteTitle({ source: 'web' })).toContain('Web 에서 늦게 저장');
  });

  it('source=desktop — 서버 쪽을 Web 이라고 단정하지 않는다', () => {
    expect(conflictReason({ source: 'desktop', firstLink: false })).toBe('Desktop과 PLAN-A Work에서 각각 수정되었습니다.');
    expect(remoteTitle({ source: 'desktop' })).toBe('PLAN-A Work Version');
    expect(remoteTitle({ source: null })).not.toContain('Web');
  });

  it('첫 연결(base_version=0) 비교는 어느 쪽도 지우지 않았다고 안내', () => {
    expect(conflictReason({ source: 'desktop', firstLink: true })).toContain('처음 연결');
    expect(conflictReason({ source: 'desktop', firstLink: true })).toContain('지우지 않았습니다');
  });
});
