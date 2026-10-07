import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Box } from '@mui/material';
import ZoomInIcon from '@mui/icons-material/ZoomIn';
import ImageZoomViewer from '../common/ImageZoomViewer';
import { hydrateProtectedImage, normalizeImagesInRoot, releaseImagesInRoot } from '../../utils/richImage';
import { resolveDescriptionImageView, type DescriptionImageView } from '../../utils/descriptionImageViewer';
import { sanitizeTaskDescriptionHtml } from '../../utils/taskDescription';
import {
  DEFERRED_IMAGE_SELECTOR,
  descriptionDeferredImageSx,
  descriptionImageSx,
} from '../../utils/descriptionImageLayout';
import { MEMO_TEXT } from './personalMemoTheme';
import { richTableSx } from '../../utils/richTableSx';
import { applyTableSizingStyles } from '../../utils/tableResize';

/**
 * 저장된 메모 본문을 **읽기 전용**으로 그린다(편집기를 항목마다 띄우지 않기 위해).
 *
 * 이미지는 Description 과 같은 공통 배치 규칙(descriptionImageSx — 폭이 되면 같은 줄,
 * 명시적 줄바꿈 유지, 좁으면 wrap)과 같은 인증 로더(normalizeImagesInRoot — 화면에
 * 들어올 때 Bearer 로 받아 Blob URL 로 표시)를 쓴다. 굵게·밑줄·글자 크기·색도 저장된
 * HTML 그대로 보인다.
 *
 * ``zoomImages`` 면 이미지에 마우스를 올렸을 때 확대 표시(돋보기·zoom-in 커서)가 보이고,
 * 이미지를 누르면 편집으로 들어가지 않고 크게 보기가 열린다(편집기 더블클릭과 같은 뷰어).
 */
export default function PersonalMemoContentView({
  html,
  muted = false,
  struck = false,
  clampLines,
  comfortable = false,
  zoomImages = false,
}: {
  html: string;
  muted?: boolean;
  struck?: boolean;
  /** 주간 칸처럼 좁은 곳에서 몇 줄까지만 보일지. 없으면 전부. */
  clampLines?: number;
  /** 주간·날짜 화면 — 틀보다 글이 먼저 읽히도록 조금 크고 편안하게(작은 위젯은 그대로). */
  comfortable?: boolean;
  /** 이미지 hover 확대 표시 + 클릭 = 크게 보기(날짜 상세). 좁은 주간 칸에서는 쓰지 않는다. */
  zoomImages?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [viewer, setViewer] = useState<DescriptionImageView | null>(null);
  const [hovered, setHovered] = useState<DOMRect | null>(null);
  // layout effect — 그리기 전에 본문을 채운다. 편집을 마치고 읽기 화면으로 돌아올 때 빈 줄이
  // 한 프레임 보였다가 채워지는 깜빡임(행 높이 흔들림)을 막는다.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return undefined;
    releaseImagesInRoot(el);
    el.innerHTML = sanitizeTaskDescriptionHtml(html).html;
    normalizeImagesInRoot(el);
    // 편집기에서 조절한 열 너비/행 최소 높이를 읽기 화면에도 그대로 펼친다(편집기와 같은 표).
    applyTableSizingStyles(el);
    return () => releaseImagesInRoot(el);
  }, [html]);
  useEffect(() => {
    if (!hovered) return undefined;
    const clear = () => setHovered(null);
    window.addEventListener('scroll', clear, true);
    return () => window.removeEventListener('scroll', clear, true);
  }, [hovered]);

  const openViewer = (img: HTMLImageElement) => {
    const view = resolveDescriptionImageView(img);
    setViewer(view);
    if (!view.pending) return;
    void hydrateProtectedImage(img).then(() => {
      if (!img.isConnected) return;
      setViewer(current => (current && current.pending ? resolveDescriptionImageView(img) : current));
    });
  };

  return (
    <>
    <Box
      ref={ref}
      data-testid="personal-memo-content"
      onClick={zoomImages ? event => {
        const target = event.target as HTMLElement;
        if (!(target instanceof HTMLImageElement) || !ref.current?.contains(target)) return;
        // 이미지 클릭은 '이 메모 편집' 이 아니라 크게 보기다.
        event.preventDefault();
        event.stopPropagation();
        setHovered(null);
        openViewer(target);
      } : undefined}
      onMouseOver={zoomImages ? event => {
        const target = event.target as HTMLElement;
        if (target instanceof HTMLImageElement) setHovered(target.getBoundingClientRect());
      } : undefined}
      onMouseOut={zoomImages ? event => {
        if (event.target instanceof HTMLImageElement) setHovered(null);
      } : undefined}
      sx={{
        fontSize: comfortable ? '0.94rem' : '0.86rem',
        lineHeight: 1.6,
        color: muted ? 'text.disabled' : comfortable ? MEMO_TEXT : 'text.primary',
        textDecoration: struck ? 'line-through' : 'none',
        wordBreak: 'break-word',
        whiteSpace: 'pre-wrap',
        minWidth: 0,
        '& p': { m: 0 },
        // 하위 내용(목록)은 부모 줄과의 관계가 보이게 들여쓴다 — 전역 reset 이 지운 표식을 이 본문 안에서만 되살린다.
        '& ul, & ol': { m: 0, pl: 2.5 },
        '& ul': { listStyle: 'disc' },
        '& ol': { listStyle: 'decimal' },
        '& li': { pl: 0.25 },
        '& b, & strong': { fontWeight: 700 },
        '& a': { color: '#2955FF', textDecoration: 'underline' },
        '& img': {
          ...descriptionImageSx,
          maxHeight: clampLines ? 72 : undefined,
          cursor: zoomImages ? 'zoom-in' : 'inherit',
          ...(zoomImages ? { transition: 'box-shadow 0.15s', '&:hover': { boxShadow: '0 0 0 1px #111827' } } : {}),
        },
        [DEFERRED_IMAGE_SELECTOR]: clampLines ? { minHeight: 40, width: 64 } : descriptionDeferredImageSx,
        // 표는 편집기(Description·작업노트와 같은 RichDescriptionEditor)와 같은 규칙 — 읽기↔편집 전환에
        // 표 모양이 바뀌지 않는다. 수동 크기 표는 위 applyTableSizingStyles 가 px 을 펼친다.
        ...richTableSx,
        // 가운데/오른쪽에 놓인 표(Word) — 자동 폭 표는 꽉 차므로 내용 폭으로 줄여야 위치가 보인다.
        '& table[data-align="center"]:not([data-resizable-table="true"]), & table[data-align="right"]:not([data-resizable-table="true"])': { width: 'fit-content' },
        ...(clampLines
          ? {
              display: '-webkit-box',
              WebkitLineClamp: clampLines,
              WebkitBoxOrient: 'vertical',
              overflow: 'hidden',
            }
          : {}),
      }}
    />
    {zoomImages && hovered && hovered.width >= 40 && (
      // 표시만 한다(누르는 것은 이미지 자체) — 포인터를 가로채지 않는다.
      <Box
        aria-hidden
        data-testid="memo-image-zoom-hint"
        sx={{
          position: 'fixed', top: hovered.top + 6, left: hovered.left + 6, zIndex: 1300,
          display: 'flex', p: 0.4, borderRadius: '50%', pointerEvents: 'none',
          color: '#fff', bgcolor: 'rgba(17,24,39,0.72)',
        }}
      >
        <ZoomInIcon sx={{ fontSize: '1rem' }} />
      </Box>
    )}
    {zoomImages && (
      // 뷰어는 portal 이지만 React 이벤트는 이 트리로 올라온다 — 뷰어 안 클릭·키가 바깥 행의
      // '메모 편집 시작' 으로 번지지 않게 여기서 멈춘다.
      <Box
        component="span"
        sx={{ display: 'contents' }}
        onClick={event => event.stopPropagation()}
        onKeyDown={event => event.stopPropagation()}
        onContextMenu={event => event.stopPropagation()}
      >
        <ImageZoomViewer
          open={!!viewer}
          src={viewer?.src || null}
          alt={viewer?.alt}
          unavailable={viewer?.unavailable}
          pending={viewer?.pending}
          onClose={() => setViewer(null)}
        />
      </Box>
    )}
    </>
  );
}
