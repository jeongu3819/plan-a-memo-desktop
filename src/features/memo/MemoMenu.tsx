/**
 * 메모 한 항목의 메뉴 — 우클릭과 ⋮ 버튼이 같은 메뉴(Web PersonalMemoMenu 와 같은 구성·페이지 방식).
 * Web 의 '오늘 업무에 추가'·'작업노트에 보내기' 는 서버 기능이라 Desktop 에는 없다.
 * '○요일마다 생성' 은 Desktop 판(이 PC 의 반복 — memo/recurrence.rs). 반복 규칙은 Sync Contract 에 없어 Web 과 공유하지 않는다.
 */
import { useEffect, useMemo, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Divider, ListItemIcon, ListItemText, Menu, MenuItem, Typography } from '@mui/material';
import ArrowBackIcon from '@mui/icons-material/ArrowBack';
import ChevronRightIcon from '@mui/icons-material/ChevronRight';
import CheckIcon from '@mui/icons-material/Check';
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutline';
import EventIcon from '@mui/icons-material/Event';
import OpenInFullIcon from '@mui/icons-material/OpenInFull';
import SubjectIcon from '@mui/icons-material/Subject';
import VerticalAlignTopIcon from '@mui/icons-material/VerticalAlignTop';
import VerticalAlignBottomIcon from '@mui/icons-material/VerticalAlignBottom';
import CheckBoxOutlinedIcon from '@mui/icons-material/CheckBoxOutlined';
import StarBorderRoundedIcon from '@mui/icons-material/StarBorderRounded';
import StarRoundedIcon from '@mui/icons-material/StarRounded';
import RepeatIcon from '@mui/icons-material/Repeat';
import RepeatOnIcon from '@mui/icons-material/RepeatOn';
import StopCircleOutlinedIcon from '@mui/icons-material/StopCircleOutlined';
import type { Location, MemoItem, MemoSection } from '../../domain/types';
import { quickMoveDate, shortDate, WEEKDAY_LABELS } from '../../vendor/plan-a-work/utils/personalMemoDates';
import { NEXT_LABEL } from '../../vendor/plan-a-work/components/personalMemo/personalMemoTheme';
import { refreshMemo, useLists, useRecurrence } from '../../services/queries';
import { errorMessage, recurrenceService } from '../../tauri/api';
import { weekdayName } from '../../domain/dayTools';
import { usePersonalMemo } from './MemoProvider';
import RecurrenceStopDialog, { type RecurrenceStopRequest } from './RecurrenceStopDialog';

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
  firstInPlace,
  lastInPlace,
  onClose,
}: {
  item: MemoItem;
  location: Location;
  anchor: MenuAnchor | null;
  /** 같은 자리에서 이미 맨 위인가 */
  firstInPlace: boolean;
  /** 같은 자리에서 이미 맨 아래인가 */
  lastInPlace: boolean;
  onClose: () => void;
}) {
  const { actions, today, notify, openLargeEditor, openDatePicker } = usePersonalMemo();
  const queryClient = useQueryClient();
  const [page, setPage] = useState<Page>('main');
  const [stopAsk, setStopAsk] = useState<RecurrenceStopRequest | null>(null);
  const [stopping, setStopping] = useState(false);
  const lists = useLists();
  // 반복 상태는 메뉴를 열 때만 읽는다(날짜 메모만 — Next List 는 날짜가 없어 대상이 아니다).
  const recurrence = useRecurrence(item.id, !!anchor && location.kind === 'day');
  // 메뉴를 연 시각 — 그 뒤에 읽은 반복 상태만 보인다(방금 시작·중지한 반복이 예전 상태로 잠깐 보이지 않게).
  // 여는 그 렌더에서 바로 정한다(effect 로 정하면 첫 렌더에 지난번 값이 남아 예전 상태가 한 번 보인다).
  const openedAt = useMemo(() => (anchor ? Date.now() : 0), [anchor]);
  useEffect(() => {
    if (anchor) setPage('main');
  }, [anchor]);

  const run = (fn: () => void) => {
    onClose();
    fn();
  };
  const dated = location.kind === 'day';
  /** 메모가 속한 날짜의 요일(오늘이 아니라) — '토요일' */
  const dayName = location.kind === 'day' ? weekdayName(location.date) : '';
  const recurrenceInfo = recurrence.data && recurrence.dataUpdatedAt >= openedAt ? recurrence.data : null;
  const rule = recurrenceInfo?.rule ?? null;

  const startRecurrence = async () => {
    try {
      const info = await recurrenceService.create(item.id);
      refreshMemo(queryClient);
      const next = info.rule ? ` 다음: ${shortDate(info.rule.nextDate)}` : '';
      // 반복은 지금 내용으로 만든다 — 원본을 나중에 고쳐도 반복 내용은 바뀌지 않는다는 것을 시작할 때 한 번 알린다.
      notify({ message: `${dayName}마다 생성합니다.${next} 지금 내용으로 반복하며, 원본을 고쳐도 바뀌지 않아요. (이 PC 에서만)`, variant: 'success' });
    } catch (error) {
      notify({ message: errorMessage(error, '반복을 시작하지 못했습니다.'), variant: 'error' });
    }
  };
  /** [반복 중지] — 정리될 앞으로의 회차가 있으면 확인창, 없으면 확인 없이 바로 중지. */
  const requestStop = async (ruleId: string) => {
    try {
      const preview = await recurrenceService.stopPreview(ruleId);
      if (preview.removed > 0) setStopAsk({ ruleId, dayName, removed: preview.removed, kept: preview.kept });
      else await stopRecurrence(ruleId);
    } catch (error) {
      notify({ message: errorMessage(error, '반복을 중지하지 못했습니다.'), variant: 'error' });
    }
  };
  const stopRecurrence = async (ruleId: string) => {
    setStopping(true);
    try {
      const result = await recurrenceService.stop(ruleId);
      setStopAsk(null);
      refreshMemo(queryClient);
      notify({
        message: result.removed > 0
          ? `반복을 중지했습니다. 아직 손대지 않은 이후 메모 ${result.removed}개를 정리했습니다.`
          : '반복을 중지했습니다. 이미 만든 메모는 그대로 둡니다.',
      });
    } catch (error) {
      notify({ message: errorMessage(error, '반복을 중지하지 못했습니다.'), variant: 'error' });
    } finally {
      setStopping(false);
    }
  };
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
      <MenuItem key="top" dense disabled={firstInPlace} data-testid="memo-menu-move-top" onClick={() => run(() => actions.moveToTop(item, location))}>
        <ListItemIcon><VerticalAlignTopIcon fontSize="small" /></ListItemIcon>
        <ListItemText primary="맨 위로 보내기" secondary={firstInPlace ? '이미 맨 위에 있습니다' : undefined} />
      </MenuItem>,
      <MenuItem key="bottom" dense disabled={lastInPlace} data-testid="memo-menu-move-bottom" onClick={() => run(() => actions.moveToBottom(item, location))}>
        <ListItemIcon><VerticalAlignBottomIcon fontSize="small" /></ListItemIcon>
        <ListItemText primary="맨 아래로 보내기" secondary={lastInPlace ? '이미 맨 아래에 있습니다' : undefined} />
      </MenuItem>,
      <MenuItem key="kind" dense onClick={() => run(() => actions.setKind(item, item.kind === 'checklist' ? 'text' : 'checklist'))}>
        <ListItemIcon>
          {item.kind === 'checklist' ? <SubjectIcon fontSize="small" /> : <CheckBoxOutlinedIcon fontSize="small" />}
        </ListItemIcon>
        <ListItemText primary={item.kind === 'checklist' ? '텍스트로 바꾸기' : '체크리스트로 바꾸기'} />
      </MenuItem>,
    );
    if (dated) {
      if (rule) {
        items.push(
          // 상태 표시(누르는 항목이 아니다) — 흐리게 보이지 않게 한다.
          <MenuItem key="repeat-on" dense disabled data-testid="memo-menu-repeat-status" sx={{ '&.Mui-disabled': { opacity: 1 } }}>
            <ListItemIcon><RepeatOnIcon fontSize="small" color="primary" /></ListItemIcon>
            <ListItemText primary={`${dayName}마다 생성 중`} secondary={<>다음 {shortDate(rule.nextDate)} · 이 PC 에서만<br />시작할 때 내용으로 만들어요</>} />
          </MenuItem>,
          <MenuItem key="repeat-stop" dense data-testid="memo-menu-repeat-stop" onClick={() => run(() => void requestStop(rule.id))}>
            <ListItemIcon><StopCircleOutlinedIcon fontSize="small" /></ListItemIcon>
            <ListItemText primary="반복 중지" secondary="이미 만든 메모는 남겨 둡니다" />
          </MenuItem>,
        );
      } else {
        const blocked = recurrenceInfo?.blocked ?? null;
        items.push(
          <MenuItem
            key="repeat"
            dense
            disabled={!recurrenceInfo || !!blocked}
            title={blocked ?? undefined}
            data-testid="memo-menu-repeat"
            onClick={() => run(() => void startRecurrence())}
          >
            <ListItemIcon><RepeatIcon fontSize="small" /></ListItemIcon>
            <ListItemText primary={`${dayName}마다 생성`} secondary={blocked ? 'Web 에 연결된 날짜는 쓸 수 없어요' : undefined} />
          </MenuItem>,
        );
      }
    }
    items.push(
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
      <Divider key="d2" />,
      <MenuItem key="delete" dense onClick={() => run(() => actions.remove(item))} sx={{ color: 'error.main' }}>
        <ListItemIcon><DeleteOutlineIcon fontSize="small" color="error" /></ListItemIcon>
        <ListItemText primary={rule ? '이 항목만 삭제' : '삭제'} />
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
    <>
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
    <RecurrenceStopDialog
      request={stopAsk}
      busy={stopping}
      onCancel={() => setStopAsk(null)}
      onConfirm={request => void stopRecurrence(request.ruleId)}
    />
    </>
  );
}
