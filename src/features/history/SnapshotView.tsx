/** 문서 한 건(DayMemo: 메인/오전/오후 · Next List 전체)을 읽기 화면으로 그린다 — History·충돌 비교 공용. */
import { Box, Checkbox, Typography } from '@mui/material';
import PersonalMemoContentView from '../../vendor/plan-a-work/components/personalMemo/PersonalMemoContentView';
import { MEMO_GROUP_DIVIDER, MEMO_MUTED, MEMO_SECTION_TITLE } from '../../vendor/plan-a-work/components/personalMemo/personalMemoTheme';
import type { DocumentSnapshot, ItemSection } from '../../domain/types';
import { SECTION_LABELS } from '../memo/MemoMenu';
import { withDisplayImageUrls } from '../../editor/displayHtml';

const ORDER: ItemSection[] = ['main', 'am', 'pm', 'next'];

export default function SnapshotView({ snapshot, emptyText = '내용 없음' }: { snapshot: DocumentSnapshot; emptyText?: string }) {
  if (snapshot.deleted) {
    return <Typography sx={{ fontSize: '0.85rem', color: 'error.main' }}>삭제된 문서입니다.</Typography>;
  }
  if (!snapshot.items.length) {
    return <Typography sx={{ fontSize: '0.85rem', color: MEMO_MUTED }}>{emptyText}</Typography>;
  }
  const groups = ORDER.map(section => [section, snapshot.items.filter(i => i.section === section).sort((a, b) => a.sortOrder - b.sortOrder)] as const).filter(
    ([, items]) => items.length > 0,
  );
  return (
    <Box data-testid="snapshot-view">
      {groups.map(([section, items], index) => (
        <Box key={section} sx={index > 0 ? { mt: 1, pt: 1, borderTop: '1px solid', borderColor: MEMO_GROUP_DIVIDER } : undefined}>
          {section !== 'next' && (
            <Typography sx={{ fontSize: '0.72rem', fontWeight: 700, color: MEMO_SECTION_TITLE, mb: 0.25 }}>{SECTION_LABELS[section]}</Typography>
          )}
          {items.map(item => (
            <Box key={item.itemKey} sx={{ display: 'flex', alignItems: 'flex-start', gap: 0.5, py: 0.25 }}>
              {item.kind === 'checklist' ? (
                <Checkbox size="small" checked={item.completed} disabled sx={{ p: '3px', width: 24, '& .MuiSvgIcon-root': { fontSize: 17 } }} />
              ) : (
                <Box sx={{ width: 24, height: 23, flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', '&::after': { content: '""', width: 5, height: 5, borderRadius: '50%', bgcolor: '#A3A9B4' } }} />
              )}
              <Box sx={{ flex: 1, minWidth: 0, pt: '2px' }}>
                <PersonalMemoContentView html={withDisplayImageUrls(item.contentHtml)} muted={item.completed} struck={item.kind === 'checklist' && item.completed} comfortable />
              </Box>
            </Box>
          ))}
        </Box>
      ))}
    </Box>
  );
}
