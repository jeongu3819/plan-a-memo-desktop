/**
 * 메모 한 항목의 메뉴 — 우클릭과 ⋮ 버튼이 같은 메뉴(Web PersonalMemoMenu 와 같은 구성·페이지 방식).
 * Web 의 '오늘 업무에 추가'·'작업노트에 보내기'·'요일마다 생성' 은 서버 기능이라 Desktop 에는 없다.
 */
import { useEffect, useState } from 'react';
import { Divider, ListItemIcon, ListItemText, Menu, MenuItem, Typography } from '@mui/material';
import ArrowBackIcon from '@mui/icons-material/ArrowBack';
import ChevronRightIcon from '@mui/icons-material/ChevronRight';
import CheckIcon from '@mui/icons-material/Check';
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutline';
import EventIcon from '@mui/icons-material/Event';
import OpenInFullIcon from '@mui/icons-material/OpenInFull';
import SubjectIcon from '@mui/icons-material/Subject';
import CheckBoxOutlinedIcon from '@mui/icons-material/CheckBoxOutlined';
import StarBorderRoundedIcon from '@mui/icons-material/StarBorderRounded';
import StarRoundedIcon from '@mui/icons-material/StarRounded';
import HistoryIcon from '@mui/icons-material/History';
import type { Location, MemoItem, MemoSection } from '../../domain/types';
import { locationLabel } from '../../domain/location';
import { quickMoveDate, shortDate, WEEKDAY_LABELS } from '../../vendor/plan-a-work/utils/personalMemoDates';
import { NEXT_LABEL } from '../../vendor/plan-a-work/components/personalMemo/personalMemoTheme';
import { useLists } from '../../services/queries';
import { usePersonalMemo } from './MemoProvider';

export type MenuAnchor = { kind: 'element'; el: HTMLElement } | { kind: 'point'; top: number; left: number };

type Page = 'main' | 'move' | 'section';

export const SECTION_LABELS: Record<MemoSection, string> = {
  main: '메인 할 일',
  am: '오전 할 일',
  pm: '오후 할 일',
};

export default function MemoMenu({
  item,
  location,
  anchor,
  onClose,
}: {
  item: MemoItem;
  location: Location;
  anchor: MenuAnchor | null;
  onClose: () => void;
}) {
  const { actions, today, openLargeEditor, openDatePicker, openHistory } = usePersonalMemo();
  const [page, setPage] = useState<Page>('main');
  const lists = useLists();
  useEffect(() => {
    if (anchor) setPage('main');
  }, [anchor]);

  const run = (fn: () => void) => {
    onClose();
    fn();
  };
  const dated = location.kind === 'day';
  const currentList = location.kind === 'next' ? location.listId : undefined;
  const back = (
    <MenuItem key="back" dense onClick={() => setPage('main')}>
      <ListItemIcon><ArrowBackIcon fontSize="small" /></ListItemIcon>
      <ListItemText primary="뒤로" />
    </MenuItem>
  );

  const items: React.ReactNode[] = [];
  if (page === 'main') {
    items.push(
      <MenuItem key="move" dense onClick={() => setPage('move')}>
        <ListItemIcon><EventIcon fontSize="small" /></ListItemIcon>
        <ListItemText primary="다른 날로 이동" />
        <ChevronRightIcon fontSize="small" sx={{ color: 'text.disabled' }} />
      </MenuItem>,
    );
    if (dated) {
      items.push(
        <MenuItem key="section" dense onClick={() => setPage('section')}>
          <ListItemIcon><SubjectIcon fontSize="small" /></ListItemIcon>
          <ListItemText primary="구역 이동" secondary={SECTION_LABELS[item.section as MemoSection]} />
          <ChevronRightIcon fontSize="small" sx={{ color: 'text.disabled' }} />
        </MenuItem>,
      );
    }
    items.push(
      <MenuItem key="kind" dense onClick={() => run(() => actions.setKind(item, item.kind === 'checklist' ? 'text' : 'checklist'))}>
        <ListItemIcon>
          {item.kind === 'checklist' ? <SubjectIcon fontSize="small" /> : <CheckBoxOutlinedIcon fontSize="small" />}
        </ListItemIcon>
        <ListItemText primary={item.kind === 'checklist' ? '텍스트로 바꾸기' : '체크리스트로 바꾸기'} />
      </MenuItem>,
      <MenuItem key="fav" dense onClick={() => run(() => actions.toggleFavorite(item))}>
        <ListItemIcon>
          {item.favorite ? <StarRoundedIcon fontSize="small" sx={{ color: '#F5B301' }} /> : <StarBorderRoundedIcon fontSize="small" />}
        </ListItemIcon>
        <ListItemText primary={item.favorite ? '즐겨찾기 해제' : '즐겨찾기'} />
      </MenuItem>,
      <Divider key="d1" />,
      <MenuItem key="large" dense onClick={() => run(() => openLargeEditor(item))}>
        <ListItemIcon><OpenInFullIcon fontSize="small" /></ListItemIcon>
        <ListItemText primary="크게 편집" />
      </MenuItem>,
      <MenuItem key="history" dense onClick={() => run(() => openHistory(location, locationLabel(location)))}>
        <ListItemIcon><HistoryIcon fontSize="small" /></ListItemIcon>
        <ListItemText primary={dated ? '이 날짜의 변경 이력' : '이 List 의 변경 이력'} />
      </MenuItem>,
      <Divider key="d2" />,
      <MenuItem key="delete" dense onClick={() => run(() => actions.remove(item))} sx={{ color: 'error.main' }}>
        <ListItemIcon><DeleteOutlineIcon fontSize="small" color="error" /></ListItemIcon>
        <ListItemText primary="삭제" />
      </MenuItem>,
    );
  } else if (page === 'move') {
    items.push(back, <Divider key="d" />);
    items.push(
      <MenuItem key="today" dense onClick={() => run(() => void actions.move({ item, target: { kind: 'day', date: today } }))}>
        <ListItemText primary="오늘" />
        <Typography variant="caption" color="text.secondary">{shortDate(today)}</Typography>
      </MenuItem>,
    );
    WEEKDAY_LABELS.forEach((label, weekday) => {
      const date = quickMoveDate(today, weekday);
      items.push(
        <MenuItem key={`w${weekday}`} dense onClick={() => run(() => void actions.move({ item, target: { kind: 'day', date } }))}>
          <ListItemText primary={label} />
          <Typography variant="caption" color="text.secondary">{shortDate(date)}</Typography>
        </MenuItem>,
      );
    });
    const listItems = lists.data ?? [];
    listItems.forEach(list => {
      const listId = list.isDefault ? null : list.id;
      const here = !dated && (currentList ?? null) === listId;
      items.push(
        <MenuItem
          key={`list-${list.id}`}
          dense
          disabled={here}
          data-testid="memo-move-to-list"
          onClick={() => run(() => void actions.move({ item, target: { kind: 'next', listId } }))}
        >
          <ListItemText
            primary={list.isDefault ? NEXT_LABEL : `${NEXT_LABEL} > ${list.name}`}
            secondary={list.isDefault ? '날짜 미정' : undefined}
            primaryTypographyProps={{ noWrap: true, sx: { maxWidth: 240 } }}
          />
        </MenuItem>,
      );
    });
    items.push(
      <MenuItem key="pick" dense onClick={() => run(() => openDatePicker(item))}>
        <ListItemText primary="날짜 선택…" />
      </MenuItem>,
    );
  } else {
    items.push(back, <Divider key="d" />);
    (Object.keys(SECTION_LABELS) as MemoSection[]).forEach(section => {
      items.push(
        <MenuItem
          key={section}
          dense
          selected={item.section === section}
          onClick={() => run(() => void actions.move({ item, target: location, section }))}
        >
          <ListItemIcon>{item.section === section ? <CheckIcon fontSize="small" /> : null}</ListItemIcon>
          <ListItemText primary={SECTION_LABELS[section]} />
        </MenuItem>,
      );
    });
  }

  return (
    <Menu
      open={!!anchor}
      onClose={onClose}
      anchorEl={anchor?.kind === 'element' ? anchor.el : null}
      anchorReference={anchor?.kind === 'point' ? 'anchorPosition' : 'anchorEl'}
      anchorPosition={anchor?.kind === 'point' ? { top: anchor.top, left: anchor.left } : undefined}
      slotProps={{ paper: { sx: { minWidth: 220 }, 'data-testid': 'personal-memo-menu' } as never }}
      data-personal-memo-overlay="true"
    >
      {items}
    </Menu>
  );
}
