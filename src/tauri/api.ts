/**
 * Typed Tauri 명령 — 화면이 로컬 DB·파일에 닿는 유일한 길.
 * Component 는 SQL·파일 경로를 모른다(memoRepository 역할은 Rust 쪽 memo 모듈).
 */
import { invoke } from '@tauri-apps/api/core';
import type {
  AppErrorBody,
  AppInfo,
  AttachmentInfo,
  LogoutResult,
  AuthStatus,
  BackupInfo,
  CleanupReport,
  ConflictView,
  DayMemo,
  DaySummary,
  DocumentInfo,
  ExportOptions,
  ExportResult,
  ItemSection,
  LocatedItem,
  Location,
  LocationInspection,
  LoginStart,
  MemoItem,
  MemoKind,
  MoveOutcome,
  MovePolicy,
  NextListInfo,
  NextListMemo,
  RelocateReport,
  SearchResult,
  StorageStatus,
  SyncOverview,
  SyncReport,
  VersionDetail,
  VersionSummary,
  WeekMemo,
} from '../domain/types';

export class AppError extends Error {
  code: string;
  constructor(body: AppErrorBody) {
    super(body.message);
    this.code = body.code;
  }
}

/** Tauri 안에서 실행 중인가(브라우저 `npm run dev` 만 띄운 경우 false). */
export function isTauri(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

async function call<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  try {
    return await invoke<T>(command, args);
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && 'message' in error) {
      throw new AppError(error as AppErrorBody);
    }
    throw new AppError({ code: 'unknown', message: String(error) });
  }
}

export function errorMessage(error: unknown, fallback = '처리하지 못했습니다.'): string {
  if (error instanceof AppError) return error.message;
  if (error instanceof Error && error.message) return error.message;
  return fallback;
}

export const appService = {
  info: () => call<AppInfo>('app_info'),
};

export const storageService = {
  status: () => call<StorageStatus>('storage_status'),
  inspect: (path: string) => call<LocationInspection>('storage_inspect', { path }),
  initialize: (path: string, createNew: boolean) => call<StorageStatus>('storage_initialize', { path, createNew }),
  relocate: (path: string) => call<RelocateReport>('storage_relocate', { path }),
  openFolder: (kind: 'root' | 'attachments' | 'backups' | 'exports' | 'logs') => call<void>('open_folder', { kind }),
  backupNow: () => call<BackupInfo>('backup_now'),
  backups: () => call<BackupInfo[]>('backup_list'),
};

export const dayMemoService = {
  week: (monday: string) => call<WeekMemo>('memo_week', { monday }),
  day: (date: string) => call<DayMemo>('memo_day', { date }),
  days: (before: string | null) => call<DaySummary[]>('memo_days', { before }),
};

export const nextListService = {
  list: (listId: string | null) => call<NextListMemo>('memo_list', { listId }),
  lists: () => call<NextListInfo[]>('memo_lists'),
  create: (name: string, id?: string) => call<NextListInfo>('list_create', { name, id: id ?? null }),
  rename: (id: string, name: string) => call<NextListInfo>('list_rename', { id, name }),
  remove: (id: string) => call<{ id: string; movedCount: number }>('list_delete', { id }),
  reorder: (ids: string[]) => call<NextListInfo[]>('lists_reorder', { ids }),
};

export const memoItemService = {
  create: (input: { id: string; location: Location; section: ItemSection; kind: MemoKind; contentHtml: string }) =>
    call<MemoItem>('item_create', { input }),
  updateContent: (id: string, html: string) => call<MemoItem>('item_update_content', { id, html }),
  setCompleted: (id: string, completed: boolean) => call<MemoItem>('item_set_completed', { id, completed }),
  setKind: (id: string, kind: MemoKind) => call<MemoItem>('item_set_kind', { id, kind }),
  setFavorite: (id: string, favorite: boolean) => call<MemoItem>('item_set_favorite', { id, favorite }),
  remove: (id: string) => call<MemoItem>('item_delete', { id }),
  restore: (id: string) => call<MemoItem>('item_restore', { id }),
  move: (input: { id: string; target: Location; section?: ItemSection | null; index?: number | null; policy?: MovePolicy | null }) =>
    call<MoveOutcome>('item_move', { input }),
  reorder: (location: Location, section: ItemSection, ids: string[]) =>
    call<MemoItem[]>('items_reorder', { location, section, ids }),
};

export const searchService = {
  search: (query: string) => call<SearchResult>('memo_search', { query }),
  favorites: () => call<LocatedItem[]>('memo_favorites'),
};

export const historyService = {
  list: (location: Location) => call<VersionSummary[]>('history_list', { location }),
  get: (versionId: number) => call<VersionDetail>('history_get', { versionId }),
  restore: (versionId: number) => call<Location>('history_restore', { versionId }),
};

export const attachmentService = {
  /** 붙여넣기·끌어 놓기 — 바이트를 raw body 로 보낸다. */
  importBlob: async (blob: Blob, itemId?: string | null) => {
    const bytes = new Uint8Array(await blob.arrayBuffer());
    try {
      return await invoke<AttachmentInfo>('attachment_import', bytes, {
        headers: itemId ? { 'x-item-id': itemId } : {},
      });
    } catch (error) {
      if (error && typeof error === 'object' && 'code' in error) throw new AppError(error as AppErrorBody);
      throw new AppError({ code: 'unknown', message: String(error) });
    }
  },
  importFile: (path: string, itemId?: string | null) =>
    call<AttachmentInfo>('attachment_import_file', { path, itemId: itemId ?? null }),
  importUrl: (url: string) => call<AttachmentInfo>('attachment_import_url', { url }),
  /** 쓰지 않는 이미지 정리 — dryRun 이면 세기만 한다. */
  cleanup: (dryRun: boolean) => call<CleanupReport>('attachments_cleanup', { dryRun }),
};

export const exportService = {
  defaultPath: (format: ExportOptions['format']) => call<string>('export_default_path', { format }),
  run: (options: ExportOptions, path: string) => call<ExportResult>('export_memos', { options, path }),
};

export const syncService = {
  overview: () => call<SyncOverview>('sync_overview'),
  link: (location: Location) => call<DocumentInfo>('sync_link', { location }),
  unlink: (location: Location) => call<DocumentInfo>('sync_unlink', { location }),
  syncNow: () => call<SyncReport>('sync_now'),
  conflicts: () => call<ConflictView[]>('conflicts_list'),
  resolve: (id: string, choice: 'local' | 'remote') => call<Location>('conflict_resolve', { id, choice }),
};

/**
 * PLAN-A Work 계정 연결 — 기본 브라우저 로그인 + PKCE + 127.0.0.1 loopback(memo-sync-v1).
 * 결과는 `auth://changed` / `auth://error` 이벤트로 온다(브라우저에서 돌아오는 시점을 화면이 기다리지 않는다).
 */
export const authService = {
  status: () => call<AuthStatus>('auth_status'),
  beginLogin: (reconnect = false) => call<LoginStart>('auth_login_begin', { reconnect }),
  cancelLogin: () => call<AuthStatus>('auth_login_cancel'),
  logout: () => call<LogoutResult>('auth_logout'),
};

/** 개발용 Mock 서버 도구 — 실제 PLAN-A Work 서버가 아니다(개발 빌드에서 서버 주소가 없을 때만 있다). */
export const mockServerService = {
  setOnline: (online: boolean) => call<void>('mock_set_online', { online }),
  remoteEdit: (location: Location, text: string) => call<number>('mock_remote_edit', { location, text }),
  remoteDelete: (location: Location) => call<number>('mock_remote_delete', { location }),
  remoteUnlink: (location: Location) => call<void>('mock_remote_unlink', { location }),
  revokeDevice: () => call<void>('mock_revoke_device'),
  failUploads: (count: number) => call<void>('mock_fail_uploads', { count }),
  dropPushResponses: (count: number) => call<void>('mock_drop_push_responses', { count }),
  setAccount: (userId: number) => call<void>('mock_set_account', { userId }),
};
