import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AppInfo } from '../domain/types';

vi.mock('@tauri-apps/api/window', () => ({
  getCurrentWindow: () => ({
    isMaximized: () => Promise.resolve(false),
    onResized: () => Promise.resolve(() => undefined),
    minimize: vi.fn(),
    toggleMaximize: vi.fn(),
    close: vi.fn(),
  }),
}));
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(() => Promise.resolve()) }));

const { default: TitleBar } = await import('../app/TitleBar');

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let container: HTMLDivElement | null = null;

async function renderWithEnv(env: AppInfo['env']) {
  const client = new QueryClient();
  // App 이 같은 키로 읽어 둔 앱 정보 — TitleBar 는 이것만 본다.
  client.setQueryData(['app', 'info'], { env } as AppInfo);
  container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(
      <QueryClientProvider client={client}>
        <TitleBar />
      </QueryClientProvider>,
    );
  });
  return container;
}

afterEach(() => {
  container?.remove();
  container = null;
});

describe('창 제목 표시줄 — 브랜드 제목과 실행 환경 표시', () => {
  it('production: PLAN-A Memo 만(환경 표시 없음)', async () => {
    const el = await renderWithEnv('production');
    expect(el.querySelector('[data-testid="window-title-brand"]')?.textContent).toBe('PLAN-A Memo');
    expect(el.querySelector('[data-testid="window-title-env"]')).toBeNull();
  });
  it('staging: 작은 Staging 표시', async () => {
    const el = await renderWithEnv('staging');
    expect(el.querySelector('[data-testid="window-title-env"]')?.textContent).toBe('Staging');
  });
  it('development: Dev 표시', async () => {
    const el = await renderWithEnv('development');
    expect(el.querySelector('[data-testid="window-title-env"]')?.textContent).toBe('Dev');
  });
  it('창 조작 버튼 세 개(최소화 · 최대화 · 닫기)', async () => {
    const el = await renderWithEnv('production');
    const labels = [...el.querySelectorAll('[data-testid="window-title-bar"] button')].map(b => b.getAttribute('aria-label'));
    expect(labels).toEqual(['최소화', '최대화', '닫기']);
  });
});
