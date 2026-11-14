/** 반복 중지 확인창 — 새 회차 없음 · 정리 수 · 남는 회차 · 취소 / 중지. (띄울지 말지는 E2E weekly-recurrence 가 확인한다) */
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import RecurrenceStopDialog, { type RecurrenceStopRequest } from '../features/memo/RecurrenceStopDialog';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let cleanup: Array<() => void> = [];
afterEach(() => {
  cleanup.forEach(fn => fn());
  cleanup = [];
});

function render(request: RecurrenceStopRequest | null) {
  const onCancel = vi.fn();
  const onConfirm = vi.fn();
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  cleanup.push(() => {
    act(() => root.unmount());
    host.remove();
  });
  act(() => root.render(<RecurrenceStopDialog request={request} onCancel={onCancel} onConfirm={onConfirm} />));
  const dialog = () => document.querySelector<HTMLElement>('[data-testid="recurrence-stop-confirm"]');
  const byId = (id: string) => document.querySelector<HTMLElement>(`[data-testid="${id}"]`)!;
  return { dialog, byId, onCancel, onConfirm };
}

describe('반복 중지 확인창', () => {
  const request: RecurrenceStopRequest = { ruleId: 'rule-1', dayName: '토요일', removed: 2, kept: 1 };

  it('새 회차를 만들지 않음 · 정리될 수 · 남는 수를 알린다', () => {
    const { dialog, byId } = render(request);
    const text = dialog()!.textContent!;
    expect(text).toContain('토요일 반복을 중지할까요?');
    expect(text).toContain('앞으로 새 메모를 만들지 않습니다.');
    expect(byId('recurrence-stop-removed').textContent).toContain('손대지 않은 2개를 정리');
    expect(byId('recurrence-stop-removed').textContent).toContain('History');
    expect(byId('recurrence-stop-kept').textContent).toContain('고치거나 완료한 이후 메모 1개');
  });

  it('남길 회차가 없어도 고친·완료한 메모는 그대로라고 알린다', () => {
    const { byId } = render({ ...request, kept: 0 });
    expect(byId('recurrence-stop-kept').textContent).toBe('고치거나 완료한 메모와 오늘까지의 메모는 그대로 둡니다.');
  });

  it('취소는 아무것도 하지 않고, 중지는 그 반복으로', () => {
    const { byId, onCancel, onConfirm } = render(request);
    act(() => byId('recurrence-stop-cancel').click());
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onConfirm).not.toHaveBeenCalled();
    act(() => byId('recurrence-stop-submit').click());
    expect(onConfirm).toHaveBeenCalledWith(request);
  });

  it('요청이 없으면 띄우지 않는다', () => {
    const { dialog } = render(null);
    expect(dialog()).toBeNull();
  });
});
