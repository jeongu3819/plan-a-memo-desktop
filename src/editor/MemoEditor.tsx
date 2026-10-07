/**
 * 메모 편집기 — PLAN-A Work 의 RichDescriptionEditor(개인 메모와 같은 설정)를 그대로 쓴다.
 *
 *   · 굵게/기울임/밑줄/취소선(Ctrl+B·I·U), 글자 크기·색(드래그 → 우클릭), 목록, 링크, 표(열 너비),
 *     Office/웹 붙여넣기, 이미지 붙여넣기·끌어 놓기, Undo/Redo(Ctrl+Z / Ctrl+Y) — 모두 Web 코드 그대로.
 *   · 이미지 업로드만 Desktop 판: 서버 대신 저장 폴더 attachments/ 로 복사하고 attachment://<id> 를 넣는다.
 *   · 파일 선택으로 이미지 넣기(Desktop 추가) — 작은 이미지 버튼.
 */
import { useCallback, useRef, useState } from 'react';
import { Box, IconButton, Tooltip } from '@mui/material';
import AddPhotoAlternateOutlinedIcon from '@mui/icons-material/AddPhotoAlternateOutlined';
import { open as openFileDialog } from '@tauri-apps/plugin-dialog';
import RichDescriptionEditor from '../vendor/plan-a-work/components/RichDescriptionEditor';
import { insertHtmlAsSingleTransaction } from '../vendor/plan-a-work/utils/richHtmlInsert';
import { attachmentDisplayUrl } from '../vendor/plan-a-work/utils/richImage';
import { attachmentService, errorMessage } from '../tauri/api';

export interface MemoEditorProps {
  itemId: string;
  value: string;
  onChange: (html: string) => void;
  onUploadingChange?: (uploading: boolean) => void;
  onError?: (message: string) => void;
  minHeight?: number;
  maxHeight?: number | string;
  fill?: boolean;
  placeholder?: string;
  /** 이미지 파일 선택 버튼 */
  showImageButton?: boolean;
}

export default function MemoEditor({
  itemId,
  value,
  onChange,
  onUploadingChange,
  onError,
  minHeight = 22,
  maxHeight = 520,
  fill = false,
  placeholder = '메모 (이미지는 Ctrl+V · Enter 는 줄바꿈)',
  showImageButton = true,
}: MemoEditorProps) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const savedRange = useRef<Range | null>(null);
  const [picking, setPicking] = useState(false);

  const uploadImage = useCallback(
    async (file: File) => {
      const info = await attachmentService.importBlob(file, itemId);
      return { url: info.url, size: info.size };
    },
    [itemId],
  );

  // 브라우저가 직접 받지 못한 외부 이미지 주소 → 이 PC 가 내려받아 첨부로(외부 주소를 본문에 남기지 않는다).
  const importImageUrl = useCallback(async (url: string) => {
    const info = await attachmentService.importUrl(url);
    return { url: info.url, size: info.size };
  }, []);

  const rememberSelection = () => {
    const editable = wrapRef.current?.querySelector<HTMLElement>('[contenteditable="true"]');
    const selection = window.getSelection();
    if (editable && selection && selection.rangeCount && editable.contains(selection.getRangeAt(0).commonAncestorContainer)) {
      savedRange.current = selection.getRangeAt(0).cloneRange();
    }
  };

  const pickImage = async () => {
    if (picking) return;
    setPicking(true);
    onUploadingChange?.(true);
    try {
      const picked = await openFileDialog({
        multiple: true,
        directory: false,
        filters: [{ name: '이미지', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp'] }],
      });
      const paths = Array.isArray(picked) ? picked : picked ? [picked] : [];
      const editable = wrapRef.current?.querySelector<HTMLElement>('[contenteditable="true"]');
      if (!paths.length || !editable) return;
      const parts: string[] = [];
      for (const path of paths) {
        const info = await attachmentService.importFile(path, itemId);
        parts.push(`<img src="${attachmentDisplayUrl(info.id)}" data-canonical-src="${info.url}" alt="">`);
      }
      insertHtmlAsSingleTransaction(editable, parts.join(''), savedRange.current);
    } catch (error) {
      onError?.(errorMessage(error, '이미지를 넣지 못했습니다.'));
    } finally {
      onUploadingChange?.(false);
      setPicking(false);
    }
  };

  return (
    <Box ref={wrapRef} sx={{ position: 'relative', ...(fill ? { flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0 } : {}) }}>
      <RichDescriptionEditor
        value={value}
        onChange={onChange}
        uploadImage={uploadImage}
        importImageUrl={importImageUrl}
        onUploadingChange={onUploadingChange}
        onWarning={onError}
        formatMenu="contextMenu"
        imageSelectionStyle="subtle"
        showImageZoomHint
        borderless={!fill}
        fill={fill}
        minHeight={minHeight}
        maxHeight={maxHeight}
        metricsContext="personal_memo"
        placeholder={placeholder}
      />
      {showImageButton && (
        <Tooltip title="이미지 파일 넣기">
          <IconButton
            size="small"
            aria-label="이미지 파일 넣기"
            data-memo-card-ignore
            disabled={picking}
            onMouseDown={event => {
              event.preventDefault(); // 편집기 포커스·캐럿을 잃지 않게
              rememberSelection();
            }}
            onClick={() => void pickImage()}
            sx={{ position: 'absolute', right: -4, bottom: -4, p: 0.25, color: 'text.disabled', '&:hover': { color: 'primary.main' } }}
          >
            <AddPhotoAlternateOutlinedIcon sx={{ fontSize: 16 }} />
          </IconButton>
        </Tooltip>
      )}
    </Box>
  );
}
