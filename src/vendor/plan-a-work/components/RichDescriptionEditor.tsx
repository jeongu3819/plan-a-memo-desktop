import React, { useRef, useEffect, useLayoutEffect, useState, useCallback } from 'react';
import {
    Box, IconButton, Tooltip, LinearProgress, Typography,
    Dialog, DialogTitle, DialogContent, DialogActions, Button,
} from '@mui/material';
import AddIcon from '@mui/icons-material/Add';
import RemoveIcon from '@mui/icons-material/Remove';
import LinkIcon from '@mui/icons-material/Link';
import LinkOffIcon from '@mui/icons-material/LinkOff';
import OpenInNewIcon from '@mui/icons-material/OpenInNew';
import EditIcon from '@mui/icons-material/Edit';
import ZoomInIcon from '@mui/icons-material/ZoomIn';
import {
    compressPastedImage,
    hydrateProtectedImage,
    releaseImagesInRoot,
    serializeRichHtml,
    normalizeImagesInRoot,
    storedHtmlForDisplay,
} from '../utils/richImage';
import { enqueueSnackbar } from 'notistack';
import { sanitizeTaskDescriptionHtml } from '../utils/taskDescription';
import {
    asSingleLinkUrl,
    buildAnchorHtml,
    linkDisplayLabel,
    linkifyPlainText,
    normalizeLinkUrl,
} from '../utils/richLink';
// 링크 DOM 조작은 작업노트(WorkNoteModal)와 같은 구현을 쓴다 — 두 편집기의
// 자동 링크/열기 동작이 갈라지지 않게 하기 위한 것이다.
import {
    autoLinkBeforeCaret as autoLinkBeforeCaretDom,
    openLinkHref,
    unwrapAnchor,
    updateAnchorFromDraft,
    type LinkDraft,
} from '../utils/richLinkDom';
import LinkEditDialog from './LinkEditDialog';
import { RICH_TEXT_SURFACE_PROPS } from '../utils/richTextSurface';
import RichLinkHoverHint from './RichLinkHoverHint';
import RichTextToolbar from './RichTextToolbar';
import RichTextContextMenu, { type RichTextContextMenuState } from './RichTextContextMenu';
import { handleRichTextShortcut, selectionTextSizePx } from '../utils/richTextFormatting';
import {
    extractImagePlaceholders,
    isSingleImageHtml,
    namespaceOfficePasteImages,
    normalizeOfficePasteHtml,
    officePasteLimitMessage,
    restoreImagePlaceholders,
    type OfficePasteResult,
} from '../utils/officePaste';
import { tsvTextToTableHtml } from '../utils/tsvTable';
import {
    buildPastedImagePlan,
    isExpectedExternalImageFailure,
    normalizePastedImageFailureReason,
    pastedImagePartialMessage,
    remoteImportFailureCodes,
    resolvePastedImages,
    type ClipboardImageSources,
    type PastedImagePlan,
    type PastedImageResolution,
    type PastedImageSlot,
    type PastedImageUploadContext,
} from '../utils/pastedImagePlan';
import { fetchBlobUrl, fetchRemoteImageBlob } from '../utils/pastedImageSource';
import { finalizePastedImagePlaceholders } from '../utils/pastedImagePlaceholder';
import {
    describeAsyncClipboardPayload,
    describeClipboardPayload,
    formatPasteDiagnostics,
    isPasteDiagnosticsEnabled,
    logAsyncClipboardPayload,
    logClipboardPayload,
    safeRemoteImageLocation,
    type PasteImageDiagnostic,
    type PasteDiagnosticsSnapshot,
    type SafeRemoteImageDiagnostic,
} from '../utils/clipboardPasteDiagnostics';
import {
    collectClipboardEventContent,
    emptyAsyncClipboardContent,
    readAsyncClipboardContentSafely,
    shouldReadAsyncClipboard,
    type AsyncClipboardContent,
} from '../utils/clipboardPasteContent';
import { extractRtfPictImages } from '../utils/rtfPict';
import {
    DEFAULT_INLINE_IMAGE_MAX_COUNT,
    DEFAULT_INLINE_IMAGE_UPLOAD_CONCURRENCY,
    inlineImageLimitMessage,
    inlineImagePartialMessage,
    runWithConcurrency,
} from '../utils/inlineImageLimit';
import { reportInlineImageBatchMetrics } from '../utils/inlineImageMetrics';
import {
    DEFERRED_IMAGE_SELECTOR,
    descriptionDeferredImageSx,
    descriptionImageSx,
} from '../utils/descriptionImageLayout';
import { useRichTableResize } from '../hooks/useDescriptionTableResize';
import { richTableSx } from '../utils/richTableSx';
import RichTableResizeOverlay from './richTable/RichTableResizeOverlay';
import {
    insertHtmlAsSingleTransaction,
    insertHtmlAtSelection as insertHtmlAtSelectionDom,
    restoreEditorSelection,
} from '../utils/richHtmlInsert';
import {
    analyzeImageDrop,
    unrecoverableDropMessage,
    type DroppedImage,
} from '../utils/imageDrop';
import {
    markDescriptionImagesFocusable,
    resolveDescriptionImageView,
    type DescriptionImageView,
} from '../utils/descriptionImageViewer';
import ImageZoomViewer from './common/ImageZoomViewer';
import MentionSuggestionPopper from './MentionSuggestionPopper';
import { useMentionAutocomplete } from '../hooks/useMentionAutocomplete';
import { markMentionTokensAtomic, type MentionCandidate } from '../utils/mentionMarkup';

export interface DescriptionImageImportOptions {
    context: string;
    bestEffort: boolean;
}

interface Props {
    /** 현재 description HTML. */
    value: string;
    /** 편집 결과 HTML 을 알려준다. */
    onChange: (html: string) => void;
    /** 붙여넣은 이미지 파일을 업로드하고 서버 접근 가능한 URL 을 돌려준다. */
    uploadImage: (
        file: File,
    ) => Promise<string | { url: string; id?: number; size?: number; upload_duration_ms?: number }>;
    /**
     * 외부 http(s) 이미지 주소를 **서버가** 내려받아 내부 이미지로 저장한다.
     * 브라우저의 로그인 쿠키를 서버에 넘기지 않으므로, 인증이 필요한 Jira/메일 이미지는
     * 여기서 실패하는 것이 정상이다(그때는 사용자에게 안내한다).
     * 주지 않으면 외부 주소 Drop 은 안내만 하고 본문을 건드리지 않는다.
     */
    importImageUrl?: (
        url: string,
        options?: DescriptionImageImportOptions,
    ) => Promise<{ url: string; id?: number; size?: number }>;
    placeholder?: string;
    disabled?: boolean;
    minHeight?: number;
    /** 편집 영역 최대 높이(px 또는 CSS 길이). 확대 편집 팝업에서 크게 쓰기 위해 노출. */
    maxHeight?: number | string;
    /** true 면 부모(flex container) 의 남은 공간을 가로·세로로 꽉 채운다. 확대 편집 팝업의 resize 추종용. */
    fill?: boolean;
    /** 외부 HTML/Base64 이미지 정리 결과를 사용자에게 알린다. */
    onWarning?: (message: string) => void;
    /** 경고가 아닌 처리 결과 안내(Office 서식 정리 완료 등). */
    onNotice?: (message: string) => void;
    /** 부모 저장 버튼이 업로드 완료까지 저장을 막을 수 있도록 상태를 전달. */
    onUploadingChange?: (uploading: boolean) => void;
    /** 본문에 넣을 수 있는 이미지 개수(백엔드 정책값). 화면마다 달라지면 안 된다. */
    maxImageCount?: number;
    /** 한 번에 붙여넣어도 동시에 실행할 업로드 개수(나머지는 큐 대기). */
    uploadConcurrency?: number;
    /** 운영 지표 로그 구분용 컨텍스트. */
    metricsContext?: string;
    /**
     * 본문에서 `@` 를 눌렀을 때 뜨는 멘션 후보.
     *
     * **주지 않으면 멘션 기능 자체가 꺼진다** — 이 편집기는 Task Description 말고도
     * 여러 곳에서 쓰이므로, 후보 범위를 정할 수 있는 호출부에서만 켜진다.
     * Task Description 의 후보는 "그 Task 의 현재 담당자"다(공간/프로젝트 전체가 아니다).
     */
    mentionCandidates?: MentionCandidate[];
    /**
     * 서식 도구모음(굵게/밑줄/글자 크기/글자색) 표시 여부. 기본 true.
     *
     * **표시 여부일 뿐 기능 스위치가 아니다** — false 여도 본문의 기존 서식은 그대로
     * 렌더링/저장되고, 이미지·멘션·링크·표 붙여넣기도 모두 그대로 동작한다.
     * 좁은 Task Details Drawer 는 본문 작성에 집중하도록 false 로 두고, 서식 편집은
     * 「크게 편집」 팝업(기본값 true)에서 한다.
     */
    showToolbar?: boolean;
    /**
     * 도구모음의 굵게/밑줄 **버튼** 표시 여부. 기본 true(기존 화면 불변).
     * false 여도 Ctrl/Cmd+B·U 단축키와 저장된 서식 렌더링은 그대로 동작한다 —
     * 개인 메모처럼 도구모음을 간결하게 두려는 화면의 표시 옵션일 뿐이다.
     */
    showEmphasisButtons?: boolean;
    /** 편집 영역을 테두리 없이 행 안에 녹여 넣는다(개인 메모 인라인 편집). 기본 false. */
    borderless?: boolean;
    /**
     * 글자 크기·색을 어디서 고르는가. 기본 'toolbar'(기존 화면 불변).
     * 'contextMenu' 면 상시 도구모음을 그리지 않고, 글자를 드래그해 고른 뒤 **우클릭**했을 때만
     * 크기(숫자)·색 메뉴가 뜬다. 선택이 없으면 브라우저 기본 우클릭 메뉴 그대로다.
     */
    formatMenu?: 'toolbar' | 'contextMenu';
    /** 이미지 선택 표시. 'subtle' = 얇은 검은 테두리(개인 메모). 기본 'accent'(파란 테두리). */
    imageSelectionStyle?: 'accent' | 'subtle';
    /** 이미지에 마우스를 올리면 '크게 보기' 버튼을 띄운다(더블클릭 확대를 발견할 수 있게). 기본 false. */
    showImageZoomHint?: boolean;
}

/**
 * 업로드가 끝나기 전 이미지 자리를 지키는 임시 이미지(1x1 투명 PNG).
 * data: 주소라 sanitizer 를 지나면 사라진다 — 업로드 중에 저장해도 깨진 이미지가
 * 저장되지 않고, 편집기 DOM 에서는 자리와 순서를 그대로 잡아 준다.
 */
const PENDING_IMAGE_SRC = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';
const PENDING_IMAGE_ALT = '이미지를 가져오는 중';
// 일반 사용자가 Vite dev server에 접속해도 보이지 않도록 명시적 QA opt-in까지 요구한다.
// production에서는 DEV가 false이므로 환경변수가 잘못 설정되어도 렌더링되지 않는다.
const PASTE_DIAGNOSTICS_ENABLED = isPasteDiagnosticsEnabled();

/** 업로드 실패 사유를 사용자 언어로. (캡처 붙여넣기와 문서 붙여넣기가 같은 문구를 쓴다) */
function uploadFailureMessage(err: any): string {
    const status = err?.response?.status;
    const detail = err?.response?.data?.detail || err?.message;
    let msg = '이미지 업로드에 실패했습니다.';
    if (status === 401 || status === 403) msg = '이미지 업로드 권한이 없습니다.';
    else if (status === 413) {
        msg = '캡처 이미지가 너무 커서 본문에 바로 삽입할 수 없습니다. 크기를 줄이거나 원본은 파일 첨부로 등록해주세요.';
    } else if (status && status >= 500) msg = '서버 오류로 업로드에 실패했습니다. 잠시 후 다시 시도해주세요.';
    else if (!status) msg = '네트워크 오류로 업로드에 실패했습니다.';
    if (detail && typeof detail === 'string') msg += `\n사유: ${detail}`;
    return msg;
}

/**
 * task 작업노트(WorkNoteModal)의 이미지 paste/resize 로직을 단일 필드용으로 재사용한 경량 리치 에디터.
 * - Ctrl+V 이미지 붙여넣기 → 업로드 → <img> 삽입 (data/blob URL 저장 안 함, 서버 URL 만)
 * - 이미지 클릭 → 선택 + 드래그 리사이즈 핸들 / 확대·축소 버튼 (style.width px 로 저장)
 * - 한글 IME: 편집 중에는 innerHTML 을 다시 쓰지 않아 자모 분리가 발생하지 않는다.
 */
const RichDescriptionEditor: React.FC<Props> = ({
    value, onChange, uploadImage, importImageUrl,
    placeholder, disabled, minHeight = 120, maxHeight = 360, fill = false,
    onWarning, onNotice, onUploadingChange, maxImageCount = DEFAULT_INLINE_IMAGE_MAX_COUNT,
    uploadConcurrency = DEFAULT_INLINE_IMAGE_UPLOAD_CONCURRENCY,
    metricsContext = 'task_description',
    mentionCandidates,
    showToolbar = true,
    showEmphasisButtons = true,
    borderless = false,
    formatMenu = 'toolbar',
    imageSelectionStyle = 'accent',
    showImageZoomHint = false,
}) => {
    const ref = useRef<HTMLDivElement>(null);
    const lastEmitted = useRef<string>('');
    const composing = useRef(false);
    // 업로드가 끝난 뒤 삽입하므로, 그 사이 편집기가 사라졌는지 확인할 근거가 필요하다.
    const mounted = useRef(true);
    // 이미지 업로드가 끝나기 전에 들어온 두 번째 붙여넣기 — 두 결과가 뒤엉키지 않게 막는다.
    const pasteInFlight = useRef(false);
    const clipboardBatches = useRef(0);
    const pasteTransactionSeq = useRef(0);
    // 한 번 거부된 Async Clipboard 권한을 Ctrl+V 마다 다시 요청하지 않는다.
    const asyncClipboardDenied = useRef(false);
    const [isUploading, setIsUploading] = useState(false);
    const [uploadProgress, setUploadProgress] = useState<{ done: number; total: number } | null>(null);
    const [pasteDiagnostics, setPasteDiagnostics] = useState<PasteDiagnosticsSnapshot | null>(null);
    const appendRemoteDiagnostic = useCallback((diagnostic: SafeRemoteImageDiagnostic) => {
        if (!PASTE_DIAGNOSTICS_ENABLED) return;
        setPasteDiagnostics(current => current
            ? { ...current, remote: [...current.remote, diagnostic].slice(-20) }
            : current);
    }, []);
    // onWarning 을 주지 않은 호출부의 기본 경고 채널 — 브라우저 alert 대신 toast.
    const warn = useCallback((message: string) => {
        if (onWarning) onWarning(message);
        else enqueueSnackbar(message, { variant: 'warning' });
    }, [onWarning]);
    const notify = useCallback((message: string) => {
        onNotice?.(message);
    }, [onNotice]);

    useEffect(() => {
        onUploadingChange?.(isUploading);
    }, [isUploading, onUploadingChange]);

    useEffect(() => () => {
        mounted.current = false;
        if (ref.current) releaseImagesInRoot(ref.current);
        onUploadingChange?.(false);
    }, [onUploadingChange]);

    /** 업로드 결과를 반영해도 되는 상태인가(unmount 뒤 state/DOM 을 건드리지 않기 위해). */
    const isEditorAlive = useCallback(
        () => mounted.current && !!ref.current?.isConnected,
        [],
    );

    /** Paste user gesture 안에서 한 번만 Async Clipboard 추가 타입을 읽는다. */
    const readAdditionalClipboard = useCallback((): Promise<AsyncClipboardContent> => {
        const canRead = !asyncClipboardDenied.current
            && typeof window !== 'undefined'
            && window.isSecureContext
            && typeof navigator !== 'undefined'
            && typeof (navigator.clipboard as Clipboard & { read?: unknown })?.read === 'function';
        if (!canRead) return Promise.resolve(emptyAsyncClipboardContent());
        // 이 호출 자체를 await 뒤로 미루면 user activation 이 사라질 수 있다.
        return readAsyncClipboardContentSafely()
            .then(({ content, permissionDenied }) => {
                if (permissionDenied) asyncClipboardDenied.current = true;
                logAsyncClipboardPayload(content);
                if (PASTE_DIAGNOSTICS_ENABLED) {
                    const report = describeAsyncClipboardPayload(content);
                    setPasteDiagnostics(current => current ? { ...current, asyncClipboard: report } : current);
                }
                return content;
            });
    }, []);

    const emit = useCallback(() => {
        const el = ref.current;
        if (!el) return;
        // 새로 들어온 이미지도 키보드로 열 수 있게 한다(tabindex 는 저장되지 않는다).
        markDescriptionImagesFocusable(el);
        // 멘션 토큰은 편집 중에만 atomic(contenteditable=false) 이고 저장되지는 않는다.
        // 붙여넣기/undo 로 들어온 토큰도 여기서 같은 상태가 된다.
        markMentionTokensAtomic(el);
        const result = sanitizeTaskDescriptionHtml(serializeRichHtml(el));
        const html = result.html;
        const normalized = html.replace(/<br\s*\/?>/gi, '').replace(/&nbsp;/gi, '').trim();
        const out = normalized === '' && !el.querySelector('img,table') ? '' : html;
        lastEmitted.current = out;
        onChange(out);
    }, [onChange]);

    // 본문 안 @멘션 자동완성. 후보를 주지 않은 호출부에서는 아무 동작도 하지 않는다
    // (키 입력을 가로채지 않으므로 기존 Enter/붙여넣기 동작이 그대로다).
    const mentions = useMentionAutocomplete({
        editorRef: ref, candidates: mentionCandidates, disabled, onCommit: emit,
    });

    // 붙여넣은 표를 이후에 다듬을 수 있게 해 주는 열/행 크기 조절.
    // 「크게 편집」과 Task Details 가 같은 컴포넌트를 쓰므로 두 화면의 동작이 갈라지지 않는다.
    const table = useRichTableResize({ editorRef: ref, disabled, onCommit: emit });
    const { applyStoredSizing: applyTableSizing } = table;

    // 외부 value 가 바뀌었고 현재 DOM 과 다를 때만 innerHTML 동기화(편집 중에는 안 건드림 → IME 안전)
    // layout effect — 편집기가 막 열렸을 때 빈 칸(placeholder)이 한 프레임 그려졌다가 본문으로
    // 바뀌는 깜빡임을 없앤다(그리기 전에 채운다). 동작은 이전과 같다.
    useLayoutEffect(() => {
        const el = ref.current;
        if (!el) return;
        if (composing.current) return;
        if (value === lastEmitted.current) return;
        releaseImagesInRoot(el);
        // [PLAN-A Memo Desktop] 넣기 전에 화면 주소로 — attachment:// 요청 실패(콘솔 오류) 없음. 저장 값은 그대로.
        el.innerHTML = storedHtmlForDisplay(value || '');
        normalizeImagesInRoot(el);
        markDescriptionImagesFocusable(el);
        markMentionTokensAtomic(el);
        // 저장된 열 너비/행 최소 높이를 다시 화면 크기로 펼친다(재조회 후 같은 크기 유지).
        applyTableSizing();
        lastEmitted.current = value || '';
    }, [value, applyTableSizing]);

    const insertHtmlAtSelection = useCallback((html: string) => {
        const root = ref.current;
        if (!root || !html) return;
        insertHtmlAtSelectionDom(root, html);
    }, []);

    // ── 붙여넣기 확인 Dialog (예외 상황에서만 뜬다) ──
    interface PasteChoice { label: string; value: string; primary?: boolean }
    const [pastePrompt, setPastePrompt] = useState<
        { title: string; message: string; choices: PasteChoice[] } | null
    >(null);
    const promptResolver = useRef<((value: string) => void) | null>(null);
    const askUser = useCallback(
        (title: string, message: string, choices: PasteChoice[]) => new Promise<string>((resolve) => {
            promptResolver.current = resolve;
            setPastePrompt({ title, message, choices });
        }),
        [],
    );
    const answerPrompt = useCallback((value: string) => {
        const resolve = promptResolver.current;
        promptResolver.current = null;
        setPastePrompt(null);
        resolve?.(value);
    }, []);
    // 편집기가 사라지면 대기 중인 붙여넣기는 취소로 끝낸다(본문 변경 없음).
    useEffect(() => () => {
        promptResolver.current?.('cancel');
        promptResolver.current = null;
    }, []);

    // Dialog 가 포커스를 가져가면 caret 이 사라지므로, 붙여넣기 시점의 위치를 붙잡아 둔다.
    const savedRange = useRef<Range | null>(null);
    const captureSelection = useCallback(() => {
        const root = ref.current;
        const selection = window.getSelection();
        const range = selection && selection.rangeCount ? selection.getRangeAt(0) : null;
        savedRange.current = range && root && root.contains(range.commonAncestorContainer)
            ? range.cloneRange()
            : null;
    }, []);
    const restoreSelection = useCallback(() => {
        const root = ref.current;
        if (!root) return;
        // 이미지 업로드가 끝날 때까지 시간이 흐르므로, 붙잡아 둔 위치가 아직 이 편집기 안에
        // 살아 있을 때만 쓴다. (그 사이 사용자가 입력해 노드가 사라졌으면 본문 끝에 넣는다)
        restoreEditorSelection(root, savedRange.current);
    }, []);

    /**
     * 붙여넣기 결과 전체를 편집기의 **한 단계**로 적용한다.
     * execCommand 는 deprecated 지만 contentEditable 의 native undo 스택에 들어가는
     * 유일한 방법이라, Ctrl+Z 한 번으로 붙여넣기 전체가 취소되려면 이것이 필요하다.
     */
    const insertAsSingleTransaction = useCallback((html: string): void => {
        const root = ref.current;
        if (!root) return;
        insertHtmlAsSingleTransaction(root, html, savedRange.current);
    }, []);

    const insertPlainText = useCallback((text: string): void => {
        if (!text) return;
        // 텍스트만 붙여넣는 경우에도 URL 은 링크로 살려 준다.
        const linkified = linkifyPlainText(text);
        if (/<a\s/i.test(linkified)) {
            insertAsSingleTransaction(linkified);
            return;
        }
        restoreSelection();
        try {
            if (document.execCommand('insertText', false, text)) return;
        } catch {
            // fall through
        }
        const escaped = document.createElement('div');
        escaped.textContent = text;
        insertHtmlAtSelection(escaped.innerHTML.replace(/\r?\n/g, '<br>'));
    }, [restoreSelection, insertHtmlAtSelection]);

    // ── 하이퍼링크 ──
    // 이 편집기에는 상시 툴바가 없다. 그래서 진입점을 세 가지로 둔다:
    //   ① 텍스트를 선택하면 뜨는 "링크" 버튼  ② Ctrl+K  ③ URL 붙여넣기/자동 링크
    const [selectedLink, setSelectedLink] = useState<{ el: HTMLAnchorElement; rect: DOMRect } | null>(null);
    const [textSelectionRect, setTextSelectionRect] = useState<DOMRect | null>(null);
    const [linkDraft, setLinkDraft] = useState<LinkDraft | null>(null);

    const refreshTextSelection = useCallback(() => {
        const root = ref.current;
        const selection = window.getSelection();
        if (disabled || !root || !selection || selection.rangeCount === 0 || selection.isCollapsed) {
            setTextSelectionRect(null);
            return;
        }
        const range = selection.getRangeAt(0);
        if (!root.contains(range.commonAncestorContainer) || !range.toString().trim()) {
            setTextSelectionRect(null);
            return;
        }
        const rect = range.getBoundingClientRect();
        setTextSelectionRect(rect.width || rect.height ? rect : null);
    }, [disabled]);

    const openLinkDialog = useCallback((anchor?: HTMLAnchorElement | null) => {
        captureSelection();
        setTextSelectionRect(null);
        if (anchor) {
            setLinkDraft({
                text: anchor.textContent || '',
                url: anchor.getAttribute('href') || '',
                editing: anchor,
            });
            return;
        }
        const selection = window.getSelection();
        const selected = selection && !selection.isCollapsed ? selection.toString() : '';
        setLinkDraft({ text: selected, url: '', editing: null });
    }, [captureSelection]);

    const applyLinkDraft = useCallback(() => {
        if (!linkDraft) return;
        const url = normalizeLinkUrl(linkDraft.url);
        if (!url) {
            warn('링크 주소를 확인해주세요. http(s):// 주소, 도메인, 이메일만 넣을 수 있습니다.');
            return;
        }
        const label = linkDraft.text.trim() || url;
        const editing = linkDraft.editing;
        setLinkDraft(null);
        if (editing && updateAnchorFromDraft(editing, url, label)) {
            setSelectedLink(null);
            emit();
            return;
        }
        insertAsSingleTransaction(buildAnchorHtml(url, label));
        emit();
    }, [linkDraft, warn, emit, insertAsSingleTransaction]);

    const removeLink = useCallback((anchor: HTMLAnchorElement) => {
        unwrapAnchor(anchor);
        setSelectedLink(null);
        emit();
    }, [emit]);

    const openLink = useCallback((href: string) => {
        if (!openLinkHref(href)) warn('열 수 없는 링크입니다.');
    }, [warn]);

    /** 스페이스/엔터 직전 단어가 URL 이면 링크로 바꾼다(캐럿은 링크 바깥으로 뺀다). */
    const autoLinkBeforeCaret = useCallback((): boolean => {
        // 한글 조합 중에는 손대지 않는다 — 조합 문자열이 깨진다.
        if (composing.current) return false;
        if (!autoLinkBeforeCaretDom(ref.current)) return false;
        emit();
        return true;
    }, [emit]);

    // ── 이미지 확대 뷰어 (더블클릭 / 포커스 후 Enter) ──
    // 보기 전용이다. 여는 동안 편집 HTML 은 전혀 건드리지 않는다.
    const [viewerImage, setViewerImage] = useState<DescriptionImageView | null>(null);
    // 이미지 크기 조절 Drag 상태. 아래 리사이즈 핸들이 쓰고, 뷰어는 "지금 끄는 중인가"를 본다.
    const dragRef = useRef<{ startX: number; startWidth: number; el: HTMLImageElement } | null>(null);

    const openImageViewer = useCallback((img: HTMLImageElement) => {
        // 크기 조절 Drag(이미지·표) 중에 뷰어가 끼어들면 안 된다.
        if (dragRef.current || table.isDragging()) return;
        const view = resolveDescriptionImageView(img);
        setViewerImage(view);
        if (!view.pending) return;
        // 아직 화면 밖이라 내려받지 않은 이미지 — 지금 받아서 보여 준다(본문은 그대로).
        void hydrateProtectedImage(img).then(() => {
            if (!img.isConnected) return;
            setViewerImage((current) => (current && current.pending
                ? resolveDescriptionImageView(img)
                : current));
        });
    }, [table]);

    const handleKeyDown = useCallback((e: React.KeyboardEvent<HTMLDivElement>) => {
        // 멘션 dropdown 이 열려 있고 고를 후보가 있을 때만 키를 가로챈다.
        // 닫혀 있으면 Enter 는 언제나 기존대로 줄바꿈이다(§4 Enter 충돌 금지).
        if (mentions.handleKeyDown(e)) {
            e.preventDefault();
            return;
        }
        // 이미지에 포커스를 둔 채 Enter — 읽기 모드에서도 확대할 수 있어야 한다.
        if (e.key === 'Enter' || e.key === ' ') {
            const focused = document.activeElement;
            if (focused instanceof HTMLImageElement && ref.current?.contains(focused)) {
                e.preventDefault();
                openImageViewer(focused);
                return;
            }
        }
        if (disabled) return;
        if (handleRichTextShortcut(e, ref.current)) { emit(); return; }
        if ((e.ctrlKey || e.metaKey) && (e.key === 'k' || e.key === 'K')) {
            e.preventDefault();
            openLinkDialog(null);
            return;
        }
        // 표 크기 Drag 1회 = transaction 1개. 그 이력이 남아 있는 동안에만 가로챈다.
        if (table.handleUndoRedoKey(e)) {
            e.preventDefault();
            return;
        }
        if (e.key === ' ' || e.key === 'Enter') autoLinkBeforeCaret();
    }, [disabled, openLinkDialog, autoLinkBeforeCaret, table, openImageViewer, mentions, emit]);

    /** URL 하나만 붙여넣은 경우 — 선택 텍스트가 있으면 그 텍스트에 링크를 건다. */
    const pasteAsLink = useCallback((url: string) => {
        const root = ref.current;
        const selection = window.getSelection();
        const hasSelection = !!root && !!selection && selection.rangeCount > 0 && !selection.isCollapsed
            && root.contains(selection.getRangeAt(0).commonAncestorContainer);
        const label = hasSelection ? selection!.toString() : url;
        insertAsSingleTransaction(buildAnchorHtml(url, label));
        emit();
        if (hasSelection) notify('선택한 텍스트에 링크를 연결했습니다.');
    }, [insertAsSingleTransaction, emit, notify]);

    // 링크 팝오버 바깥을 누르면 닫는다.
    useEffect(() => {
        if (!selectedLink) return;
        const handler = (e: MouseEvent) => {
            const target = e.target as HTMLElement | null;
            if (target?.closest('[data-link-popover="1"]')) return;
            setSelectedLink(null);
        };
        const reposition = () => {
            setSelectedLink(prev => (prev && prev.el.isConnected
                ? { el: prev.el, rect: prev.el.getBoundingClientRect() }
                : null));
        };
        document.addEventListener('mousedown', handler);
        window.addEventListener('scroll', reposition, true);
        window.addEventListener('resize', reposition);
        return () => {
            document.removeEventListener('mousedown', handler);
            window.removeEventListener('scroll', reposition, true);
            window.removeEventListener('resize', reposition);
        };
    }, [selectedLink]);

    // ── 이미지 선택 / 리사이즈 ──
    const [selectedImg, setSelectedImg] = useState<{ el: HTMLImageElement; rect: DOMRect } | null>(null);

    const refreshSelRect = useCallback(() => {
        setSelectedImg(prev => (prev ? { el: prev.el, rect: prev.el.getBoundingClientRect() } : prev));
    }, []);

    useEffect(() => {
        if (!selectedImg) return;
        window.addEventListener('scroll', refreshSelRect, true);
        window.addEventListener('resize', refreshSelRect);
        return () => {
            window.removeEventListener('scroll', refreshSelRect, true);
            window.removeEventListener('resize', refreshSelRect);
        };
    }, [selectedImg, refreshSelRect]);

    // ── 우클릭 서식 메뉴(formatMenu='contextMenu') ──
    const [formatMenuState, setFormatMenuState] = useState<RichTextContextMenuState | null>(null);
    const closeFormatMenu = useCallback(() => setFormatMenuState(null), []);
    const handleContextMenu = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
        if (formatMenu !== 'contextMenu' || disabled) return;
        const root = ref.current;
        const selection = window.getSelection();
        if (!root || !selection?.rangeCount || selection.isCollapsed) return;   // 선택 없음 → 기본 메뉴
        const range = selection.getRangeAt(0);
        if (!root.contains(range.commonAncestorContainer) || !range.toString().trim()) return;
        e.preventDefault();
        e.stopPropagation();
        setTextSelectionRect(null);
        setFormatMenuState({
            top: e.clientY, left: e.clientX, range: range.cloneRange(), currentPx: selectionTextSizePx(root),
        });
    }, [formatMenu, disabled]);

    // ── 이미지 hover → '크게 보기' 버튼(showImageZoomHint) ──
    const [hoveredImg, setHoveredImg] = useState<{ el: HTMLImageElement; rect: DOMRect } | null>(null);
    const overZoomButton = useRef(false);
    const hoverClearTimer = useRef<number | null>(null);
    const cancelHoverClear = () => {
        if (hoverClearTimer.current !== null) window.clearTimeout(hoverClearTimer.current);
        hoverClearTimer.current = null;
    };
    const scheduleHoverClear = () => {
        cancelHoverClear();
        // 이미지에서 버튼으로 옮겨 가는 사이에 사라지지 않게 잠깐 기다린다.
        hoverClearTimer.current = window.setTimeout(() => {
            if (!overZoomButton.current) setHoveredImg(null);
        }, 120);
    };
    useEffect(() => {
        if (!hoveredImg) return undefined;
        const clear = () => setHoveredImg(null);
        window.addEventListener('scroll', clear, true);
        window.addEventListener('resize', clear);
        return () => {
            window.removeEventListener('scroll', clear, true);
            window.removeEventListener('resize', clear);
        };
    }, [hoveredImg]);
    useEffect(() => () => cancelHoverClear(), []);

    // 바깥 클릭 시 선택 해제
    useEffect(() => {
        if (!selectedImg) return;
        const handler = (e: MouseEvent) => {
            const t = e.target as HTMLElement | null;
            if (!t) return;
            if (t.closest('[data-img-toolbar="1"]')) return;
            if (t.closest('[data-img-resize-handle="1"]')) return;
            if (t === selectedImg.el) return;
            setSelectedImg(null);
        };
        document.addEventListener('mousedown', handler);
        return () => document.removeEventListener('mousedown', handler);
    }, [selectedImg]);

    const resizeImage = (img: HTMLImageElement, action: 'shrink' | 'grow' | 'fit' | 'reset') => {
        if (action === 'reset') {
            img.style.width = '';
            img.style.height = '';
            img.removeAttribute('data-note-width');
        } else if (action === 'fit') {
            img.style.width = '100%';
            img.style.height = 'auto';
            img.setAttribute('data-note-width', '100%');
        } else {
            const current = img.offsetWidth || img.naturalWidth || 200;
            const delta = action === 'shrink' ? -50 : 50;
            const next = Math.max(50, Math.min(2000, current + delta));
            img.style.width = `${next}px`;
            img.style.height = 'auto';
            img.setAttribute('data-note-width', String(next));
        }
        emit();
        requestAnimationFrame(() => {
            setSelectedImg({ el: img, rect: img.getBoundingClientRect() });
        });
    };

    const startImageDragResize = useCallback((startEvent: React.PointerEvent, img: HTMLImageElement) => {
        startEvent.preventDefault();
        startEvent.stopPropagation();
        const startWidth = img.offsetWidth || img.naturalWidth || 200;
        dragRef.current = { startX: startEvent.clientX, startWidth, el: img };
        (startEvent.target as HTMLElement).setPointerCapture?.(startEvent.pointerId);

        const onMove = (e: PointerEvent) => {
            const r = dragRef.current;
            if (!r) return;
            const dx = e.clientX - r.startX;
            const next = Math.max(50, Math.min(2000, Math.round(r.startWidth + dx)));
            r.el.style.width = `${next}px`;
            r.el.style.height = 'auto';
            r.el.setAttribute('data-note-width', String(next));
            setSelectedImg({ el: r.el, rect: r.el.getBoundingClientRect() });
        };
        const onUp = () => {
            window.removeEventListener('pointermove', onMove);
            window.removeEventListener('pointerup', onUp);
            window.removeEventListener('pointercancel', onUp);
            if (dragRef.current) emit();
            dragRef.current = null;
        };
        window.addEventListener('pointermove', onMove);
        window.addEventListener('pointerup', onUp);
        window.addEventListener('pointercancel', onUp);
    }, [emit]);

    /**
     * 이미지 1장을 서버에 올리는 **유일한** 경로.
     *
     * 캡처 붙여넣기(단독)와 문서 붙여넣기(혼합)가 모두 이 함수를 쓴다 — 압축 정책,
     * 용량 검증(uploadImage 안), 저장되는 URL 형식이 두 경로에서 갈라지지 않게 하기 위해서다.
     */
    const uploadOneImage = useCallback(async (
        source: Blob,
        timestamp: number,
        namePrefix: string,
        onStage?: (patch: Partial<PasteImageDiagnostic>) => void,
    ): Promise<{ url: string; id?: number; rawBytes: number; storedBytes: number }> => {
        onStage?.({ compression: 'started', blobMime: source.type || '', blobBytes: source.size });
        let file: File;
        try {
            file = await compressPastedImage(source, timestamp, namePrefix);
            onStage?.({
                compression: 'success',
                compressedMime: file.type || '',
                compressedBytes: file.size,
            });
        } catch (error) {
            (error as { pasteFailureReason?: string }).pasteFailureReason = 'image_compression_failed';
            onStage?.({ compression: 'failed', reason: 'image_compression_failed' });
            throw error;
        }

        onStage?.({ uploadStarted: true, uploadResult: 'pending' });
        try {
            const uploaded = await uploadImage(file);
            const url = typeof uploaded === 'string' ? uploaded : uploaded.url;
            if (!url) {
                const missingUrlError = new Error('image upload returned no internal URL') as Error & {
                    pasteFailureReason?: string;
                };
                missingUrlError.pasteFailureReason = 'invalid_internal_image_response';
                throw missingUrlError;
            }
            onStage?.({
                uploadResult: 'success',
                internalUrlReceived: true,
                reason: '',
            });
            return {
                url,
                id: typeof uploaded === 'string' ? undefined : uploaded.id,
                rawBytes: source.size,
                storedBytes: typeof uploaded === 'string' ? file.size : (uploaded.size ?? file.size),
            };
        } catch (error) {
            const status = Number((error as { response?: { status?: number } })?.response?.status) || 0;
            const categorized = error as { pasteFailureReason?: string };
            categorized.pasteFailureReason ||= 'internal_upload_failed';
            onStage?.({
                uploadResult: status ? `http_${status}` : 'request_failed',
                internalUrlReceived: false,
                reason: categorized.pasteFailureReason,
            });
            throw error;
        }
    }, [uploadImage]);

    /**
     * 클립보드 이미지(스크린샷 Ctrl+V 등) 업로드 — 기존 동작 그대로.
     * 자리표시자를 먼저 넣고 업로드가 끝나면 내부 URL 로 교체한다.
     */
    const uploadClipboardImages = useCallback(async (
        blobs: Blob[],
        requestedCount: number,
    ): Promise<void> => {
        // 이미 본문에 들어 있는 이미지 + 이번에 추가할 이미지를 합산해서 판단한다.
        const currentImageCount = ref.current?.querySelectorAll('img').length || 0;
        const remaining = Math.max(0, maxImageCount - currentImageCount);
        const accepted = blobs.slice(0, remaining);
        const blockedCount = requestedCount - accepted.length;
        if (accepted.length === 0) {
            warn(inlineImageLimitMessage(maxImageCount));
            void reportInlineImageBatchMetrics({
                context: metricsContext,
                requested_count: requestedCount,
                blocked_by_limit_count: blockedCount,
                existing_image_count: currentImageCount,
                max_image_count: maxImageCount,
            });
            return;
        }
        if (blockedCount > 0) {
            warn(inlineImagePartialMessage(maxImageCount, accepted.length, requestedCount));
        }

        clipboardBatches.current += 1;
        setIsUploading(true);
        onUploadingChange?.(true);
        setUploadProgress({ done: 0, total: accepted.length });
        restoreSelection();
        const pendingImages = accepted.map((blob) => {
            const previewUrl = URL.createObjectURL(blob);
            const img = document.createElement('img');
            img.src = previewUrl;
            img.alt = '처리 중인 붙여넣기 이미지';
            img.setAttribute('data-upload-state', 'uploading');
            insertHtmlAtSelection(img.outerHTML);
            const inserted = ref.current?.querySelector(
                `img[src="${CSS.escape(previewUrl)}"]`,
            ) as HTMLImageElement | null;
            return { blob, previewUrl, img: inserted };
        });

        const failures: string[] = [];
        const failureStatuses: number[] = [];
        let uploadedCount = 0;
        let rawBytesTotal = 0;
        let storedBytesTotal = 0;
        let maxImageDurationMs = 0;
        const batchStartedAt = Date.now();

        // 동시 업로드 수를 제한해 30장을 붙여넣어도 브라우저/서버에 요청이 몰리지 않게 한다.
        await runWithConcurrency(pendingImages, uploadConcurrency, async ({ blob, previewUrl, img }) => {
            const imageStartedAt = Date.now();
            try {
                const uploaded = await uploadOneImage(blob, Date.now(), 'task-paste');
                const rawUrl = uploaded.url;
                uploadedCount += 1;
                rawBytesTotal += uploaded.rawBytes;
                storedBytesTotal += uploaded.storedBytes;
                maxImageDurationMs = Math.max(maxImageDurationMs, Date.now() - imageStartedAt);
                if (!img || !img.isConnected) return;
                img.dataset.canonicalSrc = rawUrl;
                img.alt = '붙여넣은 이미지';
                img.removeAttribute('data-upload-state');
                if (uploaded.id) {
                    img.dataset.imageId = String(uploaded.id);
                }
                img.setAttribute('loading', 'lazy');
                img.setAttribute('decoding', 'async');
                await hydrateProtectedImage(img);
            } catch (err: any) {
                // 실패한 이미지만 제거한다. 본문과 성공한 이미지는 그대로 남는다.
                img?.remove();
                failures.push(uploadFailureMessage(err));
                failureStatuses.push(Number(err?.response?.status) || 0);
            } finally {
                URL.revokeObjectURL(previewUrl);
                setUploadProgress(prev => (prev ? { ...prev, done: prev.done + 1 } : prev));
            }
        });
        clipboardBatches.current -= 1;
        if (clipboardBatches.current === 0) {
            setIsUploading(false);
            setUploadProgress(null);
        }
        if (failures.length > 0) {
            // 30장 붙여넣기에서 실패 안내가 30번 뜨지 않도록 한 번만 요약해 알린다.
            const unique = Array.from(new Set(failures));
            warn(
                failures.length === 1
                    ? failures[0]
                    : [
                        `이미지 ${pendingImages.length}개 중 ${failures.length}개를 업로드하지 못했습니다.`,
                        '성공한 이미지와 작성 중인 내용은 그대로 유지됩니다. 실패한 이미지만 다시 붙여넣어주세요.',
                        ...unique.slice(0, 2),
                    ].join('\n'),
            );
        }
        void reportInlineImageBatchMetrics({
            context: metricsContext,
            requested_count: requestedCount,
            uploaded_count: uploadedCount,
            failed_count: failures.length,
            blocked_by_limit_count: blockedCount,
            existing_image_count: currentImageCount,
            max_image_count: maxImageCount,
            raw_bytes_total: rawBytesTotal,
            stored_bytes_total: storedBytesTotal,
            total_duration_ms: Date.now() - batchStartedAt,
            max_image_duration_ms: maxImageDurationMs,
            failure_status_codes: failureStatuses,
        });
        emit();
    }, [
        uploadOneImage, emit, insertHtmlAtSelection, warn,
        restoreSelection, maxImageCount, uploadConcurrency, metricsContext, onUploadingChange,
    ]);

    /**
     * 자리 표식(업로드 대기 이미지) → 확보한 이미지. 확보하지 못한 자리는 지운다.
     * 편집기 DOM 을 통째로 다시 쓰지 않고 **그 노드만** 바꾸기 때문에, 업로드 중에
     * 사용자가 이어서 입력한 내용이 사라지지 않는다.
     */
    const finalizePendingImages = useCallback((
        resolvedByRef: Map<string, string>,
        targetRefs: Set<string>,
        failureByRef: Map<string, string>,
    ) => finalizePastedImagePlaceholders(
        ref.current,
        resolvedByRef,
        targetRefs,
        failureByRef,
        {
            pendingAlt: PENDING_IMAGE_ALT,
            resolvedAlt: '붙여넣은 이미지',
            // 내부 이미지는 인증 헤더가 필요해 <img> 가 직접 못 받는다 → 공용 경로로 그린다.
            onResolved: (img) => { void hydrateProtectedImage(img); },
        },
    ), []);

    /**
     * 붙여넣을 HTML 을 **동기적으로** 만든다(이미지 업로드 전).
     *
     * 여기서 결과가 비어 있으면 붙여넣기를 가로챌 이유가 없다 → 호출자는 preventDefault
     * 를 하지 않고 TSV/텍스트/브라우저 기본 동작으로 넘어간다. "가로챘는데 아무것도 넣지
     * 않는" 경로를 만들지 않는 것이 이 분리의 목적이다.
     */
    const prepareDocumentPaste = useCallback((result: OfficePasteResult) => {
        const currentImageCount = ref.current?.querySelectorAll('img').length || 0;
        const budget = Math.max(0, maxImageCount - currentImageCount);
        const plan = buildPastedImagePlan(result, budget);
        // sanitizer 를 지나는 동안 이미지 자리는 텍스트 표식으로 둔다(자리·순서 보존).
        const extracted = extractImagePlaceholders(result.html);
        const sanitized = sanitizeTaskDescriptionHtml(extracted.html);
        const acceptedRefs = new Set(plan.slots.map((slot) => slot.ref));
        const html = restoreImagePlaceholders(
            sanitized.html, extracted.refs, acceptedRefs, PENDING_IMAGE_SRC,
        );
        if (!html.trim()) return null;
        return { html, plan, currentImageCount };
    }, [maxImageCount]);

    /**
     * Office/웹 문서 붙여넣기(텍스트 + 표 + 이미지 혼합).
     *
     * 순서가 핵심이다:
     *   ① 텍스트·표를 **먼저** 삽입한다(이미지 업로드를 기다리지 않는다).
     *   ② 이미지가 없으면 여기서 끝 — 이미지 API 는 호출조차 하지 않는다.
     *   ③ 이미지는 자리 표식(data-office-image-ref)만 남겨 두고 비동기로 확보한 뒤,
     *      그 자리만 실제 이미지로 바꾼다. 확보하지 못한 자리는 지운다.
     *
     * 그래서 이미지가 400/401/timeout 을 내도 이미 들어간 텍스트·표는 그대로 남는다.
     * 편집기 전체 HTML 을 다시 set 하지 않으므로, 업로드 중 사용자가 이어서 입력한
     * 내용을 옛 상태로 덮어쓰지도 않는다.
     */
    const pasteDocumentHtml = useCallback(async (
        prepared: { html: string; plan: PastedImagePlan; currentImageCount: number },
        result: OfficePasteResult,
        clipboardImages: File[],
        eventRtf: string,
        asyncClipboardPromise: Promise<AsyncClipboardContent> | null,
    ): Promise<void> => {
        const { plan, currentImageCount } = prepared;
        const blockedCount = plan.blockedCount;
        const refIndexes = new Map(plan.slots.map((slot, index) => [slot.ref, index + 1]));
        const sourceLabel = (slot: PastedImageSlot): string => {
            if (slot.kind === 'remote') return /^https:/i.test(slot.url) ? 'https' : 'http';
            if (slot.kind === 'binary') return slot.reason || 'binary';
            if (slot.kind === 'data') return 'data';
            return 'internal';
        };
        const candidateCount = (slot: PastedImageSlot): number => slot.kind === 'remote'
            ? [slot.url, ...(slot.fallbackUrls || [])]
                .filter((url, index, all) => !!url && all.indexOf(url) === index)
                .slice(0, 2).length
            : 1;
        const initialImageRefs: PasteImageDiagnostic[] = plan.slots.map((slot, index) => ({
            index: index + 1,
            sourceDiscovered: sourceLabel(slot),
            candidateCount: candidateCount(slot),
            browserFetch: slot.kind === 'remote' ? 'not_started' : undefined,
            compression: slot.kind === 'internal' ? undefined : 'not_started',
            uploadStarted: false,
            internalUrlReceived: slot.kind === 'internal',
            final: 'pending',
        }));
        for (let index = 0; index < blockedCount; index += 1) {
            initialImageRefs.push({
                index: plan.slots.length + index + 1,
                sourceDiscovered: 'limit',
                candidateCount: 0,
                uploadStarted: false,
                internalUrlReceived: false,
                final: 'intentionally_skipped',
                reason: 'image_limit',
            });
        }
        for (let index = 0; index < result.unrecoverableImageCount; index += 1) {
            initialImageRefs.push({
                index: plan.totalCount + index + 1,
                sourceDiscovered: 'unrecoverable',
                candidateCount: 0,
                uploadStarted: false,
                internalUrlReceived: false,
                final: 'failed',
                reason: 'no_safe_source',
            });
        }
        const recountDiagnostics = (imageRefs: PasteImageDiagnostic[]) => ({
            resolvedImages: imageRefs.filter(item => item.final === 'resolved').length,
            failedImages: imageRefs.filter(item => item.final === 'failed').length,
            pendingImages: imageRefs.filter(item => item.final === 'pending').length,
            intentionallySkippedImages: imageRefs.filter(
                item => item.final === 'intentionally_skipped',
            ).length,
        });
        if (PASTE_DIAGNOSTICS_ENABLED) {
            setPasteDiagnostics(current => current ? {
                ...current,
                imageRefs: initialImageRefs,
                ...recountDiagnostics(initialImageRefs),
            } : current);
        }
        const updateImageDiagnostic = (
            imageRef: string,
            patch: Partial<PasteImageDiagnostic>,
        ) => {
            if (!PASTE_DIAGNOSTICS_ENABLED) return;
            const index = refIndexes.get(imageRef);
            if (!index) return;
            setPasteDiagnostics(current => {
                if (!current) return current;
                const imageRefs = (current.imageRefs || initialImageRefs).map(item => (
                    item.index === index ? { ...item, ...patch } : item
                ));
                return { ...current, imageRefs, ...recountDiagnostics(imageRefs) };
            });
        };

        // ── ① 텍스트·표 즉시 삽입 ──
        insertAsSingleTransaction(prepared.html);
        if (ref.current) normalizeImagesInRoot(ref.current);
        // 붙여넣은 표의 열 너비(원본 → data-col-width)를 실제 화면 크기로 펼친다.
        applyTableSizing();
        emit();

        const cleanedLayout = result.stats.removedEmptyBlocks > 0
            || result.stats.removedSpacerRows > 0
            || result.stats.removedSpacerColumns > 0
            || result.stats.unwrappedLayoutTables > 0
            || result.stats.reorderedAbsoluteGroups > 0;
        if (
            (result.isOffice || cleanedLayout)
            && plan.totalCount === 0
            && result.unrecoverableImageCount === 0
        ) {
            notify(
                result.isOffice
                    ? 'Office 문서의 서식을 Description 에 맞게 정리했습니다. (Ctrl+Z 로 되돌릴 수 있습니다)'
                    : '붙여넣은 서식을 Description 에 맞게 정리했습니다. (Ctrl+Z 로 되돌릴 수 있습니다)',
            );
        }

        // ── ② 이미지가 없으면 이미지 경로를 아예 실행하지 않는다 ──
        // (표만 붙여넣었는데 이미지 업로드/import 요청이 나가면 그것 자체가 오류다)
        if (plan.slots.length === 0) {
            const missing = result.unrecoverableImageCount + blockedCount;
            if (missing > 0) {
                warn(result.unrecoverableImageCount > 0
                    ? pastedImagePartialMessage(missing, 0)
                    : inlineImageLimitMessage(maxImageCount));
                void reportInlineImageBatchMetrics({
                    context: metricsContext + '_office_paste',
                    requested_count: missing,
                    failed_count: result.unrecoverableImageCount,
                    blocked_by_limit_count: blockedCount,
                    existing_image_count: currentImageCount,
                    max_image_count: maxImageCount,
                    failure_reasons: result.unrecoverableImageCount > 0
                        ? ['external_image_unavailable']
                        : [],
                });
            }
            return;
        }

        // ── ③ 이미지 확보(비동기) ──
        // Async Clipboard 권한/Blob 읽기를 기다리는 동안에도 Apply/Save가 pending
        // placeholder를 확정 저장하지 않도록 즉시 업로드 중 상태로 전환한다.
        setIsUploading(true);
        setUploadProgress({ done: 0, total: plan.slots.length });
        // Async Clipboard 가 이벤트보다 강한 경로다. 거기에 이미지가 없으면 event,
        // 그 다음 RTF pict 로 내려간다. 서로 합쳐 개수를 부풀리지 않고 source group
        // 별로 보수적으로 매칭한다.
        const asyncClipboard = asyncClipboardPromise
            ? await asyncClipboardPromise
            : emptyAsyncClipboardContent();
        const rtf = asyncClipboard.rtf || eventRtf;
        const rtfImages = rtf
            ? extractRtfPictImages(rtf, { maxImages: Math.max(1, maxImageCount) })
            : null;
        const imageSources: ClipboardImageSources = {
            asyncClipboard: asyncClipboard.images,
            clipboardEvent: clipboardImages,
            rtf: rtfImages?.images.map(image => image.file) || [],
        };
        const batchStartedAt = Date.now();
        const failureStatuses: number[] = [];
        let resolution: PastedImageResolution;
        try {
            resolution = await resolvePastedImages(plan, imageSources, {
            // 캡처 붙여넣기와 **같은** 압축·용량·업로드 경로를 그대로 재사용한다.
            uploadBlob: (
                blob: Blob,
                namePrefix: string,
                context?: PastedImageUploadContext,
            ) => uploadOneImage(
                blob,
                Date.now(),
                namePrefix,
                context ? (patch) => updateImageDiagnostic(context.ref, patch) : undefined,
            ),
            importRemoteUrl: importImageUrl
                ? async (url) => {
                    const location = safeRemoteImageLocation(url);
                    try {
                        const imported = await importImageUrl(url, {
                            context: metricsContext + '_office_paste',
                            bestEffort: true,
                        });
                        appendRemoteDiagnostic({ stage: 'backend', ...location, result: 'ok' });
                        return typeof imported === 'string' ? imported : imported.url;
                    } catch (error) {
                        const response = (error as {
                            response?: { status?: number; data?: { code?: string } };
                        })?.response;
                        appendRemoteDiagnostic({
                            stage: 'backend',
                            ...location,
                            result: response?.status ? `http_${response.status}` : 'request_failed',
                            status: response?.status,
                            code: response?.data?.code,
                        });
                        throw error;
                    }
                }
                : undefined,
            readBlobUrl: fetchBlobUrl,
            fetchRemoteUrl: (url) => fetchRemoteImageBlob(url, undefined, (diagnostic) => {
                appendRemoteDiagnostic(diagnostic);
            }),
            concurrency: uploadConcurrency,
            onProgress: (done, total) => {
                if (total <= 0) return;
                setIsUploading(true);
                setUploadProgress({ done, total });
            },
            onImageState: (imageRef, event) => {
                if (event.stage === 'browser_fetch') {
                    updateImageDiagnostic(imageRef, {
                        browserFetch: event.result,
                        ...(event.mime !== undefined ? { blobMime: event.mime } : {}),
                        ...(event.bytes !== undefined ? { blobBytes: event.bytes } : {}),
                    });
                    return;
                }
                if (event.stage === 'internal_url') {
                    updateImageDiagnostic(imageRef, {
                        internalUrlReceived: true,
                        reason: '',
                    });
                    return;
                }
                updateImageDiagnostic(imageRef, {
                    final: 'failed',
                    reason: event.reason,
                });
            },
        });
        } catch (error) {
            const failureByRef = new Map<string, string>();
            plan.slots.forEach((slot) => {
                failureByRef.set(slot.ref, 'image_pipeline_failed');
                updateImageDiagnostic(slot.ref, {
                    final: 'failed',
                    reason: 'image_pipeline_failed',
                });
            });
            resolution = {
                resolvedByRef: new Map(),
                uploadErrors: [error],
                remoteErrors: [],
                remoteFailedCount: plan.slots.filter(slot => slot.kind === 'remote').length,
                binaryUnmatched: [],
                rawBytesTotal: 0,
                storedBytesTotal: 0,
                maxImageDurationMs: 0,
                matchedClipboardImageCount: 0,
                failureByRef,
                internalFailureReasons: ['unexpected_exception'],
            };
        } finally {
            setIsUploading(false);
            setUploadProgress(null);
        }

        const failures = resolution.uploadErrors.map((error) => {
            failureStatuses.push(Number((error as any)?.response?.status) || 0);
            return uploadFailureMessage(error);
        });
        // 업로드 도중 편집기가 사라졌다면 DOM/state 를 건드리지 않는다.
        if (!isEditorAlive()) return;

        // ── ④ 자리 표식 → 실제 이미지 / 확보 못 한 자리는 삭제 ──
        const finalized = finalizePendingImages(
            resolution.resolvedByRef,
            new Set(plan.slots.map(slot => slot.ref)),
            resolution.failureByRef,
        );
        const placedImageCount = finalized.placed;
        emit();

        if (PASTE_DIAGNOSTICS_ENABLED) {
            setPasteDiagnostics(current => {
                if (!current) return current;
                const imageRefs = (current.imageRefs || initialImageRefs).map((item) => {
                    const imageRef = plan.slots[item.index - 1]?.ref;
                    const state = imageRef ? finalized.byRef.get(imageRef) : undefined;
                    return state ? { ...item, ...state } : item;
                });
                // accepted slot은 반드시 resolved/failed 중 하나로 종결한다.
                const completed = imageRefs.map((item) => item.final === 'pending'
                    ? {
                        ...item,
                        final: 'failed' as const,
                        reason: 'image_pipeline_incomplete',
                    }
                    : item);
                return {
                    ...current,
                    matchedImages: resolution.matchedClipboardImageCount,
                    imageRefs: completed,
                    ...recountDiagnostics(completed),
                };
            });
        }

        const requestedImageCount = plan.totalCount + result.unrecoverableImageCount;
        const lostImageCount = requestedImageCount - placedImageCount;
        const metricRemoteCodes = remoteImportFailureCodes(resolution.remoteErrors);
        const finalizedFailureReasons = Array.from(finalized.byRef.values())
            .filter(state => state.final === 'failed')
            .map(state => normalizePastedImageFailureReason(
                state.reason || 'unexpected_exception',
                metricRemoteCodes,
            ));
        if (result.unrecoverableImageCount > 0) {
            finalizedFailureReasons.push('external_image_unavailable');
        }
        const metricFailureReasons = Array.from(new Set([
            ...resolution.internalFailureReasons,
            ...finalizedFailureReasons,
        ]));
        const hasExpectedExternalLoss = finalizedFailureReasons.some(
            isExpectedExternalImageFailure,
        );
        const finalizedFailedCount = Array.from(finalized.byRef.values())
            .filter(state => state.final === 'failed').length
            + result.unrecoverableImageCount;
        if (lostImageCount > 0) {
            if (hasExpectedExternalLoss) {
                warn(pastedImagePartialMessage(requestedImageCount, placedImageCount));
            } else if (finalizedFailedCount === 0 && blockedCount > 0) {
                warn(inlineImageLimitMessage(maxImageCount));
            } else {
                warn(Array.from(new Set(failures))[0] || '이미지를 저장하지 못했습니다. 다시 시도해 주세요.');
            }
        }
        void reportInlineImageBatchMetrics({
            context: metricsContext + '_office_paste',
            requested_count: requestedImageCount,
            uploaded_count: placedImageCount,
            failed_count: finalizedFailedCount,
            blocked_by_limit_count: blockedCount,
            existing_image_count: currentImageCount,
            max_image_count: maxImageCount,
            raw_bytes_total: resolution.rawBytesTotal,
            stored_bytes_total: resolution.storedBytesTotal,
            total_duration_ms: Date.now() - batchStartedAt,
            max_image_duration_ms: resolution.maxImageDurationMs,
            failure_reasons: metricFailureReasons,
            failure_status_codes: failureStatuses,
        });
    }, [
        uploadOneImage, importImageUrl, emit, warn, notify, isEditorAlive, appendRemoteDiagnostic,
        insertAsSingleTransaction, finalizePendingImages, applyTableSizing,
        maxImageCount, uploadConcurrency, metricsContext,
    ]);

    /** 표 모양 텍스트(Excel TSV)를 표로 넣는다. 넣었으면 true. */
    const insertTsvTable = useCallback((text: string): boolean => {
        const tableHtml = tsvTextToTableHtml(text);
        if (!tableHtml) return false;
        const sanitized = sanitizeTaskDescriptionHtml(tableHtml);
        if (!sanitized.html.trim()) return false;
        insertAsSingleTransaction(sanitized.html);
        applyTableSizing();
        emit();
        notify('탭으로 구분된 값을 표로 붙여넣었습니다. (Ctrl+Z 로 되돌릴 수 있습니다)');
        return true;
    }, [insertAsSingleTransaction, applyTableSizing, emit, notify]);

    /**
     * 붙여넣기 1회의 처리 경로 결정.
     *
     * 규칙 하나만 지킨다: **넣을 것이 있을 때만 preventDefault 한다.**
     * 가로챈 뒤 아무것도 넣지 못하는 경로가 있으면 사용자에게는 "붙여넣기가 안 되는
     * 편집기" 가 된다. 그래서 삽입할 HTML 을 먼저 동기적으로 만들어 보고, 만들지
     * 못하면 TSV → 텍스트 → 브라우저 기본 동작 순으로 넘긴다.
     */
    const runPaste = useCallback(async (e: React.ClipboardEvent<HTMLDivElement>) => {
        const clipboard = e.clipboardData;
        // DataTransfer 는 await 후 무효화될 수 있으므로 모든 event 타입을 먼저 동기 수집한다.
        const eventContent = collectClipboardEventContent(clipboard);
        let pastedHtml = eventContent.html;
        let plainText = eventContent.plainText;
        let eventRtf = eventContent.rtf;
        const clipboardBlobs = eventContent.images;
        // 개발 환경에서만: 이 PC 의 클립보드가 실제로 무엇을 줬는지(형태만) 남긴다.
        // 붙여넣기 결과가 PC 마다 다른 원인은 거의 항상 여기서 드러난다.
        logClipboardPayload(clipboard, pastedHtml, plainText, eventRtf, eventContent.uriList);
        if (PASTE_DIAGNOSTICS_ENABLED) {
            setPasteDiagnostics({
                clipboardEvent: describeClipboardPayload(
                    clipboard, pastedHtml, plainText, eventRtf, eventContent.uriList,
                ),
                remote: [],
                matchedImages: 0,
                resolvedImages: 0,
                failedImages: 0,
            });
        }

        let pasteClaimed = false;
        const claimPaste = () => {
            if (pasteClaimed) return;
            e.preventDefault();
            captureSelection();
            pasteClaimed = true;
        };

        // 표-only HTML 은 이미지 파이프라인에서 완전히 분리한다. img/item/RTF 단서가
        // 있을 때만 navigator.read() 를 user gesture 안에서 시작한다.
        const mayContainRecoverableImages = shouldReadAsyncClipboard({
            html: pastedHtml,
            rtf: eventRtf,
            eventImageCount: clipboardBlobs.length,
        });
        const asyncClipboardPromise = mayContainRecoverableImages
            ? readAdditionalClipboard()
            : null;

        // ClipboardEvent 에는 없고 Async Clipboard 에만 HTML/RTF가 있는 브라우저.
        // 중복 기본 삽입을 막기 위해 await 전에 paste transaction 을 선점한다.
        if (!pastedHtml && asyncClipboardPromise) {
            claimPaste();
            const asyncClipboard = await asyncClipboardPromise;
            pastedHtml = asyncClipboard.html || '';
            plainText = plainText || asyncClipboard.plainText;
            eventRtf = eventRtf || asyncClipboard.rtf;
        }

        const requestedClipboardImageCount = Math.max(
            eventContent.imageItemCount,
            clipboardBlobs.length,
        );

        const preferredDirectImages = async (): Promise<File[]> => {
            const asyncClipboard = asyncClipboardPromise
                ? await asyncClipboardPromise
                : emptyAsyncClipboardContent();
            if (asyncClipboard.images.length > 0) return asyncClipboard.images;
            if (clipboardBlobs.length > 0) return clipboardBlobs;
            const rtf = asyncClipboard.rtf || eventRtf;
            return rtf ? extractRtfPictImages(rtf).images.map(image => image.file) : [];
        };

        // 주소창/링크를 복사한 경우. 선택 텍스트가 있으면 그 텍스트에 링크를 건다.
        const pastedLinkUrl = clipboardBlobs.length === 0 ? asSingleLinkUrl(plainText) : null;

        // ── 경로 A: HTML 이 없다(이미지 단독 · 링크 · 순수 텍스트/TSV) ──
        if (!pastedHtml) {
            const directImages = mayContainRecoverableImages
                ? await preferredDirectImages()
                : [];
            if (directImages.length > 0) {
                claimPaste();
                await uploadClipboardImages(
                    directImages,
                    Math.max(requestedClipboardImageCount, directImages.length),
                );
                return;
            }
            if (pastedLinkUrl) {
                claimPaste();
                pasteAsLink(pastedLinkUrl);
                return;
            }
            // Excel 이 text/html 을 주지 않는 환경 — 탭으로 구분된 값은 표로 살린다.
            if (tsvTextToTableHtml(plainText)) {
                claimPaste();
                insertTsvTable(plainText);
                return;
            }
            if (pasteClaimed && plainText) {
                insertPlainText(plainText);
                emit();
            }
            return; // 그 밖의 텍스트 / Ctrl+Shift+V 는 브라우저 기본 동작
        }

        pasteTransactionSeq.current += 1;
        let result: OfficePasteResult;
        try {
            result = namespaceOfficePasteImages(
                normalizeOfficePasteHtml(pastedHtml),
                `paste-${Date.now()}-${pasteTransactionSeq.current}`,
            );
        } catch {
            claimPaste();
            if (!insertTsvTable(plainText) && plainText) { insertPlainText(plainText); emit(); }
            return;
        }

        // HTML 이 그 URL 하나를 표현한 것뿐이면(브라우저의 링크 복사) 링크 붙여넣기로 처리한다.
        if (pastedLinkUrl && result.images.length === 0 && result.pendingImages.length === 0) {
            const htmlText = new DOMParser()
                .parseFromString(result.html, 'text/html').body?.textContent || '';
            if (htmlText.trim() === plainText.trim()) {
                claimPaste();
                pasteAsLink(pastedLinkUrl);
                return;
            }
        }

        if (result.limitExceeded) {
            claimPaste();
            const answer = await askUser(
                '붙여넣기에는 너무 큰 문서입니다',
                `${officePasteLimitMessage(result.limitExceeded)}\n\n`
                + '텍스트만 붙여넣으면 서식과 이미지 없이 내용만 들어갑니다.',
                [
                    { label: '텍스트만 붙여넣기', value: 'text', primary: true },
                    { label: '취소', value: 'cancel' },
                ],
            );
            if (answer === 'text' && plainText) {
                insertPlainText(plainText);
                emit();
            }
            return;
        }

        // ── 경로 B: 편집 가능한 구조가 우선 ──
        // 클립보드의 "선택 영역 전체 이미지"는 구조를 복구할 수 없을 때만 쓴다
        // (그래야 같은 내용이 HTML 과 이미지로 중복 삽입되지 않는다).
        const preferClipboardImage = clipboardBlobs.length > 0
            && (!result.hasMeaningfulContent || isSingleImageHtml(result));
        if (preferClipboardImage) {
            claimPaste();
            const directImages = await preferredDirectImages();
            await uploadClipboardImages(
                directImages,
                Math.max(requestedClipboardImageCount, directImages.length),
            );
            return;
        }

        // HTML 경로가 표를 만들어 내지 못했는데 text/plain 이 표 모양이면 그쪽이 정확하다.
        // (Excel 이 `<table>` 껍데기 없는 조각만 주는 환경 — 파서가 복구하지 못한 경우)
        const htmlHasImages = result.images.length > 0 || result.pendingImages.length > 0;
        let prepared: ReturnType<typeof prepareDocumentPaste> | null;
        try {
            prepared = result.hasMeaningfulContent ? prepareDocumentPaste(result) : null;
        } catch {
            claimPaste();
            if (!insertTsvTable(plainText) && plainText) { insertPlainText(plainText); emit(); }
            return;
        }
        const preferTsvTable = !htmlHasImages
            && result.stats.tableCount === 0
            && !!tsvTextToTableHtml(plainText);

        if (prepared && !preferTsvTable) {
            claimPaste();
            await pasteDocumentHtml(
                prepared, result, clipboardBlobs, eventRtf, asyncClipboardPromise,
            );
            return;
        }

        // ── 경로 C: HTML 로는 넣을 것이 없다 → TSV → 텍스트 → 브라우저 기본 동작 ──
        if (tsvTextToTableHtml(plainText)) {
            claimPaste();
            insertTsvTable(plainText);
            return;
        }
        if (prepared) {
            claimPaste();
            await pasteDocumentHtml(
                prepared, result, clipboardBlobs, eventRtf, asyncClipboardPromise,
            );
            return;
        }
        if (plainText) {
            claimPaste();
            insertPlainText(plainText);
            emit();
            return;
        }
        // 우리가 넣을 수 있는 것이 하나도 없다 → 가로채지 않는다(브라우저 기본 붙여넣기).
    }, [
        emit, askUser, captureSelection, insertPlainText, insertTsvTable,
        uploadClipboardImages, prepareDocumentPaste, pasteDocumentHtml, pasteAsLink,
        readAdditionalClipboard,
    ]);

    /**
     * 붙여넣기 1회 = 처리 1회.
     * 이미지 업로드는 비동기라, 앞선 붙여넣기가 끝나기 전에 다음 붙여넣기가 들어오면
     * 두 결과가 서로 다른 caret 위치에 엇갈려 들어간다. 그래서 한 번에 하나만 처리한다.
     */
    const handlePaste = useCallback(async (e: React.ClipboardEvent<HTMLDivElement>) => {
        if (disabled) return;
        // File-only clipboard images reserve their own DOM positions synchronously.
        // They can overlap in time; completion only updates each reserved image.
        const files = Array.from(e.clipboardData.items).filter(item => item.type.startsWith('image/'))
            .map(item => item.getAsFile()).filter((file): file is File => !!file);
        if (!pasteInFlight.current && files.length && !e.clipboardData.getData('text/html')
            && !e.clipboardData.getData('text/rtf')) {
            e.preventDefault();
            captureSelection();
            await uploadClipboardImages(files, files.length);
            return;
        }
        if (pasteInFlight.current || clipboardBatches.current > 0) {
            e.preventDefault();
            warn('이미지를 붙여넣는 중입니다. 잠시 후 다시 붙여넣어주세요.');
            return;
        }
        pasteInFlight.current = true;
        try {
            await runPaste(e);
        } finally {
            pasteInFlight.current = false;
        }
    }, [disabled, warn, runPaste, captureSelection, uploadClipboardImages]);

    // ── 외부 이미지 Drag & Drop ──
    // 편집기 안에서 시작한 Drag(내 이미지 위치 옮기기)는 브라우저 기본 동작이 맞다.
    const internalDrag = useRef(false);
    const fileInputRef = useRef<HTMLInputElement>(null);
    const filePickerResolver = useRef<((files: File[]) => void) | null>(null);

    /** 자동으로 가져올 수 없을 때 사용자가 직접 파일을 고르는 경로. */
    const pickImageFiles = useCallback(() => new Promise<File[]>((resolve) => {
        const input = fileInputRef.current;
        if (!input) {
            resolve([]);
            return;
        }
        filePickerResolver.current = resolve;
        input.value = '';
        // 파일 선택 창을 닫기만 해도(취소) change 는 오지 않는다 → 포커스 복귀로 마무리한다.
        const onFocus = () => {
            window.removeEventListener('focus', onFocus);
            window.setTimeout(() => {
                const pending = filePickerResolver.current;
                if (!pending) return;
                filePickerResolver.current = null;
                pending([]);
            }, 500);
        };
        window.addEventListener('focus', onFocus);
        input.click();
    }), []);

    useEffect(() => () => {
        filePickerResolver.current?.([]);
        filePickerResolver.current = null;
    }, []);

    /** Drop 위치에 캐럿을 놓는다(그래야 놓은 자리에 이미지가 들어간다). */
    const placeCaretAtPoint = useCallback((clientX: number, clientY: number) => {
        const root = ref.current;
        if (!root) return;
        root.focus({ preventScroll: true });
        const doc = document as Document & {
            caretRangeFromPoint?: (x: number, y: number) => Range | null;
            caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null;
        };
        let range: Range | null = null;
        if (typeof doc.caretRangeFromPoint === 'function') {
            range = doc.caretRangeFromPoint(clientX, clientY);
        } else if (typeof doc.caretPositionFromPoint === 'function') {
            const position = doc.caretPositionFromPoint(clientX, clientY);
            if (position) {
                range = document.createRange();
                range.setStart(position.offsetNode, position.offset);
                range.collapse(true);
            }
        }
        if (!range || !root.contains(range.commonAncestorContainer)) {
            range = document.createRange();
            range.selectNodeContents(root);
            range.collapse(false);
        }
        const selection = window.getSelection();
        selection?.removeAllRanges();
        selection?.addRange(range);
    }, []);

    /** 이미 서버에 저장된 이미지를 본문에 넣는다(캡처 붙여넣기와 같은 이미지 노드). */
    const insertInternalImages = useCallback((
        entries: { url: string; id?: number }[],
    ): void => {
        if (entries.length === 0) return;
        const html = entries.map((entry) => {
            const img = document.createElement('img');
            img.setAttribute('src', entry.url);
            img.setAttribute('alt', '가져온 이미지');
            if (entry.id) img.setAttribute('data-image-id', String(entry.id));
            return img.outerHTML;
        }).join('');
        insertAsSingleTransaction(html);
        if (ref.current) normalizeImagesInRoot(ref.current);
        emit();
    }, [insertAsSingleTransaction, emit]);

    /**
     * 허용된 http(s) 이미지 주소를 서버가 내려받아 내부 이미지로 만든다.
     * 실패하면 **본문을 건드리지 않고** 실패 목록만 돌려준다(액박을 남기지 않기 위해).
     */
    const importRemoteImages = useCallback(async (
        images: DroppedImage[],
    ): Promise<{ imported: { url: string; id?: number }[]; failed: DroppedImage[] }> => {
        const imported: { url: string; id?: number }[] = [];
        const failed: DroppedImage[] = [];
        if (!importImageUrl || images.length === 0) {
            return { imported, failed: images };
        }
        setIsUploading(true);
        setUploadProgress({ done: 0, total: images.length });
        await runWithConcurrency(images, uploadConcurrency, async (image) => {
            try {
                const result = await importImageUrl(image.url as string);
                imported.push(typeof result === 'string' ? { url: result } : result);
            } catch {
                // 로그인 권한이 필요하거나 차단된 주소. 사용자에게는 아래에서 한 번만 안내한다.
                failed.push(image);
            } finally {
                setUploadProgress(prev => (prev ? { ...prev, done: prev.done + 1 } : prev));
            }
        });
        setIsUploading(false);
        setUploadProgress(null);
        return { imported, failed };
    }, [importImageUrl, uploadConcurrency]);

    const handleDrop = useCallback(async (e: React.DragEvent<HTMLDivElement>) => {
        if (disabled) return;
        if (internalDrag.current) return; // 내부 이동 — 브라우저에 맡긴다
        const analysis = analyzeImageDrop(e.dataTransfer);
        if (!analysis.hasImagePayload) return; // 텍스트 Drop 등은 기본 동작 유지

        e.preventDefault();
        e.stopPropagation();
        placeCaretAtPoint(e.clientX, e.clientY);
        captureSelection();

        const currentImageCount = ref.current?.querySelectorAll('img').length || 0;
        const budget = Math.max(0, maxImageCount - currentImageCount);
        if (budget === 0) {
            warn(inlineImageLimitMessage(maxImageCount));
            return;
        }
        const accepted = analysis.images.slice(0, budget);
        const blockedByLimit = analysis.images.length - accepted.length;

        const localFiles = accepted
            .filter(image => !!image.file)
            .map(image => image.file as File);
        const remoteImages = accepted.filter(image => image.source === 'remote-url' && image.url);

        // 서버 import 는 본문을 건드리기 전에 끝낸다 → 실패해도 Description 은 그대로.
        const { imported, failed } = await importRemoteImages(remoteImages);

        const unavailable = failed.length + analysis.unrecoverable.length;
        let extraFiles: File[] = [];
        if (unavailable > 0) {
            const lines = [
                `이미지 ${unavailable}개는 자동으로 가져올 수 없습니다.`,
                '',
            ];
            if (failed.length > 0) {
                lines.push(
                    '· 원본 서비스의 로그인 권한이 필요하거나 접근이 허용되지 않은 주소입니다.',
                );
            }
            const reasons = unrecoverableDropMessage(analysis.unrecoverable);
            if (reasons) lines.push(reasons);
            lines.push('');
            lines.push('이미지를 복사한 뒤 Ctrl+V 로 붙여넣거나, 파일로 선택해주세요.');
            const answer = await askUser('이미지를 가져오지 못했습니다', lines.join('\n'), [
                { label: '파일 선택', value: 'pick', primary: true },
                { label: '이미지 없이 계속', value: 'continue' },
                { label: '취소', value: 'cancel' },
            ]);
            if (answer === 'cancel') return; // 본문 변화 없음
            if (answer === 'pick') extraFiles = await pickImageFiles();
        }

        if (blockedByLimit > 0) {
            warn(inlineImagePartialMessage(maxImageCount, accepted.length, analysis.images.length));
        }

        restoreSelection();
        if (imported.length > 0) insertInternalImages(imported);

        const files = localFiles.concat(extraFiles).slice(0, Math.max(0, budget - imported.length));
        if (files.length > 0) await uploadClipboardImages(files, files.length);
    }, [
        disabled, maxImageCount, warn, askUser, captureSelection, restoreSelection,
        placeCaretAtPoint, pickImageFiles, importRemoteImages, insertInternalImages,
        uploadClipboardImages,
    ]);

    const copyPasteDiagnostics = useCallback(async () => {
        if (!pasteDiagnostics) return;
        const report = formatPasteDiagnostics(pasteDiagnostics);
        try {
            await navigator.clipboard.writeText(report);
        } catch {
            const textarea = document.createElement('textarea');
            textarea.value = report;
            textarea.setAttribute('readonly', '');
            textarea.style.cssText = 'position:fixed;left:-9999px;top:0';
            document.body.appendChild(textarea);
            textarea.select();
            document.execCommand('copy');
            textarea.remove();
        }
        enqueueSnackbar('익명화된 붙여넣기 진단을 복사했습니다.', { variant: 'success' });
    }, [pasteDiagnostics]);

    return (
        <Box sx={fill
            ? { position: 'relative', height: '100%', display: 'flex', flexDirection: 'column', minHeight: 0 }
            : { position: 'relative' }}>
            {showToolbar && formatMenu === 'toolbar' && !disabled && (
                <RichTextToolbar editorRef={ref} onFormat={emit} showEmphasis={showEmphasisButtons} />
            )}
            {isUploading && (
                <Box sx={{ mb: 0.5 }}>
                    <LinearProgress
                        variant={uploadProgress && uploadProgress.total > 1 ? 'determinate' : 'indeterminate'}
                        value={uploadProgress && uploadProgress.total > 0
                            ? (uploadProgress.done / uploadProgress.total) * 100
                            : undefined}
                        sx={{ borderRadius: 1 }}
                    />
                    {uploadProgress && uploadProgress.total > 1 && (
                        <Typography variant="caption" sx={{ color: '#6B7280', mt: 0.25, display: 'block' }}>
                            이미지 업로드 중 {uploadProgress.done}/{uploadProgress.total}
                        </Typography>
                    )}
                </Box>
            )}
            {PASTE_DIAGNOSTICS_ENABLED && pasteDiagnostics && (
                <Box sx={{ display: 'flex', justifyContent: 'flex-end', mb: 0.5 }}>
                    <Button
                        type="button"
                        size="small"
                        variant="text"
                        onClick={() => { void copyPasteDiagnostics(); }}
                        data-testid="copy-paste-diagnostics"
                        sx={{ minHeight: 24, py: 0, px: 0.75, fontSize: '0.72rem' }}
                    >
                        붙여넣기 진단 복사 (DEV)
                    </Button>
                </Box>
            )}
            <Box
                ref={ref}
                contentEditable={!disabled}
                suppressContentEditableWarning
                // 링크 아래 빨간 물결선(브라우저 맞춤법 검사)을 끈다. 작업노트와 같은 설정.
                {...RICH_TEXT_SURFACE_PROPS}
                onInput={() => {
                    // 내용이 바뀌면 표 크기 Undo 이력을 버린다 → Ctrl+Z 는 다시 타이핑 취소로.
                    table.notifyContentChanged();
                    emit();
                    mentions.refresh();
                }}
                onBlur={() => { emit(); setTextSelectionRect(null); mentions.close(); }}
                onCompositionStart={() => { composing.current = true; }}
                onCompositionEnd={() => { composing.current = false; emit(); mentions.refresh(); }}
                onPaste={handlePaste}
                onDragStart={() => { internalDrag.current = true; }}
                onDragEnd={() => { internalDrag.current = false; }}
                onDragOver={(e) => { if (!disabled) e.preventDefault(); }}
                onDrop={(e) => {
                    const wasInternal = internalDrag.current;
                    internalDrag.current = false;
                    if (wasInternal) return; // 편집기 안에서 옮기는 중 — 기본 동작
                    void handleDrop(e);
                }}
                onKeyDown={handleKeyDown}
                onKeyUp={(e) => { refreshTextSelection(); if (e.key !== 'Escape') mentions.refresh(); }}
                onMouseUp={() => { refreshTextSelection(); mentions.refresh(); }}
                onContextMenu={handleContextMenu}
                onMouseOver={showImageZoomHint ? (e) => {
                    const target = e.target as HTMLElement;
                    if (!(target instanceof HTMLImageElement)) return;
                    cancelHoverClear();
                    setHoveredImg({ el: target, rect: target.getBoundingClientRect() });
                } : undefined}
                onMouseOut={showImageZoomHint ? (e) => {
                    if (e.target instanceof HTMLImageElement) scheduleHoverClear();
                } : undefined}
                onPointerMove={table.handlePointerMove}
                onPointerDown={table.handlePointerDown}
                onPointerLeave={table.handlePointerLeave}
                // 한 번 클릭 = 선택·크기 조절 / 두 번 클릭 = 크게 보기.
                // (표 경계 더블클릭은 pointerdown 단계에서 처리되므로 여기까지 오지 않는다)
                onDoubleClick={(e) => {
                    const target = e.target as HTMLElement;
                    if (!(target instanceof HTMLImageElement)) return;
                    e.preventDefault();
                    e.stopPropagation();
                    openImageViewer(target);
                }}
                onClick={(e) => {
                    const target = e.target as HTMLElement;
                    // 표 안을 누르면 크기 조절 도구를 띄운다(평상시에는 아무것도 보이지 않는다).
                    table.syncActiveTable(target);
                    if (target instanceof HTMLImageElement) {
                        e.preventDefault();
                        e.stopPropagation();
                        setSelectedImg({ el: target, rect: target.getBoundingClientRect() });
                        return;
                    }
                    // contentEditable 안의 <a> 는 클릭해도 열리지 않는다. 대신 팝오버를 띄우고,
                    // Ctrl/⌘+클릭은 곧바로 새 탭으로 연다.
                    const anchor = target.closest?.('a') as HTMLAnchorElement | null;
                    if (anchor && ref.current?.contains(anchor)) {
                        e.preventDefault();
                        if (e.ctrlKey || e.metaKey) {
                            openLink(anchor.getAttribute('href') || '');
                            return;
                        }
                        setSelectedLink({ el: anchor, rect: anchor.getBoundingClientRect() });
                        return;
                    }
                    setSelectedLink(null);
                }}
                data-placeholder={placeholder
                    || '설명을 입력하세요. 이미지는 Ctrl+V, 링크는 Ctrl+K 로 넣을 수 있습니다.'}
                sx={{
                    fontSize: '0.9rem',
                    // 글자 크기 '기본'(rich-size-base) 표식이 되돌아갈 크기 = 이 편집기의 본문 크기.
                    '--rich-base-font-size': '0.9rem',
                    lineHeight: 1.7,
                    p: 1.25,
                    ...(fill
                        ? { flex: 1, minHeight: 0, maxHeight: 'none' }
                        : { minHeight, maxHeight }),
                    overflowY: 'auto',
                    // 아주 넓은 표가 들어와도 편집 영역 밖으로 밀고 나가지 않게 한다.
                    overflowX: 'auto',
                    outline: 'none',
                    border: '1px solid',
                    borderColor: 'rgba(0,0,0,0.23)',
                    borderRadius: 1,
                    color: '#374151',
                    wordBreak: 'break-word',
                    whiteSpace: 'pre-wrap',
                    transition: 'border-color 0.15s',
                    '&:hover': { borderColor: 'rgba(0,0,0,0.55)' },
                    '&:focus': { borderColor: '#2955FF', borderWidth: '2px', p: '9px' },
                    ...(borderless ? {
                        p: 0.5,
                        borderColor: 'transparent',
                        '&:hover': { borderColor: 'transparent' },
                        '&:focus': { borderColor: 'transparent', borderWidth: '1px', p: 0.5 },
                    } : {}),
                    '&:empty::before': {
                        content: 'attr(data-placeholder)',
                        color: '#9CA3AF',
                        pointerEvents: 'none',
                    },
                    '& b, & strong': { fontWeight: 700 },
                    // ── @멘션 토큰 ──
                    // 문장 전체를 물들이지 않고 토큰만 눈에 들어오게 한다(soft primary).
                    // class 가 아니라 identity 속성으로 고른다 — class 가 빠진 옛 HTML 도
                    // 같은 모양으로 보이게 하기 위해서다(계약은 data 속성 하나뿐).
                    '& span[data-mention-user-id]': {
                        display: 'inline-block',
                        px: 0.6,
                        borderRadius: '6px',
                        bgcolor: 'rgba(41,85,255,0.10)',
                        border: '1px solid rgba(41,85,255,0.28)',
                        color: '#1E40AF',
                        fontWeight: 600,
                        lineHeight: 1.45,
                        whiteSpace: 'nowrap',
                        // atomic 토큰이라 안쪽에 캐럿이 들어가지 않는다 — 텍스트 커서도 감춘다.
                        cursor: 'default',
                        userSelect: 'none',
                    },
                    '& a': {
                        color: '#2955FF',
                        textDecoration: 'underline',
                        textUnderlineOffset: '2px',
                        cursor: 'pointer',
                        // 긴 URL 이 편집 폭을 밀어내지 않게 한다.
                        overflowWrap: 'anywhere',
                    },
                    // ── 외부 문서 붙여넣기 타이포그래피 ──
                    // 저장 HTML 에는 class/style 이 남지 않으므로(sanitizer) 간격은 전적으로
                    // 여기서 결정된다. Word/PPT 의 문단 여백 대신 Description 기준을 쓴다.
                    '& p': { margin: '0 0 8px', lineHeight: 1.55 },
                    '& h1, & h2, & h3, & h4, & h5, & h6': {
                        margin: '16px 0 8px',
                        lineHeight: 1.3,
                        fontWeight: 700,
                    },
                    '& h1': { fontSize: '1.25rem' },
                    '& h2': { fontSize: '1.1rem' },
                    '& h3, & h4, & h5, & h6': { fontSize: '1rem' },
                    '& ul, & ol': { margin: '0 0 8px', paddingLeft: '1.4em' },
                    '& li': { margin: 0, lineHeight: 1.55 },
                    '& blockquote': {
                        margin: '0 0 8px',
                        paddingLeft: 1.25,
                        borderLeft: '3px solid rgba(0,0,0,0.12)',
                        color: '#6B7280',
                    },
                    // 표 규칙은 작업노트·메모와 같은 단일 출처(utils/richTableSx)를 쓴다.
                    ...richTableSx,
                    // 이미지도 텍스트와 같은 흐름에 참여한다(옆 배치 + 폭 부족 시 자동 wrap).
                    // 규칙은 utils/descriptionImageLayout 한 곳에만 둔다 — 「크게 편집」과
                    // Task Details 가 같은 컴포넌트를 쓰므로 두 화면의 배치가 갈라지지 않는다.
                    '& img': descriptionImageSx,
                    // 아직 내려받지 않은 이미지는 자리만 잡아 둔다(스크롤하면 제자리에 그대로 표시됨).
                    [DEFERRED_IMAGE_SELECTOR]: descriptionDeferredImageSx,
                    // 개인 메모: 이미지 강조는 파랑 대신 얇은 검정(키보드 포커스 표시도 같은 톤).
                    ...(imageSelectionStyle === 'subtle'
                        ? { '& img:focus-visible': { outline: '1px solid #111827', outlineOffset: '2px' } }
                        : {}),
                }}
            />

            {/* 본문 @멘션 후보 — 캐럿 위치에 붙는다. 후보를 주지 않은 호출부에서는 열리지 않는다. */}
            <MentionSuggestionPopper
                open={mentions.open}
                anchorRect={mentions.anchorRect}
                suggestions={mentions.suggestions}
                highlight={mentions.highlight}
                hasCandidates={mentions.hasCandidates}
                onHighlight={mentions.setHighlight}
                onSelect={mentions.select}
            />

            {/* 자동으로 가져오지 못한 이미지를 사용자가 직접 고를 때만 쓰인다. */}
            <input
                ref={fileInputRef}
                type="file"
                accept="image/*"
                multiple
                hidden
                onChange={(e) => {
                    const picked = Array.from(e.target.files || [])
                        .filter(file => (file.type || '').toLowerCase().startsWith('image/'));
                    const resolve = filePickerResolver.current;
                    filePickerResolver.current = null;
                    resolve?.(picked);
                }}
            />

            {/* 표 열/행 경계 안내선 + 표 선택 메뉴 — 작업노트·메모와 같은 컴포넌트. */}
            <RichTableResizeOverlay table={table} disabled={disabled} />

            {!disabled && selectedImg && (
                <>
                    {/* 리사이즈 toolbar */}
                    <Box
                        data-img-toolbar="1"
                        onMouseDown={(e) => e.preventDefault()}
                        sx={{
                            position: 'fixed',
                            top: Math.max(4, selectedImg.rect.top + 4),
                            left: selectedImg.rect.right - 4,
                            transform: 'translateX(-100%)',
                            zIndex: 2000,
                            display: 'flex', alignItems: 'center', gap: 0.25,
                            px: 0.5, py: 0.25, borderRadius: 999,
                            bgcolor: 'rgba(30,30,30,0.92)',
                            backdropFilter: 'blur(6px)',
                            boxShadow: '0 4px 12px rgba(0,0,0,0.35)',
                        }}
                    >
                        {showImageZoomHint && (
                            <>
                                <Tooltip title="크게 보기 (더블클릭)" arrow>
                                    <IconButton
                                        size="small"
                                        aria-label="이미지 크게 보기"
                                        data-testid="rich-image-zoom-toolbar"
                                        onClick={() => openImageViewer(selectedImg.el)}
                                        sx={{ color: '#fff', p: 0.4 }}
                                    >
                                        <ZoomInIcon sx={{ fontSize: '0.85rem' }} />
                                    </IconButton>
                                </Tooltip>
                                <Box sx={{ width: 1, height: 14, bgcolor: 'rgba(255,255,255,0.25)', mx: 0.25 }} />
                            </>
                        )}
                        <Tooltip title="축소 (-50px)" arrow>
                            <IconButton size="small" onClick={() => resizeImage(selectedImg.el, 'shrink')} sx={{ color: '#fff', p: 0.4 }}>
                                <RemoveIcon sx={{ fontSize: '0.85rem' }} />
                            </IconButton>
                        </Tooltip>
                        <Tooltip title="확대 (+50px)" arrow>
                            <IconButton size="small" onClick={() => resizeImage(selectedImg.el, 'grow')} sx={{ color: '#fff', p: 0.4 }}>
                                <AddIcon sx={{ fontSize: '0.85rem' }} />
                            </IconButton>
                        </Tooltip>
                        <Box sx={{ width: 1, height: 14, bgcolor: 'rgba(255,255,255,0.25)', mx: 0.25 }} />
                        <Tooltip title="폭 맞춤" arrow>
                            <IconButton size="small" onClick={() => resizeImage(selectedImg.el, 'fit')} sx={{ color: '#fff', p: 0.4, fontSize: '0.65rem', fontWeight: 700, minWidth: 32, borderRadius: 999 }}>
                                100%
                            </IconButton>
                        </Tooltip>
                        <Tooltip title="원본 크기" arrow>
                            <IconButton size="small" onClick={() => resizeImage(selectedImg.el, 'reset')} sx={{ color: '#fff', p: 0.4, fontSize: '0.65rem', fontWeight: 700, minWidth: 32, borderRadius: 999 }}>
                                원본
                            </IconButton>
                        </Tooltip>
                    </Box>
                    {/* 선택 테두리 */}
                    <Box data-testid="rich-image-selection" sx={{
                        position: 'fixed',
                        top: selectedImg.rect.top - 2,
                        left: selectedImg.rect.left - 2,
                        width: selectedImg.rect.width + 4,
                        height: selectedImg.rect.height + 4,
                        border: imageSelectionStyle === 'subtle' ? '1px solid #111827' : '2px solid #2955FF',
                        borderRadius: 1,
                        pointerEvents: 'none',
                        zIndex: 1999,
                        boxSizing: 'border-box',
                    }} />
                    {/* 드래그 리사이즈 핸들 */}
                    <Box
                        data-img-resize-handle="1"
                        onPointerDown={(e) => startImageDragResize(e, selectedImg.el)}
                        onMouseDown={(e) => e.preventDefault()}
                        sx={{
                            position: 'fixed',
                            top: selectedImg.rect.bottom - 8,
                            left: selectedImg.rect.right - 8,
                            width: 16, height: 16,
                            bgcolor: imageSelectionStyle === 'subtle' ? '#111827' : '#2955FF',
                            border: '2px solid #fff',
                            borderRadius: 0.5,
                            cursor: 'nwse-resize',
                            zIndex: 2001,
                            boxShadow: '0 1px 3px rgba(0,0,0,0.35)',
                            touchAction: 'none',
                        }}
                    />
                </>
            )}

            {/* 이미지 hover → 크게 보기. 한 번 클릭은 선택(크기 조절), 더블클릭·이 버튼은 확대. */}
            {/* 선택된 이미지는 크기 조절 막대에 같은 버튼이 있다(겹치지 않게 hover 표시는 숨긴다). */}
            {showImageZoomHint && hoveredImg && hoveredImg.el.isConnected && hoveredImg.rect.width >= 40
                && selectedImg?.el !== hoveredImg.el && (
                <Tooltip title="크게 보기 (더블클릭)" arrow placement="top">
                    <IconButton
                        data-img-toolbar="1"
                        data-testid="rich-image-zoom-hint"
                        aria-label="이미지 크게 보기"
                        size="small"
                        onMouseDown={(e) => e.preventDefault()}
                        onMouseEnter={() => { overZoomButton.current = true; cancelHoverClear(); }}
                        onMouseLeave={() => { overZoomButton.current = false; scheduleHoverClear(); }}
                        onClick={() => {
                            const img = hoveredImg.el;
                            overZoomButton.current = false;
                            setHoveredImg(null);
                            openImageViewer(img);
                        }}
                        sx={{
                            position: 'fixed',
                            top: Math.max(4, hoveredImg.rect.top + 6),
                            left: hoveredImg.rect.left + 6,
                            zIndex: 2002,
                            p: 0.4,
                            color: '#fff',
                            bgcolor: 'rgba(17,24,39,0.72)',
                            '&:hover': { bgcolor: 'rgba(17,24,39,0.9)' },
                        }}
                    >
                        <ZoomInIcon sx={{ fontSize: '1rem' }} />
                    </IconButton>
                </Tooltip>
            )}

            {formatMenu === 'contextMenu' && (
                <RichTextContextMenu
                    editorRef={ref}
                    state={formatMenuState}
                    onClose={closeFormatMenu}
                    onFormat={emit}
                />
            )}

            {/* 텍스트를 선택하면 뜨는 링크 버튼 — 상시 툴바 없이 링크를 걸 수 있는 진입점 */}
            {!disabled && textSelectionRect && !selectedLink && !linkDraft && (
                <Box
                    data-link-toolbar="1"
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => openLinkDialog(null)}
                    sx={{
                        position: 'fixed',
                        // Keep the selection link affordance below text so it cannot
                        // cover the shared formatting toolbar on the first line.
                        top: Math.min(window.innerHeight - 40, textSelectionRect.bottom + 4),
                        left: textSelectionRect.left,
                        zIndex: 2000,
                        display: 'flex', alignItems: 'center', gap: 0.5,
                        px: 1, py: 0.5, borderRadius: 999,
                        bgcolor: 'rgba(30,30,30,0.92)',
                        backdropFilter: 'blur(6px)',
                        boxShadow: '0 4px 12px rgba(0,0,0,0.35)',
                        color: '#fff',
                        cursor: 'pointer',
                        fontSize: '0.7rem',
                        fontWeight: 700,
                        userSelect: 'none',
                    }}
                >
                    <LinkIcon sx={{ fontSize: '0.85rem' }} />
                    링크 (Ctrl+K)
                </Box>
            )}

            {/* 링크 클릭 시 — 열기 / 편집 / 제거 */}
            {selectedLink && (
                <Box
                    data-link-popover="1"
                    sx={{
                        position: 'fixed',
                        top: Math.min(window.innerHeight - 48, selectedLink.rect.bottom + 6),
                        left: Math.max(8, Math.min(selectedLink.rect.left, window.innerWidth - 340)),
                        zIndex: 2000,
                        display: 'flex', alignItems: 'center', gap: 0.5,
                        px: 1, py: 0.5, borderRadius: 1.5,
                        bgcolor: '#fff',
                        border: '1px solid rgba(0,0,0,0.12)',
                        boxShadow: '0 6px 18px rgba(0,0,0,0.18)',
                        maxWidth: 340,
                    }}
                >
                    <Typography
                        variant="caption"
                        sx={{ color: '#374151', mr: 0.5, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                        title={selectedLink.el.getAttribute('href') || ''}
                    >
                        {linkDisplayLabel(selectedLink.el.getAttribute('href'))}
                    </Typography>
                    <Tooltip title="새 탭에서 열기" arrow>
                        <IconButton
                            size="small"
                            onClick={() => openLink(selectedLink.el.getAttribute('href') || '')}
                            sx={{ p: 0.4 }}
                        >
                            <OpenInNewIcon sx={{ fontSize: '0.85rem' }} />
                        </IconButton>
                    </Tooltip>
                    {!disabled && (
                        <>
                            <Tooltip title="링크 편집" arrow>
                                <IconButton size="small" onClick={() => openLinkDialog(selectedLink.el)} sx={{ p: 0.4 }}>
                                    <EditIcon sx={{ fontSize: '0.85rem' }} />
                                </IconButton>
                            </Tooltip>
                            <Tooltip title="링크 제거 (텍스트는 유지)" arrow>
                                <IconButton size="small" onClick={() => removeLink(selectedLink.el)} sx={{ p: 0.4 }}>
                                    <LinkOffIcon sx={{ fontSize: '0.85rem' }} />
                                </IconButton>
                            </Tooltip>
                        </>
                    )}
                </Box>
            )}

            {/* 링크 hover 안내 — 작업노트와 같은 컴포넌트. 클릭 팝오버가 떠 있으면 쉰다. */}
            <RichLinkHoverHint rootRef={ref} suppressed={!!selectedLink || !!linkDraft} />

            {/* 링크 삽입 / 편집 — 작업노트와 같은 Dialog 를 공유한다. */}
            <LinkEditDialog
                draft={linkDraft}
                onChange={setLinkDraft}
                onApply={applyLinkDraft}
                onRemove={removeLink}
            />

            {/* 이미지 크게 보기 — Task Details · 「크게 편집」 팝업 · 읽기 모드가 같은 뷰어를 쓴다. */}
            <ImageZoomViewer
                open={!!viewerImage}
                src={viewerImage?.src || null}
                alt={viewerImage?.alt}
                unavailable={viewerImage?.unavailable}
                pending={viewerImage?.pending}
                onClose={() => setViewerImage(null)}
            />

            {/* 예외 상황(이미지 복구 실패 · 용량 초과)에서만 뜬다. 일반 붙여넣기는 질문 없이 처리. */}
            <Dialog
                open={!!pastePrompt}
                onClose={() => answerPrompt('cancel')}
                maxWidth="xs"
                fullWidth
            >
                <DialogTitle sx={{ fontWeight: 700, fontSize: '0.95rem' }}>
                    {pastePrompt?.title}
                </DialogTitle>
                <DialogContent>
                    <Typography
                        variant="body2"
                        sx={{ whiteSpace: 'pre-wrap', color: '#374151', lineHeight: 1.6 }}
                    >
                        {pastePrompt?.message}
                    </Typography>
                </DialogContent>
                <DialogActions sx={{ px: 3, pb: 2 }}>
                    {(pastePrompt?.choices || []).map(choice => (
                        <Button
                            key={choice.value}
                            onClick={() => answerPrompt(choice.value)}
                            variant={choice.primary ? 'contained' : 'text'}
                            sx={{
                                textTransform: 'none',
                                fontWeight: 600,
                                ...(choice.primary ? { bgcolor: '#2955FF' } : { color: '#6B7280' }),
                            }}
                        >
                            {choice.label}
                        </Button>
                    ))}
                </DialogActions>
            </Dialog>
        </Box>
    );
};

export default RichDescriptionEditor;
