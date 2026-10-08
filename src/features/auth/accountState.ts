/**
 * 계정 화면이 보여 줄 상태 — 만료(같은 기기로 다시 연결)와 폐기(device_revoked — 새 기기 등록만)를 구분한다.
 */
import type { AuthStatus } from '../../domain/types';

export type AccountMode = 'connected' | 'revoked' | 'expired' | 'signed_out';

export function accountMode(auth: Pick<AuthStatus, 'loggedIn' | 'expired' | 'revoked' | 'session'> | undefined | null): AccountMode {
  if (!auth?.session) return 'signed_out';
  if (auth.revoked) return 'revoked';
  if (auth.loggedIn) return 'connected';
  if (auth.expired) return 'expired';
  return 'signed_out';
}

/** 같은 서버 기기 id 로 다시 연결해도 되는가(폐기된 기기는 서버가 409 device_revoked — 자동·반복 시도 금지). */
export const canReconnectSameDevice = (mode: AccountMode) => mode === 'expired';
