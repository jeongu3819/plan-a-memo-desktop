/**
 * ImageZoomViewer — Description 안의 이미지를 큰 화면에서 확인하는 lightbox.
 *
 * 정책:
 *  - **보기 전용**이다. 여기서 이미지를 다시 올리거나 편집 HTML 을 바꾸지 않는다.
 *    편집기가 이미 화면에 그리고 있는 src(권한 이미지의 blob URL 포함)를 그대로 쓴다.
 *  - MUI `Dialog` 위에 올린다. 그래서 focus trap · ESC(가장 위 모달만) · 배경 스크롤 잠금
 *    중첩 처리를 직접 구현하지 않는다 → 「크게 편집」 팝업 위에서 열려도 꼬이지 않는다.
 *  - 배율의 기준은 원본 크기다(`utils/imageZoom`).
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Box, CircularProgress, Dialog, IconButton, Tooltip, Typography } from '@mui/material';
import CloseIcon from '@mui/icons-material/Close';
import ZoomInIcon from '@mui/icons-material/ZoomIn';
import ZoomOutIcon from '@mui/icons-material/ZoomOut';
import FitScreenIcon from '@mui/icons-material/FitScreen';
import CropOriginalIcon from '@mui/icons-material/CropOriginal';
import ImageNotSupportedOutlinedIcon from '@mui/icons-material/ImageNotSupportedOutlined';
import {
    clampImageZoom,
    fitImageZoom,
    formatImageZoom,
    imageZoomBounds,
    stepImageZoom,
    type ImageSize,
} from '../../utils/imageZoom';
import { IMAGE_VIEWER_LAYERS } from '../../utils/imageViewerLayers';

interface Props {
    open: boolean;
    /** 편집기에 지금 그려져 있는 주소. 비어 있으면 "불러올 수 없음"으로 본다. */
    src: string | null;
    alt?: string;
    /** 편집기에서 이미 로드에 실패한 이미지 — 뷰어에서 다시 시도하지 않고 안내만 한다. */
    unavailable?: boolean;
    /** 아직 원본을 받아오는 중(주소가 나중에 들어온다) — 안내 대신 로딩을 보여 준다. */
    pending?: boolean;
    onClose: () => void;
}

/** 이미지에 내주는 화면 비율(요구 사양: 약 90vw × 90vh). */
const VIEWPORT_RATIO = 0.9;
/** 상단 도구 막대에 가리지 않도록 세로로 조금 더 뺀다. */
const TOOLBAR_RESERVE_PX = 72;

const ViewerTooltip: React.FC<{ title: string; children: React.ReactElement }> = ({ title, children }) => (
    <Tooltip
        title={title}
        arrow
        placement="bottom"
        disableInteractive
        slotProps={{
            popper: {
                sx: { zIndex: IMAGE_VIEWER_LAYERS.tooltip, pointerEvents: 'none' },
                modifiers: [
                    { name: 'flip', enabled: true, options: { boundary: 'viewport', padding: 8 } },
                    { name: 'preventOverflow', enabled: true, options: { boundary: 'viewport', padding: 8 } },
                ],
            },
            tooltip: {
                sx: {
                    bgcolor: '#111827', color: '#fff', fontWeight: 600,
                    boxShadow: '0 4px 14px rgba(0,0,0,0.55)',
                },
            },
            arrow: { sx: { color: '#111827' } },
        }}
    >
        {children}
    </Tooltip>
);

const ImageZoomViewer: React.FC<Props> = ({ open, src, alt, unavailable, pending, onClose }) => {
    const [natural, setNatural] = useState<ImageSize | null>(null);
    const [status, setStatus] = useState<'loading' | 'loaded' | 'error'>('loading');
    /** null = 화면 맞춤. 사용자가 배율을 정하면 숫자가 된다. */
    const [zoom, setZoom] = useState<number | null>(null);
    const [viewport, setViewport] = useState<ImageSize>({ width: 0, height: 0 });

    const scrollRef = useRef<HTMLDivElement | null>(null);
    const panRef = useRef<{ x: number; y: number; left: number; top: number } | null>(null);

    const measureViewport = useCallback(() => {
        if (typeof window === 'undefined') return;
        setViewport({
            width: Math.max(0, window.innerWidth * VIEWPORT_RATIO),
            height: Math.max(0, window.innerHeight * VIEWPORT_RATIO - TOOLBAR_RESERVE_PX),
        });
    }, []);

    // 열 때마다 기본 상태(화면 맞춤)로 되돌린다.
    useEffect(() => {
        if (!open) return;
        setNatural(null);
        setZoom(null);
        setStatus(!src || unavailable ? 'error' : 'loading');
        measureViewport();
    }, [open, src, unavailable, measureViewport]);

    useEffect(() => {
        if (!open) return;
        window.addEventListener('resize', measureViewport);
        return () => window.removeEventListener('resize', measureViewport);
    }, [open, measureViewport]);

    const fitZoom = fitImageZoom(natural, viewport);
    // 매 렌더마다 새 객체가 되면 아래 휠 리스너가 계속 다시 붙는다.
    const bounds = useMemo(() => imageZoomBounds(fitZoom), [fitZoom]);
    const effectiveZoom = zoom === null ? fitZoom : zoom;
    const isFit = zoom === null;

    const zoomIn = useCallback(() => {
        setZoom((current) => stepImageZoom(current === null ? fitZoom : current, 1, bounds));
    }, [fitZoom, bounds]);
    const zoomOut = useCallback(() => {
        setZoom((current) => stepImageZoom(current === null ? fitZoom : current, -1, bounds));
    }, [fitZoom, bounds]);
    const zoomFit = useCallback(() => setZoom(null), []);
    const zoomOriginal = useCallback(() => setZoom(clampImageZoom(1, bounds)), [bounds]);

    // Ctrl/⌘ + 휠 = 줌. 그냥 휠은 확대된 이미지를 훑어보는 스크롤로 남긴다.
    // (모달이 배경 스크롤을 잠그므로 페이지가 함께 움직일 일은 없다)
    useEffect(() => {
        const el = scrollRef.current;
        if (!open || !el) return;
        const onWheel = (event: WheelEvent) => {
            if (!event.ctrlKey && !event.metaKey) return;
            event.preventDefault();
            if (event.deltaY < 0) zoomIn();
            else zoomOut();
        };
        el.addEventListener('wheel', onWheel, { passive: false });
        return () => el.removeEventListener('wheel', onWheel);
    }, [open, zoomIn, zoomOut]);

    // 확대해서 화면보다 커진 이미지는 마우스로 끌어서 본다.
    const startPan = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
        const el = scrollRef.current;
        if (!el) return;
        const scrollable = el.scrollWidth > el.clientWidth || el.scrollHeight > el.clientHeight;
        if (!scrollable || event.button !== 0) return;
        panRef.current = { x: event.clientX, y: event.clientY, left: el.scrollLeft, top: el.scrollTop };
        el.setPointerCapture?.(event.pointerId);
        event.preventDefault();
    }, []);

    const movePan = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
        const el = scrollRef.current;
        const start = panRef.current;
        if (!el || !start) return;
        el.scrollLeft = start.left - (event.clientX - start.x);
        el.scrollTop = start.top - (event.clientY - start.y);
    }, []);

    const endPan = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
        if (!panRef.current) return;
        panRef.current = null;
        scrollRef.current?.releasePointerCapture?.(event.pointerId);
    }, []);

    const showImage = !!src && !unavailable && status !== 'error';
    // 주소를 아직 못 받았어도 "받는 중"이면 안내 문구 대신 로딩을 보여 준다.
    const showLoading = (showImage && status === 'loading') || (!src && !unavailable && !!pending);
    const showError = !showImage && !showLoading;
    const width = natural && showImage ? Math.round(natural.width * effectiveZoom) : undefined;

    return (
        <Dialog
            open={open}
            onClose={onClose}
            fullScreen
            aria-label={alt ? `이미지 크게 보기: ${alt}` : '이미지 크게 보기'}
            // 「크게 편집」 팝업(및 편집기의 고정 도구 막대)보다 반드시 위에 온다.
            sx={{ zIndex: IMAGE_VIEWER_LAYERS.dialog }}
            PaperProps={{
                sx: {
                    bgcolor: 'rgba(15,23,42,0.92)',
                    backgroundImage: 'none',
                    boxShadow: 'none',
                },
            }}
        >
            {/* 도구 막대 — 축소 / 배율 / 확대 / 화면 맞춤 / 원본 / 닫기 */}
            <Box
                sx={{
                    position: 'absolute', top: 12, right: 12, zIndex: IMAGE_VIEWER_LAYERS.toolbar,
                    display: 'flex', alignItems: 'center', gap: 0.25,
                    px: 0.75, py: 0.25, borderRadius: 999,
                    bgcolor: 'rgba(17,24,39,0.85)',
                    backdropFilter: 'blur(6px)',
                    boxShadow: '0 4px 16px rgba(0,0,0,0.4)',
                }}
            >
                <ViewerTooltip title="축소 (Ctrl+휠)">
                    <span>
                        <IconButton
                            size="small"
                            onClick={zoomOut}
                            disabled={!showImage || effectiveZoom <= bounds.min}
                            aria-label="축소"
                            sx={{ color: '#fff', '&.Mui-disabled': { color: 'rgba(255,255,255,0.3)' } }}
                        >
                            <ZoomOutIcon fontSize="small" />
                        </IconButton>
                    </span>
                </ViewerTooltip>
                <ViewerTooltip title="현재 배율">
                    <Typography
                        component="span"
                        variant="caption"
                        aria-live="polite"
                        sx={{ color: '#fff', minWidth: 46, textAlign: 'center', fontWeight: 700, fontSize: '0.72rem' }}
                    >
                        {showImage ? formatImageZoom(effectiveZoom) : '—'}
                    </Typography>
                </ViewerTooltip>
                <ViewerTooltip title="확대 (Ctrl+휠)">
                    <span>
                        <IconButton
                            size="small"
                            onClick={zoomIn}
                            disabled={!showImage || effectiveZoom >= bounds.max}
                            aria-label="확대"
                            sx={{ color: '#fff', '&.Mui-disabled': { color: 'rgba(255,255,255,0.3)' } }}
                        >
                            <ZoomInIcon fontSize="small" />
                        </IconButton>
                    </span>
                </ViewerTooltip>
                <Box sx={{ width: '1px', height: 16, bgcolor: 'rgba(255,255,255,0.25)', mx: 0.5 }} />
                <ViewerTooltip title="화면 맞춤">
                    <span>
                        <IconButton
                            size="small"
                            onClick={zoomFit}
                            disabled={!showImage}
                            aria-label="화면 맞춤"
                            aria-pressed={isFit}
                            sx={{
                                color: isFit ? '#93C5FD' : '#fff',
                                '&.Mui-disabled': { color: 'rgba(255,255,255,0.3)' },
                            }}
                        >
                            <FitScreenIcon fontSize="small" />
                        </IconButton>
                    </span>
                </ViewerTooltip>
                <ViewerTooltip title="원본 크기 (100%)">
                    <span>
                        <IconButton
                            size="small"
                            onClick={zoomOriginal}
                            disabled={!showImage}
                            aria-label="원본 크기"
                            sx={{ color: '#fff', '&.Mui-disabled': { color: 'rgba(255,255,255,0.3)' } }}
                        >
                            <CropOriginalIcon fontSize="small" />
                        </IconButton>
                    </span>
                </ViewerTooltip>
                <Box sx={{ width: '1px', height: 16, bgcolor: 'rgba(255,255,255,0.25)', mx: 0.5 }} />
                <ViewerTooltip title="닫기 (Esc)">
                    <IconButton
                        size="small"
                        autoFocus
                        onClick={onClose}
                        aria-label="이미지 크게 보기 닫기"
                        sx={{ color: '#fff' }}
                    >
                        <CloseIcon fontSize="small" />
                    </IconButton>
                </ViewerTooltip>
            </Box>

            {/* 이미지 영역 — 바깥(어두운 배경)을 누르면 닫히고, 이미지 자체는 닫지 않는다. */}
            <Box
                ref={scrollRef}
                onClick={(event) => { if (event.target === event.currentTarget) onClose(); }}
                onPointerDown={startPan}
                onPointerMove={movePan}
                onPointerUp={endPan}
                onPointerCancel={endPan}
                sx={{
                    flex: 1,
                    minHeight: 0,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    overflow: 'auto',
                    p: 2,
                    // 터치는 브라우저 기본 스크롤에 맡기고(pointercancel 로 pan 이 끝난다),
                    // 마우스는 아래 pointer 핸들러가 끌어서 이동시킨다.
                    cursor: 'default',
                }}
            >
                {showLoading && (
                    <Box sx={{ position: 'absolute', display: 'flex', alignItems: 'center', gap: 1.25 }}>
                        <CircularProgress size={22} sx={{ color: 'rgba(255,255,255,0.85)' }} />
                        <Typography variant="body2" sx={{ color: 'rgba(255,255,255,0.85)' }}>
                            이미지를 불러오는 중…
                        </Typography>
                    </Box>
                )}

                {showError && (
                    <Box sx={{ textAlign: 'center', color: 'rgba(255,255,255,0.85)', px: 3 }}>
                        <ImageNotSupportedOutlinedIcon sx={{ fontSize: 44, opacity: 0.7, mb: 1 }} />
                        <Typography variant="body1" sx={{ fontWeight: 600 }}>
                            이미지를 불러올 수 없습니다
                        </Typography>
                        <Typography variant="caption" sx={{ display: 'block', mt: 0.5, opacity: 0.75 }}>
                            원본이 삭제되었거나 접근 권한이 없을 수 있습니다. Description 내용은 그대로 유지됩니다.
                        </Typography>
                    </Box>
                )}

                {showImage && src && (
                    <Box
                        component="img"
                        src={src}
                        alt={alt || '확대한 이미지'}
                        draggable={false}
                        onLoad={(event: React.SyntheticEvent<HTMLImageElement>) => {
                            const el = event.currentTarget;
                            setNatural({
                                width: el.naturalWidth || el.width || 0,
                                height: el.naturalHeight || el.height || 0,
                            });
                            setStatus('loaded');
                        }}
                        onError={() => setStatus('error')}
                        sx={{
                            // 원본보다 크게 늘리지 않고, 화면 맞춤에서는 90vw × 90vh 안에 들어온다.
                            width: width ? `${width}px` : 'auto',
                            maxWidth: width ? 'none' : `${VIEWPORT_RATIO * 100}vw`,
                            maxHeight: width ? 'none' : `calc(${VIEWPORT_RATIO * 100}vh - ${TOOLBAR_RESERVE_PX}px)`,
                            height: 'auto',
                            objectFit: 'contain',
                            flexShrink: 0,
                            userSelect: 'none',
                            visibility: status === 'loading' ? 'hidden' : 'visible',
                            cursor: isFit ? 'default' : 'grab',
                            boxShadow: '0 8px 40px rgba(0,0,0,0.55)',
                        }}
                    />
                )}
            </Box>
        </Dialog>
    );
};

export default ImageZoomViewer;
