/**
 * 메모 메뉴의 한 글자 단축키 — 메뉴가 열려 있는 동안만 MemoMenu 가 듣는다(앱 전체에 등록하지 않는다).
 *   T — 오늘로 이동('다른 날로 이동 → 오늘' 과 같은 명령)
 */

type KeyLike = Pick<KeyboardEvent, 'key' | 'code' | 'ctrlKey' | 'altKey' | 'metaKey' | 'isComposing' | 'keyCode'> & {
  target?: EventTarget | null;
};

/** 글자를 받는 곳(편집기·입력칸) — IME 가 여기서 조합을 시작한다. */
function isEditableTarget(target: EventTarget | null | undefined): boolean {
  if (!target || typeof (target as HTMLElement).tagName !== 'string') return false;
  const el = target as HTMLElement;
  if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT') return true;
  return el.isContentEditable || !!el.closest?.('[contenteditable=""], [contenteditable="true"], [contenteditable="plaintext-only"]');
}

/**
 * 오늘로 이동 키인가.
 *   · 't' / 'T'(Shift 포함)
 *   · 한글 입력 모드 등으로 글자가 't' 가 아니어도 **물리 T 키**(code 'KeyT')면 — 'ㅅ'·'ㅆ', IME 가 받은 'Process'(keyCode 229).
 *     단 글자가 다른 라틴 문자면 아니다(Dvorak 등에서 그 자리는 다른 글자 키다).
 *   · 아님: Ctrl·Alt·Win(Meta)과 함께(다른 단축키), 한글 조합 중(isComposing),
 *     편집기·입력칸에서 IME 가 받은 키(229 — 거기서 조합이 시작되므로 글자 입력이다).
 * 실측(Windows 한국어 IME·WebView2): 메뉴가 포커스를 가져가면 한글 모드여도 't'(KeyT, 84)로 온다 — 위 'ㅅ'·'Process' 는
 * 메뉴(편집 불가 요소)에서도 IME 가 키를 받는 환경을 위한 것이다.
 */
export function isMoveTodayKey(event: KeyLike): boolean {
  if (event.ctrlKey || event.altKey || event.metaKey) return false;
  if (event.isComposing) return false;
  const imeKey = event.keyCode === 229 || event.key === 'Process';
  if (imeKey && isEditableTarget(event.target)) return false;
  if (event.key === 't' || event.key === 'T') return true;
  if (event.code !== 'KeyT') return false;
  return !/^[a-z]$/i.test(event.key);
}
