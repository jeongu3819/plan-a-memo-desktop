import { describe, expect, it, vi } from 'vitest';
import { DraftStore } from '../services/draftStore';
import type { MemoItem } from '../domain/types';

const item = (content = 'v0', id = '6f1c2b9e-1111-4222-8333-944455556666'): MemoItem => ({
  id,
  documentId: 'd',
  section: 'main',
  kind: 'checklist',
  contentHtml: content,
  completed: false,
  completedAt: null,
  favorite: false,
  sortOrder: 0,
  createdAt: '',
  updatedAt: '',
});

describe('DraftStore (자동 저장)', () => {
  it('입력 → 잠시 뒤 한 번만 저장하고 저장됨 상태가 된다', async () => {
    vi.useFakeTimers();
    const save = vi.fn(async (_id: string, html: string) => item(html));
    const store = new DraftStore(save);
    const memo = item();
    store.edit(memo, 'v1');
    store.edit(memo, 'v2');
    expect(store.draft(memo.id)?.status).toBe('dirty');
    expect(store.unsavedCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(700);
    expect(save).toHaveBeenCalledTimes(1);
    expect(save).toHaveBeenCalledWith(memo.id, 'v2');
    expect(store.draft(memo.id)?.status).toBe('saved');
    expect(store.unsavedCount()).toBe(0);
    vi.useRealTimers();
  });

  it('저장 실패는 저장됨으로 보이지 않고 다시 시도할 수 있다', async () => {
    let fail = true;
    const save = vi.fn(async (_id: string, html: string) => {
      if (fail) throw new Error('disk full');
      return item(html);
    });
    const store = new DraftStore(save);
    const memo = item();
    store.edit(memo, 'v1');
    await store.flush(memo.id);
    expect(store.draft(memo.id)?.status).toBe('error');
    expect(store.failedCount()).toBe(1);
    fail = false;
    store.retry(memo.id);
    await store.flush(memo.id);
    expect(store.draft(memo.id)?.status).toBe('saved');
    expect(store.failedCount()).toBe(0);
  });

  it('이미지 업로드 중에는 저장하지 않고 끝난 뒤 저장한다', async () => {
    const save = vi.fn(async (_id: string, html: string) => item(html));
    const store = new DraftStore(save);
    const memo = item();
    store.edit(memo, 'v1');
    store.setUploading(memo.id, true);
    await store.flush(memo.id);
    expect(save).not.toHaveBeenCalled();
    store.setUploading(memo.id, false);
    await store.flush(memo.id);
    expect(save).toHaveBeenCalledWith(memo.id, 'v1');
  });

  it('저장 중에 더 입력하면 그 내용도 이어서 저장한다', async () => {
    let resolveFirst: () => void = () => undefined;
    const save = vi.fn((_id: string, html: string) =>
      html === 'v1'
        ? new Promise<MemoItem>(resolve => {
            resolveFirst = () => resolve(item(html));
          })
        : Promise.resolve(item(html)),
    );
    const store = new DraftStore(save);
    const memo = item();
    store.edit(memo, 'v1');
    const first = store.flush(memo.id);
    await Promise.resolve();
    store.edit(memo, 'v2');
    resolveFirst();
    await first;
    await store.flushAll();
    expect(save).toHaveBeenLastCalledWith(memo.id, 'v2');
    expect(store.draft(memo.id)?.status).toBe('saved');
  });

  it('flushAll 은 창을 닫기 전 남은 입력을 모두 저장한다', async () => {
    const save = vi.fn(async (_id: string, html: string) => item(html));
    const store = new DraftStore(save);
    store.edit(item('x', 'a'), 'A');
    store.edit(item('x', 'b'), 'B');
    await store.flushAll();
    expect(save).toHaveBeenCalledTimes(2);
  });
});
