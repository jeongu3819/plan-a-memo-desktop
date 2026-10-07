/**
 * Description 이미지 → 확대 뷰어 입력.
 *
 * 원칙: **편집기가 지금 화면에 그리고 있는 것만 쓴다.**
 * Description 이미지는 저장 형태가 여러 가지다.
 *   - 권한이 필요한 내부 이미지: 저장은 `/api/spaces/…/download`, 화면은 Bearer 로 받아온 blob URL
 *   - 외부 http(s) 이미지 / 업로드 직후 미리보기 blob URL / (구) data URL
 * 뷰어가 저장 주소로 다시 요청하면 권한 이미지는 401 이 난다. 그래서 `currentSrc` 를 그대로
 * 쓴다 → 편집기에서 보이는 이미지는 뷰어에서도 그대로 보인다(재요청·재업로드 없음).
 */

/** hydrate 전에 자리만 잡아 두는 1×1 투명 GIF. 이것을 확대해 봐야 의미가 없다. */
const TRANSPARENT_PIXEL =
    'data:image/gif;base64,R0lGODlhAQABAAD/ACwAAAAAAQABAAACADs=';

/** 아직 내려받지 않은 상태들. 확대 요청이 오면 그때 받아서 보여 준다. */
const PENDING_LOAD_STATES = new Set(['deferred', 'queued', 'loading']);

export interface DescriptionImageView {
    /** 뷰어에 넘길 주소. 비어 있으면 아직 못 받았거나 실패한 이미지다. */
    src: string;
    alt: string;
    /** 다시 시도해도 보여 줄 수 없다 — 뷰어는 안내 문구를 띄운다. */
    unavailable: boolean;
    /** 지금 받아오는 중(또는 받아와야 함) — 뷰어는 로딩 표시를 띄운다. */
    pending: boolean;
}

/** 화면에 실제로 그려진 주소(권한 이미지의 blob URL 포함). */
function renderedSrc(img: HTMLImageElement): string {
    const current = img.currentSrc || img.getAttribute('src') || '';
    return current === TRANSPARENT_PIXEL ? '' : current;
}

export function resolveDescriptionImageView(img: HTMLImageElement): DescriptionImageView {
    const alt = img.getAttribute('alt') || '';
    const failed = img.getAttribute('data-image-load-error') === 'true';
    const loadState = img.getAttribute('data-image-load-state') || '';
    const src = failed ? '' : renderedSrc(img);
    const pending = !src && !failed && PENDING_LOAD_STATES.has(loadState);
    return { src, alt, unavailable: failed || (!src && !pending), pending };
}

/** 아직 내려받지 않아 확대 전에 hydrate 가 필요한 이미지인가. */
export function needsHydrationBeforeViewing(img: HTMLImageElement): boolean {
    return resolveDescriptionImageView(img).pending;
}

/**
 * 이미지를 키보드로도 열 수 있게 한다(포커스 → Enter, 닫으면 다시 그 이미지로 복귀).
 *
 * `tabindex` 는 **화면에만 존재하는 속성**이다. Description sanitizer(프론트·백엔드 모두)
 * 의 IMG 허용 목록에 없으므로 저장 HTML 에는 절대 남지 않는다.
 */
export function markDescriptionImagesFocusable(root: HTMLElement | null | undefined): void {
    if (!root) return;
    root.querySelectorAll('img').forEach((img) => {
        if (img.getAttribute('tabindex') !== '0') img.setAttribute('tabindex', '0');
    });
}
