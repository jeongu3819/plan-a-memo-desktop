/**
 * 화면 데이터 — React Query 로 로컬 명령 결과를 담는다(서버 응답을 기다리는 구조가 아니다).
 * 로컬 DB 는 빠르므로 쓰기 뒤에는 관련 화면을 다시 읽는다. 본문 자동 저장만은 다시 읽지 않고
 * 캐시의 항목만 바꾼다(편집 중 화면이 흔들리지 않게).
 */
import { QueryClient, useQuery } from '@tanstack/react-query';
import {
  authService,
  dayMemoService,
  historyService,
  nextListService,
  searchService,
  syncService,
} from '../tauri/api';
import type { DayMemo, Location, MemoItem, NextListMemo, WeekMemo } from '../domain/types';
import { locationKey } from '../domain/location';

export const keys = {
  memo: ['memo'] as const,
  week: (monday: string) => ['memo', 'week', monday] as const,
  day: (date: string) => ['memo', 'day', date] as const,
  list: (listId: string | null) => ['memo', 'list', listId ?? 'default'] as const,
  lists: ['memo', 'lists'] as const,
  days: ['memo', 'days'] as const,
  search: (q: string) => ['memo', 'search', q] as const,
  favorites: ['memo', 'favorites'] as const,
  history: (location: Location) => ['memo', 'history', locationKey(location)] as const,
  sync: ['sync'] as const,
  syncOverview: ['sync', 'overview'] as const,
  conflicts: ['sync', 'conflicts'] as const,
  auth: ['auth'] as const,
};

export function createQueryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: 1, refetchOnWindowFocus: false, staleTime: 5_000 },
    },
  });
}

export const useWeek = (monday: string) =>
  useQuery({ queryKey: keys.week(monday), queryFn: () => dayMemoService.week(monday), placeholderData: prev => prev });

export const useDay = (date: string | null) =>
  useQuery({ queryKey: keys.day(date ?? ''), queryFn: () => dayMemoService.day(date!), enabled: !!date });

export const useNextList = (listId: string | null, enabled = true) =>
  useQuery({ queryKey: keys.list(listId), queryFn: () => nextListService.list(listId), enabled });

export const useLists = () => useQuery({ queryKey: keys.lists, queryFn: nextListService.lists });

export const useFavorites = (enabled = true) =>
  useQuery({ queryKey: keys.favorites, queryFn: searchService.favorites, enabled });

export const useHistory = (location: Location | null) =>
  useQuery({
    queryKey: location ? keys.history(location) : ['memo', 'history', 'none'],
    queryFn: () => historyService.list(location!),
    enabled: !!location,
  });

export const useSyncOverview = () =>
  useQuery({ queryKey: keys.syncOverview, queryFn: syncService.overview, refetchInterval: 15_000 });

export const useConflicts = () => useQuery({ queryKey: keys.conflicts, queryFn: syncService.conflicts });

export const useAuthStatus = () => useQuery({ queryKey: keys.auth, queryFn: authService.status });

/** 저장된 항목 하나를 캐시된 화면 데이터에 반영한다(다시 읽지 않는다). */
export function patchItemInCaches(client: QueryClient, item: MemoItem) {
  const replace = (items: MemoItem[]) => items.map(existing => (existing.id === item.id ? item : existing));
  client.setQueriesData<WeekMemo>({ queryKey: ['memo', 'week'] }, data =>
    data
      ? {
          ...data,
          days: data.days.map(d => ({ ...d, items: replace(d.items) })),
          next: { ...data.next, items: replace(data.next.items) },
        }
      : data,
  );
  client.setQueriesData<DayMemo>({ queryKey: ['memo', 'day'] }, data => (data ? { ...data, items: replace(data.items) } : data));
  client.setQueriesData<NextListMemo>({ queryKey: ['memo', 'list'] }, data =>
    data ? { ...data, items: replace(data.items) } : data,
  );
}

export function refreshMemo(client: QueryClient) {
  void client.invalidateQueries({ queryKey: keys.memo });
  void client.invalidateQueries({ queryKey: keys.sync });
}
