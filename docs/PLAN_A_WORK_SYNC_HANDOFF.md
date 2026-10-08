# PLAN-A Work 수정·확인 요청 (memo-sync-v1 · Desktop 연동)

> 보낸 쪽: PLAN-A Memo Desktop(이 저장소). 기준: `docs/upstream-plan-a-work/` 스냅샷 4개 파일.
> Desktop 은 `plan-a-work` 저장소를 수정하지 않았고, SQL 을 실행하지 않았고, 서버 flag 를 켜지 않았다.
> Desktop 쪽 검증 결과는 [sync-contract-verification.md](sync-contract-verification.md).

| # | 항목 | 종류 | 상태(4차 스냅샷 기준) |
|---|---|---|---|
| 1 | 로컬 경로 검사 정규식이 `https://` 링크를 거절 | 버그 | **PLAN-A Work 수정 완료**(URL 속성·CSS url() 문맥 검사, 422 `{code, item}`) — Desktop Mock·안내 반영 완료. 실제 서버 확인은 통합 때 |
| 2 | 이미 있는 Next List 의 이름 변경 API 없음 | 기능 확장 | **v1 범위 밖으로 확정**(계약: 응답 전용, 통합 전제 아님). Desktop 은 'PC 에만' 유지 |
| 3 | Contract ↔ 코드 확인 요청 | 확인 | **답변 받음**(READINESS §2 A–E): source 명시, manifest 중복 없음, 크기 422/413, 이동 409 code 유지, 폐기 기기 409 `device_revoked` — Desktop 반영 완료 |
| 4 | 실제 통합 테스트 준비 | 환경 | **대기** — 승인된 일회용 MySQL·Staging·OAuth·저장소(READINESS §6–9) |
| 5 | 다음 스냅샷에 넣어 줄 파일 | 자료 | 일부 — `services/memo_sync.py`·models 는 아직 스냅샷에 없음(READINESS 문서로 동작 확인) |
| 6 | 폐기 기기 안내를 Desktop 이 받을 수 있게(선택) | 개선 제안 | 신규 — §6 |

---

## 1. 로컬 경로 검사가 정상 `https://` 링크를 거절한다

### 1-1. 위치

스냅샷 4개 파일에는 이 검사가 **없다**. `memo_sync_api.py` 의 Push 가 부르는 서비스 함수에 있다.

* 호출: `source/memo_sync_api.py:348` — `value = sync.normalize(db, doc, body.model_dump(include={'items', 'deleted'}))`
* 정의(2차 작업 때 `ccb4998` 에서 확인, 이번 스냅샷 밖): `backend/app/services/memo_sync.py` · `normalize()`

```python
if re.search(r'(?:file:|[A-Za-z]:[\\/])', item['content'], re.I):
    raise HTTPException(422, 'Local paths are not allowed')
```

(이번 작업에서는 외부 저장소를 다시 열지 않았다. 현재 코드에 같은 줄이 있는지 PLAN-A Work 에서 확인해 달라.)

### 1-2. 발생 조건

HTML **전체 문자열**에서 `영문자 + ':' + '/' 또는 '\'` 를 찾는다. 그래서

* `https://` 의 `s:/`, `http://` 의 `p:/` 가 '드라이브 경로' 로 잡힌다 — **링크가 하나라도 있는 메모는 Push 가 422**.
* `file:` 은 본문 글자에도 걸린다 — 예: `profile: 설정`.
* 하나의 항목만 걸려도 **문서(그 날짜/List) 전체** Push 가 거절된다.

`normalize()` 는 Desktop Push(`native/documents/{id}/push`) 경로에서 불린다. Web 저장 경로(`personal_memos`)에 같은
검사가 있는지는 스냅샷으로 확인할 수 없다. Web 에서 링크를 넣을 수 있다면, 그런 날짜는 Desktop 이 연결해서 한 번이라도
수정하는 순간부터 그 날짜 전체가 올라가지 않는다(Push 는 문서 전체를 보내므로 Web 이 넣은 링크도 함께 검사된다).

### 1-3. 재현 Payload

`POST /api/memo-sync/native/documents/{document_id}/push`(유효한 Desktop credential, 연결된 DAY)

```json
{
  "base_version": 2,
  "local_version": 5,
  "request_id": "repro-https-link-0001",
  "link_id": "<현재 link generation>",
  "deleted": false,
  "items": [
    {"id": 101, "item_version": 1, "section": "main", "kind": "checklist", "completed": false, "sort_order": 0,
     "content": "<p>배포 문서 <a href=\"https://example.com/docs\" target=\"_blank\" rel=\"noopener noreferrer\">링크</a></p>"},
    {"client_key": "repro0000000000000000000000000001", "section": "pm", "kind": "text", "completed": false, "sort_order": 0,
     "content": "<p>profile: 설정 확인</p>"}
  ]
}
```

현재 결과: `422 {"detail": "Local paths are not allowed"}` — 두 항목 모두 단독으로도 422.

### 1-4. 사례별 결과 (현행 정규식 vs 아래 제안)

Desktop 이 같은 정규식을 JavaScript 로 옮겨 돌린 결과다(서버에서 실행한 결과가 아니다 — §1-6 테스트로 확인 필요).

| 본문(HTML) | 의미 | 현행 | 제안 | 기대 |
|---|---|---|---|---|
| `<a href="https://example.com/docs">문서</a>` | 정상 https 링크 | **거절** | 허용 | 허용 |
| `<p>http://intranet/wiki 참고</p>` | 주소를 글자로 적음 | **거절** | 허용 | 허용 |
| `<p>profile: 설정 확인</p>` | 일반 글자 | **거절** | 허용 | 허용 |
| `<p>10:30/11:00 회의, 비율 3:1</p>` | 시각·비율 | 허용 | 허용 | 허용 |
| `<img src="/api/personal-memos/images/ab12.png/download">` | 서버 이미지 | 허용 | 허용 | 허용 |
| `<p>경로는 C:\Users\me\a.png 입니다</p>` | 경로를 **글자로** 적음(참조 아님) | 거절 | 허용 | 정책 결정(아래) |
| `<img src="file:///C:/Users/me/a.png">` | 로컬 파일 이미지 | 거절 | 거절 | 거절 |
| `<img src="C:\Users\me\a.png">` | 드라이브 경로 이미지 | 거절 | 거절 | 거절 |
| `<a href="C:/Users/me/a.docx">a</a>` | 드라이브 경로 링크 | 거절 | 거절 | 거절 |
| `<a href="\\fileserver\share\a.xlsx">a</a>` | UNC 경로 링크 | **허용(누락)** | 거절 | 거절 |
| `<a href="file&#58;///C:/a.txt">a</a>` | 엔티티로 숨긴 `file:` | 거절 | 거절 | 거절 |
| `<p style="background:url('file:///C:/a.png')">` | CSS `url(file:)` | 거절 | 거절 | 거절 |

### 1-5. 로컬 경로를 계속 막아야 하는 이유

* Desktop PC 의 경로(`C:\Users\<이름>\…`)가 서버·Web·다른 기기로 퍼진다(사용자 이름 등 개인정보 노출).
* 다른 기기·Web 에서는 그 파일이 없어 이미지·링크가 깨진다. Contract 도 "Server URLs … never a Desktop file path,
  blob URL or data URI" 를 요구한다.
* `file:` 링크는 브라우저·OS 에서 로컬 파일을 여는 경로가 될 수 있다.

Desktop 은 이미 로컬 이미지를 `attachment://<id>` 로 저장하고 전송 사본에서만 서버 이미지 주소로 바꾸므로,
**정상 동작에서는 경로 참조를 보내지 않는다.** 서버 검사는 비정상 입력을 막는 마지막 방어선으로 남겨야 한다.

### 1-6. 권장 수정 방향

모든 경로 검사를 지우지 말고, **URL 이 실제로 쓰이는 자리만** 검사한다.

1. `prepare_content()` 가 이미 HTML 을 파싱·정리한다면(현재 sanitizer) 그 **결과 DOM** 에서 검사한다.
2. 검사 대상: `href`, `src`, `srcset`(쉼표로 나눈 각 URL), `poster`, `action`, `formaction`, `background`, `data`,
   `xlink:href` 속성 값과 `style` 안의 `url(...)`. HTML 엔티티를 먼저 풀고, 앞뒤 공백·제어 문자를 지운 값으로 본다.
3. 거절 조건(값의 **시작**): `file:` scheme, `^[A-Za-z]:[\\/]`(드라이브), `\\` 또는 `//server/share`(UNC).
   더 단단하게 하려면 허용 목록으로: `href` 는 `http`·`https`·`mailto`·`tel`·상대 경로만, `img src` 는
   `/api/personal-memos/images/<name>/download` 만(Contract 이미지 규칙과 같음).
4. 본문 **글자**(text node)는 경로처럼 보여도 참조가 아니므로 검사하지 않는 것을 권장한다. 글자로 적은 경로까지 막아야
   한다는 정책이라면, 그 경우에도 `https://` 같은 scheme 뒤의 `:/` 는 제외해야 한다(예: `(?<![A-Za-z0-9+.-])[A-Za-z]:[\\/](?!/)`
   — 앞 글자가 scheme 문자가 아니고 `://` 가 아닌 경우만).
5. 오류 응답은 지금처럼 422 를 유지하되, 가능하면 `{"detail": {"code": "local_path_not_allowed", "item": <index>}}` 처럼
   어느 항목인지 알려 주면 Desktop 이 그 항목을 표시할 수 있다(선택).

참고 구현 스케치(서버 코드에 맞게 바꿔서):

```python
URL_ATTRS = {'href', 'src', 'srcset', 'poster', 'action', 'formaction', 'background', 'data', 'xlink:href'}
LOCAL_REF = re.compile(r'^(?:file:|[A-Za-z]:[\\/]|\\\\|//[^/]+/)', re.I)
CSS_URL = re.compile(r'url\(\s*([\'"]?)(.*?)\1\s*\)', re.I | re.S)

def _local_reference(value: str) -> bool:
    value = html.unescape(value or '').strip().replace('\x00', '')
    return bool(LOCAL_REF.match(value))

def has_local_reference(fragment) -> bool:          # fragment = prepare_content 가 파싱한 DOM
    for el in fragment.iter():
        for name, value in el.attrib.items():
            name = name.lower()
            if name == 'srcset':
                if any(_local_reference(part.strip().split(' ')[0]) for part in value.split(',')):
                    return True
            elif name in URL_ATTRS and _local_reference(value):
                return True
            elif name == 'style' and any(_local_reference(m.group(2)) for m in CSS_URL.finditer(value)):
                return True
    return False
```

### 1-7. 필요한 Backend Regression Test

`backend/tests/test_memo_sync.py` 에 Push 단위로(422 여부 + 저장 결과):

1. `https://`·`http://` 링크(`<a href>`·글자) 가 있는 항목 → accepted, 본문 그대로 저장.
2. `profile:`·`10:30/11:00`·`3:1` 같은 글자 → accepted.
3. 서버 이미지 주소 `<img src="/api/personal-memos/images/<name>/download">` → accepted(기존 테스트 유지).
4. `<img src="file:///C:/…">`, `<img src="C:\…">`, `<a href="C:/…">`, `<a href="\\server\share\…">`,
   엔티티(`file&#58;`), 대소문자(`FILE:`), 앞 공백(`  file:`), `srcset`, `style="background:url(file:…)"` → 422.
5. 한 문서에 정상 항목 + 경로 항목 → 문서 전체 422, **서버 문서·version·항목이 바뀌지 않음**(부분 저장 없음).
6. 같은 request_id 재전송: 422 는 `memo_sync_requests` 에 기록되지 않으므로, 고친 본문을 같은 request_id 로 보내도
   `request_id_reused` 가 아니어야 한다(현재 구조 유지 확인).
7. Web 저장 경로(`personal_memos`)의 기존 검사·sanitizer 회귀가 없는지.

### 1-8. Desktop 에 미치는 영향

| | 수정 전(현재) | 수정 후 |
|---|---|---|
| 링크 없는 날짜/List | 정상 | 정상 |
| 링크가 있는 날짜/List | 그 문서만 '오류' + 이유 표시. 로컬 내용·링크는 그대로, Outbox 보관, 1시간마다(또는 [지금 동기화]) 같은 내용으로 재시도. 다른 문서는 계속 동기화 | 다음 재시도에서 그대로 올라감(Desktop 변경 불필요) |
| 경로 참조 | Desktop 은 보내지 않음(`attachment://` → 서버 이미지 주소 변환) | 같음 |

Desktop 은 링크를 지우거나 본문을 고쳐서 우회하지 **않는다**(이번 작업에서 안내 문구의 '해당 글자를 빼면 보낼 수 있습니다'
권유도 없앴다). (4차: 서버 수정 후 Mock 은 `sync/reference.rs` 의 URL 위치 검사로 교체했다.) 3차 당시 Mock 서버(`sync/mock.rs::server_rejects_as_local_path`)는 현행 규칙을 그대로 흉내 내고 있으므로, 서버가
고쳐지면 Mock 도 같은 규칙으로 바꾼다.

---

## 2. Next List 이름 변경 API (확장 요청)

현재 Contract·코드에 있는 것: 기본 Next(`default`), `GET web/lists`, `POST web/lists`, `POST native/lists {id, title}`
(같은 id·같은 제목만 재시도 안전, **제목이 다르면 409**), `PUT web/lists/{list_id}/items/{memo_id}`(소속 이동).
**이미 있는 List 의 이름을 바꾸는 경로는 Web·native 모두 없다.** Push 문서에도 제목 필드가 없다(`title` 은 응답 전용).

Desktop 의 현재 동작(이번 작업):

* List 이름은 이 PC 의 정보로 취급 — 연결된 List 라도 이름 변경은 서버로 보내지 않고, 화면에서
  "이름은 이 PC 에만 바뀌고 PLAN-A Work 의 List 이름은 바뀌지 않습니다" 라고 알린다.
* 이름을 바꾼 뒤 다시 연결해도 `POST native/lists` 의 409 를 '이미 있는 List' 로 보고 연결을 이어 간다.
* 존재하지 않는 Endpoint 는 부르지 않는다. 이후 API 가 생기면 `SyncTransport` 에 메서드 하나와 Outbox 작업 하나를
  더하는 것으로 붙일 수 있다(Mapper·UI 경계는 유지).

요청(양방향 이름 변경이 필요하다면):

```
PATCH /api/memo-sync/native/lists/{list_id}   {"title": "...", "request_id": "..."}   (Desktop credential)
PATCH /api/memo-sync/web/lists/{list_id}      {"title": "..."}                        (Web session + CSRF)
```

* 소유권 검사, `default` 는 거절, 1–120자.
* 연결된 기기에 알릴 이벤트(예: changes `kind=renamed` 또는 문서 version 증가 + snapshot `title` 변경) — Desktop 은
  snapshot `title` 이 바뀌면 로컬 이름에 반영할 수 있다.
* 양쪽에서 동시에 바꾼 경우 규칙(마지막 저장 우선을 쓸지, 비교를 쓸지)을 Contract 에 명시.

---

## 3. Contract ↔ 코드 확인 요청

4개 파일만으로 결론을 낼 수 없거나, 문서와 코드가 다르게 읽히는 곳이다. Desktop 은 어느 한쪽으로 임의로 바꾸지 않았다.

1. **Conflict `source` 기본값** — `push()`(api.py:352)는 `MemoSyncConflict(...)` 에 `source` 를 넣지 않는다. DDL 의
   `memo_sync_conflicts.source` 는 `NOT NULL`, 기본값 없음. ORM 모델에 Python 기본값 `'desktop'` 이 있는지 확인해 달라.
   없으면 Desktop Push 가 conflict 를 만들 때마다 500 이 난다.
2. **ACK manifest 중복** — `ack()`(api.py:375)는 `sorted(body.attachments) != sorted(a['name'] for a in manifest)`
   로 비교한다. 같은 이미지를 한 문서에서 두 번 쓰면 `sync.attachments()` 가 이름을 두 번 돌려주는지? 돌려준다면 Desktop
   (이름 중복 없이 보냄)의 ACK 가 계속 `attachments_incomplete` 가 된다. 이름 집합(set) 비교 또는 manifest 중복 제거를 권장.
3. **항목 크기 초과 상태 코드** — MEMO_SYNC_IMPLEMENTATION 표는 '413 용량' 이지만, 항목 50만 자·1,000개 초과는 Pydantic
   (`max_length`)이라 **422**, 문서 2MB 는 `normalize` 의 413 이다. Desktop 은 413·422 모두 '그 문서만 거절' 로 같게
   처리하므로 기능 문제는 없다. 문서 표만 맞춰 달라.
4. **다른 문서 항목 요구 시 409 code** — Contract 는 "a Desktop push cannot claim an item belonging to another unit"
   이라고만 적는다. Desktop 은 `item_moved_or_not_owned`·`client_key_in_use`(2차 때 확인)를 '다른 위치에서 이미 변경'
   안내로 처리한다. code 이름이 바뀌었다면 알려 달라(바뀌어도 데이터 손상은 없고 안내만 일반 오류가 된다).
5. **폐기한 기기의 재인증** — `exchange()`(api.py:216–223)는 `device_id` 로 다시 인증하면 폐기된 기기도 `revoked_at=None`
   으로 되살린다(링크는 비활성 유지). Contract 의 "Explicitly revoked links stay inactive" 와는 맞지만, Web 기기 관리에서
   '해제' 한 기기가 같은 owner 의 재로그인으로 다시 목록에 나타나는 것이 의도인지 확인해 달라. Desktop 은 어느 쪽이든
   이후 Push 의 409 `link_inactive` 로 연결을 끝내고 로컬 내용을 지킨다.
6. (선택) **계정 표시 정보** — exchange 응답에 `user_id` 만 있어 Desktop 은 "PLAN-A Work 사용자 #42" 로 표시한다.
   이메일·이름(표시용) 또는 `GET native/me` 가 있으면 사용자가 어느 계정으로 연결했는지 알 수 있다.

---

## 4. 실제 Web ↔ EXE 통합 테스트 준비

### 4-1. 서버 준비 조건(모두 PLAN-A Work 쪽, Desktop 은 하지 않음)

| # | 조건 | 확인 |
|---|---|---|
| 1 | 승인된 개발용/Staging DB 에 `memo-sync-v1.mysql.sql` migration 적용 | ☐ |
| 2 | `MEMO_SYNC_ENABLED=true` | ☐ |
| 3 | `MEMO_SYNC_SCHEMA_READY=true` | ☐ |
| 4 | `MEMO_SYNC_ENVIRONMENT=local` 또는 `staging`, `MEMO_SYNC_SERVER_ID` 설정 (**production 금지** — Desktop 개발 빌드는 production namespace 를 거부한다) | ☐ |
| 5 | Frontend `VITE_MEMO_SYNC_ENABLED=true` 배포 | ☐ |
| 6 | `/memo-desktop/authorize` 화면 사용 가능 | ☐ |
| 7 | HTTPS(staging) 또는 `http://127.0.0.1:<port>`(로컬) / 동의 후 `http://127.0.0.1:<port>/memo-sync/callback` 으로 이동이 CSP·브라우저 정책에 막히지 않음 | ☐ |
| 8 | 이미지 Storage(S3 또는 로컬 UPLOAD_DIR) 와 inline image 정책 | ☐ |
| 9 | 테스트 사용자, (필요하면) 두 번째 테스트 사용자 | ☐ |
| 10 | §1 정규식 수정 배포 | ☐ |

### 4-2. Desktop 실행 방법(운영 Installer 사용 금지)

운영 Installer(0.2.x)는 `https://planawork.com` 고정이다. **통합 테스트에 쓰지 않는다.** 개발 빌드를 쓴다.

```powershell
npm run e2e:build                                   # development debug 빌드
$env:PLANA_SERVER_ORIGIN = "https://staging.planawork.com"   # 또는 http://127.0.0.1:8000 (로컬 Backend)
npm run e2e                                         # 실제 서버 모드: Mock 전용 단계는 건너뛴다
```

* 개발 빌드는 `planawork.com`(운영) 주소를 거부하고, 서버 namespace 가 `production` 이면 credential 을 저장하지 않는다.
* credential 은 Windows 자격 증명 관리자의 `PLAN-A Memo (development…)` 항목에만 저장된다(운영 항목과 분리).
* 앱 설정·저장 폴더는 E2E 실행마다 임시 폴더(`PLANA_CONFIG_DIR`) — 사용자 메모와 섞이지 않는다.

### 4-3. 실제 E2E 시나리오(Mock 결과와 따로 기록)

| 시나리오 | 검증 항목 | 결과 |
|---|---|---|
| Desktop 최초 로그인 | 브라우저·PKCE·Loopback·Token(Windows 자격 증명 관리자) | 미실행 |
| Device 등록 | Web 기기 목록에 표시 | 미실행 |
| Desktop → Web DAY 연결 | 선택한 날짜 전체만 연결 | 미실행 |
| Web → Desktop DAY 연결 | 지정한 PC 에만 내려받음 | 미실행 |
| NEXT_LIST 연결 | 선택한 List 만 | 미실행 |
| 최초 내용 충돌 | 양쪽 내용 보존, 비교 화면 | 미실행 |
| Desktop 수정 → Web | 자동 반영 | 미실행 |
| Web 수정 → Desktop | 자동 반영(30초 주기 또는 [지금 동기화]) | 미실행 |
| 체크·이동·삭제 | 양쪽 일치, History | 미실행 |
| 이미지 | 양쪽 표시, ACK synced | 미실행 |
| https 링크가 있는 메모 | §1 수정 후 정상 반영 | 미실행(현재 서버는 거절) |
| 오프라인 | 복구 후 반영 | 미실행 |
| 강제 종료 | Outbox 유지 후 전송 | 미실행 |
| Conflict | 사용자가 최신 선택, 선택 안 한 쪽 History | 미실행 |
| Stale Conflict | 이전 선택 거절(409) 후 비교 새로 고침 | 미실행 |
| Unlink | 양쪽 사본 유지 | 미실행 |
| Device Revoke | 이후 API 401, 로컬 유지 | 미실행 |

---

## 5. 다음 스냅샷에 넣어 줄 파일

`docs/upstream-plan-a-work/README.md` 에 원본 commit 번호와 함께:

* `backend/app/services/memo_sync.py` — `normalize`, `snapshot`, `attachments`, `publish`, `replace`, `status`,
  `namespace`, `validate_unit`, `link_owned`, `doc_owned`, `emit`
* `backend/app/memo_sync_models.py` — 특히 `MemoSyncConflict.source` 기본값
* `backend/app/services/personal_memos.py` 의 `INLINE_IMAGE_POLICY`, `prepare_content`, `process_task_inline_image`, `image_url`
* `backend/tests/test_memo_sync.py`(Contract 사례 확인용)

## 6. (4차 · 선택) 폐기된 기기 안내를 Desktop 이 받을 수 있게

현재 `native/auth/start` 는 폐기된 `device_id` 도 받아 주고, **브라우저 동의(`web/auth/authorize`)** 에서야 409 `device_revoked` 를 낸다.
그 오류는 브라우저 화면에만 보이고 loopback 으로 오지 않으므로, Desktop 은 5분 동안 기다리다 시간 초과로만 끝난다(지금은
기다리는 동안 "브라우저에 device_revoked 가 보이면 [새 기기로 등록]" 을 안내한다). 다음 중 하나가 있으면 Desktop 이 바로 안내할 수 있다.

1. `auth/start` 에서 `device_id` 가 폐기돼 있으면 409 `{code: device_revoked}`(브라우저를 열기 전에 알 수 있음).
2. 동의 화면이 폐기 오류일 때 `redirect_uri?error=device_revoked&state=<state>` 로 이동(RFC 6749 의 error 응답과 같은 모양).
   Desktop loopback 은 이미 `error` 를 읽는다 — `device_revoked` 를 구분해 '새 기기 등록 필요' 로 보여 주도록 바로 맞출 수 있다.

어느 쪽이든 Contract 문장 한 줄과 함께 알려 주면 반영한다. 통합 테스트의 전제는 아니다.
