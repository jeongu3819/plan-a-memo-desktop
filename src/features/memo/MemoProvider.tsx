/**
 * 메모 화면 공용 상태와 동작 — 초안 저장소, 편집 중인 항목, 알림(실행 취소), 항목 동작, 공용 Dialog.
 * (Web PersonalMemoContext 의 역할. 서버 대신 Tauri 명령을 부른다.)
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { DraftStore } from '../../services/draftStore';
import { patchItemInCaches, refreshMemo } from '../../services/queries';
import { errorMessage, memoItemService } from '../../tauri/api';
import type { ItemSection, Location, MemoItem, MemoKind, MovePolicy } from '../../domain/types';
import { koreanMonthDay } from '../../domain/location';
import { movedMessage } from '../../vendor/plan-a-work/utils/personalMemoDates';
import MemoNotice, { type Notice } from './MemoNotice';
import { DatePickerDialog, LargeEditorDialog, MoveDecisionDialog } from './MemoDialogs';
import HistoryDialog from '../history/HistoryDialog';

interface MoveRequest {
  item: MemoItem;
  target: Location;
  section?: ItemSection | null;
  index?: number | null;
}

export interface MemoActions {
  create: (location: Location, section: ItemSection, kind: MemoKind, html: string) => Promise<MemoItem | null>;
  toggleComplete: (item: MemoItem) => void;
  setKind: (item: MemoItem, kind: MemoKind) => void;
  toggleFavorite: (item: MemoItem) => void;
  remove: (item: MemoItem) => void;
  move: (request: MoveRequest) => Promise<void>;
  reorder: (location: Location, section: ItemSection, ids: string[]) => void;
}

interface MemoContextValue {
  store: DraftStore;
  storeVersion: number;
  today: string;
  editingId: string | null;
  setEditingId: (id: string | null) => void;
  notify: (notice: Omit<Notice, 'id'>) => void;
  actions: MemoActions;
  openLargeEditor: (item: MemoItem) => void;
  openDatePicker: (item: MemoItem) => void;
  openHistory: (location: Location, title: string) => void;
}

const MemoContext = createContext<MemoContextValue | null>(null);

export function usePersonalMemo() {
  const value = useContext(MemoContext);
  if (!value) throw new Error('MemoProvider 가 필요합니다.');
  return value;
}

let noticeSeq = 0;

export function MemoProvider({ today, children }: { today: string; children: ReactNode }) {
  const queryClient = useQueryClient();
  const store = useMemo(() => new DraftStore(), []);
  const storeVersion = useSyncExternalStore(store.subscribe, store.getVersion);
  const [editingId, setEditingState] = useState<string | null>(null);
  const editingRef = useRef<string | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [decision, setDecision] = useState<MoveRequest | null>(null);
  const [datePick, setDatePick] = useState<MemoItem | null>(null);
  const [large, setLarge] = useState<MemoItem | null>(null);
  const [history, setHistory] = useState<{ location: Location; title: string } | null>(null);

  useEffect(() => {
    store.onSaved = item => patchItemInCaches(queryClient, item);
  }, [store, queryClient]);

  const notify = useCallback((n: Omit<Notice, 'id'>) => {
    noticeSeq += 1;
    setNotice({ ...n, id: noticeSeq });
  }, []);

  const setEditingId = useCallback(
    (id: string | null) => {
      const previous = editingRef.current;
      if (previous && previous !== id) void store.close(previous);
      editingRef.current = id;
      setEditingState(id);
    },
    [store],
  );

  const run = useCallback(
    async <T,>(task: () => Promise<T>, failure: string): Promise<T | null> => {
      try {
        const result = await task();
        refreshMemo(queryClient);
        return result;
      } catch (error) {
        notify({ message: errorMessage(error, failure), variant: 'error' });
        refreshMemo(queryClient);
        return null;
      }
    },
    [notify, queryClient],
  );

  const doMove = useCallback(
    async (request: MoveRequest, policy: MovePolicy | null) => {
      await store.flush(request.item.id);
      const outcome = await run(
        () =>
          memoItemService.move({
            id: request.item.id,
            target: request.target,
            section: request.section ?? null,
            index: request.index ?? null,
            policy,
          }),
        '메모를 옮기지 못했습니다.',
      );
      if (!outcome) return;
      if (outcome.status === 'needs_decision') {
        setDecision(request);
        return;
      }
      if (request.item.documentId !== outcome.item?.documentId) {
        notify({ message: movedMessage(request.target.kind === 'day' ? request.target.date : null), variant: 'default' });
      }
    },
    [notify, run, store],
  );

  const actions: MemoActions = useMemo(
    () => ({
      create: (location, section, kind, html) =>
        run(
          () => memoItemService.create({ id: crypto.randomUUID(), location, section, kind, contentHtml: html }),
          '메모를 저장하지 못했습니다. 입력한 내용은 그대로 있습니다.',
        ),
      toggleComplete: item => void run(() => memoItemService.setCompleted(item.id, !item.completed), '체크하지 못했습니다.'),
      setKind: (item, kind) => void run(() => memoItemService.setKind(item.id, kind), '유형을 바꾸지 못했습니다.'),
      toggleFavorite: item => {
        void run(() => memoItemService.setFavorite(item.id, !item.favorite), '즐겨찾기를 바꾸지 못했습니다.').then(saved => {
          if (saved) notify({ message: saved.favorite ? '즐겨찾기에 추가했습니다.' : '즐겨찾기에서 뺐습니다.', variant: 'default' });
        });
      },
      remove: item => {
        if (editingRef.current === item.id) setEditingId(null);
        void run(async () => {
          await store.flush(item.id);
          return memoItemService.remove(item.id);
        }, '삭제하지 못했습니다.').then(removed => {
          if (!removed) return;
          store.discard(item.id);
          notify({
            message: '메모를 삭제했습니다.',
            actionLabel: '실행 취소',
            onAction: () => void run(() => memoItemService.restore(item.id), '되돌리지 못했습니다.'),
          });
        });
      },
      move: request => doMove(request, null),
      reorder: (location, section, ids) => void run(() => memoItemService.reorder(location, section, ids), '순서를 바꾸지 못했습니다.'),
    }),
    [doMove, notify, run, setEditingId, store],
  );

  // 창을 닫을 때·앱이 숨겨질 때 남은 입력을 저장한다.
  useEffect(() => {
    const flush = () => void store.flushAll();
    window.addEventListener('beforeunload', flush);
    document.addEventListener('visibilitychange', flush);
    return () => {
      window.removeEventListener('beforeunload', flush);
      document.removeEventListener('visibilitychange', flush);
    };
  }, [store]);

  const value: MemoContextValue = {
    store,
    storeVersion,
    today,
    editingId,
    setEditingId,
    notify,
    actions,
    openLargeEditor: setLarge,
    openDatePicker: setDatePick,
    openHistory: (location, title) => setHistory({ location, title }),
  };

  return (
    <MemoContext.Provider value={value}>
      {children}
      <MemoNotice notice={notice} onDismiss={id => setNotice(current => (current?.id === id ? null : current))} />
      <MoveDecisionDialog
        request={decision}
        targetLabel={decision?.target.kind === 'day' ? koreanMonthDay(decision.target.date) : '이 List'}
        onClose={() => setDecision(null)}
        onChoose={policy => {
          const request = decision;
          setDecision(null);
          if (request) void doMove(request, policy);
        }}
      />
      <DatePickerDialog
        item={datePick}
        today={today}
        onClose={() => setDatePick(null)}
        onPick={(item, date) => {
          setDatePick(null);
          void doMove({ item, target: { kind: 'day', date } }, null);
        }}
      />
      <LargeEditorDialog item={large} onClose={() => setLarge(null)} />
      <HistoryDialog
        location={history?.location ?? null}
        title={history?.title ?? ''}
        onClose={() => setHistory(null)}
        onRestored={() => {
          refreshMemo(queryClient);
          notify({ message: '이 버전으로 되돌렸습니다. 되돌리기 전 내용은 History 에 남아 있습니다.', variant: 'success' });
        }}
      />
    </MemoContext.Provider>
  );
}
