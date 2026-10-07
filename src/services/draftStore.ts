/**
 * 메모 본문 자동 저장 — 저장 버튼 없이 입력 → 잠시 뒤 Local DB 저장.
 *
 * 상태: dirty(입력됨) → saving(저장 중) → saved(저장됨) / error(저장 실패).
 * 저장이 실패하면 '저장됨' 으로 보이지 않는다 — 실패 건수가 헤더에 남고 '다시 시도' 를 고를 수 있다.
 * 이미지 업로드 중에는 저장하지 않고(반쪽 본문 방지) 업로드가 끝난 뒤 저장한다.
 * (Web personalMemoStore 의 상태 이름·의미를 따른다. 서버 대신 로컬 DB 라 충돌 상태는 없다.)
 */
import { errorMessage, memoItemService } from '../tauri/api';
import type { MemoItem } from '../domain/types';

export type DraftStatus = 'dirty' | 'saving' | 'saved' | 'error';

export interface MemoDraft {
  itemId: string;
  content: string;
  /** 마지막으로 DB 에 저장된 내용 */
  savedContent: string;
  status: DraftStatus;
  error: string | null;
  uploading: boolean;
}

export const AUTOSAVE_DELAY_MS = 600;

type SaveFn = (id: string, html: string) => Promise<MemoItem>;

export class DraftStore {
  private drafts = new Map<string, MemoDraft>();
  private timers = new Map<string, ReturnType<typeof setTimeout>>();
  private inflight = new Map<string, Promise<void>>();
  private listeners = new Set<() => void>();
  private version = 0;
  /** 저장이 끝난 항목을 화면 캐시에 반영 */
  onSaved: (item: MemoItem) => void = () => {};

  constructor(private saveFn: SaveFn = memoItemService.updateContent) {}

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getVersion = () => this.version;

  private changed() {
    this.version += 1;
    this.listeners.forEach(listener => listener());
  }

  draft(id: string): MemoDraft | undefined {
    return this.drafts.get(id);
  }

  /** 편집을 시작한 순간의 내용으로 초안을 연다(이미 있으면 그대로 — 저장 실패 초안을 잃지 않는다). */
  open(item: Pick<MemoItem, 'id' | 'contentHtml'>) {
    if (this.drafts.has(item.id)) return;
    this.drafts.set(item.id, {
      itemId: item.id,
      content: item.contentHtml,
      savedContent: item.contentHtml,
      status: 'saved',
      error: null,
      uploading: false,
    });
    this.changed();
  }

  edit(item: Pick<MemoItem, 'id' | 'contentHtml'>, html: string) {
    this.open(item);
    const draft = this.drafts.get(item.id)!;
    if (draft.content === html && draft.status !== 'error') return;
    draft.content = html;
    draft.status = html === draft.savedContent ? 'saved' : 'dirty';
    draft.error = null;
    this.changed();
    if (draft.status === 'dirty') this.schedule(item.id);
  }

  setUploading(id: string, uploading: boolean) {
    const draft = this.drafts.get(id);
    if (!draft || draft.uploading === uploading) return;
    draft.uploading = uploading;
    this.changed();
    if (!uploading && draft.status === 'dirty') this.schedule(id, 0);
  }

  private schedule(id: string, delay = AUTOSAVE_DELAY_MS) {
    const existing = this.timers.get(id);
    if (existing) clearTimeout(existing);
    this.timers.set(
      id,
      setTimeout(() => {
        this.timers.delete(id);
        void this.save(id);
      }, delay),
    );
  }

  private async save(id: string): Promise<void> {
    const running = this.inflight.get(id);
    if (running) {
      await running;
    }
    const draft = this.drafts.get(id);
    if (!draft || draft.uploading || draft.content === draft.savedContent) {
      if (draft && !draft.uploading && draft.status === 'dirty') {
        draft.status = 'saved';
        this.changed();
      }
      return;
    }
    const html = draft.content;
    draft.status = 'saving';
    this.changed();
    const task = (async () => {
      try {
        const saved = await this.saveFn(id, html);
        draft.savedContent = html;
        if (draft.content === html) {
          draft.status = 'saved';
          draft.error = null;
        } else {
          draft.status = 'dirty';
          this.schedule(id);
        }
        this.onSaved(saved);
      } catch (error) {
        draft.status = 'error';
        draft.error = errorMessage(error, '저장하지 못했습니다.');
      } finally {
        this.inflight.delete(id);
        this.changed();
      }
    })();
    this.inflight.set(id, task);
    await task;
  }

  /** 바로 저장(편집 종료·화면 전환·창 닫기). */
  async flush(id: string): Promise<void> {
    const timer = this.timers.get(id);
    if (timer) {
      clearTimeout(timer);
      this.timers.delete(id);
    }
    await this.save(id);
  }

  async flushAll(): Promise<void> {
    await Promise.all([...this.drafts.keys()].map(id => this.flush(id)));
  }

  retry(id: string) {
    const draft = this.drafts.get(id);
    if (!draft) return;
    draft.status = 'dirty';
    this.changed();
    void this.flush(id);
  }

  /** 편집을 마쳤다 — 저장되면 초안을 치운다(실패면 남겨 둔다). */
  async close(id: string) {
    await this.flush(id);
    const draft = this.drafts.get(id);
    if (draft && draft.status === 'saved' && !draft.uploading) {
      this.drafts.delete(id);
      this.changed();
    }
  }

  /** 항목이 지워졌으면 초안도 버린다. */
  discard(id: string) {
    const timer = this.timers.get(id);
    if (timer) clearTimeout(timer);
    this.timers.delete(id);
    if (this.drafts.delete(id)) this.changed();
  }

  unsavedCount(): number {
    let n = 0;
    this.drafts.forEach(d => {
      if (d.status === 'dirty' || d.status === 'saving') n += 1;
    });
    return n;
  }

  failedCount(): number {
    let n = 0;
    this.drafts.forEach(d => {
      if (d.status === 'error') n += 1;
    });
    return n;
  }

  anyUploading(): boolean {
    for (const d of this.drafts.values()) if (d.uploading) return true;
    return false;
  }
}
