/**
 * 비교 화면 문구 — 서버 Conflict 의 실제 출처(`source`)를 따른다. 서버 쪽을 언제나 'Web' 이라고 부르지 않는다
 * (memo-sync-v1: source=web 이면 제안이 Web, 서버 현재는 이 PC 가 먼저 저장한 내용일 수 있다).
 */
import type { ConflictView } from '../../domain/types';

export function conflictReason(view: Pick<ConflictView, 'source' | 'firstLink'>): string {
  if (view.source === 'web') return 'PLAN-A Work 에서 오래 열어 둔 편집 내용이 늦게 저장되어, 이 PC 가 보낸 내용과 다릅니다.';
  if (view.firstLink) return '처음 연결하는데 이 PC 와 PLAN-A Work 에 이미 서로 다른 내용이 있습니다. 어느 쪽도 지우지 않았습니다.';
  return 'Desktop과 PLAN-A Work에서 각각 수정되었습니다.';
}

/** 오른쪽(PLAN-A Work 쪽) 제목 */
export function remoteTitle(view: Pick<ConflictView, 'source'>): string {
  return view.source === 'web' ? 'PLAN-A Work Version (Web 에서 늦게 저장)' : 'PLAN-A Work Version';
}
