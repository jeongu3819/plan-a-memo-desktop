export interface PastedImagePlaceholderState {
    placeholderFound: boolean;
    placeholderReplaced: boolean;
    final: 'resolved' | 'failed';
    reason?: string;
}

export interface PastedImagePlaceholderResult {
    placed: number;
    byRef: Map<string, PastedImagePlaceholderState>;
}

/**
 * 비동기 이미지 확보 결과를 현재 editor DOM의 ref 자리 하나에만 적용한다.
 * 요청한 모든 ref를 순회하므로 placeholder가 사라져도 조용히 유실되지 않는다.
 */
export function finalizePastedImagePlaceholders(
    root: HTMLElement | null,
    resolvedByRef: Map<string, string>,
    targetRefs: Set<string>,
    failureByRef: Map<string, string>,
    options: {
        pendingAlt?: string;
        resolvedAlt?: string;
        onResolved?: (img: HTMLImageElement, url: string) => void;
    } = {},
): PastedImagePlaceholderResult {
    const byRef = new Map<string, PastedImagePlaceholderState>();
    if (!root) {
        targetRefs.forEach((imageRef) => byRef.set(imageRef, {
            placeholderFound: false,
            placeholderReplaced: false,
            final: 'failed',
            reason: 'editor_unavailable',
        }));
        return { placed: 0, byRef };
    }

    const placeholders = new Map<string, HTMLImageElement[]>();
    Array.from(root.querySelectorAll('img[data-office-image-ref]')).forEach((node) => {
        const img = node as HTMLImageElement;
        const imageRef = img.getAttribute('data-office-image-ref') || '';
        const matches = placeholders.get(imageRef) || [];
        matches.push(img);
        placeholders.set(imageRef, matches);
    });

    let placed = 0;
    targetRefs.forEach((imageRef) => {
        const matches = placeholders.get(imageRef) || [];
        const url = resolvedByRef.get(imageRef);
        if (matches.length === 0) {
            byRef.set(imageRef, {
                placeholderFound: false,
                placeholderReplaced: false,
                final: 'failed',
                reason: url ? 'placeholder_missing' : (failureByRef.get(imageRef) || 'image_unresolved'),
            });
            return;
        }
        if (matches.length > 1) {
            matches.forEach((img) => img.remove());
            byRef.set(imageRef, {
                placeholderFound: true,
                placeholderReplaced: false,
                final: 'failed',
                reason: 'duplicate_placeholder',
            });
            return;
        }

        const img = matches[0];
        img.removeAttribute('data-office-image-ref');
        img.removeAttribute('data-upload-state');
        if (!url) {
            img.remove();
            byRef.set(imageRef, {
                placeholderFound: true,
                placeholderReplaced: false,
                final: 'failed',
                reason: failureByRef.get(imageRef) || 'image_unresolved',
            });
            return;
        }

        placed += 1;
        if (!img.getAttribute('alt') || img.getAttribute('alt') === options.pendingAlt) {
            img.setAttribute('alt', options.resolvedAlt || '붙여넣은 이미지');
        }
        img.setAttribute('loading', 'lazy');
        img.setAttribute('decoding', 'async');
        img.dataset.canonicalSrc = url;
        options.onResolved?.(img, url);
        byRef.set(imageRef, {
            placeholderFound: true,
            placeholderReplaced: true,
            final: 'resolved',
        });
    });
    return { placed, byRef };
}
