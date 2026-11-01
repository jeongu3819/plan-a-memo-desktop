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

  it('같은 메모의 저장은 동시에 보내지 않는다 — 오래된 내용이 최신 내용을 덮지 않는다', async () => {
    let active = 0;
    let maxActive = 0;
    let db = '';
    const pending: Array<() => void> = [];
    const save = vi.fn(
      (_id: string, html: string) =>
        new Promise<MemoItem>(resolve => {
          active += 1;
          maxActive = Math.max(maxActive, active);
          pending.push(() => {
            active -= 1;
            db = html; // 응답이 온 순서대로 DB 에 쓰였다고 본다
            resolve(item(html));
          });
        }),
    );
    const tick = () => new Promise(r => setTimeout(r, 0));
    const store = new DraftStore(save);
    const memo = item();
    store.edit(memo, 'v1');
    const flushes = [store.flush(memo.id)];
    await tick();
    store.edit(memo, 'v2');
    flushes.push(store.flush(memo.id), store.flush(memo.id)); // 저장 중에 두 번 더(바깥 클릭 + 창 숨김)
    await tick();
    pending.shift()!(); // v1 응답
    await tick();
    store.edit(memo, 'v3');
    flushes.push(store.flush(memo.id));
    await tick();
    // 남은 응답을 늦게 시작한 것부터(역순) 돌려준다 — 동시에 보냈다면 v2 가 v3 를 덮는다
    while (pending.length) {
      pending.pop()!();
      await tick();
    }
    await Promise.all(flushes);
    await store.flushAll();
    expect(maxActive).toBe(1);
    expect(db).toBe('v3');
    expect(store.draft(memo.id)?.status).toBe('saved');
  });

  it('수십만 자 본문도 자르지 않고 그대로 저장 함수에 넘긴다', async () => {
    const long = `<p>${'가나다라마바사 ABC 123 😀 '.repeat(20000)}</p><p>[END-OF-MEMO-PASTE-TEST-12345]</p>`;
    const save = vi.fn(async (_id: string, html: string) => item(html));
    const store = new DraftStore(save);
    const memo = item();
    store.edit(memo, long);
    await store.flush(memo.id);
    expect(save).toHaveBeenCalledWith(memo.id, long);
    expect(store.draft(memo.id)?.savedContent).toBe(long);
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
