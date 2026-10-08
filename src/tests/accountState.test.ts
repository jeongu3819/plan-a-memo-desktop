import { describe, expect, it } from 'vitest';
import { accountMode, canReconnectSameDevice } from '../features/auth/accountState';

const session = { accountKey: 'local:x|1', userId: 1, displayName: 'u', namespace: 'local:x', serverDeviceId: 'd', deviceName: 'PC', connectedAt: '', expiresAt: '', isMock: true };

describe('계정 상태 — 만료와 기기 폐기를 구분', () => {
  it('정상 연결', () => {
    expect(accountMode({ loggedIn: true, expired: false, revoked: false, session })).toBe('connected');
  });
  it('만료 → 같은 기기로 다시 연결', () => {
    const mode = accountMode({ loggedIn: false, expired: true, revoked: false, session });
    expect(mode).toBe('expired');
    expect(canReconnectSameDevice(mode)).toBe(true);
  });
  it('폐기(device_revoked) → 같은 기기로는 다시 연결하지 않는다', () => {
    const mode = accountMode({ loggedIn: false, expired: true, revoked: true, session });
    expect(mode).toBe('revoked');
    expect(canReconnectSameDevice(mode)).toBe(false);
  });
  it('로그아웃 상태', () => {
    expect(accountMode({ loggedIn: false, expired: false, revoked: false, session: null })).toBe('signed_out');
    expect(accountMode(undefined)).toBe('signed_out');
  });
});
