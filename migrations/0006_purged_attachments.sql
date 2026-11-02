-- PLAN-A Memo local schema v6 — 영구 삭제한 List 의 이미지 정리 대기
--
-- 영구 삭제하면 그 List 의 이미지도 지운다. 다만 Backup 에는 파일이 들어 있지 않고(DB 만 복사) 이미지를 참조만 하므로,
-- 남아 있는 Backup 이 참조하는 파일을 바로 지우면 그 Backup 을 복원했을 때 이미지가 사라진다. 여기에 적어 두고
-- 참조하는 Backup 이 없어지면 지운다. 다른 메모가 쓰고 있으면 지우지 않고 이 표에서만 뺀다.
-- 새 테이블만 추가한다(기존 테이블·데이터는 그대로). PLAN-A Work 로 보내지 않는다.
CREATE TABLE purged_attachments (
    attachment_id  TEXT PRIMARY KEY,
    purged_at      TEXT NOT NULL
);
