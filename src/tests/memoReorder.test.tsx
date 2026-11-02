import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DayMemo, MemoItem } from '../domain/types';

const invoke = vi.fn();
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...args: unknown[]) => invoke(...args) }));

const { MemoProvider, usePersonalMemo } = await import('../features/memo/MemoProvider');
const { keys } = await import('../services/queries');

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const DATE = '2026-11-02';
const item = (id: string, sortOrder: number) => ({ id, section: 'main', sortOrder, contentHtml: id, kind: 'checklist' }) as MemoItem;
const day = (): DayMemo => ({ date: DATE, document: null, items: [item('a', 0), item('b', 1), item('c', 2)] });

let container: HTMLDivElement | null = null;
afterEach(() => {
  container?.remove();
  container = null;
  invoke.mockReset();
});

async function setup() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  client.setQueryData(keys.day(DATE), day());
  let reorder: ReturnType<typeof usePersonalMemo>['actions']['reorder'] | null = null;
  function Probe() {
    reorder = usePersonalMemo().actions.reorder;
    return null;
  }
  container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(
      <QueryClientProvider client={client}>
        <MemoProvider today={DATE}>
          <Probe />
        </MemoProvider>
      </QueryClientProvider>,
    );
  });
  const ids = () => client.getQueryData<DayMemo>(keys.day(DATE))!.items.map(i => i.id);
  return { reorder: reorder!, ids };
}

describe('메모 순서 변경', () => {
  it('저장을 기다리지 않고 놓은 순서를 바로 보여 준다', async () => {
    let finish: (value: MemoItem[]) => void = () => undefined;
    invoke.mockImplementation((command: string) => (command === 'items_reorder' ? new Promise(resolve => (finish = resolve)) : Promise.resolve(null)));
    const { reorder, ids } = await setup();
    act(() => reorder({ kind: 'day', date: DATE }, 'main', ['c', 'a', 'b']));
    expect(ids()).toEqual(['c', 'a', 'b']);
    expect(invoke).toHaveBeenCalledWith('items_reorder', { location: { kind: 'day', date: DATE }, section: 'main', ids: ['c', 'a', 'b'] });
    await act(async () => finish([]));
    expect(ids()).toEqual(['c', 'a', 'b']);
  });

  it('저장에 실패하면 원래 순서로 되돌린다', async () => {
    invoke.mockImplementation((command: string) => (command === 'items_reorder' ? Promise.reject({ code: 'db', message: '저장 실패' }) : Promise.resolve(null)));
    const { reorder, ids } = await setup();
    await act(async () => {
      reorder({ kind: 'day', date: DATE }, 'main', ['c', 'a', 'b']);
    });
    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, 0));
    });
    expect(ids()).toEqual(['a', 'b', 'c']);
  });
});
