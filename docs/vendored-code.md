# plan-a-work 에서 가져온 코드

출처: `plan-a-work` 저장소(로컬 `~/plan`, origin `jeongu3819/plan`) `frontend/src/`, commit `db28deb`.
`plan-a-work` 는 읽기만 했고 수정하지 않았다. Desktop Sync/Auth/Device/Conflict 개발 코드는 조사·복사하지 않았다.

위치: `src/vendor/plan-a-work/` — **원본과 같은 상대 경로**로 두어 import 를 고치지 않았다.
ESLint 는 이 폴더를 검사하지 않는다(원본 규칙 유지). 원본이 바뀌면 같은 경로로 다시 복사하고 아래 '수정' 만 다시 적용한다.

## 그대로 재사용(수정 없음)

| 파일 | 용도 |
|---|---|
| `components/RichDescriptionEditor.tsx` (한 줄 수정 — 아래) | 개인 메모 Rich Editor(굵게/기울임/밑줄/취소선·글자 크기/색·목록·링크·표·열 너비·Office/웹 붙여넣기·이미지 붙여넣기/끌어 놓기·이미지 크기 조절·확대·Undo/Redo) |
| `components/RichTextContextMenu.tsx`, `RichTextToolbar.tsx`, `LinkEditDialog.tsx`, `RichLinkHoverHint.tsx`, `MentionSuggestionPopper.tsx` | 우클릭 서식 메뉴·링크 |
| `components/common/ImageZoomViewer.tsx`, `components/richTable/RichTableResizeOverlay.tsx` | 이미지 확대·표 크기 조절 |
| `components/personalMemo/PersonalMemoContentView.tsx` | 저장된 메모 읽기 화면 |
| `components/personalMemo/personalMemoTheme.tsx` | 메모 색·Radius·요일/Today/Next 배지 |
| `components/personalMemo/personalMemoPreview.ts` (+test) | 주간 칸 구역별 미리보기 개수 |
| `components/personalMemo/memoSearchHighlight.ts` (+test) | 검색어 강조(CSS Highlight) |
| `hooks/useDescriptionTableResize.ts`, `hooks/useMentionAutocomplete.ts` | 표 크기 조절·멘션(메모에서는 꺼짐) |
| `theme/tokens.ts`, `theme/customTheme.ts`, `theme/planAiTheme.ts` | 전역 MUI 테마(버튼·Dialog·Menu·Tooltip) |
| `utils/personalMemoDates.ts` (+test) | 날짜 계산·라벨(이번 주/같은 요일 ±2주/영문 날짜) |
| `utils/richTextFormatting.ts`, `richLink*.ts`, `richHtmlInsert.ts`, `richTableSx.ts`, `richTextSurface.ts`, `richImageLayout.ts`, `tableResize.ts`, `tsvTable.ts` | HTML serialization·서식·표 |
| `utils/officePaste.ts`, `clipboardPaste*.ts`, `pastedImage*.ts`, `rtfPict.ts`, `imageDrop.ts`, `inlineImage{Limit,Url}.ts`, `descriptionImage*.ts`, `imageZoom.ts`, `imageViewerLayers.ts`, `htmlText.ts`, `mentionMarkup.ts` (+test), `avatarColor.ts` | 붙여넣기·이미지 처리 |
| `frontend/src/index.css` 의 "저장 서식 계약" 블록 | `src/styles/global.css` 앞부분(글자 크기·정렬·들여쓰기·표 규칙) |

## Desktop 에 맞게 수정한 것

| 파일 | 변경 |
|---|---|
| `utils/richImage.ts` | **다시 작성**(export 이름·의미 동일). 보호 이미지 canonical 을 `/api/personal-memos/images/…` 대신 `attachment://<id>` 로, 화면 주소를 Bearer blob 대신 `http://attachment.localhost/<id>` 로. `serializeRichHtml` 은 화면 주소가 섞여도 `attachment://` 로 저장하고, **브라우징 컨텍스트 없는 문서**(`createHTMLDocument`)에서 복제·수정한다. `storedHtmlForDisplay` 추가(편집기에 넣기 전에 화면 주소로). `descriptionToPreviewText` 는 `div` 대신 inert `<template>` 로 파싱. 이 세 가지가 편집·저장 때 남던 `attachment://` 로딩 콘솔 오류(ERR_UNKNOWN_URL_SCHEME)의 원인이었다. `compressPastedImage` 는 원본 그대로 |
| `components/RichDescriptionEditor.tsx` | 외부 value 동기화 한 줄: `el.innerHTML = storedHtmlForDisplay(value)` (원본은 `value` 를 그대로 넣고 나서 hydrate) |
| `utils/taskDescription.ts` | `safeImageUrl` 에 `attachment://<uuid>` 허용 한 줄 추가(나머지 sanitizer 규칙 그대로) |
| `utils/inlineImageMetrics.ts` | 서버 보고 대신 no-op(같은 함수 모양) |
| `api/personalMemos.ts` | 원본 API 클라이언트 대신 **타입만**(`MemoSection`, `MemoKind`) |

## 참고만 하고 Desktop 코드로 새로 쓴 것

| Web | Desktop |
|---|---|
| `PersonalMemoWorkspace.tsx`, `PersonalMemoDialogs.tsx`(창 머리) | `features/memo/MemoWorkspace.tsx` — 같은 머리(serif 날짜·인사말)·이동 조작·화면 전환 |
| `PersonalMemoWeekView.tsx` | `features/memo/WeekView.tsx` — 같은 카드·간격·배지·끌어 놓기 |
| `PersonalMemoDayView.tsx` | `features/memo/DayView.tsx` — 같은 구역 배치·정렬 + 연결 버튼 |
| `PersonalMemoRow.tsx`, `PersonalMemoMenu.tsx`, `PersonalMemoQuickInput.tsx` | `features/memo/MemoRow.tsx`, `MemoMenu.tsx`, `QuickInput.tsx` (서버 전용 메뉴 제외, 즐겨찾기·History 추가) |
| `PersonalMemoNextLists.tsx` | `features/next/NextListTabs.tsx` (+ 끌어서 순서) |
| `PersonalMemoBrowse.tsx` | `features/search/BrowseView.tsx` (+ 즐겨찾기 · History 검색) |
| `personalMemoStore.ts`, `PersonalMemoContext.tsx` | `services/draftStore.ts`, `features/memo/MemoProvider.tsx` (같은 저장 상태 이름) |
| `memoLocation.ts` | `domain/location.ts` (id 가 숫자 → UUID) |
| backend `personal_memo_export.py`, `personal_memo_backup.py` | `src-tauri/src/memo/export.rs`, `memo/text.rs` (txt/csv/zip 형식·검색 평문 규칙 동일) |

## 가져오지 않은 것

Web API 저장 코드(`api/client.ts`·axios·세션), `plan_a_session` Cookie, Dashboard/Project/Space 종속 코드,
Router, Web 인증, 개발 중인 Sync/Auth/Device 코드, 반복(요일마다)·오늘 업무·작업노트 보내기(서버 기능).
