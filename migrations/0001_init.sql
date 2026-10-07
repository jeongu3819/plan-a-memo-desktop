-- PLAN-A Memo local schema v1
--
-- 핵심 개념
--   documents  : Sync 단위. DAY(날짜 하루 전체 = 1건) 또는 NEXT_LIST(List 하나 = 1건).
--   memo_items : 문서 안의 항목. DAY 는 section main/am/pm(메인·오전·오후), NEXT_LIST 는 next.
--                (구역 값은 PLAN-A Work 개인 메모의 기존 값 main/am/pm 을 그대로 쓴다.)
--   sync_*     : 사용자가 직접 연결한 문서만 Sync 대상. 연결 전에는 어떤 것도 전송하지 않는다.
--
-- 모든 시각은 UTC ISO-8601 문자열. id 는 UUID 문자열(로컬 생성 — 서버 id 와 분리).

CREATE TABLE settings (
    key         TEXT PRIMARY KEY,
    value       TEXT NOT NULL,
    updated_at  TEXT NOT NULL
);

CREATE TABLE next_lists (
    id          TEXT PRIMARY KEY,
    name        TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 100),
    is_default  INTEGER NOT NULL DEFAULT 0 CHECK (is_default IN (0, 1)),
    sort_order  INTEGER NOT NULL DEFAULT 0,
    created_at  TEXT NOT NULL,
    updated_at  TEXT NOT NULL,
    deleted_at  TEXT
);
CREATE UNIQUE INDEX ux_next_lists_default ON next_lists(is_default) WHERE is_default = 1;
CREATE INDEX ix_next_lists_order ON next_lists(sort_order) WHERE deleted_at IS NULL;

-- 기본 Next(List 이름 없이 'Next' 로 보이는 곳). id 고정 — 어느 PC 에서 만들어도 같은 값.
INSERT INTO next_lists (id, name, is_default, sort_order, created_at, updated_at)
VALUES ('00000000-0000-4000-8000-000000000001', 'Next', 1, 0,
        strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));

CREATE TABLE documents (
    id               TEXT PRIMARY KEY,                 -- local_document_id
    kind             TEXT NOT NULL CHECK (kind IN ('DAY', 'NEXT_LIST')),
    memo_date        TEXT,                             -- DAY: YYYY-MM-DD
    next_list_id     TEXT REFERENCES next_lists(id),   -- NEXT_LIST
    local_revision   INTEGER NOT NULL DEFAULT 0,       -- 로컬 변경마다 +1
    synced_revision  INTEGER NOT NULL DEFAULT 0,       -- 서버가 받아 준 마지막 local_revision
    server_version   INTEGER,                          -- 마지막으로 알고 있는 서버 버전
    sync_enabled     INTEGER NOT NULL DEFAULT 0 CHECK (sync_enabled IN (0, 1)),
    sync_status      TEXT NOT NULL DEFAULT 'local_only'
                     CHECK (sync_status IN ('local_only', 'pending', 'synced', 'auth_required', 'error', 'conflict')),
    sync_error       TEXT,
    created_at       TEXT NOT NULL,
    updated_at       TEXT NOT NULL,
    deleted_at       TEXT,
    CHECK ((kind = 'DAY' AND memo_date IS NOT NULL AND next_list_id IS NULL)
        OR (kind = 'NEXT_LIST' AND next_list_id IS NOT NULL AND memo_date IS NULL))
);
CREATE UNIQUE INDEX ux_documents_day ON documents(memo_date) WHERE kind = 'DAY';
CREATE UNIQUE INDEX ux_documents_list ON documents(next_list_id) WHERE kind = 'NEXT_LIST';
CREATE INDEX ix_documents_sync ON documents(sync_enabled, sync_status);

CREATE TABLE memo_items (
    id            TEXT PRIMARY KEY,                    -- local_item_id (Sync 의 item_key 로도 쓴다)
    document_id   TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
    section       TEXT NOT NULL CHECK (section IN ('main', 'am', 'pm', 'next')),
    kind          TEXT NOT NULL DEFAULT 'checklist' CHECK (kind IN ('checklist', 'text')),
    content_html  TEXT NOT NULL DEFAULT '',
    content_text  TEXT NOT NULL DEFAULT '',            -- 검색용 평문(태그 제거)
    completed     INTEGER NOT NULL DEFAULT 0 CHECK (completed IN (0, 1)),
    completed_at  TEXT,
    favorite      INTEGER NOT NULL DEFAULT 0 CHECK (favorite IN (0, 1)),
    sort_order    INTEGER NOT NULL DEFAULT 0,
    created_at    TEXT NOT NULL,
    updated_at    TEXT NOT NULL,
    deleted_at    TEXT
);
CREATE INDEX ix_items_document ON memo_items(document_id, section, sort_order) WHERE deleted_at IS NULL;
CREATE INDEX ix_items_favorite ON memo_items(updated_at) WHERE favorite = 1 AND deleted_at IS NULL;

CREATE TABLE attachments (
    id                    TEXT PRIMARY KEY,            -- local_attachment_id → attachment://<id>
    document_id           TEXT REFERENCES documents(id) ON DELETE SET NULL,
    item_id               TEXT REFERENCES memo_items(id) ON DELETE SET NULL,
    relative_path         TEXT NOT NULL UNIQUE,        -- 저장 폴더 기준 상대 경로(절대 경로 저장 금지)
    mime_type             TEXT NOT NULL,
    size                  INTEGER NOT NULL,
    content_hash          TEXT NOT NULL,               -- sha256 hex
    original_name         TEXT,
    server_attachment_id  TEXT,
    sync_status           TEXT NOT NULL DEFAULT 'local_only'
                          CHECK (sync_status IN ('local_only', 'uploaded', 'error')),
    created_at            TEXT NOT NULL
);
CREATE INDEX ix_attachments_item ON attachments(item_id);
CREATE INDEX ix_attachments_server ON attachments(server_attachment_id);

-- 문서 단위 변경 이력(수정·삭제·이동 전, Conflict 에서 선택되지 않은 버전 등).
CREATE TABLE document_versions (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    document_id     TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
    reason          TEXT NOT NULL,
    local_revision  INTEGER NOT NULL,
    snapshot_json   TEXT NOT NULL,
    content_text    TEXT NOT NULL,
    created_at      TEXT NOT NULL
);
CREATE INDEX ix_versions_document ON document_versions(document_id, id DESC);

CREATE TABLE sync_links (
    document_id         TEXT PRIMARY KEY REFERENCES documents(id) ON DELETE CASCADE,
    server_document_id  TEXT UNIQUE,                   -- 첫 연결이 끝나야 생긴다
    account_id          TEXT,
    linked_at           TEXT NOT NULL
);

-- 영속 Outbox — 앱이 강제 종료돼도 남는다. 문서·작업마다 1건으로 합친다(최신 revision 만 보내면 된다).
CREATE TABLE sync_outbox (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    document_id      TEXT NOT NULL,
    op               TEXT NOT NULL CHECK (op IN ('LINK', 'PUSH', 'UNLINK')),
    local_revision   INTEGER NOT NULL,
    idempotency_key  TEXT NOT NULL UNIQUE,
    payload          TEXT,
    attempts         INTEGER NOT NULL DEFAULT 0,
    next_attempt_at  TEXT,
    last_error       TEXT,
    created_at       TEXT NOT NULL
);
CREATE UNIQUE INDEX ux_outbox_document_op ON sync_outbox(document_id, op);

CREATE TABLE sync_state (
    key    TEXT PRIMARY KEY,
    value  TEXT NOT NULL
);

CREATE TABLE conflicts (
    id                    TEXT PRIMARY KEY,
    document_id           TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
    local_snapshot_json   TEXT NOT NULL,
    remote_snapshot_json  TEXT NOT NULL,
    local_revision        INTEGER NOT NULL,
    remote_version        INTEGER NOT NULL,
    status                TEXT NOT NULL DEFAULT 'open'
                          CHECK (status IN ('open', 'resolved_local', 'resolved_remote')),
    created_at            TEXT NOT NULL,
    updated_at            TEXT NOT NULL,
    resolved_at           TEXT
);
CREATE UNIQUE INDEX ux_conflicts_open ON conflicts(document_id) WHERE status = 'open';
