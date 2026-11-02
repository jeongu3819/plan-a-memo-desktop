-- PLAN-A Memo local schema v5 — List 휴지통
--
-- 삭제한 List 를 7일 동안 복구할 수 있게 하는 이 PC 의 메타데이터다. PLAN-A Work 로 보내지 않는다.
-- 새 테이블만 추가한다(기존 테이블·데이터는 그대로). List 이름·순서·메모는 원래 자리(next_lists · memo_items)에
-- deleted_at 표시만 달고 남으므로 복구는 표시를 지우는 것이고, 이미지 정리는 계속 이 메모들을 참조로 본다.
--
-- 이 표의 행이 있고 next_lists.deleted_at 이 있어야 휴지통 항목이다 — 예전 버전에서 지운 List(메모는 Next 로 옮겨짐)는
-- 행이 없어 나타나지 않고, Web 에서 다시 연결해 되살아난 List 는 deleted_at 이 지워져 휴지통에서 빠진다.
CREATE TABLE list_trash (
    list_id      TEXT PRIMARY KEY,
    was_linked   INTEGER NOT NULL DEFAULT 0,  -- 지울 때 PLAN-A Work 와 연결돼 있었는가(복구 안내용)
    deleted_at   TEXT NOT NULL,
    purge_after  TEXT NOT NULL                -- 이 시각이 지나면 영구 삭제 대상(deleted_at + 7일, UTC)
);
CREATE INDEX ix_list_trash_purge ON list_trash(purge_after);
