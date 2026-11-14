-- PLAN-A Memo local schema v7 — 요일마다 생성(매주 반복)
--
-- 이 PC 의 메타데이터다. memo-sync-v1/v2 Contract 에는 반복 규칙이 없다(Web 의 반복은 서버가 관리하는 메타데이터) —
-- PLAN-A Work 로 보내지 않고, Web 과 공유하는 것처럼 표시하지 않는다.
-- 새 테이블만 추가한다(기존 테이블·데이터는 그대로). 회차는 평범한 memo_items 행이다(새 id = 새 Sync client_key).
--
-- 규칙 하나 = 원본 메모 하나. 같은 원본에 살아 있는 규칙은 하나뿐이다.
-- 회차는 필요한 날짜에만 만든다 — 오늘부터 2주(가까운 같은 요일 두 번)와, 화면이 그보다 먼 날짜를 읽을 때 그 날짜.
-- 무한히 미리 만들지 않는다.
CREATE TABLE memo_recurrences (
    id                    TEXT PRIMARY KEY,
    source_item_id        TEXT NOT NULL,                   -- 반복을 시작한 메모(지우거나 옮겨도 규칙은 그대로)
    source_date           TEXT NOT NULL,                   -- 원본 메모의 날짜(YYYY-MM-DD)
    weekday               INTEGER NOT NULL CHECK (weekday BETWEEN 0 AND 6),  -- 0 = 일요일 … 6 = 토요일(원본 날짜의 요일)
    section               TEXT NOT NULL CHECK (section IN ('main', 'am', 'pm')),
    kind                  TEXT NOT NULL CHECK (kind IN ('checklist', 'text')),
    content_html          TEXT NOT NULL,                   -- 반복을 시작할 때의 본문(이후 원본을 고쳐도 바뀌지 않는다)
    starts_on             TEXT NOT NULL,                   -- 첫 회차 날짜(원본 다음 주 같은 요일 · 지난 날짜면 오늘 이후 첫 같은 요일)
    materialized_through  TEXT,                            -- 이 날짜까지는 회차를 빠짐없이 확인했다(빠른 건너뛰기용)
    stopped_at            TEXT,                            -- 반복 중지(이후 새 회차를 만들지 않는다)
    created_at            TEXT NOT NULL,
    updated_at            TEXT NOT NULL
);
CREATE UNIQUE INDEX ux_recurrences_active_source ON memo_recurrences(source_item_id) WHERE stopped_at IS NULL;
CREATE INDEX ix_recurrences_active ON memo_recurrences(stopped_at);

-- 회차 기록 — (규칙, 날짜) 당 1행. 행이 있으면 그 날짜에는 다시 만들지 않는다
-- (회차를 지우거나 다른 날로 옮겨도 · 여러 번 조회해도 · 앱을 다시 열어도 중복되지 않는다). 본문 문자열로 비교하지 않는다.
CREATE TABLE memo_recurrence_occurrences (
    recurrence_id    TEXT NOT NULL REFERENCES memo_recurrences(id) ON DELETE CASCADE,
    occurrence_date  TEXT NOT NULL,
    item_id          TEXT NOT NULL,                        -- 만든 메모(memo_items.id)
    created_at       TEXT NOT NULL,                        -- 만든 시각 = 그 메모의 처음 updated_at(손대지 않았는지 판단)
    PRIMARY KEY (recurrence_id, occurrence_date)
);
CREATE INDEX ix_recurrence_occurrences_item ON memo_recurrence_occurrences(item_id);
CREATE INDEX ix_recurrence_occurrences_date ON memo_recurrence_occurrences(occurrence_date);
