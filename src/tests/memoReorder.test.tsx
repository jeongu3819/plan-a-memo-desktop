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
  let actions: ReturnType<typeof usePersonalMemo>['actions'] | null = null;
  function Probe() {
    actions = usePersonalMemo().actions;
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
  return { reorder: actions!.reorder, moveToTop: actions!.moveToTop, ids };
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

  describe('맨 위로 보내기', () => {
    const settle = () => act(async () => {
      await new Promise(resolve => setTimeout(resolve, 0));
    });
    /** 저장된 순서를 흉내 내는 백엔드 — items_reorder 가 받은 순서가 다음 읽기에 보인다. */
    function backend(initial: MemoItem[]) {
      let saved = initial;
      const reorders: string[][] = [];
      invoke.mockImplementation((command: string, args: { ids?: string[] }) => {
        if (command === 'memo_day' || command === 'memo_list') return Promise.resolve({ items: saved });
        if (command === 'items_reorder') {
          reorders.push(args.ids!);
          const moved = args.ids!.map(id => saved.find(i => i.id === id)!);
          saved = [...moved, ...saved.filter(i => !args.ids!.includes(i.id))];
          return Promise.resolve(saved);
        }
        return Promise.resolve(null);
      });
      return { reorders, saved: () => saved.map(i => i.id) };
    }
    const LOCATION = { kind: 'day', date: DATE } as const;

    it('같은 구역 안에서만 맨 위로 — 다른 구역 항목은 순서에 넣지 않는다', async () => {
      const server = backend([item('a', 0), item('b', 1), item('c', 2), { ...item('p', 0), section: 'pm' }]);
      const { moveToTop, ids } = await setup();
      act(() => moveToTop(item('c', 2), LOCATION));
      await settle();
      expect(server.reorders).toEqual([['c', 'a', 'b']]);
      expect(invoke).toHaveBeenCalledWith('items_reorder', { location: LOCATION, section: 'main', ids: ['c', 'a', 'b'] });
      expect(ids()).toEqual(['c', 'a', 'b']);
    });

    it('연달아 눌러도 앞의 결과 위에서 계산해 순서가 꼬이지 않는다', async () => {
      const server = backend([item('a', 0), item('b', 1), item('c', 2)]);
      const { moveToTop } = await setup();
      act(() => {
        moveToTop(item('c', 2), LOCATION);
        moveToTop(item('b', 1), LOCATION);
        moveToTop(item('a', 0), LOCATION);
      });
      await settle();
      await settle();
      expect(server.reorders).toEqual([['c', 'a', 'b'], ['b', 'c', 'a'], ['a', 'b', 'c']]);
      expect(server.saved()).toEqual(['a', 'b', 'c']);
    });

    it('이미 맨 위면 저장하지 않고, Next List 는 그 List 안에서 옮긴다', async () => {
      const next = (id: string, sortOrder: number) => ({ ...item(id, sortOrder), section: 'next' }) as MemoItem;
      const server = backend([next('x', 0), next('y', 1)]);
      const { moveToTop } = await setup();
      const list = { kind: 'next', listId: 'L1' } as const;
      act(() => moveToTop(next('x', 0), list));
      await settle();
      expect(server.reorders).toEqual([]);
      act(() => moveToTop(next('y', 1), list));
      await settle();
      expect(invoke).toHaveBeenCalledWith('memo_list', { listId: 'L1' });
      expect(invoke).toHaveBeenCalledWith('items_reorder', { location: list, section: 'next', ids: ['y', 'x'] });
    });

    it('그 사이 지워진 메모면 아무것도 바꾸지 않는다', async () => {
      const server = backend([item('a', 0)]);
      const { moveToTop } = await setup();
      act(() => moveToTop(item('gone', 3), LOCATION));
      await settle();
      expect(server.reorders).toEqual([]);
    });
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
