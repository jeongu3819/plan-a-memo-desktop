/** Browser-side Task description policy.
 *
 * This is an early UX boundary only. The backend applies the authoritative
 * allow-list, Base64 rejection, and UTF-8 byte limit again.
 */

import { sanitizeCellStyleText } from './officePaste';
import { MENTION_ATTR, MENTION_CLASS, isMentionElement } from './mentionMarkup';
import {
  MAX_INDENT_LEVEL, isTextSize, normalizeTextColor, normalizeRichText, normalizeTableSpans,
} from './richTextFormatting';
import {
  COL_WIDTH_ATTR,
  RESIZABLE_TABLE_ATTR,
  ROW_MIN_HEIGHT_ATTR,
  TABLE_SCROLL_ATTR,
  clampColWidth,
  clampRowMinHeight,
} from './tableResize';

const ALLOWED_TAGS = new Set([
  'P', 'BR', 'DIV',
  'STRONG', 'B', 'EM', 'I', 'U', 'S',
  'UL', 'OL', 'LI', 'BLOCKQUOTE',
  'A', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6',
  'TABLE', 'THEAD', 'TBODY', 'TFOOT', 'TR', 'TH', 'TD',
  // 사용자가 조절한 열 너비를 담는 유일한 구조. 값은 숫자 data 속성만 살아남는다.
  'COLGROUP', 'COL',
  'PRE', 'CODE', 'HR', 'IMG',
  // Mention identity, validated size presets and text color only.
  'SPAN',
]);

const DROP_WITH_CONTENT = new Set([
  'SCRIPT', 'STYLE', 'IFRAME', 'OBJECT', 'EMBED', 'SVG', 'CANVAS', 'META', 'LINK',
]);

const BASE64_IMAGE_RE = /^\s*data\s*:\s*image\/[^;,]+(?:\s*;[^,]*)?\s*;\s*base64\s*,/i;
const UNSAFE_URL_RE = /^\s*(?:javascript|vbscript|data)\s*:/i;
const SAFE_IMAGE_DIMENSION_RE = /^(?:auto|\d{1,4}(?:\.\d+)?(?:px|%)?)$/i;

export interface TaskDescriptionSanitizeResult {
  html: string;
  base64ImageCount: number;
  removedStyleAttributeCount: number;
}

function safeLinkUrl(value: string): boolean {
  if (!value || UNSAFE_URL_RE.test(value)) return false;
  // 백엔드 bleach 는 protocols={"http","https","mailto"} 만 통과시킨다. 프론트가 더
  // 넓게 허용하면 편집기에서 보이던 링크가 저장 후 사라진다(file:///, cid: 등).
  return /^(?:https?:\/\/|mailto:|\/(?!\/)|\.\.?\/|[^:]*$)/i.test(value);
}

function safeImageUrl(value: string): boolean {
  if (!value || BASE64_IMAGE_RE.test(value) || UNSAFE_URL_RE.test(value)) return false;
  // Stored images are server/root-relative or HTTP(S). blob: is editor-only
  // state and file:/cid: references from mail/Word must not reach the API.
  // [PLAN-A Memo Desktop] 로컬 첨부 참조 attachment://<uuid> 도 저장 가능한 내부 주소다.
  if (/^attachment:\/\/[0-9a-f-]{36}$/i.test(value.trim())) return true;
  return /^(?:https?:\/\/|\/|\.\/|\.\.\/)/i.test(value);
}

function copySafeAttributes(element: HTMLElement): { base64Image: boolean; removedStyle: boolean } {
  const attributes = new Map(
    Array.from(element.attributes).map(attr => [attr.name.toLowerCase(), attr.value]),
  );
  const hadStyle = attributes.has('style');
  Array.from(element.attributes).forEach(attr => element.removeAttribute(attr.name));

  if (element.tagName === 'A') {
    const href = attributes.get('href')?.trim() || '';
    if (safeLinkUrl(href)) element.setAttribute('href', href);
    const target = (attributes.get('target') || '').toLowerCase();
    if (target === '_blank' || target === '_self') element.setAttribute('target', target);
    if (target === '_blank') {
      element.setAttribute('rel', 'noopener noreferrer');
    } else {
      const rel = attributes.get('rel')?.trim();
      if (rel) element.setAttribute('rel', rel);
    }
  } else if (element.tagName === 'IMG') {
    const src = attributes.get('src')?.trim() || '';
    if (BASE64_IMAGE_RE.test(src)) return { base64Image: true, removedStyle: hadStyle };
    if (!safeImageUrl(src)) return { base64Image: false, removedStyle: hadStyle };
    element.setAttribute('src', src);
    for (const name of ['alt', 'title'] as const) {
      const value = attributes.get(name);
      if (value) element.setAttribute(name, value);
    }
    const imageId = attributes.get('data-image-id')?.trim();
    if (imageId && /^\d+$/.test(imageId)) element.setAttribute('data-image-id', imageId);
    for (const name of ['width', 'height'] as const) {
      const value = attributes.get(name)?.trim();
      if (value && SAFE_IMAGE_DIMENSION_RE.test(value)) element.setAttribute(name, value);
    }
    // Preserve only dimensions created by this editor. All Word/web-page
    // colors, fonts, spacing, classes, ids, data-* and event handlers go away.
    const sourceStyle = attributes.get('style') || '';
    const probe = document.createElement('span');
    probe.setAttribute('style', sourceStyle);
    const width = probe.style.width;
    const height = probe.style.height;
    if (width && SAFE_IMAGE_DIMENSION_RE.test(width)) element.style.width = width;
    if (height && SAFE_IMAGE_DIMENSION_RE.test(height)) element.style.height = height;
  } else if (element.tagName === 'TH' || element.tagName === 'TD') {
    for (const name of ['colspan', 'rowspan', 'scope'] as const) {
      const value = attributes.get(name);
      if (value) element.setAttribute(name, value);
    }
    // 붙여넣은 표의 서식(배경·글자색·정렬·세로정렬·기울임·밑줄·테두리)을 살린다.
    // 허용 property 와 값 검증은 officePaste 와 **같은 함수**를 쓴다 — 붙여넣기 경로와
    // 저장 경로가 갈라지면 화면에는 보이다가 저장 후 사라진다.
    // (폭/높이는 여기서 통과하지 못한다. 열 너비는 <col data-col-width> 계약이 담는다)
    const cellStyle = sanitizeCellStyleText(attributes.get('style'));
    if (cellStyle) element.setAttribute('style', cellStyle);
    const align = attributes.get('data-align');
    if (align && /^(left|center|right)$/.test(align)) element.setAttribute('data-align', align);
  } else if (element.tagName === 'TABLE') {
    // 표 자체의 위치(가운데/오른쪽). 셀 안 글자 정렬(td data-align)과 별개다.
    const tableAlign = attributes.get('data-align');
    if (tableAlign && /^(left|center|right)$/.test(tableAlign)) element.setAttribute('data-align', tableAlign);
    // Existing Worknote sizing preferences remain independent of text formatting.
    if (attributes.get('data-fit-mode') === 'fit') element.setAttribute('data-fit-mode', 'fit');
    if (attributes.get('data-wrap-text') === 'true') element.setAttribute('data-wrap-text', 'true');
    // 수동 크기 조절을 한 번이라도 한 표라는 표시. 값은 "true" 하나뿐이다.
    if ((attributes.get(RESIZABLE_TABLE_ATTR) || '').trim().toLowerCase() === 'true') {
      element.setAttribute(RESIZABLE_TABLE_ATTR, 'true');
    }
  } else if (element.tagName === 'COL') {
    // 화면 폭은 런타임 style 이 만든다. 저장되는 것은 검증된 숫자뿐.
    const width = clampColWidth(attributes.get(COL_WIDTH_ATTR));
    if (width !== null) element.setAttribute(COL_WIDTH_ATTR, String(width));
  } else if (element.tagName === 'TR') {
    const height = clampRowMinHeight(attributes.get(ROW_MIN_HEIGHT_ATTR));
    if (height !== null) element.setAttribute(ROW_MIN_HEIGHT_ATTR, String(height));
  } else if (element.tagName === 'DIV') {
    // 넓어진 표만 가로 스크롤시키는 상자. 값은 "1" 하나뿐이다.
    if ((attributes.get(TABLE_SCROLL_ATTR) || '').trim() === '1') {
      element.setAttribute(TABLE_SCROLL_ATTR, '1');
    }
    copyBlockFormatting(element, attributes);
  } else if (/^(P|H[1-6]|LI|BLOCKQUOTE)$/.test(element.tagName)) {
    copyBlockFormatting(element, attributes);
  } else if (element.tagName === 'SPAN') {
    // Mention spans keep identity only; ordinary spans keep size/color/highlight only.
    const mentionId = (attributes.get(MENTION_ATTR) || '').trim();
    if (/^\d{1,12}$/.test(mentionId)) {
      element.setAttribute(MENTION_ATTR, mentionId);
      element.setAttribute('class', MENTION_CLASS);
    } else {
      const size = attributes.get('data-text-size') || null;
      if (isTextSize(size)) element.setAttribute('data-text-size', size);
      const probe = document.createElement('span');
      probe.setAttribute('style', attributes.get('style') || '');
      const color = normalizeTextColor(probe.style.color);
      if (color) element.style.color = color;
      const highlight = normalizeTextColor(probe.style.backgroundColor);
      if (highlight) element.style.backgroundColor = highlight;
    }
  } else if (element.tagName === 'OL') {
    const start = attributes.get('start');
    if (start && /^-?\d+$/.test(start)) element.setAttribute('start', start);
    if (attributes.has('reversed')) element.setAttribute('reversed', '');
  } else if (element.tagName === 'LI') {
    const value = attributes.get('value');
    if (value && /^-?\d+$/.test(value)) element.setAttribute('value', value);
  }

  return { base64Image: false, removedStyle: hadStyle };
}

/** 문단 서식 계약: 정렬(data-align) · 들여쓰기 단계(data-indent, 문단/div 만). 백엔드와 같은 값. */
function copyBlockFormatting(element: HTMLElement, attributes: Map<string, string>): void {
  const align = attributes.get('data-align');
  if (align && /^(left|center|right)$/.test(align)) element.setAttribute('data-align', align);
  const indent = attributes.get('data-indent');
  if (/^(P|DIV)$/.test(element.tagName) && indent && /^\d$/.test(indent)
    && Number(indent) >= 1 && Number(indent) <= MAX_INDENT_LEVEL) {
    element.setAttribute('data-indent', indent);
  }
}

export function sanitizeTaskDescriptionHtml(value?: string | null): TaskDescriptionSanitizeResult {
  const source = value || '';
  if (!source || !/<\s*[a-zA-Z!/][^>]*>/.test(source)) {
    return { html: source, base64ImageCount: 0, removedStyleAttributeCount: 0 };
  }

  const template = document.createElement('template');
  template.innerHTML = source;
  normalizeRichText(template.content);
  normalizeTableSpans(template.content);
  let base64ImageCount = 0;
  let removedStyleAttributeCount = 0;

  const cleanChildren = (parent: ParentNode) => {
    for (const child of Array.from(parent.children)) {
      const element = child as HTMLElement;
      if (DROP_WITH_CONTENT.has(element.tagName)) {
        element.remove();
        continue;
      }
      cleanChildren(element);
      // Unformatted Office wrappers are unwrapped, keeping just their content.
      const allowed = ALLOWED_TAGS.has(element.tagName)
        && (element.tagName !== 'SPAN' || isMentionElement(element)
          || isTextSize(element.getAttribute('data-text-size')) || !!normalizeTextColor(element.style.color)
          || !!normalizeTextColor(element.style.backgroundColor));
      if (!allowed) {
        element.replaceWith(...Array.from(element.childNodes));
        continue;
      }
      const result = copySafeAttributes(element);
      if (result.removedStyle && element.tagName !== 'IMG') removedStyleAttributeCount += 1;
      if (result.base64Image) {
        base64ImageCount += 1;
        element.remove();
      } else if (element.tagName === 'IMG' && !element.getAttribute('src')) {
        element.remove();
      }
    }
  };

  cleanChildren(template.content);
  return {
    html: template.innerHTML,
    base64ImageCount,
    removedStyleAttributeCount,
  };
}

export function utf8ByteLength(value?: string | null): number {
  return new TextEncoder().encode(value || '').byteLength;
}

/**
 * Backend 저장 형식과 같은 비교 경계.
 * 호출자는 sanitizeTaskDescriptionHtml(...).html 값을 넘긴다.
 * 플랫폼 줄바꿈과 빈 rich-editor placeholder는 같게 보되, IMG 태그는 보존한다.
 */
export function normalizeTaskDescriptionForComparison(value?: string | null): string {
  const normalized = (value || '').replace(/\r\n?/g, '\n').trim();
  if (!/<\s*img\b/i.test(normalized)) {
    const plain = normalized
      .replace(/<[^>]+>/g, '')
      .replace(/&nbsp;|&#160;/gi, ' ')
      .trim();
    if (!plain) return '';
  }
  return normalized;
}
