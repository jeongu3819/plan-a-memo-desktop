/**
 * Rust DTO 와 같은 모양의 화면 타입(serde camelCase).
 *
 * 핵심 규칙
 *   · 날짜 하루 전체 = DayMemo 문서 1건. 메인/오전/오후(main/am/pm)는 그 안의 Section.
 *   · Next List 하나 = 문서 1건(section 'next').
 */
import type { MemoKind, MemoSection } from '../vendor/plan-a-work/api/personalMemos';

export type { MemoKind, MemoSection };
export type ItemSection = MemoSection | 'next';
export type DocKind = 'DAY' | 'NEXT_LIST';
export type SyncStatus = 'local_only' | 'pending' | 'synced' | 'auth_required' | 'error' | 'conflict';

export type Location =
  | { kind: 'day'; date: string }
  | { kind: 'next'; listId: string | null };

export interface DocumentInfo {
  id: string;
  kind: DocKind;
  memoDate: string | null;
  nextListId: string | null;
  localRevision: number;
  syncedRevision: number;
  serverVersion: number | null;
  syncEnabled: boolean;
  syncStatus: SyncStatus;
  syncError: string | null;
  hasConflict: boolean;
  updatedAt: string;
}

export interface MemoItem {
  id: string;
  documentId: string;
  section: ItemSection;
  kind: MemoKind;
  contentHtml: string;
  completed: boolean;
  completedAt: string | null;
  favorite: boolean;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
}

export interface DayMemo {
  date: string;
  document: DocumentInfo | null;
  items: MemoItem[];
}

export interface NextListInfo {
  id: string;
  name: string;
  isDefault: boolean;
  sortOrder: number;
  itemCount: number;
  document: DocumentInfo | null;
}

export interface NextListMemo {
  list: NextListInfo;
  items: MemoItem[];
}

export interface WeekMemo {
  monday: string;
  days: DayMemo[];
  next: NextListMemo;
}

export interface LocatedItem {
  item: MemoItem;
  location: Location;
  listName: string | null;
}

export interface SearchHit extends LocatedItem {
  excerpt: string;
}

export interface HistoryHit {
  versionId: number;
  documentId: string;
  location: Location;
  listName: string | null;
  reasonLabel: string;
  createdAt: string;
  excerpt: string;
}

export interface SearchResult {
  query: string;
  tokens: string[];
  items: SearchHit[];
  lists: Array<{ id: string; name: string; isDefault: boolean }>;
  history: HistoryHit[];
  truncated: boolean;
}

export interface DaySummary {
  date: string;
  itemCount: number;
  checklistCount: number;
  doneCount: number;
  previews: string[];
  syncEnabled: boolean;
}

export interface SnapshotItem {
  itemKey: string;
  section: ItemSection;
  kind: MemoKind;
  contentHtml: string;
  completed: boolean;
  completedAt: string | null;
  sortOrder: number;
  favorite?: boolean;
}

export interface DocumentSnapshot {
  kind: DocKind;
  memoDate: string | null;
  list: { name: string; isDefault: boolean; sortOrder: number } | null;
  deleted: boolean;
  items: SnapshotItem[];
}

export interface VersionSummary {
  id: number;
  documentId: string;
  reason: string;
  reasonLabel: string;
  localRevision: number;
  createdAt: string;
  itemCount: number;
  preview: string;
}

export interface VersionDetail {
  summary: VersionSummary;
  location: Location;
  snapshot: DocumentSnapshot;
}

export interface MoveOutcome {
  status: 'moved' | 'needs_decision';
  item: MemoItem | null;
  target: Location;
  sourceLinked: boolean;
}

export type MovePolicy = 'link_target' | 'local_only';

export interface AttachmentInfo {
  id: string;
  url: string;
  mimeType: string;
  size: number;
  contentHash: string;
}

export interface StorageStatus {
  state: 'ready' | 'first_run' | 'missing' | 'error';
  path: string | null;
  defaultPath: string | null;
  message: string | null;
}

export interface AppInfo {
  version: string;
  env: 'development' | 'staging' | 'production';
  storage: StorageStatus;
  syncTransport: string;
  realSyncConfigured: boolean;
  today: string;
}

export interface LocationInspection {
  path: string;
  resolvedPath: string;
  exists: boolean;
  isStorage: boolean;
  writable: boolean;
  problem: string | null;
}

export interface RelocateReport {
  oldRoot: string;
  newRoot: string;
  copiedFiles: number;
  copiedBytes: number;
}

export interface BackupInfo {
  fileName: string;
  size: number;
  createdAt: string | null;
}

export interface ExportOptions {
  format: 'txt' | 'csv' | 'zip';
  from: string | null;
  to: string | null;
  includeNext: boolean;
}

export interface ExportResult {
  path: string;
  memoCount: number;
  imagesSaved: number;
  imagesMissing: number;
}

export interface AuthSession {
  /** '<서버 namespace>|<user_id>' — 이 PC 의 Sync 상태를 계정별로 나누는 키 */
  accountKey: string;
  userId: number;
  displayName: string;
  namespace: string;
  serverDeviceId: string;
  deviceName: string;
  connectedAt: string;
  expiresAt: string;
  isMock: boolean;
}

export interface AuthStatus {
  provider: 'mock' | 'plan-a-work';
  configured: boolean;
  webOrigin: string | null;
  loggedIn: boolean;
  /** 만료·Web 에서 기기 해제 — 같은 기기로 다시 연결할 수 있다 */
  expired: boolean;
  loginPending: boolean;
  session: AuthSession | null;
}

export interface LoginStart {
  mode: 'mock' | 'browser';
  authorizeUrl: string | null;
  authorizationId: string;
  expiresIn: number;
}

export interface LogoutResult {
  serverRevoked: boolean;
  accountKey: string | null;
}

export interface SyncReport {
  pushed: number;
  pulled: number;
  conflicts: number;
  failed: number;
  acked: number;
  offline: boolean;
  authRequired: boolean;
  unavailable: boolean;
  notices: string[];
  changedDocuments: string[];
  finishedAt: string;
}

export interface SyncOverview {
  transport: string;
  isMock: boolean;
  env: 'development' | 'staging' | 'production';
  serverOrigin: string | null;
  auth: AuthStatus;
  linkedDocuments: number;
  pending: number;
  conflicts: number;
  errors: number;
  authRequired: number;
  outbox: number;
  /** 다른 PLAN-A Work 계정으로 연결된 문서 수 */
  otherAccount: number;
  lastReport: SyncReport | null;
  mockOnline: boolean | null;
}

export interface ConflictView {
  id: string;
  documentId: string;
  location: Location;
  listName: string | null;
  local: DocumentSnapshot;
  remote: DocumentSnapshot;
  remoteVersion: number;
  /** desktop: 이 PC 가 보낸 내용과 비교 / web: 오래된 Web 편집기가 늦게 저장한 내용과 비교 */
  source: 'desktop' | 'web' | null;
  /** 처음 연결하는 날짜/List 에 양쪽 모두 내용이 있어 생긴 비교(어느 쪽도 지우지 않음) */
  firstLink: boolean;
  createdAt: string;
  updatedAt: string;
}

/** Rust AppError 직렬화 */
export interface AppErrorBody {
  code: string;
  message: string;
}

export const DEFAULT_LIST_ID = '00000000-0000-4000-8000-000000000001';

export interface CleanupReport {
  total: number;
  candidates: number;
  candidateBytes: number;
  keptForBackups: number;
  removed: number;
  dryRun: boolean;
}
