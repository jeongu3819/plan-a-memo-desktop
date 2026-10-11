-- PLAN-A Memo local schema v3 — 지난 미완료 가져오기 · 날짜별 알림
--
-- 모두 이 PC 의 메타데이터다. 메모 내용(memo_items)·Sync 단위(documents)·Sync Contract 는 바꾸지 않는다.
-- PLAN-A Work 로 보내지 않는다(서버 DTO 에 없는 값 — 여러 기기 공유가 필요하면 별도 Contract 확장).
-- 기존 테이블·데이터는 건드리지 않는다(새 테이블만 추가).

-- ── 지난주 같은 요일의 미완료 체크리스트 안내(대상 날짜당 1건) ─────────────────────
--   shown    : 안내를 보였다(아직 고르지 않음)
--   skipped  : [이번에는 건너뛰기] — 다시 자동 안내하지 않는다(보조 메뉴로는 언제든 다시 볼 수 있다)
--   imported : 고른 항목을 가져왔다
CREATE TABLE carryover_prompts (
    target_date  TEXT PRIMARY KEY,               -- 안내를 받은 날짜(YYYY-MM-DD)
    source_date  TEXT NOT NULL,                  -- 바로 지난주 같은 요일
    status       TEXT NOT NULL CHECK (status IN ('shown', 'skipped', 'imported')),
    created_at   TEXT NOT NULL,
    updated_at   TEXT NOT NULL
);

-- ── 복사 관계 — 같은 원본을 같은 날짜로 두 번 복사하지 않게(재클릭·재실행·재시도) ─────────
-- 복사본은 새 memo_items.id(따라서 Sync 의 새 client_key)다. 원본은 바꾸지 않는다.
CREATE TABLE item_copies (
    source_item_id  TEXT NOT NULL,
    source_date     TEXT NOT NULL,
    target_date     TEXT NOT NULL,
    new_item_id     TEXT NOT NULL,
    copied_at       TEXT NOT NULL,
    PRIMARY KEY (source_item_id, target_date)
);
CREATE INDEX ix_item_copies_target ON item_copies(target_date);

-- ── 날짜별 알림 — 대상 날짜 · 미리 알림(7일 전/2일 전) 하나에 1행 ──────────────────────
-- 알림 시각(fire_at)은 사용자 PC 의 로컬 시각('YYYY-MM-DDTHH:MM'). 매주 반복하지 않는다(그 날짜에만).
--   pending   : 예약됨(아직 시각이 오지 않음 · 또는 지났는데 아직 처리하지 않음)
--   delivered : Windows 알림을 띄웠다
--   skipped   : 시각에 확인해 보니 완료하지 않은 체크리스트가 없어 띄우지 않았다
--   expired   : 저장할 때 이미 지난 시각 · 대상 날짜가 지나 버린 놓친 알림(소급 발송하지 않음)
--   missed    : PC 가 꺼져 있는 등으로 시각에 띄우지 못해 앱을 다시 열 때 한 번 안내했다
CREATE TABLE day_reminders (
    memo_date    TEXT NOT NULL,
    offset_days  INTEGER NOT NULL CHECK (offset_days IN (7, 2)),
    remind_time  TEXT NOT NULL,                  -- 'HH:MM'
    fire_at      TEXT NOT NULL,                  -- 로컬 'YYYY-MM-DDTHH:MM'
    status       TEXT NOT NULL DEFAULT 'pending'
                 CHECK (status IN ('pending', 'delivered', 'skipped', 'expired', 'missed')),
    handled_at   TEXT,
    created_at   TEXT NOT NULL,
    updated_at   TEXT NOT NULL,
    PRIMARY KEY (memo_date, offset_days)
);
CREATE INDEX ix_day_reminders_due ON day_reminders(status, fire_at);
