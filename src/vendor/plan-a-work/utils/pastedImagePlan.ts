/**
 * 혼합 붙여넣기(텍스트 + 표 + 이미지) 이미지 확보 계획 — 순수 로직 단일 출처.
 *
 * 왜 필요한가:
 *   클립보드 HTML 안의 `<img src>` 는 **거의 항상 그대로는 못 쓰는 주소**다.
 *   data:(Base64) · http(s) · blob: · file:// · cid: 가 뒤섞여 오고, 원본 문서 안에서만
 *   의미가 있는 주소를 그대로 저장하면 다른 사용자에게는 액박이 된다.
 *
 *   그래서 파서(officePaste)는 모든 이미지를 ref placeholder 로 바꾸고, 이 모듈이
 *   "ref 하나하나를 어떤 경로로 실제 이미지로 만들 것인가"를 정한다. 네트워크·DOM·업로드는
 *   호출자(RichDescriptionEditor)가 담당한다 — 여기서는 순수 함수만 노출한다.
 *
 * 순서 보존:
 *   본문 위치는 ref 가 기억한다(applyUploadedImages 가 같은 자리에 넣는다). 이 모듈이
 *   다루는 "순서"는 ① 개수 상한을 앞에서부터 적용하기 위한 순서, ② clipboard 이미지
 *   item 과 본문 img 를 짝짓기 위한 순서 두 가지다.
 */

import { officeImageToFile, type OfficePasteImage, type OfficePasteResult, type PendingPasteImage } from './officePaste';
import { runWithConcurrency } from './inlineImageLimit';

/** clipboard 이미지와 짝지을 때 쓰는 근거(주소 자체는 안내·로그에 쓰지 않는다). */
export interface PastedImageHints {
    nameHint?: string;
    mimeHint?: string;
}

/** Browser capability groups, ordered from strongest to weakest evidence. */
export interface ClipboardImageSources {
    asyncClipboard?: File[];
    clipboardEvent?: File[];
    rtf?: File[];
}

export type ClipboardImageInput = File[] | ClipboardImageSources;

/** 본문 이미지 한 자리(ref)를 어떻게 실제 이미지로 만들 것인가. */
export type PastedImageSlot =
    /** 본문에 Base64 로 들어 있다 → 캡처 붙여넣기와 같은 압축·업로드 경로. */
    | { ref: string; kind: 'data'; order: number; image: OfficePasteImage }
    /** 이미 우리 서버에 있는 이미지 → 주소만 옮긴다(업로드 없음). */
    | { ref: string; kind: 'internal'; order: number; url: string }
    /** 외부 http(s) → 브라우저가 직접, 안 되면 서버가 내려받아 내부 이미지로. */
    | ({ ref: string; kind: 'remote'; order: number; url: string; fallbackUrls?: string[] } & PastedImageHints)
    /** blob:/file:/cid: → 바이너리를 따로 확보해야 한다. */
    | ({
        ref: string; kind: 'binary'; order: number; url: string;
        reason?: PendingPasteImage['reason'];
    } & PastedImageHints);

export interface PastedImagePlan {
    /** 본문 등장 순서. 개수 상한 안에 든 자리만 들어 있다. */
    slots: PastedImageSlot[];
    /** 개수 상한을 넘어 넣지 못한 이미지 수(자리 자체가 사라진다). */
    blockedCount: number;
    /** 상한과 무관하게 본문에 있던 이미지 자리 총 개수. */
    totalCount: number;
}

/**
 * 파싱 결과 → 이미지 확보 계획.
 *
 * `budget` 은 "이 Description 에 더 넣을 수 있는 이미지 수"다. 상한을 넘으면 **뒤쪽**
 * 이미지부터 버린다 — 앞부분 문맥이 살아 있는 편이 사용자에게 이해하기 쉽다.
 */
export function buildPastedImagePlan(
    result: Pick<OfficePasteResult, 'images' | 'pendingImages'>,
    budget: number,
): PastedImagePlan {
    const all: PastedImageSlot[] = [
        ...result.images.map((image): PastedImageSlot => ({
            ref: image.ref, kind: 'data', order: image.order, image,
        })),
        ...result.pendingImages.map((pending): PastedImageSlot => {
            const hints: PastedImageHints = {
                nameHint: pending.nameHint,
                mimeHint: pending.mimeHint,
            };
            if (pending.kind === 'binary') {
                return {
                    ref: pending.ref, kind: 'binary', order: pending.order,
                    url: pending.url, reason: pending.reason, ...hints,
                };
            }
            if (pending.kind === 'remote') {
                return {
                    ref: pending.ref, kind: 'remote', order: pending.order,
                    url: pending.url, fallbackUrls: pending.fallbackUrls, ...hints,
                };
            }
            return { ref: pending.ref, kind: 'internal', order: pending.order, url: pending.url };
        }),
    ].sort((a, b) => a.order - b.order);

    const limit = Math.max(0, Math.floor(budget));
    const slots = all.slice(0, limit);
    return { slots, blockedCount: all.length - slots.length, totalCount: all.length };
}

/**
 * clipboard 이미지 item 과 "바이너리가 필요한 본문 이미지"를 순서로 짝짓는다.
 *
 * 왜 개수가 같을 때만 하는가:
 *   Word/Excel 에서 텍스트와 그림을 함께 복사하면 clipboard 의 이미지 item 이
 *   **선택 영역 전체를 찍은 한 장**인 경우가 있다. 그것을 본문 첫 번째 그림 자리에
 *   끼워 넣으면 전혀 다른 그림이 들어간다. 개수가 정확히 일치할 때만 1:1 로 짝짓고,
 *   어긋나면 추측하지 않는다(→ 그 자리는 비고, 사용자에게 몇 장을 못 가져왔는지 알린다).
 */
export function matchClipboardBinaries(
    binarySlots: ({ ref: string; order: number } & PastedImageHints)[],
    clipboardImages: File[],
): Map<string, File> {
    const matched = new Map<string, File>();
    if (binarySlots.length === 0 || clipboardImages.length === 0) return matched;
    const ordered = [...binarySlots].sort((a, b) => a.order - b.order);

    if (clipboardImages.length === ordered.length) {
        ordered.forEach((slot, index) => matched.set(slot.ref, clipboardImages[index]));
        return matched;
    }

    // 개수가 어긋나면 순서는 근거가 되지 못한다. 그래도 **파일명이 정확히 일치**하고
    // 그 이름을 가진 후보가 단 하나라면 그것은 추측이 아니라 확인이다.
    // (Outlook/Word 의 `image003.png` 처럼 주소와 clipboard 파일명이 같은 경우)
    const byName = new Map<string, File[]>();
    clipboardImages.forEach((file) => {
        const name = (file.name || '').trim().toLowerCase();
        if (!name) return;
        const bucket = byName.get(name);
        if (bucket) bucket.push(file);
        else byName.set(name, [file]);
    });
    const used = new Set<File>();
    ordered.forEach((slot) => {
        const name = (slot.nameHint || '').trim().toLowerCase();
        if (!name) return;
        const bucket = byName.get(name);
        if (!bucket || bucket.length !== 1) return;
        const file = bucket[0];
        if (used.has(file)) return;
        used.add(file);
        matched.set(slot.ref, file);
    });

    // If counts differ, MIME is useful only when it identifies exactly one
    // remaining slot and one remaining file (for example one JPEG among PNGs).
    const normalizeMime = (value?: string) => (value || '').trim().toLowerCase()
        .replace('image/jpg', 'image/jpeg');
    const remainingFiles = clipboardImages.filter(file => !used.has(file));
    const remainingSlots = ordered.filter(slot => !matched.has(slot.ref));
    const filesByMime = new Map<string, File[]>();
    remainingFiles.forEach((file) => {
        const mime = normalizeMime(file.type);
        if (!mime) return;
        const bucket = filesByMime.get(mime) || [];
        bucket.push(file);
        filesByMime.set(mime, bucket);
    });
    const slotsByMime = new Map<string, typeof remainingSlots>();
    remainingSlots.forEach((slot) => {
        const mime = normalizeMime(slot.mimeHint);
        if (!mime) return;
        const bucket = slotsByMime.get(mime) || [];
        bucket.push(slot);
        slotsByMime.set(mime, bucket);
    });
    slotsByMime.forEach((slots, mime) => {
        const files = filesByMime.get(mime) || [];
        if (slots.length !== 1 || files.length !== 1 || used.has(files[0])) return;
        used.add(files[0]);
        matched.set(slots[0].ref, files[0]);
    });
    return matched;
}

function clipboardSourceGroups(input: ClipboardImageInput): File[][] {
    if (Array.isArray(input)) return input.length ? [input] : [];
    return [input.asyncClipboard || [], input.clipboardEvent || [], input.rtf || []]
        .filter(group => group.length > 0);
}

/**
 * Match Async Clipboard → ClipboardEvent → RTF candidates without ever using
 * the first image for every slot. Exact count/order is accepted, as is a
 * unique 1:1 relation. With mismatched counts, only an exact filename or an
 * exact cover of the cid/blob/file subset is considered safe.
 */
export function matchClipboardImageSources(
    slots: PastedImageSlot[],
    input: ClipboardImageInput,
    excludedRefs: Set<string> = new Set(),
): Map<string, File> {
    const matched = new Map<string, File>();
    for (const group of clipboardSourceGroups(input)) {
        const available = slots.filter(slot => (
            slot.kind !== 'internal'
            && !excludedRefs.has(slot.ref)
            && !matched.has(slot.ref)
        ));
        if (available.length === 0) break;

        const hintedSlots = available.map(slot => ({
            ref: slot.ref,
            order: slot.order,
            nameHint: 'nameHint' in slot ? slot.nameHint : undefined,
            mimeHint: slot.kind === 'data'
                ? slot.image.mime
                : ('mimeHint' in slot ? slot.mimeHint : undefined),
        }));
        const direct = matchClipboardBinaries(hintedSlots, group);
        direct.forEach((file, ref) => matched.set(ref, file));
        if (direct.size > 0 || group.length === available.length) continue;

        // Office commonly supplies data:image for one picture and a clipboard
        // File only for a separate file:/cid: picture. Preserve that behavior.
        const binaryOnly = available.filter(
            (slot): slot is Extract<PastedImageSlot, { kind: 'binary' }> => slot.kind === 'binary',
        ).sort((a, b) => a.order - b.order);
        if (binaryOnly.length > 0 && group.length === binaryOnly.length) {
            binaryOnly.forEach((slot, index) => matched.set(slot.ref, group[index]));
            continue;
        }
        if (available.length === 1 && group.length === 1) {
            matched.set(available[0].ref, group[0]);
        }
    }
    return matched;
}

// ─────────────────────── 계획 실행(확보) ───────────────────────

export interface ResolvedImageUpload {
    url: string;
    id?: number;
    rawBytes: number;
    storedBytes: number;
}

export type PastedImageUploadSource =
    | 'async_clipboard'
    | 'clipboard_event'
    | 'rtf'
    | 'data_image'
    | 'blob_url'
    | 'remote_browser';

export interface PastedImageUploadContext {
    ref: string;
    source: PastedImageUploadSource;
}

export type PastedImageResolveEvent =
    | { stage: 'browser_fetch'; result: 'started' | 'success' | 'failed'; mime?: string; bytes?: number }
    | { stage: 'internal_url'; source: 'upload' | 'backend_import' | 'existing_internal' }
    | { stage: 'failed'; reason: string };

/**
 * 확보에 필요한 바깥 세계(업로드·네트워크)를 주입받는다.
 * 덕분에 "어떤 순서로 무엇을 시도하는가"라는 규칙만 여기 남고, 그 규칙을 그대로 테스트할 수 있다.
 */
export interface PastedImageResolveDeps {
    /** 이미지 1장 업로드 — 캡처 붙여넣기와 **같은** 경로여야 한다. */
    uploadBlob: (
        blob: Blob,
        namePrefix: string,
        context?: PastedImageUploadContext,
    ) => Promise<ResolvedImageUpload>;
    /** 브라우저가 직접 내려받을 수 있는 외부 이미지인지(CORS 허용/사내망). 실패는 null. */
    fetchRemoteUrl?: (url: string) => Promise<Blob | null>;
    /** 외부 http(s) 주소를 서버가 내려받아 내부 이미지로 만든다. 없으면 시도하지 않는다. */
    importRemoteUrl?: (url: string) => Promise<string>;
    /** blob: 주소에서 바이트 얻기(같은 문서가 만든 주소만 성공한다). */
    readBlobUrl?: (url: string) => Promise<Blob | null>;
    /** data: 이미지를 업로드용 File 로(기본: officeImageToFile). */
    toFile?: (image: OfficePasteImage, index: number) => File;
    onProgress?: (done: number, total: number) => void;
    /** DEV 진단용 자리별 상태. ref는 호출자가 익명 문서 순서로 바꿔 기록한다. */
    onImageState?: (ref: string, event: PastedImageResolveEvent) => void;
    concurrency?: number;
}

export interface PastedImageResolution {
    /** ref → 본문에 넣을 최종 URL. 여기 없는 ref 는 본문에서 지워진다. */
    resolvedByRef: Map<string, string>;
    /** 업로드 중 발생한 오류(사용자 안내 문구는 호출자가 만든다). */
    uploadErrors: unknown[];
    /** 외부 주소 가져오기 실패 원인(서버가 돌려준 오류 그대로). */
    remoteErrors: unknown[];
    /** 외부 주소를 끝내 가져오지 못한 이미지 수. */
    remoteFailedCount: number;
    /** 바이너리를 짝지어 주지 못한 blob:/file:/cid: 이미지들의 사유. */
    binaryUnmatched: PendingPasteImage['reason'][];
    rawBytesTotal: number;
    storedBytesTotal: number;
    maxImageDurationMs: number;
    /** 별도 Clipboard/RTF Blob 이 HTML placeholder 에 근거 있게 매칭된 수. */
    matchedClipboardImageCount: number;
    /** 확보에 실패한 자리별 종결 사유. 성공도 실패도 아닌 상태를 남기지 않는다. */
    failureByRef: Map<string, string>;
    /** 실제 PLAN-A 처리 장애. 최종 fallback 성공 여부와 별개로 운영 지표에 남긴다. */
    internalFailureReasons: string[];
}

const EXPECTED_EXTERNAL_IMAGE_FAILURES = new Set([
    'authentication_required_or_empty',
    'remote_timeout',
    'cors_or_network_failed',
    'source_unreachable',
    'cid_without_binary',
    'external_image_unavailable',
]);

/** 외부 원본을 읽지 못한 예상 제한인지(내부 저장 실패와 구분). */
export function isExpectedExternalImageFailure(reason: string): boolean {
    return EXPECTED_EXTERNAL_IMAGE_FAILURES.has(reason);
}

/** backend import 결과를 관리자 지표에 보낼 비식별 실패 코드로 정규화한다. */
export function normalizeRemoteImageFailure(codes: string[]): string {
    const unique = new Set(codes.filter(Boolean));
    if (unique.has('authentication_required_or_empty')) return 'authentication_required_or_empty';
    if (unique.has('timeout') || unique.has('remote_timeout')) return 'remote_timeout';
    if (unique.has('source_unreachable')) return 'source_unreachable';
    if (unique.has('external_image_unavailable')) return 'external_image_unavailable';
    if (unique.size === 0) return 'external_image_unavailable';
    // invalid_url/import_disabled/unsupported/image_too_large 등은 예상 접근 제한으로 숨기지 않는다.
    return 'remote_import_rejected';
}

/** ref별 상세 사유를 사용자 본문이 없는 공통 운영 코드로 바꾼다. */
export function normalizePastedImageFailureReason(
    reason: string,
    remoteCodes: string[] = [],
): string {
    if (reason === 'remote_sources_exhausted') return normalizeRemoteImageFailure(remoteCodes);
    if (reason === 'cid_binary_missing') return 'cid_without_binary';
    if (
        reason === 'binary_missing'
        || reason === 'blob_binary_missing'
        || reason === 'local-file_binary_missing'
        || reason === 'clipboard-only_binary_missing'
        || reason === 'no_safe_source'
    ) return 'external_image_unavailable';
    return reason || 'unexpected_exception';
}

function internalFailureReason(error: unknown, fallback: string): string | null {
    const annotated = (error as { pasteFailureReason?: unknown })?.pasteFailureReason;
    if (typeof annotated === 'string' && annotated) return annotated;
    const status = Number((error as { response?: { status?: unknown } })?.response?.status) || 0;
    if (status >= 500) return fallback;
    return null;
}

/**
 * 계획대로 이미지를 확보한다 — 혼합 붙여넣기가 이미지를 잃지 않는 핵심 절차.
 *
 * 자리(ref)마다 확보 경로가 정해져 있다:
 *   internal → 그대로 사용(재업로드 없음)
 *   data     → 압축 후 업로드
 *   binary   → ① 같은 문서의 blob: 이면 직접 읽기 ② 아니면 clipboard 이미지와 매칭
 *   remote   → ① 브라우저가 직접 내려받기(CORS 허용/사내망) ② 안 되면 서버 import
 *
 * 확보하지 못한 자리는 **그 자리만** 비운다. 이미지 실패가 다른 이미지·텍스트·표에
 * 영향을 주지 않도록, 모든 작업은 개별적으로 try/catch 하고 예외를 밖으로 던지지 않는다
 * (Promise.all 로 묶으면 한 장의 400 이 붙여넣기 전체를 취소시킨다).
 *
 * 여기서 실패한 ref 는 지도에 없으므로 applyUploadedImages 가 그 자리를 지운다 →
 * 깨진 이미지도, 임시/인증 주소도 본문에 남을 수 없다.
 */
export async function resolvePastedImages(
    plan: PastedImagePlan,
    clipboardImages: ClipboardImageInput,
    deps: PastedImageResolveDeps,
): Promise<PastedImageResolution> {
    const resolvedByRef = new Map<string, string>();
    const uploadErrors: unknown[] = [];
    const remoteErrors: unknown[] = [];
    const binaryUnmatched: PendingPasteImage['reason'][] = [];
    const failureByRef = new Map<string, string>();
    const internalFailureReasons = new Set<string>();
    let remoteFailedCount = 0;
    let rawBytesTotal = 0;
    let storedBytesTotal = 0;
    let maxImageDurationMs = 0;

    const concurrency = Math.max(1, deps.concurrency || 4);
    const timestamp = Date.now();
    const toFile = deps.toFile
        || ((image: OfficePasteImage, index: number) => officeImageToFile(image, timestamp, index));

    // ── ① 같은 문서가 만든 blob: 은 지금 바로 바이트를 읽을 수 있다 ──
    const binarySlots = plan.slots.filter(
        (slot): slot is Extract<PastedImageSlot, { kind: 'binary' }> => slot.kind === 'binary',
    );
    const recovered = new Map<string, Blob>();
    if (deps.readBlobUrl) {
        await runWithConcurrency(binarySlots, concurrency, async (slot) => {
            const blob = await deps.readBlobUrl!(slot.url);
            if (blob) recovered.set(slot.ref, blob);
        });
    }

    // ── ② Async Clipboard → event → RTF 를 모든 비영구 이미지 자리에 매칭 ──
    // data:/remote URL 보다 별도 Blob 을 우선한다. 같은 문서의 blob: 을 직접 읽은
    // 자리는 더 구체적인 근거이므로 다시 매칭하지 않는다.
    const clipboardByRef = matchClipboardImageSources(
        plan.slots,
        clipboardImages,
        new Set(recovered.keys()),
    );

    const clipboardSource = (blob: Blob): PastedImageUploadSource => {
        if (!Array.isArray(clipboardImages)) {
            if ((clipboardImages.asyncClipboard || []).includes(blob as File)) return 'async_clipboard';
            if ((clipboardImages.clipboardEvent || []).includes(blob as File)) return 'clipboard_event';
            if ((clipboardImages.rtf || []).includes(blob as File)) return 'rtf';
        }
        return 'clipboard_event';
    };

    // ── ③ 자리별 작업 구성 ──
    interface UploadJob {
        ref: string;
        blob: Blob;
        namePrefix: string;
        source: PastedImageUploadSource;
    }
    const uploadJobs: UploadJob[] = [];
    const remoteSlots: Extract<PastedImageSlot, { kind: 'remote' }>[] = [];

    plan.slots.forEach((slot, index) => {
        if (slot.kind === 'internal') {
            resolvedByRef.set(slot.ref, slot.url); // 이미 우리 서버에 있는 이미지
            deps.onImageState?.(slot.ref, { stage: 'internal_url', source: 'existing_internal' });
            return;
        }
        const clipboardBlob = clipboardByRef.get(slot.ref);
        if (clipboardBlob) {
            uploadJobs.push({
                ref: slot.ref,
                blob: clipboardBlob,
                namePrefix: 'paste-image',
                source: clipboardSource(clipboardBlob),
            });
            return;
        }
        if (slot.kind === 'data') {
            uploadJobs.push({
                ref: slot.ref,
                blob: toFile(slot.image, index),
                namePrefix: 'office-paste',
                source: 'data_image',
            });
            return;
        }
        if (slot.kind === 'binary') {
            const blob = recovered.get(slot.ref);
            if (blob) {
                uploadJobs.push({
                    ref: slot.ref, blob, namePrefix: 'paste-image', source: 'blob_url',
                });
            } else {
                binaryUnmatched.push(slot.reason);
                const reason = slot.reason ? `${slot.reason}_binary_missing` : 'binary_missing';
                failureByRef.set(slot.ref, reason);
                deps.onImageState?.(slot.ref, { stage: 'failed', reason });
            }
            return;
        }
        remoteSlots.push(slot);
    });

    const total = uploadJobs.length + remoteSlots.length;
    let done = 0;
    const advance = () => {
        done += 1;
        deps.onProgress?.(done, total);
    };
    deps.onProgress?.(0, total);

    const jobs: (() => Promise<void>)[] = uploadJobs.map((job) => async () => {
        const startedAt = Date.now();
        try {
            const uploaded = await deps.uploadBlob(job.blob, job.namePrefix, {
                ref: job.ref,
                source: job.source,
            });
            resolvedByRef.set(job.ref, uploaded.url);
            deps.onImageState?.(job.ref, { stage: 'internal_url', source: 'upload' });
            rawBytesTotal += uploaded.rawBytes;
            storedBytesTotal += uploaded.storedBytes;
            maxImageDurationMs = Math.max(maxImageDurationMs, Date.now() - startedAt);
        } catch (error) {
            uploadErrors.push(error);
            const reason = internalFailureReason(error, 'internal_upload_failed')
                || 'internal_upload_failed';
            internalFailureReasons.add(reason);
            failureByRef.set(job.ref, reason);
            deps.onImageState?.(job.ref, { stage: 'failed', reason });
        } finally {
            advance();
        }
    });

    interface RemoteAcquisition {
        url: string;
        source: 'upload' | 'backend_import';
        blobMime?: string;
        blobBytes?: number;
    }
    const remoteCache = new Map<string, Promise<RemoteAcquisition>>();
    const acquireRemote = async (url: string, ref: string): Promise<RemoteAcquisition> => {
        const existing = remoteCache.get(url);
        if (existing) {
            const acquired = await existing;
            if (acquired.blobMime || acquired.blobBytes !== undefined) {
                deps.onImageState?.(ref, {
                    stage: 'browser_fetch', result: 'success',
                    mime: acquired.blobMime, bytes: acquired.blobBytes,
                });
            }
            return acquired;
        }
        const promise = (async () => {
            // ① 브라우저가 직접 가져올 수 있으면 그것이 가장 정확하다.
            let fetched: Blob | null = null;
            deps.onImageState?.(ref, { stage: 'browser_fetch', result: 'started' });
            try {
                fetched = deps.fetchRemoteUrl ? await deps.fetchRemoteUrl(url) : null;
            } catch (error) {
                // 브라우저 fetch 구현이 예외를 던져도 서버 import까지 계속 확인한다.
                remoteErrors.push(error);
            }
            if (fetched) {
                deps.onImageState?.(ref, {
                    stage: 'browser_fetch', result: 'success',
                    mime: fetched.type || '', bytes: fetched.size,
                });
                try {
                    const uploaded = await deps.uploadBlob(fetched, 'paste-image', {
                        ref,
                        source: 'remote_browser',
                    });
                    rawBytesTotal += uploaded.rawBytes;
                    storedBytesTotal += uploaded.storedBytes;
                    return {
                        url: uploaded.url,
                        source: 'upload' as const,
                        blobMime: fetched.type || '',
                        blobBytes: fetched.size,
                    };
                } catch (error) {
                    // 바이트는 얻었지만 업로드만 실패한 경우에도 서버 import 경로는 독립적으로 시도한다.
                    uploadErrors.push(error);
                    internalFailureReasons.add(
                        internalFailureReason(error, 'internal_upload_failed')
                        || 'internal_upload_failed',
                    );
                }
            } else {
                deps.onImageState?.(ref, { stage: 'browser_fetch', result: 'failed' });
            }
            // ② 서버 import. 사용자 쿠키는 전달하지 않는다.
            if (!deps.importRemoteUrl) throw new Error('remote import unavailable');
            const imported = await deps.importRemoteUrl(url);
            if (!imported) {
                const error = new Error('remote import returned no url') as Error & {
                    pasteFailureReason?: string;
                };
                error.pasteFailureReason = 'invalid_internal_image_response';
                throw error;
            }
            return { url: imported, source: 'backend_import' as const };
        })();
        remoteCache.set(url, promise);
        return promise;
    };

    jobs.push(
        ...remoteSlots.map((slot) => async () => {
            const startedAt = Date.now();
            const candidates = [slot.url, ...(slot.fallbackUrls || [])]
                .filter((url, index, all) => !!url && all.indexOf(url) === index)
                .slice(0, 2);
            let acquired: RemoteAcquisition | null = null;
            for (const url of candidates) {
                try {
                    acquired = await acquireRemote(url, slot.ref);
                    break;
                } catch (error) {
                    remoteErrors.push(error);
                    const internalReason = internalFailureReason(error, 'internal_upload_failed');
                    if (internalReason) internalFailureReasons.add(internalReason);
                }
            }
            if (acquired) {
                resolvedByRef.set(slot.ref, acquired.url);
                deps.onImageState?.(slot.ref, {
                    stage: 'internal_url', source: acquired.source,
                });
                maxImageDurationMs = Math.max(maxImageDurationMs, Date.now() - startedAt);
            } else {
                // 모든 안전한 후보가 실패한 img 하나만 제거한다.
                remoteFailedCount += 1;
                failureByRef.set(slot.ref, 'remote_sources_exhausted');
                deps.onImageState?.(slot.ref, {
                    stage: 'failed', reason: 'remote_sources_exhausted',
                });
            }
            advance();
        }),
    );
    await runWithConcurrency(jobs, concurrency, async (job) => { await job(); });

    return {
        resolvedByRef,
        uploadErrors,
        remoteErrors,
        remoteFailedCount,
        binaryUnmatched,
        rawBytesTotal,
        storedBytesTotal,
        maxImageDurationMs,
        matchedClipboardImageCount: clipboardByRef.size,
        failureByRef,
        internalFailureReasons: Array.from(internalFailureReasons),
    };
}

/** 외부 원본 이미지가 일부라도 빠졌을 때 한 paste당 한 번만 표시할 안내. */
export function pastedImagePartialMessage(total: number, succeeded: number): string {
    if (total <= 0 || succeeded >= total) return '';
    return 'Drag해서 복사한 이미지는 가져올 수 없습니다. 원본에서 \u0022이미지 복사\u0022 후 붙여넣어 주세요.';
}

/** axios 오류 목록에서 서버가 준 실패 코드만 뽑는다(주소·본문은 보지 않는다). */
export function remoteImportFailureCodes(errors: unknown[]): string[] {
    return errors
        .map((error) => (error as { response?: { data?: { code?: unknown } } })?.response?.data?.code)
        .filter((code): code is string => typeof code === 'string' && !!code);
}
