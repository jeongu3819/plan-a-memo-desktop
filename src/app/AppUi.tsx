/** 앱 전역 Dialog 열기(설정 · 계정 연결 · 충돌 비교 · 내보내기). */
import { createContext, useContext } from 'react';

export interface AppUi {
  openSettings: () => void;
  /** 계정 연결 창 — reason 은 '왜 필요한지' 한 줄. 연결되면 onConnected. */
  openAccount: (reason?: string, onConnected?: () => void) => void;
  openConflicts: (documentId?: string) => void;
  openExport: () => void;
}

export const AppUiContext = createContext<AppUi | null>(null);

export function useAppUi(): AppUi {
  const value = useContext(AppUiContext);
  if (!value) throw new Error('AppUiContext 가 필요합니다.');
  return value;
}
