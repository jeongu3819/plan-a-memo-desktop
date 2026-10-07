/**
 * Avatar 색 표시 규칙 — 화면들의 단일 원천.
 *
 * ## canonical source
 * 색의 원본은 **DB 의 `users.avatar_color`** 하나다(백엔드
 * `app/services/avatar_color.py`). 여기는 그 값을 화면에 그릴 때 쓰는 얇은
 * resolver 이며, 새 색을 만들어 내는 곳이 아니다.
 *
 * ## 왜 필요한가
 * 화면마다 `m.avatar_color || '#2955FF'` 처럼 **같은 fallback 상수**를 쓰고 있었다.
 * API 가 색을 주지 않는 응답(멤버 요약, 멘션 후보, 활동 피드 등)에서는 서로 다른
 * 사용자가 전부 그 한 색으로 그려져 구분이 되지 않는다. 또 legacy 기본색을 그대로
 * 들고 있는 사용자도 같은 결과가 된다.
 *
 * 그래서 fallback 도 **사용자에서 결정론적으로** 파생한다 — 백엔드와 같은 팔레트,
 * 같은 seed 규칙이므로 서버가 색을 준 화면과 주지 않은 화면의 색이 일치한다.
 * 화면에 들어갈 때마다 색이 바뀌는 일은 없다(난수·시간·순번을 쓰지 않는다).
 *
 * ⚠️ 팔레트/해시를 바꾸면 `backend/app/services/avatar_color.py` 도 함께 바꾼다.
 */

/** 코드가 박아 두었던 기본 색. "사용자가 고른 적 없는 값"의 판별 기준. */
export const LEGACY_DEFAULT_AVATAR_COLOR = '#2955FF';

/** backend `AVATAR_PALETTE` 와 **순서까지 동일**해야 한다. */
export const AVATAR_PALETTE = [
  '#3B6FE0',
  '#E0663B',
  '#2FA36B',
  '#B45BD1',
  '#D9455F',
  '#1FA2B8',
  '#C98A1E',
  '#5A6BD6',
  '#D4568F',
  '#4E9B3F',
  '#8A63D2',
  '#C25E2E',
  '#2C8FCC',
  '#A85A3C',
  '#6E8C1F',
  '#CF4FA8',
] as const;

export interface AvatarColorSeed {
  /** 우선 seed — 계정이 재생성돼 id 가 달라져도 같은 사람은 같은 색. */
  loginid?: string | null;
  userId?: number | string | null;
}

/**
 * seed 문자열. 백엔드 `_seed_text` 와 같은 형식이어야 한다.
 * loginid 는 대소문자를 구분하지 않는다(계정 비교와 같은 규칙).
 */
const seedText = ({ loginid, userId }: AvatarColorSeed): string => {
  const login = (loginid || '').trim().toLowerCase();
  if (login) return `login:${login}`;
  if (userId !== null && userId !== undefined && `${userId}`.trim() !== '') {
    const numeric = Number(userId);
    if (Number.isFinite(numeric)) return `id:${Math.trunc(numeric)}`;
  }
  return '';
};

/**
 * SHA-1 앞 4바이트를 팔레트 길이로 나눈 나머지 — 백엔드와 같은 값을 얻기 위한 구현.
 *
 * 브라우저의 `crypto.subtle.digest` 는 비동기라 렌더 중에 쓸 수 없으므로 동기
 * 구현을 둔다. 암호 용도가 아니라 **플랫폼과 무관하게 재현 가능한 숫자**를 얻는
 * 것이 목적이다.
 */
const sha1FirstWord = (input: string): number => {
  const bytes: number[] = [];
  for (let i = 0; i < input.length; i += 1) {
    const code = input.charCodeAt(i);
    // seed 는 loginid/숫자라 사실상 ASCII 지만, 한글 loginid 같은 예외에서도
    // 백엔드의 UTF-8 인코딩과 같은 바이트열이 되도록 직접 인코딩한다.
    if (code < 0x80) {
      bytes.push(code);
    } else if (code < 0x800) {
      bytes.push(0xc0 | (code >> 6), 0x80 | (code & 0x3f));
    } else {
      bytes.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f));
    }
  }

  const bitLength = bytes.length * 8;
  bytes.push(0x80);
  while (bytes.length % 64 !== 56) bytes.push(0);
  // 길이는 64bit big-endian. seed 길이는 2^32 비트를 넘지 않으므로 상위 4바이트는 0.
  bytes.push(0, 0, 0, 0);
  bytes.push((bitLength >>> 24) & 0xff, (bitLength >>> 16) & 0xff, (bitLength >>> 8) & 0xff, bitLength & 0xff);

  const rotl = (value: number, shift: number) => ((value << shift) | (value >>> (32 - shift))) >>> 0;

  let h0 = 0x67452301;
  let h1 = 0xefcdab89;
  let h2 = 0x98badcfe;
  let h3 = 0x10325476;
  let h4 = 0xc3d2e1f0;

  const w = new Array<number>(80);
  for (let block = 0; block < bytes.length; block += 64) {
    for (let i = 0; i < 16; i += 1) {
      const o = block + i * 4;
      w[i] = ((bytes[o] << 24) | (bytes[o + 1] << 16) | (bytes[o + 2] << 8) | bytes[o + 3]) >>> 0;
    }
    for (let i = 16; i < 80; i += 1) {
      w[i] = rotl(w[i - 3] ^ w[i - 8] ^ w[i - 14] ^ w[i - 16], 1);
    }

    let a = h0;
    let b = h1;
    let c = h2;
    let d = h3;
    let e = h4;

    for (let i = 0; i < 80; i += 1) {
      let f: number;
      let k: number;
      if (i < 20) {
        f = (b & c) | (~b & d);
        k = 0x5a827999;
      } else if (i < 40) {
        f = b ^ c ^ d;
        k = 0x6ed9eba1;
      } else if (i < 60) {
        f = (b & c) | (b & d) | (c & d);
        k = 0x8f1bbcdc;
      } else {
        f = b ^ c ^ d;
        k = 0xca62c1d6;
      }
      const temp = (rotl(a, 5) + (f >>> 0) + e + k + w[i]) >>> 0;
      e = d;
      d = c;
      c = rotl(b, 30);
      b = a;
      a = temp;
    }

    h0 = (h0 + a) >>> 0;
    h1 = (h1 + b) >>> 0;
    h2 = (h2 + c) >>> 0;
    h3 = (h3 + d) >>> 0;
    h4 = (h4 + e) >>> 0;
  }

  return h0 >>> 0;
};

/** seed → 팔레트 색. 같은 입력이면 항상 같은 색이다. */
export const deriveAvatarColor = (seed: AvatarColorSeed): string => {
  const text = seedText(seed);
  if (!text) return AVATAR_PALETTE[0];
  return AVATAR_PALETTE[sha1FirstWord(text) % AVATAR_PALETTE.length];
};

/** 비어 있거나 legacy 기본값 그대로 — 즉 "아직 아무도 고르지 않은 색". */
export const isUnassignedAvatarColor = (color?: string | null): boolean => {
  const value = (color || '').trim();
  if (!value) return true;
  return value.toLowerCase() === LEGACY_DEFAULT_AVATAR_COLOR.toLowerCase();
};

/**
 * 화면에 그릴 색. 저장된 색이 사용자의 선택이면 그대로 쓰고, 아니면 파생한다.
 *
 * seed 를 줄 수 없는 호출부(사용자 식별자를 들고 있지 않은 자리)는 저장값을 그대로
 * 쓰게 되며, 그 경우에도 예전과 같은 색이 나온다 — 즉 이 함수로 바꾼다고 기존
 * 화면이 깨지지 않는다.
 */
export const resolveAvatarColor = (
  stored?: string | null,
  seed?: AvatarColorSeed,
): string => {
  if (!isUnassignedAvatarColor(stored)) return (stored || '').trim();
  if (!seed) return LEGACY_DEFAULT_AVATAR_COLOR;
  return deriveAvatarColor(seed);
};
