import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Location, MemoItem } from '../domain/types';
import { moveMenuDays } from '../domain/dayTools';
import { isMoveTodayKey } from '../features/memo/menuShortcut';

const invoke = vi.fn();
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...args: unknown[]) => invoke(...args) }));

const { MemoProvider } = await import('../features/memo/MemoProvider');
const { default: MemoMenu } = await import('../features/memo/MemoMenu');

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe('다른 날로 이동 — 날짜 목록(오늘부터 날짜순)', () => {
  const view = (today: string) => moveMenuDays(today).map(d => `${d.label}|${d.detail}|${d.date}`);

  it('금요일: 오늘·내일(토)·모레(일)·월~금 — 8개, 날짜 오름차순', () => {
    expect(view('2026-11-20')).toEqual([
      '오늘|금 · 11/20|2026-11-20',
      '내일|토 · 11/21|2026-11-21',
      '모레|일 · 11/22|2026-11-22',
      '월요일|11/23|2026-11-23',
      '화요일|11/24|2026-11-24',
      '수요일|11/25|2026-11-25',
      '목요일|11/26|2026-11-26',
      '금요일|11/27|2026-11-27',
    ]);
  });

  it('일요일: 내일 월 · 모레 화 · 수요일부터', () => {
    expect(view('2026-11-22').slice(0, 4)).toEqual([
      '오늘|일 · 11/22|2026-11-22',
      '내일|월 · 11/23|2026-11-23',
      '모레|화 · 11/24|2026-11-24',
      '수요일|11/25|2026-11-25',
    ]);
  });

  it('토요일·일요일도 날짜순 자리 그대로(정렬·중복 없음)', () => {
    for (const today of ['2026-11-16', '2026-11-18', '2026-11-21', '2026-11-22']) {
      const dates = moveMenuDays(today).map(d => d.date);
      expect(dates).toEqual([...dates].sort());
      expect(new Set(dates).size).toBe(8);
      expect(dates[0]).toBe(today);
    }
  });

  it('월말 → 다음 달', () => {
    expect(moveMenuDays('2026-11-28').map(d => d.date)).toEqual([
      '2026-11-28', '2026-11-29', '2026-11-30', '2026-12-01', '2026-12-02', '2026-12-03', '2026-12-04', '2026-12-05',
    ]);
  });

  it('연말 → 다음 해(연도 표시)', () => {
    const days = moveMenuDays('2026-12-30');
    expect(days.map(d => d.date)).toEqual([
      '2026-12-30', '2026-12-31', '2027-01-01', '2027-01-02', '2027-01-03', '2027-01-04', '2027-01-05', '2027-01-06',
    ]);
    expect(days[2]).toMatchObject({ label: '모레', detail: '금 · 2027. 1/1' });
    expect(days[3]).toMatchObject({ label: '토요일', detail: '2027. 1/2' });
  });

  it('윤년 2월 29일 · 평년 2월 말', () => {
    expect(moveMenuDays('2028-02-27').slice(0, 4).map(d => d.date)).toEqual(['2028-02-27', '2028-02-28', '2028-02-29', '2028-03-01']);
    expect(moveMenuDays('2027-02-27').slice(0, 4).map(d => d.date)).toEqual(['2027-02-27', '2027-02-28', '2027-03-01', '2027-03-02']);
  });
});

describe('T 단축키 판정', () => {
  const key = (init: Partial<KeyboardEvent> & { target?: EventTarget | null }) =>
    isMoveTodayKey({ key: 't', code: 'KeyT', ctrlKey: false, altKey: false, metaKey: false, isComposing: false, keyCode: 84, ...init });
  const menuItem = () => document.createElement('li');
  const editable = () => {
    const el = document.createElement('div');
    el.setAttribute('contenteditable', 'true');
    document.body.appendChild(el);
    return el;
  };

  it('t · T(Shift) — code 가 없어도(스캔 코드 없는 입력)', () => {
    expect(key({})).toBe(true);
    expect(key({ key: 'T' })).toBe(true);
    expect(key({ code: '' })).toBe(true);
    expect(key({ key: 'r', code: 'KeyR' })).toBe(false);
  });

  it('한글 입력 모드 — 물리 T 키(KeyT)의 ㅅ · ㅆ(Shift)', () => {
    expect(key({ key: 'ㅅ' })).toBe(true);
    expect(key({ key: 'ㅆ', shiftKey: true })).toBe(true);
    expect(key({ key: 'ㅅ', code: '' })).toBe(false); // 어느 키인지 모르면 아니다
    expect(key({ key: 'ㅇ', code: 'KeyD' })).toBe(false);
  });

  it('IME 가 받은 키(Process · 229) — 메뉴에서는 물리 T 면 이동, 편집기·입력칸에서는 글자 입력', () => {
    expect(key({ key: 'Process', keyCode: 229, target: menuItem() })).toBe(true);
    expect(key({ key: 'Process', keyCode: 229, code: 'KeyD', target: menuItem() })).toBe(false);
    expect(key({ key: 'Process', keyCode: 229, target: editable() })).toBe(false);
    expect(key({ key: 'Process', keyCode: 229, target: document.createElement('input') })).toBe(false);
    expect(key({ key: 'Process', keyCode: 229, target: document.createElement('textarea') })).toBe(false);
  });

  it('그 자리가 다른 라틴 글자인 배열(Dvorak 등)은 아니다', () => {
    expect(key({ key: 'y', code: 'KeyT' })).toBe(false);
    expect(key({ key: 'Y', code: 'KeyT' })).toBe(false);
  });

  it('Ctrl·Alt·Win 과 함께면 다른 단축키 — 한글 모드여도', () => {
    expect(key({ ctrlKey: true })).toBe(false);
    expect(key({ altKey: true })).toBe(false);
    expect(key({ metaKey: true })).toBe(false);
    expect(key({ key: 'T', ctrlKey: true })).toBe(false);
    expect(key({ key: 'ㅅ', ctrlKey: true })).toBe(false);
  });

  it('한글 조합 중(isComposing)은 아니다', () => {
    expect(key({ isComposing: true })).toBe(false);
    expect(key({ key: 'ㅅ', isComposing: true })).toBe(false);
    expect(key({ key: 'Process', keyCode: 229, isComposing: true, target: menuItem() })).toBe(false);
  });
});

// ── 실제 메뉴 ─────────────────────────────────────────────────────────────

const TODAY = '2026-11-20';
const memo = (over: Partial<MemoItem> = {}) =>
  ({
    id: 'item-1',
    documentId: 'doc-1123',
    section: 'am',
    sortOrder: 0,
    contentHtml: '<p><b>보고서</b> <span style="background-color: rgb(255, 245, 157);">강조</span></p>',
    kind: 'checklist',
    completed: true,
    favorite: false,
    ...over,
  }) as MemoItem;

let root: Root | null = null;
let container: HTMLDivElement | null = null;
let editor: HTMLDivElement | null = null;
let openMenu: () => void = () => undefined;

beforeEach(() => {
  vi.setSystemTime(new Date(2026, 10, 20, 10, 0, 0));
  invoke.mockImplementation((command: string, args: { input?: { target: Location } }) => {
    if (command === 'memo_lists') return Promise.resolve([{ id: 'next', name: 'Next', isDefault: true }]);
    if (command === 'recurrence_get') return Promise.resolve({ rule: null, blocked: null });
    if (command === 'item_move') {
      return Promise.resolve({ status: 'moved', item: { ...memo(), documentId: 'doc-today' }, target: args.input!.target, sourceLinked: false });
    }
    return Promise.resolve(null);
  });
});

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  container?.remove();
  editor?.remove();
  container = null;
  editor = null;
  invoke.mockReset();
  vi.useRealTimers();
  document.body.innerHTML = '';
});

const settle = () =>
  act(async () => {
    await new Promise(resolve => setTimeout(resolve, 0));
  });

async function render({ location = { kind: 'day', date: '2026-11-23' } as Location, appToday = TODAY, item = memo() } = {}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  function Host() {
    const [anchor, setAnchor] = useState<{ kind: 'point'; top: number; left: number } | null>({ kind: 'point', top: 20, left: 20 });
    openMenu = () => setAnchor({ kind: 'point', top: 20, left: 20 });
    return <MemoMenu item={item} location={location} anchor={anchor} firstInPlace={false} lastInPlace={false} onClose={() => setAnchor(null)} />;
  }
  // 편집기 — 메뉴가 열려 있어도 포커스가 여기 남아 있는 경우를 흉내 낸다.
  editor = document.createElement('div');
  editor.setAttribute('contenteditable', 'true'); // jsdom 은 contentEditable 속성을 반영하지 않는다
  document.body.appendChild(editor);
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(
      <QueryClientProvider client={client}>
        <MemoProvider today={appToday}>
          <Host />
        </MemoProvider>
      </QueryClientProvider>,
    );
  });
  await settle();
}

const menuOpen = () => !!document.querySelector('[data-testid="personal-memo-menu"]');
const moves = () => invoke.mock.calls.filter(([command]) => command === 'item_move').map(([, args]) => args);
function press(init: KeyboardEventInit, target: Element = document.activeElement ?? document.body) {
  const event = new KeyboardEvent('keydown', { key: 't', bubbles: true, cancelable: true, ...init });
  act(() => {
    target.dispatchEvent(event);
  });
  return event;
}
async function openMovePage() {
  const entry = [...document.querySelectorAll('[role="menuitem"]')].find(el => el.textContent?.includes('다른 날로 이동')) as HTMLElement;
  act(() => entry.click());
  await settle();
}
const dayItems = () => [...document.querySelectorAll<HTMLElement>('[data-testid="memo-move-day"]')];

describe('메모 메뉴 — T 로 오늘 이동', () => {
  it('메뉴에서 T → 오늘로 이동(메뉴 닫힘). 메뉴의 오늘 클릭과 같은 명령', async () => {
    await render();
    const event = press({});
    await settle();
    expect(event.defaultPrevented).toBe(true);
    expect(menuOpen()).toBe(false);
    const viaKey = moves();
    expect(viaKey).toEqual([{ input: { id: 'item-1', target: { kind: 'day', date: TODAY }, section: null, index: null, policy: null } }]);

    invoke.mockClear();
    act(() => openMenu());
    await settle();
    await openMovePage();
    const today = dayItems()[0];
    expect(today.dataset.date).toBe(TODAY);
    act(() => today.click());
    await settle();
    expect(moves()).toEqual(viaKey);
    expect(menuOpen()).toBe(false);
  });

  it('Shift+T(대문자)도, 하위 메뉴(다른 날로 이동)를 연 상태에서도', async () => {
    await render();
    press({ key: 'T', shiftKey: true });
    await settle();
    expect(moves()).toHaveLength(1);
    invoke.mockClear();
    act(() => openMenu());
    await settle();
    await openMovePage();
    press({});
    await settle();
    expect(moves()).toHaveLength(1);
  });

  it('한글 입력 모드 — 메뉴에서 물리 T(ㅅ · Process/229)도 오늘로, 같은 이동 명령', async () => {
    const expected = [{ input: { id: 'item-1', target: { kind: 'day', date: TODAY }, section: null, index: null, policy: null } }];
    await render();
    const hangul = press({ key: 'ㅅ', code: 'KeyT' });
    await settle();
    expect(hangul.defaultPrevented).toBe(true);
    expect(moves()).toEqual(expected);

    invoke.mockClear();
    act(() => openMenu());
    await settle();
    const ime = press({ key: 'Process', code: 'KeyT', keyCode: 229 } as KeyboardEventInit);
    expect(ime.keyCode).toBe(229);
    await settle();
    expect(moves()).toEqual(expected);
  });

  it('한글 모드에서 편집기가 받은 IME 키(Process/229)는 글자 입력 — 이동·막기 없음', async () => {
    await render();
    const event = press({ key: 'Process', code: 'KeyT', keyCode: 229 } as KeyboardEventInit, editor!);
    await settle();
    expect(event.defaultPrevented).toBe(false);
    expect(moves()).toHaveLength(0);
    expect(menuOpen()).toBe(true);
  });

  it('메뉴를 닫은 뒤 한글 모드의 T(ㅅ)는 평범한 입력', async () => {
    await render();
    act(() => {
      document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    });
    await settle();
    const event = press({ key: 'ㅅ', code: 'KeyT' }, editor!);
    await settle();
    expect(event.defaultPrevented).toBe(false);
    expect(moves()).toHaveLength(0);
  });

  it('편집기가 포커스를 갖고 있어도 메뉴가 받는다 — 글자로 들어가지 않는다', async () => {
    await render();
    const event = press({}, editor!);
    await settle();
    expect(event.defaultPrevented).toBe(true);
    expect(moves()).toHaveLength(1);
  });

  it('Ctrl+T · Alt+T · 한글 조합 중에는 이동하지 않고 기본 동작도 막지 않는다', async () => {
    await render();
    for (const init of [{ ctrlKey: true }, { altKey: true }, { metaKey: true }, { isComposing: true }, { key: 'Process', keyCode: 229 }]) {
      const event = press(init);
      expect(event.defaultPrevented).toBe(false);
    }
    await settle();
    expect(moves()).toHaveLength(0);
    expect(menuOpen()).toBe(true);
  });

  it('메뉴를 닫은 뒤의 t 는 평범한 입력이다', async () => {
    await render();
    const escape = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
    act(() => {
      document.activeElement!.dispatchEvent(escape);
    });
    await settle();
    expect(menuOpen()).toBe(false);
    editor!.focus();
    const event = press({}, editor!);
    await settle();
    expect(event.defaultPrevented).toBe(false);
    expect(moves()).toHaveLength(0);
  });

  it('빠른 연타 · 키 반복에도 한 번만, 우클릭한 그 메모만', async () => {
    await render();
    press({});
    press({});
    press({ repeat: true });
    await settle();
    expect(moves()).toHaveLength(1);
    expect((moves()[0] as { input: { id: string } }).input.id).toBe('item-1');
  });

  it('이미 오늘 날짜의 메모 — T 는 아무것도 저장하지 않고(글자도 막음), 메뉴의 오늘은 꺼짐', async () => {
    await render({ location: { kind: 'day', date: TODAY } });
    const event = press({});
    await settle();
    expect(event.defaultPrevented).toBe(true);
    expect(moves()).toHaveLength(0);
    expect(menuOpen()).toBe(true);
    await openMovePage();
    const [today, tomorrow] = dayItems();
    expect(today.getAttribute('aria-disabled')).toBe('true');
    expect(tomorrow.getAttribute('aria-disabled')).toBeNull();
  });

  it('Next List 의 메모도 T 로 오늘(같은 이동 명령)', async () => {
    await render({ location: { kind: 'next', listId: null }, item: memo({ section: 'next' }) });
    press({});
    await settle();
    expect(moves()).toEqual([{ input: { id: 'item-1', target: { kind: 'day', date: TODAY }, section: null, index: null, policy: null } }]);
  });
});

describe('메모 메뉴 — 날짜 목록', () => {
  it('오늘(T 표시) → 내일 → 모레 → 월~금, 그 뒤 List · 날짜 선택 그대로', async () => {
    await render();
    await openMovePage();
    const rows = dayItems().map(el => `${el.querySelector('.MuiListItemText-root')!.textContent}|${el.querySelector('.MuiTypography-caption')!.textContent}`);
    expect(rows).toEqual([
      '오늘T|금 · 11/20',
      '내일|토 · 11/21',
      '모레|일 · 11/22',
      '월요일|11/23',
      '화요일|11/24',
      '수요일|11/25',
      '목요일|11/26',
      '금요일|11/27',
    ]);
    expect(document.querySelector('[data-testid="memo-move-today-key"]')?.textContent).toBe('T');
    // 메모가 있는 11/23 은 꺼짐
    expect(dayItems()[3].getAttribute('aria-disabled')).toBe('true');
    const all = [...document.querySelectorAll('[role="menuitem"]')].map(el => el.textContent ?? '');
    const lastDay = all.findIndex(t => t.startsWith('금요일'));
    expect(all.slice(lastDay + 1)).toEqual(['Next날짜 미정', '날짜 선택…']);
  });

  it('자정이 지난 뒤 연 메뉴는 새 날짜부터(앱의 오늘이 아직 갱신 전이어도)', async () => {
    vi.setSystemTime(new Date(2026, 10, 21, 0, 0, 10));
    await render({ appToday: TODAY });
    await openMovePage();
    expect(dayItems().map(el => el.dataset.date)).toEqual([
      '2026-11-21', '2026-11-22', '2026-11-23', '2026-11-24', '2026-11-25', '2026-11-26', '2026-11-27', '2026-11-28',
    ]);
    press({});
    await settle();
    expect(moves()).toEqual([{ input: { id: 'item-1', target: { kind: 'day', date: '2026-11-21' }, section: null, index: null, policy: null } }]);
  });
});
