/**
 * Description 인라인 이미지 개수 정책의 단일 소스.
 *
 * - Task Details 의 작은 Description, "크게 편집" 모달, 단발 일정 Description 이
 *   모두 이 함수만 사용한다(화면별로 다른 상한이 생기지 않도록).
 * - 실제 값은 백엔드 `/api/upload-policy` 가 내려주는 설정값이며, 프론트는
 *   정책이 아직 로딩되지 않은 순간에만 기본값(30)을 쓴다.
 * - 어떤 값이 내려와도 애플리케이션 절대 상한(50)을 넘기지 않는다.
 */

export const INLINE_IMAGE_ABSOLUTE_CAP = 50;
export const DEFAULT_INLINE_IMAGE_MAX_COUNT = 30;
export const DEFAULT_INLINE_IMAGE_UPLOAD_CONCURRENCY = 4;

interface PasteImagePolicyLike {
    max_count_per_description?: number | null;
    hard_cap_per_description?: number | null;
    upload_concurrency?: number | null;
}

interface UploadPolicyLike {
    paste_image?: PasteImagePolicyLike | null;
}

const toPositiveInt = (value: unknown): number | null => {
    const parsed = typeof value === 'number' ? value : Number(value);
    if (!Number.isFinite(parsed)) return null;
    const rounded = Math.floor(parsed);
    return rounded > 0 ? rounded : null;
};

/** 정책 응답 → 실제 적용할 이미지 개수 상한. */
export function resolveInlineImageMaxCount(policy?: UploadPolicyLike | null): number {
    const paste = policy?.paste_image || undefined;
    const hardCap = Math.min(
        toPositiveInt(paste?.hard_cap_per_description) ?? INLINE_IMAGE_ABSOLUTE_CAP,
        INLINE_IMAGE_ABSOLUTE_CAP,
    );
    const configured = toPositiveInt(paste?.max_count_per_description) ?? DEFAULT_INLINE_IMAGE_MAX_COUNT;
    return Math.max(1, Math.min(configured, hardCap));
}

/** 정책 응답 → 동시 업로드 개수(브라우저·서버 순간 부하 제어). */
export function resolveInlineImageUploadConcurrency(policy?: UploadPolicyLike | null): number {
    const configured = toPositiveInt(policy?.paste_image?.upload_concurrency)
        ?? DEFAULT_INLINE_IMAGE_UPLOAD_CONCURRENCY;
    return Math.max(1, Math.min(configured, 8));
}

/** 설정값이 바뀌면 안내 문구의 숫자도 함께 바뀐다. */
export function inlineImageLimitMessage(limit: number): string {
    return `작업 설명에는 이미지를 최대 ${limit}개까지 넣을 수 있습니다.`;
}

/** 일부만 허용된 경우의 안내(몇 장이 왜 빠졌는지 정확히 알려준다). */
export function inlineImagePartialMessage(
    limit: number,
    accepted: number,
    requested: number,
): string {
    if (accepted <= 0) return inlineImageLimitMessage(limit);
    return `${inlineImageLimitMessage(limit)} 붙여넣은 ${requested}개 중 ${accepted}개만 추가했습니다.`;
}

/**
 * 최대 `limit` 개씩만 동시에 실행하는 큐.
 * - 30장을 붙여넣어도 요청이 한 번에 몰리지 않는다.
 * - worker 가 throw 해도 나머지 작업은 계속 진행된다(부분 실패 허용).
 */
export async function runWithConcurrency<T>(
    items: T[],
    limit: number,
    worker: (item: T, index: number) => Promise<void>,
): Promise<void> {
    const size = Math.max(1, Math.floor(limit) || 1);
    let cursor = 0;
    const runNext = async (): Promise<void> => {
        while (cursor < items.length) {
            const index = cursor;
            cursor += 1;
            try {
                await worker(items[index], index);
            } catch {
                // worker 내부에서 사용자 안내까지 처리한다. 큐는 멈추지 않는다.
            }
        }
    };
    await Promise.all(
        Array.from({ length: Math.min(size, items.length) }, () => runNext()),
    );
}
