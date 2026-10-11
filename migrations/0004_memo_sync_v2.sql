-- PLAN-A Memo local schema v4 — PLAN-A Work memo-sync-v2(공통 관리 상태) 연결
--
-- 연결된 DAY 의 복사 이력·복사 안내·알림 설정·알림 발생(occurrence)·확인(ACK)을 PLAN-A Work 서버와 함께 쓴다.
-- 기존 테이블·데이터(0001–0003: 메모·복사 이력 item_copies·안내 carryover_prompts·알림 day_reminders)는 그대로 둔다 —
-- 새 테이블만 추가한다. Local-only DAY 는 지금처럼 이 PC 의 테이블만 쓴다(서버로 보내지 않는다).
-- 모든 서버 관리 상태는 account_key('<server namespace>|<user_id>')로 나눈다 — 다른 계정·다른 환경의 상태를 섞지 않는다.

-- ── 서버 관리 명령 Outbox(복사·건너뛰기·알림 설정·확인) ───────────────────────────
-- 문서 본문 Push(sync_outbox)와 따로 둔다. 같은 날짜의 복사 명령은 그 날짜의 본문 Push 보다 **먼저** 보낸다(v2 Contract).
--   body_json  : 처음 보낸 요청 본문 그대로 — 응답을 잃으면 같은 request_id·같은 본문으로 다시 보낸다(서버 결과 재사용).
--   payload_json : 이 PC 쪽 정보(원본·복사본 로컬 id, 복사 당시 본문, 알림 제안 등) — 서버로 보내지 않는다.
--   status     : pending(보낼 차례) · done(서버 확정) · conflict(알림 설정 충돌 — 사용자 선택 대기) · dropped(연결 해제 등으로 보내지 않음)
--   reconciled : 복사 결과를 그 날짜 문서에 맞췄는가(복사 명령만)
CREATE TABLE management_outbox (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    account_key      TEXT NOT NULL,
    memo_date        TEXT NOT NULL,
    kind             TEXT NOT NULL CHECK (kind IN ('carry', 'dismiss', 'rule', 'ack')),
    request_id       TEXT NOT NULL UNIQUE,
    route            TEXT,
    body_json        TEXT,
    payload_json     TEXT NOT NULL DEFAULT '{}',
    status           TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'done', 'conflict', 'dropped')),
    result_json      TEXT,
    reconciled       INTEGER NOT NULL DEFAULT 1 CHECK (reconciled IN (0, 1)),
    sent_at          TEXT,
    attempts         INTEGER NOT NULL DEFAULT 0,
    next_attempt_at  TEXT,
    last_error       TEXT,
    created_at       TEXT NOT NULL,
    updated_at       TEXT NOT NULL
);
CREATE INDEX ix_management_outbox_pending ON management_outbox(account_key, status, id);
CREATE INDEX ix_management_outbox_day ON management_outbox(account_key, memo_date);

-- ── 연결된 DAY 의 서버 관리 상태(날짜당 1행, 계정별) ─────────────────────────────
-- rule_* 는 서버가 확정한 알림 설정(version 은 서버 rule.version — 메모 version·관리 revision 과 별개).
-- rule_conflict_json : 서버 설정과 이 PC 설정이 달라 사용자가 골라야 함({current, proposed, initial})
-- carry_candidates_json : 서버가 알려 준 '아직 복사하지 않은' 원본 서버 id 목록(마지막 조회 시점)
CREATE TABLE shared_days (
    account_key            TEXT NOT NULL,
    memo_date              TEXT NOT NULL,
    link_id                TEXT,
    management_revision    INTEGER NOT NULL DEFAULT 0,
    rule_version           INTEGER NOT NULL DEFAULT 0,
    rule_timezone          TEXT,
    rule_time              TEXT,
    rule_offsets           TEXT NOT NULL DEFAULT '[]',
    rule_conflict_json     TEXT,
    prompt_dismissed       INTEGER NOT NULL DEFAULT 0 CHECK (prompt_dismissed IN (0, 1)),
    prompt_copied_count    INTEGER NOT NULL DEFAULT 0,
    carry_candidates_json  TEXT,
    carry_auto_prompt      INTEGER,
    carry_checked_at       TEXT,
    state_json             TEXT,
    state_stale            INTEGER NOT NULL DEFAULT 0 CHECK (state_stale IN (0, 1)),
    updated_at             TEXT NOT NULL,
    PRIMARY KEY (account_key, memo_date)
);

-- ── 알림 발생(occurrence) — 서버 공통 id(1주 전·2일 전이 서로 다른 발생) ───────────────────
-- local_ack_at : 이 PC 에서 사용자가 확인했다(서버로 보냈거나 보낼 차례)
CREATE TABLE shared_occurrences (
    account_key      TEXT NOT NULL,
    memo_date        TEXT NOT NULL,
    offset_days      INTEGER NOT NULL CHECK (offset_days IN (7, 2)),
    occurrence_id    TEXT NOT NULL,
    scheduled_at     TEXT,
    state            TEXT NOT NULL,
    delivery_status  TEXT,
    acknowledged_at  TEXT,
    local_ack_at     TEXT,
    updated_at       TEXT NOT NULL,
    PRIMARY KEY (account_key, memo_date, offset_days)
);
CREATE UNIQUE INDEX ux_shared_occurrences_id ON shared_occurrences(account_key, occurrence_id);

-- ── 이 PC 가 띄운 Windows 알림 — 누를 때 쓰는 일회용 token(알림 주소에 서버 id 를 넣지 않는다) ─────────
-- occurrences_json : 이 알림이 알린 발생 id 목록(연결된 날짜만). withdraw : 다른 곳에서 확인돼 화면에서 거둘 알림
CREATE TABLE reminder_toasts (
    token             TEXT PRIMARY KEY,
    account_key       TEXT,
    tag               TEXT NOT NULL,
    dates_json        TEXT NOT NULL,
    occurrences_json  TEXT NOT NULL DEFAULT '[]',
    shown_at          TEXT NOT NULL,
    used_at           TEXT,
    withdraw          INTEGER NOT NULL DEFAULT 0 CHECK (withdraw IN (0, 1)),
    withdrawn_at      TEXT
);
CREATE INDEX ix_reminder_toasts_withdraw ON reminder_toasts(withdraw, withdrawn_at);

-- ── 복사 결과를 자동으로 합칠 수 없을 때 사용자에게 묻는 항목 ─────────────────────────
--   both_changed   : 이 PC 의 복사본과 PLAN-A Work 의 복사본이 둘 다 바뀜
--   server_removed : PLAN-A Work 에서 지워졌거나 다른 날짜로 옮겨진 복사본을 이 PC 에서 고쳤음
--   duplicate      : 같은 원본의 복사본이 이미 있는데 이 PC 에서 따로 고친 복사본이 있음
--   copy_failed    : 서버가 복사를 받지 않음(원본이 바뀜·완료·삭제 등)
CREATE TABLE carry_reviews (
    id                 TEXT PRIMARY KEY,
    account_key        TEXT NOT NULL,
    memo_date          TEXT NOT NULL,
    kind               TEXT NOT NULL CHECK (kind IN ('both_changed', 'server_removed', 'duplicate', 'copy_failed')),
    item_id            TEXT NOT NULL,
    canonical_item_id  INTEGER,
    other_item_id      TEXT,
    local_html         TEXT,
    server_html        TEXT,
    status             TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved_local', 'resolved_server')),
    created_at         TEXT NOT NULL,
    resolved_at        TEXT
);
CREATE INDEX ix_carry_reviews_open ON carry_reviews(account_key, memo_date, status);
