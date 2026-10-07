/**
 * Description 본문 이미지의 배치 규칙 (단일 출처).
 *
 * 왜 CSS 로만 처리하는가:
 *   Task description 은 저장 전에 프론트(`sanitizeTaskDescriptionHtml`)와 백엔드
 *   (`app/services/task_description.py`, bleach + CSSSanitizer)를 모두 통과한다. 두
 *   sanitizer 모두 img 에 대해 `src/alt/title/data-image-id/width/height` 와
 *   **style 의 width·height 만** 남기고 class·기타 style·data-* 를 전부 제거한다.
 *   따라서 배치 정보를 class 나 `display:` 스타일로 저장하면 저장 직후 사라진다
 *   (편집 중엔 옆으로 보이다가 다시 열면 세로로 돌아가는 현상).
 *
 *   그래서 이미지는 마크업에 아무 표시도 남기지 않고, 렌더러 CSS 에서만
 *   inline-block 으로 흐르게 한다. 배치는 저장 HTML 의 구조(형제 관계 / <br> / <div>)
 *   와 컨테이너 폭으로만 결정되므로 sanitizer 를 그대로 통과하고, 폭이 좁아지면
 *   자동으로 wrap 된다. 공백 문자나 absolute 좌표는 쓰지 않는다.
 *
 * 이 객체를 「크게 편집」과 Task Details 가 함께 쓰기 때문에 두 화면의 layout 규칙이
 * 갈라질 수 없다. (같은 HTML → 같은 배치, 폭 차이로 인한 wrap 만 다름)
 */

/** 본문 이미지 기본 배치 — 텍스트와 같은 흐름에 참여한다. */
import { richImageFlowSx } from './richImageLayout';

export const descriptionImageSx = {
  /** 형제 이미지의 inline 흐름·상단 정렬·폭 제한은 모든 Rich Content가 공유한다. */
  margin: '2px 0',
  ...richImageFlowSx,
  cursor: 'pointer',
  /** MUI sx 의 숫자 borderRadius 는 theme.shape.borderRadius 배수다(기존 값 유지). */
  borderRadius: 1,
  userSelect: 'none',
  WebkitUserDrag: 'none',
  /**
   * 이미지는 키보드로도 확대할 수 있다(포커스 → Enter). 그 포커스가 보여야 한다.
   * `tabindex` 는 화면에만 붙고 저장 HTML 에는 남지 않는다(sanitizer 가 제거).
   */
  '&:focus-visible': {
    outline: '2px solid #2955FF',
    outlineOffset: '2px',
  },
} as const;

/**
 * 아직 내려받지 않은 이미지의 자리표시자.
 * 전체 폭(width:100%)을 쓰면 로드 전에는 항상 한 줄을 차지해 옆 배치가 불가능하므로
 * 고정 폭 상자로 자리만 잡는다.
 */
export const descriptionDeferredImageSx = {
  minHeight: 120,
  width: 240,
  maxWidth: '100%',
  bgcolor: 'rgba(0,0,0,0.04)',
} as const;

/** 자리표시자 CSS 를 적용할 이미지 로드 상태 selector. */
export const DEFERRED_IMAGE_SELECTOR =
  '& img[data-image-load-state="deferred"], & img[data-image-load-state="queued"], & img[data-image-load-state="loading"]';
