import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { UpdateInfo } from '../domain/types';

const { install, store } = vi.hoisted(() => ({
  install: vi.fn(() => Promise.resolve()),
  store: {
    flushAll: vi.fn(() => Promise.resolve()),
    anyUploading: vi.fn(() => false),
    failedCount: vi.fn(() => 0),
    unsavedCount: vi.fn(() => 0),
  },
}));

vi.mock('@tauri-apps/api/event', () => ({ listen: () => Promise.resolve(() => undefined) }));
vi.mock('../tauri/api', () => ({
  updateService: { install },
  errorMessage: (failure: unknown, fallback: string) => (failure instanceof Error ? failure.message : fallback),
}));
vi.mock('../features/memo/MemoProvider', () => ({ usePersonalMemo: () => ({ store }) }));

const { default: UpdateDialog } = await import('../features/update/UpdateDialog');

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const INFO: UpdateInfo = { currentVersion: '0.2.4', version: '0.2.5', notes: '- 메모 개선\n- 버그 수정', date: null };
let root: Root | null = null;
let host: HTMLDivElement | null = null;
let quickInput: HTMLTextAreaElement | null = null;

async function render(onClose: () => void = () => undefined) {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(<UpdateDialog info={INFO} onClose={onClose} />);
  });
}

const dialog = () => document.querySelector('[data-testid="update-dialog"]') as HTMLElement;
const clickUpdate = () =>
  act(async () => {
    (document.querySelector('[data-testid="update-install"]') as HTMLElement).click();
  });

beforeEach(() => {
  vi.clearAllMocks();
  store.flushAll.mockImplementation(() => Promise.resolve());
  store.anyUploading.mockReturnValue(false);
  store.failedCount.mockReturnValue(0);
  store.unsavedCount.mockReturnValue(0);
  install.mockImplementation(() => Promise.resolve());
});

afterEach(async () => {
  await act(async () => root?.unmount());
  host?.remove();
  quickInput?.remove();
  root = host = quickInput = null;
});

describe('UpdateDialog', () => {
  it('새 버전·변경사항과 [나중에] [업데이트]를 보여 준다', async () => {
    const onClose = vi.fn();
    await render(onClose);
    expect(dialog().textContent).toContain('새로운 버전이 있습니다 — v0.2.5');
    expect(dialog().querySelector('[data-testid="update-notes"]')?.textContent).toContain('메모 개선');
    const buttons = [...dialog().querySelectorAll('button')];
    expect(buttons.map(b => b.textContent)).toEqual(['나중에', '업데이트']);
    await act(async () => buttons[0].click());
    expect(onClose).toHaveBeenCalled();
    expect(install).not.toHaveBeenCalled();
  });

  it('[업데이트] → 저장을 끝낸 뒤에 설치한다', async () => {
    const order: string[] = [];
    store.flushAll.mockImplementation(async () => void order.push('flush'));
    install.mockImplementation(async () => void order.push('install'));
    await render();
    await clickUpdate();
    expect(order).toEqual(['flush', 'install']);
  });

  it.each([
    ['이미지를 넣는 중', () => store.anyUploading.mockReturnValue(true), '이미지를 넣는 중'],
    ['저장 실패', () => store.failedCount.mockReturnValue(1), '저장하지 못한 메모'],
    ['아직 저장되지 않음', () => store.unsavedCount.mockReturnValue(1), '저장하지 못한 메모'],
  ])('%s → 설치하지 않고 안내한다', async (_name, prepare, message) => {
    prepare();
    await render();
    await clickUpdate();
    expect(install).not.toHaveBeenCalled();
    expect(dialog().querySelector('[data-testid="update-error"]')?.textContent).toContain(message);
  });

  it('입력칸에 글이 남아 있으면 설치하지 않는다', async () => {
    quickInput = document.createElement('textarea');
    quickInput.setAttribute('data-testid', 'personal-memo-quick-input');
    quickInput.value = '쓰던 글';
    document.body.appendChild(quickInput);
    await render();
    await clickUpdate();
    expect(install).not.toHaveBeenCalled();
    expect(dialog().querySelector('[data-testid="update-error"]')?.textContent).toContain('입력칸');
  });

  it('설치 실패 → 원인을 보여 주고 [다시 시도]', async () => {
    install.mockImplementation(() => Promise.reject(new Error('서명을 확인하지 못했습니다')));
    await render();
    await clickUpdate();
    expect(dialog().querySelector('[data-testid="update-error"]')?.textContent).toContain('서명');
    expect(dialog().querySelector('[data-testid="update-install"]')?.textContent).toBe('다시 시도');
  });
});
