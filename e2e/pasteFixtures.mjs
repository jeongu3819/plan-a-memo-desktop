// 긴 텍스트 붙여넣기 시험 원문 — 같은 입력이면 늘 같은 원문(결정적).
// 모든 원문: 첫 줄 [FIRST-<이름>] · 가운데 [MID-<이름>] · 마지막 줄 끝 END_MARKER.

export const END_MARKER = '[END-OF-MEMO-PASTE-TEST-12345]';

const KO = [
  '오늘 회의에서 논의한 내용은 일정 조정, 예산 검토, 담당자 배정입니다.',
  '다음 주까지 고객 요구사항을 다시 정리하고 우선순위를 확정해야 합니다.',
  '배포 전 점검 목록을 확인하고 누락된 항목이 없는지 검토합니다.',
  '서버 로그에서 오류가 반복되는 시간대를 찾아 원인을 분석합니다.',
  '문서의 마지막 문단까지 빠짐없이 저장되는지 확인하는 문장입니다.',
];
const MIXED = [
  'Line {n}: 한글 English 12345 !@#$%^&*()_+-=[]{};\':",./<>? ✅🚀👍🏽 家族 é ñ ü — “quotes” ‘single’ ₩€£¥ ½ ±',
  '{n}) 가족 👨‍👩‍👧‍👦 국기 🇰🇷 수식 a² + b² = c² · 화살표 → ← ↑ ↓ · 괄호 「」『』【】 · 탭 없음',
  'Mixed {n}: The quick brown fox 빠른 갈색 여우 jumps over 0x1F600 😀 & <tag> "attr" \\back\\slash',
];

function lines(name, count, make) {
  const out = [`[FIRST-${name}] 첫 문장입니다. 붙여넣기 시험 원문의 시작입니다.`];
  const mid = Math.floor(count / 2);
  for (let i = 1; i <= count; i += 1) {
    if (i === mid) out.push(`[MID-${name}] 중간 검증 문장입니다.`);
    out.push(make(i));
  }
  out.push(`마지막 검증 문장입니다. 이 문장의 마지막 글자까지 보존되어야 합니다. ${END_MARKER}`);
  return out.join('\n');
}

const ko = i => `${i}번째 문단. ${KO[i % KO.length]}${i % 5 === 0 ? '\n' : ''}`;
const mixed = i => MIXED[i % MIXED.length].replace('{n}', String(i));

function blankHeavy(i) {
  const gap = '\n'.repeat(1 + (i % 4)); // 1~4 줄 비우기
  return `${i}번 문단 — 빈 줄이 여러 개 이어집니다.${gap}`;
}

function structured(i) {
  const r = i % 12;
  if (r === 0) return `## ${i}번 제목 (Markdown)`;
  if (r === 1) return `${i}. 번호 목록 항목입니다`;
  if (r === 2) return `- [ ] 체크리스트 미완료 ${i}`;
  if (r === 3) return `- [x] 체크리스트 완료 ${i}`;
  if (r === 4) return `    - 들여쓴 하위 항목 ${i} (공백 4칸)`;
  if (r === 5) return `\t탭으로 들여쓴 줄 ${i}`;
  if (r === 6) return `| 열1 ${i} | 열2 값 | 열3 ✅ |`;
  if (r === 7) return '|---|---|---|';
  if (r === 8) return `**굵게** _기울임_ \`code ${i}\` > 인용`;
  if (r === 9) return `https://example.com/docs/${i}/very/long/path?query=${'abc'.repeat(30)}&n=${i}#section-${i}`;
  if (r === 10) return '```';
  return `    코드 블록 안의 줄 ${i}  (두 칸 공백)  끝`;
}

function oneLine(name, chars) {
  const unit = '줄바꿈없는아주긴한줄 LongLineWithoutBreaks 0123456789 ';
  const body = unit.repeat(Math.ceil(chars / unit.length)).slice(0, chars);
  return `[FIRST-${name}] ${body.slice(0, chars / 2)}[MID-${name}]${body.slice(chars / 2)} ${END_MARKER}`;
}

/** 이름·원문 목록. size 단계: S(수십 줄) · M(수백 줄) · L(수천 줄/수만 자) · XL(수십만 자). */
export function fixtures() {
  return [
    { name: 'ko-S', text: lines('ko-S', 12, ko) },
    { name: 'ko-M', text: lines('ko-M', 400, ko) },
    { name: 'ko-L', text: lines('ko-L', 4000, ko) },
    { name: 'mixed-L', text: lines('mixed-L', 2500, mixed) },
    { name: 'blank-M', text: lines('blank-M', 600, blankHeavy) },
    { name: 'oneline-L', text: oneLine('oneline-L', 60000) },
    { name: 'structured-M', text: lines('structured-M', 700, structured) },
    { name: 'ko-XL', text: lines('ko-XL', 6000, ko) },
  ];
}

/** 같은 내용의 서식 있는 HTML(Word·웹 문서에서 복사한 모양). */
export function richHtmlOf(text) {
  const esc = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return text
    .split('\n')
    .map((line, i) => {
      if (!line) return '<p><br></p>';
      if (i % 7 === 3) return `<p><b>${esc(line)}</b></p>`;
      if (i % 7 === 5) return `<p><span style="color:#c00">${esc(line)}</span></p>`;
      return `<p>${esc(line)}</p>`;
    })
    .join('');
}

export function metrics(text) {
  const s = text.replace(/\r\n?/g, '\n');
  const all = s.split('\n');
  return {
    chars: [...s].length,
    utf16: s.length,
    bytes: Buffer.byteLength(s, 'utf8'),
    lines: all.length,
    nonEmptyLines: all.filter(l => l.trim()).length,
    first: all[0].slice(0, 40),
    hasMid: /\[MID-[^\]]+\]/.test(s),
    hasEnd: s.includes(END_MARKER),
    lastChars: s.slice(-12),
  };
}

/** 공백·줄바꿈을 모두 뺀 글자 열 — HTML 정규화(문단·<br>) 와 상관없이 글자 하나라도 빠지면 달라진다. */
// \s 는 NBSP 를 포함한다. 폭 없는 공백(U+200B)만 따로 더한다.
const WHITESPACE_RE = new RegExp(`[\\s${String.fromCharCode(0x200b)}]+`, 'g');
export const signature = text => text.replace(WHITESPACE_RE, '');

/** 공백을 다듬은 비어 있지 않은 줄 목록 — 줄 구조(문단·줄바꿈) 보존 확인. */
export const contentLines = text =>
  text
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map(l => l.replace(/\s+/g, ' ').trim())
    .filter(Boolean);
