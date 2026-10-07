/**
 * 이미지 확대 뷰어의 배율 계산.
 *
 * 컴포넌트에서 분리한 이유는 하나다 — "화면 맞춤이 원본보다 커지지 않는가",
 * "배율이 범위를 벗어나지 않는가" 같은 규칙은 렌더 없이 검증할 수 있어야 한다.
 *
 * 배율의 기준은 항상 **이미지 원본 크기**다. 그래서 화면에 표시되는 100% 는
 * 언제나 "원본 1:1" 을 뜻한다.
 */

export const IMAGE_ZOOM_LIMITS = {
    /** 사용자가 버튼으로 내려갈 수 있는 하한. */
    min: 0.5,
    max: 3,
    step: 0.25,
    /**
     * 화면 맞춤 전용 하한.
     * 아주 긴 캡처(예: 500×4000)는 0.5 로는 화면에 들어오지 않는다. 그런 이미지의
     * "화면 맞춤"까지 0.5 로 막으면 기본 상태가 화면을 넘어가 버린다.
     */
    fitMin: 0.05,
} as const;

export interface ImageSize {
    width: number;
    height: number;
}

export interface ZoomBounds {
    min: number;
    max: number;
}

function clamp(value: number, min: number, max: number): number {
    return Math.min(max, Math.max(min, value));
}

/** 소수점 오차가 쌓여 99% / 101% 가 뜨지 않게 한다. */
function round(value: number): number {
    return Math.round(value * 100) / 100;
}

/**
 * 화면 맞춤 배율.
 * - 이미지가 뷰어보다 크면 들어오도록 줄인다.
 * - 작으면 **억지로 늘리지 않는다**(1배 유지). 캡처 이미지가 뿌옇게 확대되지 않게.
 */
export function fitImageZoom(natural: ImageSize | null, viewport: ImageSize): number {
    if (!natural || natural.width <= 0 || natural.height <= 0) return 1;
    if (viewport.width <= 0 || viewport.height <= 0) return 1;
    const scale = Math.min(1, viewport.width / natural.width, viewport.height / natural.height);
    return round(clamp(scale, IMAGE_ZOOM_LIMITS.fitMin, IMAGE_ZOOM_LIMITS.max));
}

/**
 * 이 이미지에서 실제로 쓸 수 있는 배율 범위.
 * 화면 맞춤이 하한보다 작으면 그 값까지는 허용한다(맞춤 상태에서 축소 버튼이 오히려
 * 이미지를 키우는 일이 없도록).
 */
export function imageZoomBounds(fitZoom: number): ZoomBounds {
    return {
        min: Math.min(IMAGE_ZOOM_LIMITS.min, round(fitZoom)),
        max: IMAGE_ZOOM_LIMITS.max,
    };
}

/** 배율을 허용 범위 안으로. */
export function clampImageZoom(zoom: number, bounds?: ZoomBounds): number {
    if (!Number.isFinite(zoom)) return 1;
    const { min, max } = bounds || { min: IMAGE_ZOOM_LIMITS.min, max: IMAGE_ZOOM_LIMITS.max };
    return round(clamp(zoom, min, max));
}

/** 확대/축소 한 단계. 화면 맞춤 상태(소수 배율)에서도 눈금에 맞춰 움직인다. */
export function stepImageZoom(current: number, direction: 1 | -1, bounds?: ZoomBounds): number {
    const { step } = IMAGE_ZOOM_LIMITS;
    // 0.62 에서 확대하면 0.87 이 아니라 0.75 로 — 눈금이 어긋난 채 굳지 않게.
    const snapped = direction > 0
        ? Math.floor(round(current) / step + 1e-6) * step + step
        : Math.ceil(round(current) / step - 1e-6) * step - step;
    return clampImageZoom(snapped, bounds);
}

/** 뷰어에 표시할 배율 문자열(항상 원본 대비). */
export function formatImageZoom(zoom: number): string {
    return `${Math.round(round(clamp(zoom, IMAGE_ZOOM_LIMITS.fitMin, IMAGE_ZOOM_LIMITS.max)) * 100)}%`;
}
