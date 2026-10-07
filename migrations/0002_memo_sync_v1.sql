-- PLAN-A Memo local schema v2 — PLAN-A Work memo-sync-v1 Contract 연결
--
-- 로컬 id(documents.id · memo_items.id · attachments.id)는 그대로 둔다. 서버 식별자는 아래 매핑에만 있다.
--   account_key = '<server namespace>|<user_id>'  (예: 'production:abcd1234|42')
--     서버 namespace(환경+설치 id) + 계정으로 Sync 상태를 묶는다. 다른 계정·다른 환경으로 로그인하면
--     이전 계정의 Link·Outbox·Cursor 는 쓰지 않는다(지우지도 않는다).
-- 기존 데이터·테이블은 지우거나 다시 만들지 않는다(conflicts 만 컬럼·상태 추가를 위해 복사 후 교체).

-- ── Link: 서버 문서 + link generation + ACK ─────────────────────────────
ALTER TABLE sync_links ADD COLUMN account_key TEXT;
ALTER TABLE sync_links ADD COLUMN link_id TEXT;              -- 서버 link generation(재연결마다 새 값)
ALTER TABLE sync_links ADD COLUMN acked_version INTEGER NOT NULL DEFAULT 0;
ALTER TABLE sync_links ADD COLUMN remote_pending INTEGER NOT NULL DEFAULT 0 CHECK (remote_pending IN (0, 1));
ALTER TABLE sync_links ADD COLUMN server_digest TEXT;         -- 마지막으로 맞춘 서버 내용의 digest(같은 내용 재전송 방지)
CREATE INDEX ix_sync_links_account ON sync_links(account_key);

-- ── Outbox: 어느 계정의 작업인가 ────────────────────────────────────────
ALTER TABLE sync_outbox ADD COLUMN account_key TEXT;

-- ── 항목 매핑: 로컬 항목 ↔ 서버 personal_memos.id ──────────────────────────
-- 문서마다 따로 둔다 — 같은 로컬 항목이 다른 날짜로 옮겨 가면 그 문서에서는 '새 항목'(새 client_key)이다
-- (v1 Contract: Desktop push 로 다른 문서의 항목을 가져올 수 없다).
CREATE TABLE sync_item_map (
    document_id     TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
    item_id         TEXT NOT NULL,
    account_key     TEXT NOT NULL,
    server_item_id  INTEGER,                 -- 서버가 받아 준 뒤에 생긴다
    client_key      TEXT,                    -- 새 항목을 처음 보낼 때 만든 키(재전송에도 같은 값)
    item_version    INTEGER,                 -- 서버 item_version(그대로 되돌려 보낸다)
    PRIMARY KEY (document_id, item_id)
);
CREATE INDEX ix_item_map_server ON sync_item_map(account_key, server_item_id);
CREATE UNIQUE INDEX ux_item_map_client_key ON sync_item_map(account_key, client_key) WHERE client_key IS NOT NULL;

-- ── 이미지 매핑: 로컬 첨부 ↔ 서버 stored_name ─────────────────────────────
CREATE TABLE sync_attachment_map (
    attachment_id  TEXT NOT NULL REFERENCES attachments(id) ON DELETE CASCADE,
    account_key    TEXT NOT NULL,
    server_name    TEXT NOT NULL,
    server_sha256  TEXT,
    created_at     TEXT NOT NULL,
    PRIMARY KEY (attachment_id, account_key)
);
CREATE UNIQUE INDEX ux_attachment_map_name ON sync_attachment_map(account_key, server_name);

-- ── Conflict: 서버 conflict id · 출처(desktop/web) · 다른 곳에서 해결됨 ──────────
CREATE TABLE conflicts_v2 (
    id                    TEXT PRIMARY KEY,
    document_id           TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
    local_snapshot_json   TEXT NOT NULL,
    remote_snapshot_json  TEXT NOT NULL,
    local_revision        INTEGER NOT NULL,
    remote_version        INTEGER NOT NULL,
    status                TEXT NOT NULL DEFAULT 'open'
                          CHECK (status IN ('open', 'resolved_local', 'resolved_remote', 'resolved_elsewhere', 'closed')),
    server_conflict_id    TEXT,
    source                TEXT CHECK (source IS NULL OR source IN ('desktop', 'web')),
    account_key           TEXT,
    created_at            TEXT NOT NULL,
    updated_at            TEXT NOT NULL,
    resolved_at           TEXT
);
INSERT INTO conflicts_v2 (id, document_id, local_snapshot_json, remote_snapshot_json, local_revision, remote_version,
                          status, created_at, updated_at, resolved_at)
SELECT id, document_id, local_snapshot_json, remote_snapshot_json, local_revision, remote_version,
       status, created_at, updated_at, resolved_at
  FROM conflicts;
DROP TABLE conflicts;
ALTER TABLE conflicts_v2 RENAME TO conflicts;
CREATE UNIQUE INDEX ux_conflicts_open ON conflicts(document_id) WHERE status = 'open';
