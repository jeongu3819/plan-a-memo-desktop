import { RESIZABLE_TABLE_ATTR, TABLE_SCROLL_SELECTOR } from './tableResize';

/**
 * Rich 본문 표의 화면 규칙 (단일 출처) — Description · 작업노트 · 메모(편집/읽기) 공용.
 *
 * 저장 HTML 에는 크기 숫자(`<col data-col-width>` / `<tr data-row-min-height>`)만 남고,
 * 보이는 px 은 `applyTableSizingStyles()` 가 런타임 inline style 로 펼친다. 여기 규칙은 그
 * 전제(반응형 기본값 · 수동 크기 표 · 넓은 표의 가로 스크롤 상자)만 세운다.
 *
 * 세 화면이 이 객체를 함께 쓰므로 같은 HTML 이면 같은 표가 된다.
 * (기준은 Description 의 기존 규칙이다 — 값 변경 없음)
 */
export const richTableSx = {
    // ── 표는 항상 본문 폭 기준으로 반응형 ──
    // 고정 폭/행 높이는 붙여넣기 파이프라인에서 이미 제거되지만, 여기서도
    // height:auto 를 강제해 저장된 옛 HTML 까지 같은 모양으로 보이게 한다.
    '& table': {
        width: '100%',
        maxWidth: '100%',
        height: 'auto',
        tableLayout: 'auto',
        borderCollapse: 'collapse',
        margin: '0 0 8px',
        // 표 안에서는 태그 사이 공백이 줄바꿈이 되면 안 된다.
        whiteSpace: 'normal',
    },
    // 사용자가 직접 크기를 조절한 표. 실제 px 은 저장된 data 속성에서
    // 런타임에 펼쳐진 inline style 이 정하고, 여기서는 그 전제만 세운다.
    [`& table[${RESIZABLE_TABLE_ATTR}="true"]`]: {
        tableLayout: 'fixed',
        maxWidth: 'none',
    },
    // 넓어진 표는 이 상자 안에서만 가로 스크롤한다 → 문단·이미지는 제자리.
    [`& ${TABLE_SCROLL_SELECTOR}`]: {
        maxWidth: '100%',
        overflowX: 'auto',
        overflowY: 'hidden',
        margin: '0 0 8px',
    },
    [`& ${TABLE_SCROLL_SELECTOR} > table`]: { margin: 0 },
    '& td, & th': {
        height: 'auto',
        minHeight: 0,
        padding: '6px 8px',
        verticalAlign: 'top',
        overflowWrap: 'anywhere',
        border: '1px solid rgba(0,0,0,0.15)',
        // 행 높이를 줄여도 내용은 절대 잘리지 않는다(= min-height 의미).
        overflow: 'visible',
    },
    '& th': { fontWeight: 700, bgcolor: 'rgba(0,0,0,0.03)', textAlign: 'left' },
    '& td > p:last-child, & th > p:last-child': { marginBottom: 0 },
} as const;
