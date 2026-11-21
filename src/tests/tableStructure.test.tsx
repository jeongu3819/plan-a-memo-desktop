/**
 * 표 행·열 삭제 — 남는 셀은 같은 노드·같은 HTML, 병합 셀 rowspan/colspan 조정(서버 정리 규칙과 같은 모양),
 * 마지막 행·열·겹친 병합은 바꾸지 않음, Undo/Redo 가 같은 노드를 제자리로, 저장 HTML 에 선택 흔적 없음.
 * (실제 화면 조작 — 핸들·우클릭·Delete·자동 저장·재실행 — 은 Windows E2E `table-structure` 단계)
 */
import { act, createRef } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import RichTextContextMenu, { type RichTextMenuAction } from '../vendor/plan-a-work/components/RichTextContextMenu';
import {
  reconcileStructureHistory,
  sentinelIds,
  structureDeleteLabel,
} from '../vendor/plan-a-work/hooks/useRichTableStructure';
import {
  TOOLBAR_GAP_ABOVE,
  TOOLBAR_GAP_BELOW,
  placeTableToolbar,
  toolbarBox,
  type PlainRect,
} from '../vendor/plan-a-work/utils/tableToolbarPlacement';
import {
  TABLE_STRUCTURE_MESSAGES,
  bandIndexAt,
  buildStructureGrid,
  checkStructureDeletion,
  columnBands,
  deleteTableStructure,
} from '../vendor/plan-a-work/utils/tableStructure';
import { sanitizeTaskDescriptionHtml } from '../vendor/plan-a-work/utils/taskDescription';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let cleanup: Array<() => void> = [];
afterEach(() => {
  cleanup.forEach(fn => fn());
  cleanup = [];
});

function mount(html: string): { root: HTMLDivElement; table: HTMLTableElement } {
  const root = document.createElement('div');
  root.contentEditable = 'true';
  root.innerHTML = html;
  document.body.appendChild(root);
  cleanup.push(() => root.remove());
  return { root, table: root.querySelector('table')! };
}

/** 4×4 표 — 셀 글자 r{행}c{열}, 일부 셀에 서식·링크·이미지. */
function grid4(): string {
  const cell = (r: number, c: number) => {
    if (r === 1 && c === 1) return '<td style="background-color: rgb(254, 240, 138)"><b>r1c1</b></td>';
    if (r === 2 && c === 2) return '<td data-align="center"><a href="https://example.com/x">r2c2</a><br><img src="attachment://11111111-1111-4111-8111-111111111111" alt=""></td>';
    return `<td>r${r}c${c}</td>`;
  };
  const rows = [0, 1, 2, 3].map(r => `<tr>${[0, 1, 2, 3].map(c => cell(r, c)).join('')}</tr>`).join('');
  return `<p>앞 문단</p><table><tbody>${rows}</tbody></table><p>뒤 문단</p>`;
}

const texts = (table: HTMLTableElement) =>
  Array.from(table.querySelectorAll('tr')).map(tr => Array.from(tr.children).map(td => td.textContent).join('|'));

describe('기본 행·열 삭제 (4×4)', () => {
  it.each([
    ['첫 번째 행', 0, ['r1c0|r1c1|r1c2|r1c3', 'r2c0|r2c1|r2c2|r2c3', 'r3c0|r3c1|r3c2|r3c3']],
    ['중간 행', 2, ['r0c0|r0c1|r0c2|r0c3', 'r1c0|r1c1|r1c2|r1c3', 'r3c0|r3c1|r3c2|r3c3']],
    ['마지막 행', 3, ['r0c0|r0c1|r0c2|r0c3', 'r1c0|r1c1|r1c2|r1c3', 'r2c0|r2c1|r2c2|r2c3']],
  ])('%s 삭제 — 나머지 행이 위로, 열 구성 그대로', (_name, index, expected) => {
    const { table } = mount(grid4());
    const result = deleteTableStructure(table, 'row', [index]);
    expect(result.ok).toBe(true);
    expect(texts(table)).toEqual(expected);
  });

  it.each([
    ['첫 번째 열', 0, 'r0c1|r0c2|r0c3'],
    ['중간 열', 2, 'r0c0|r0c1|r0c3'],
    ['마지막 열', 3, 'r0c0|r0c1|r0c2'],
  ])('%s 삭제 — 모든 행에서 같은 칸만', (_name, index, firstRow) => {
    const { table } = mount(grid4());
    expect(deleteTableStructure(table, 'col', [index]).ok).toBe(true);
    expect(texts(table)[0]).toBe(firstRow);
    expect(texts(table)).toHaveLength(4);
    table.querySelectorAll('tr').forEach(tr => expect(tr.children).toHaveLength(3));
  });

  it('여러 행·여러 열을 한 번에', () => {
    const { table } = mount(grid4());
    expect(deleteTableStructure(table, 'row', [0, 2, 3]).ok).toBe(true);
    expect(texts(table)).toEqual(['r1c0|r1c1|r1c2|r1c3']);
    const second = mount(grid4()).table;
    expect(deleteTableStructure(second, 'col', [1, 2]).ok).toBe(true);
    expect(texts(second)).toEqual(['r0c0|r0c3', 'r1c0|r1c3', 'r2c0|r2c3', 'r3c0|r3c3']);
  });

  it('지우지 않은 셀은 같은 노드·같은 HTML(서식·배경·정렬·링크·이미지) — 표 밖 문단도 그대로', () => {
    const { root, table } = mount(grid4());
    const keep = [table.rows[1].cells[1], table.rows[2].cells[2]];
    const before = keep.map(td => td.outerHTML);
    const paragraphs = Array.from(root.querySelectorAll('p')).map(p => p.outerHTML);
    deleteTableStructure(table, 'row', [0]);
    deleteTableStructure(table, 'col', [0]);
    keep.forEach((td, i) => {
      expect(td.isConnected).toBe(true);
      expect(td.outerHTML).toBe(before[i]);
    });
    expect(Array.from(root.querySelectorAll('p')).map(p => p.outerHTML)).toEqual(paragraphs);
  });
});

describe('Undo / Redo — 같은 노드를 제자리로', () => {
  it('행·열 삭제를 되돌리면 innerHTML 과 노드가 지우기 전과 같다, 다시 하면 같은 결과', () => {
    const { root, table } = mount(grid4());
    const original = root.innerHTML;
    const nodes = Array.from(table.querySelectorAll('td'));
    const rows = deleteTableStructure(table, 'row', [1, 2]);
    const cols = deleteTableStructure(table, 'col', [3]);
    if (!rows.ok || !cols.ok) throw new Error('삭제 실패');
    const after = root.innerHTML;
    cols.edit.undo();
    rows.edit.undo();
    expect(root.innerHTML).toBe(original);
    expect(Array.from(table.querySelectorAll('td'))).toEqual(nodes); // 복제가 아니라 같은 객체
    rows.edit.redo();
    cols.edit.redo();
    expect(root.innerHTML).toBe(after);
  });

  it('병합 셀을 옮긴 삭제도 정확히 되돌린다', () => {
    const { root, table } = mount('<table><tbody><tr><td rowspan="3">A</td><td>b0</td><td rowspan="2">C</td></tr><tr><td>b1</td></tr><tr><td>b2</td><td>c2</td></tr></tbody></table>');
    const original = root.innerHTML;
    const result = deleteTableStructure(table, 'row', [0]);
    if (!result.ok) throw new Error(result.reason);
    result.edit.undo();
    expect(root.innerHTML).toBe(original);
  });
});

describe('병합 셀 (rowspan · colspan)', () => {
  it('병합 셀의 시작 행을 지우면 다음 행으로 옮기고 rowspan 을 줄인다(열 위치 유지)', () => {
    const { table } = mount('<table><tbody><tr><td rowspan="3">A</td><td>b0</td><td rowspan="2">C</td></tr><tr><td>b1</td></tr><tr><td>b2</td><td>c2</td></tr></tbody></table>');
    expect(deleteTableStructure(table, 'row', [0]).ok).toBe(true);
    expect(table.rows[0].innerHTML).toBe('<td rowspan="2">A</td><td>b1</td><td>C</td>');
    expect(table.rows[1].innerHTML).toBe('<td>b2</td><td>c2</td>');
    const g = buildStructureGrid(table);
    expect(g.problem).toBeNull();
    expect(g.columns).toBe(3);
    expect(g.grid.map(row => row.map(c => c?.el.textContent).join(''))).toEqual(['Ab1C', 'Ab2c2']);
  });

  it('병합 셀 가운데 행을 지우면 rowspan 만 줄어든다(1 이 되면 속성 제거)', () => {
    const { table } = mount('<table><tbody><tr><td rowspan="2">A</td><td>b0</td></tr><tr><td>b1</td></tr><tr><td>a2</td><td>b2</td></tr></tbody></table>');
    deleteTableStructure(table, 'row', [1]);
    expect(table.rows[0].innerHTML).toBe('<td>A</td><td>b0</td>');
    expect(table.rows[1].innerHTML).toBe('<td>a2</td><td>b2</td>');
  });

  it('병합 셀에 걸친 열을 지우면 colspan 이 줄고, 병합 셀이 덮는 열을 모두 지우면 셀도 사라진다', () => {
    const { table } = mount('<table><tbody><tr><td colspan="3">제목</td><td>x</td></tr><tr><td>a</td><td>b</td><td>c</td><td>d</td></tr></tbody></table>');
    deleteTableStructure(table, 'col', [1]);
    expect(table.rows[0].innerHTML).toBe('<td colspan="2">제목</td><td>x</td>');
    expect(texts(table)[1]).toBe('a|c|d');
    deleteTableStructure(table, 'col', [0, 1]);
    expect(texts(table)).toEqual(['x', 'd']);
  });

  it('rowspan + colspan 셀 — 행·열 삭제가 각각 맞게 줄인다', () => {
    const { table } = mount('<table><tbody><tr><td rowspan="2" colspan="2">M</td><td>c0</td></tr><tr><td>c1</td></tr><tr><td>a2</td><td>b2</td><td>c2</td></tr></tbody></table>');
    deleteTableStructure(table, 'row', [0]);
    expect(table.rows[0].innerHTML).toBe('<td colspan="2">M</td><td>c1</td>');
    deleteTableStructure(table, 'col', [0]);
    expect(table.rows[0].innerHTML).toBe('<td>M</td><td>c1</td>');
    expect(texts(table)[1]).toBe('b2|c2');
  });

  it('겹친 병합(잘못된 HTML)은 바꾸지 않고 이유를 알려 준다', () => {
    // 둘째 행의 colspan=2 셀(0~1열)이 첫 행 B(rowspan, 1열)와 겹친다.
    const html = '<table><tbody><tr><td>a</td><td rowspan="2">B</td></tr><tr><td colspan="2">겹침</td></tr><tr><td>c</td><td>d</td></tr></tbody></table>';
    const { root, table } = mount(html);
    const before = root.innerHTML;
    const result = deleteTableStructure(table, 'row', [0]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe(TABLE_STRUCTURE_MESSAGES.overlap);
    expect(root.innerHTML).toBe(before);
  });

  it('삭제 결과는 서버 정리 규칙(_normalize_table_spans)과 같은 모양 — span 은 행 묶음 안, 1 은 속성 없음', () => {
    const { table } = mount('<table><thead><tr><th rowspan="5">H</th><th>h</th></tr></thead><tbody><tr><td>a</td><td>b</td></tr></tbody></table>');
    // thead 의 rowspan=5 는 thead(1행) 안으로 잘린다 → 1
    const g = buildStructureGrid(table);
    expect(g.cells[0].rowSpan).toBe(1);
    deleteTableStructure(table, 'col', [1]);
    expect(table.querySelector('th')!.outerHTML).toBe('<th rowspan="5">H</th>'); // 손대지 않은 셀은 원래 HTML 그대로
    expect(texts(table)).toEqual(['H', 'a']);
  });
});

describe('표 머리·몸통·꼬리 · 열 너비 · 행 높이', () => {
  it('thead/tbody/tfoot — 행 번호는 DOM 순서, 비워진 묶음은 지운다', () => {
    const { table } = mount('<table><thead><tr><th>머리</th></tr></thead><tbody><tr><td>1</td></tr><tr><td>2</td></tr></tbody><tfoot><tr><td>꼬리</td></tr></tfoot></table>');
    deleteTableStructure(table, 'row', [0]);
    expect(table.querySelector('thead')).toBeNull();
    expect(texts(table)).toEqual(['1', '2', '꼬리']);
    deleteTableStructure(table, 'row', [2]);
    expect(table.querySelector('tfoot')).toBeNull();
    expect(texts(table)).toEqual(['1', '2']);
  });

  it('열을 지우면 <col data-col-width> 도 같은 자리를 빼고, 표 화면 폭(런타임)을 남은 합으로', () => {
    const { table } = mount('<table data-resizable-table="true" style="table-layout: fixed; width: 360px; max-width: none;"><colgroup><col data-col-width="100" style="width: 100px;"><col data-col-width="120" style="width: 120px;"><col data-col-width="140" style="width: 140px;"></colgroup><tbody><tr data-row-min-height="40"><td>a</td><td>b</td><td>c</td></tr><tr><td>d</td><td>e</td><td>f</td></tr></tbody></table>');
    const result = deleteTableStructure(table, 'col', [1]);
    expect(Array.from(table.querySelectorAll('col')).map(c => c.getAttribute('data-col-width'))).toEqual(['100', '140']);
    expect(table.style.width).toBe('240px');
    expect(table.querySelector('tr')!.getAttribute('data-row-min-height')).toBe('40');
    if (!result.ok) throw new Error('삭제 실패');
    result.edit.undo();
    expect(table.style.width).toBe('360px');
    expect(table.querySelectorAll('col')).toHaveLength(3);
  });

  it('행을 지우면 그 행의 최소 높이만 함께 사라진다', () => {
    const { table } = mount('<table><tbody><tr data-row-min-height="60"><td>a</td></tr><tr data-row-min-height="40"><td>b</td></tr></tbody></table>');
    deleteTableStructure(table, 'row', [0]);
    expect(table.querySelector('tr')!.outerHTML).toBe('<tr data-row-min-height="40"><td>b</td></tr>');
  });

  it('저장 HTML(sanitize) — 남은 셀 서식 그대로, 선택 강조 흔적 없음', () => {
    const { root, table } = mount(grid4());
    deleteTableStructure(table, 'row', [0]);
    const html = sanitizeTaskDescriptionHtml(root.innerHTML).html;
    expect(html).toContain('background-color');
    expect(html).toContain('data-align="center"');
    expect(html).toContain('href="https://example.com/x"');
    expect(html).not.toMatch(/table-structure|outline|data-start|data-kind/);
    expect(html).not.toContain('r0c0');
  });
});

describe('표가 사라지는 삭제는 막는다', () => {
  it('마지막 행·마지막 열(또는 전체 선택) — 바꾸지 않고 이유', () => {
    const { root, table } = mount('<table><tbody><tr><td>하나</td><td>둘</td></tr></tbody></table>');
    const before = root.innerHTML;
    expect(checkStructureDeletion(table, 'row', [0])).toEqual({ ok: false, reason: TABLE_STRUCTURE_MESSAGES.lastRow });
    expect(deleteTableStructure(table, 'row', [0]).ok).toBe(false);
    expect(deleteTableStructure(table, 'col', [0, 1]).ok).toBe(false);
    expect(root.innerHTML).toBe(before);
    expect(deleteTableStructure(table, 'col', [1]).ok).toBe(true);
    expect(checkStructureDeletion(table, 'col', [0])).toEqual({ ok: false, reason: TABLE_STRUCTURE_MESSAGES.lastColumn });
  });

  it('빈 표·범위 밖 번호', () => {
    const { table } = mount('<table><tbody></tbody></table>');
    expect(deleteTableStructure(table, 'row', [0]).ok).toBe(false);
    const other = mount(grid4()).table;
    expect(checkStructureDeletion(other, 'row', [9])).toEqual({ ok: false, reason: TABLE_STRUCTURE_MESSAGES.nothing });
  });
});

describe('좌표 → 행·열', () => {
  it('병합 셀만 있는 열 경계도 나눠서 찾는다', () => {
    const { table } = mount('<table><tbody><tr><td colspan="2">AB</td><td>C</td></tr></tbody></table>');
    const cells = Array.from(table.querySelectorAll('td'));
    const rects = [{ left: 0, right: 200 }, { left: 200, right: 300 }];
    cells.forEach((cell, i) => {
      vi.spyOn(cell, 'getBoundingClientRect').mockReturnValue({ ...rects[i], top: 0, bottom: 20, width: 0, height: 20, x: 0, y: 0, toJSON: () => ({}) } as DOMRect);
    });
    vi.spyOn(table, 'getBoundingClientRect').mockReturnValue({ left: 0, right: 300, top: 0, bottom: 20, width: 300, height: 20, x: 0, y: 0, toJSON: () => ({}) } as DOMRect);
    const bands = columnBands(table);
    expect(bands).toEqual([{ start: 0, end: 100 }, { start: 100, end: 200 }, { start: 200, end: 300 }]);
    expect(bandIndexAt(bands, 150)).toBe(1);
    expect(bandIndexAt(bands, -20)).toBe(-1);
    expect(bandIndexAt(bands, -20, true)).toBe(0);
    expect(bandIndexAt(bands, 999, true)).toBe(2);
  });
});

describe('우클릭 메뉴 — 표 편집', () => {
  function renderMenu(tableActions: RichTextMenuAction[] | null) {
    const editorRef = createRef<HTMLDivElement>();
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    const range = document.createRange();
    act(() => {
      root.render(
        <RichTextContextMenu
          editorRef={editorRef}
          state={{ top: 10, left: 10, range, currentPx: null, tableActions }}
          onClose={() => undefined}
          onFormat={() => undefined}
          actions={[{ key: 'move-top', label: '맨 위로 보내기', onSelect: () => undefined }]}
        />,
      );
    });
    cleanup.push(() => { act(() => root.unmount()); host.remove(); });
    return document.querySelector('[data-testid="rich-text-context-menu"]') as HTMLElement;
  }

  it('표 안이면 서식 아래 · 항목 명령 위에 "표 편집" 그룹 — 서식 그룹은 그대로', () => {
    const onRow = vi.fn();
    const menu = renderMenu([
      { key: 'table-delete-row', label: '현재 행 삭제', onSelect: onRow },
      { key: 'table-delete-col', label: '현재 열 삭제', onSelect: () => undefined, disabled: true, disabledReason: TABLE_STRUCTURE_MESSAGES.lastColumn },
    ]);
    const groups = Array.from(menu.querySelectorAll('[role="group"]')).map(g => g.getAttribute('aria-label'));
    expect(groups).toEqual(['글자 서식', '글자 크기', '글자 색상', '배경색', '목록', '표 편집', '항목']);
    const row = menu.querySelector('[data-testid="rich-menu-action-table-delete-row"]') as HTMLButtonElement;
    expect(row.textContent).toBe('현재 행 삭제');
    act(() => row.click());
    expect(onRow).toHaveBeenCalledTimes(1);
    expect((menu.querySelector('[data-testid="rich-menu-action-table-delete-col"]') as HTMLButtonElement).disabled).toBe(true);
  });

  it('표 밖이면 "표 편집" 이 없다(기존 메뉴 그대로)', () => {
    const menu = renderMenu(null);
    expect(menu.textContent).not.toContain('표 편집');
    expect(menu.querySelector('[data-testid="rich-menu-action-move-top"]')).not.toBeNull();
  });

  it('문구 — 현재 / 선택(개수는 둘 이상일 때)', () => {
    expect(structureDeleteLabel('row', 1, false)).toBe('현재 행 삭제');
    expect(structureDeleteLabel('col', 1, false)).toBe('현재 열 삭제');
    expect(structureDeleteLabel('row', 3, true)).toBe('선택한 행 삭제 (3개)');
    expect(structureDeleteLabel('col', 2, true)).toBe('선택한 열 삭제 (2개)');
    expect(structureDeleteLabel('row', 1, true)).toBe('선택한 행 삭제');
  });
});

describe('구조 변경 ↔ 브라우저 기본 Undo 이력 (sentinel 표식)', () => {
  it('표식 번호 읽기', () => {
    expect([...sentinelIds('#1;#2;#10;')]).toEqual([1, 2, 10]);
    expect(sentinelIds('').size).toBe(0);
  });

  it('표식이 사라지면 그 구조 변경을 되돌리고(최근 것부터), 다시 나타나면 다시 적용한다(오래된 것부터)', () => {
    const entries = [{ id: 1, applied: true }, { id: 2, applied: true }, { id: 3, applied: false }];
    expect(reconcileStructureHistory(entries, new Set([1, 2]))).toEqual({ undo: [], redo: [] });
    expect(reconcileStructureHistory(entries, new Set([1]))).toEqual({ undo: [2], redo: [] });
    expect(reconcileStructureHistory(entries, new Set([]))).toEqual({ undo: [2, 1], redo: [] });
    expect(reconcileStructureHistory(entries, new Set([1, 2, 3]))).toEqual({ undo: [], redo: [3] });
  });

  it('DomEdit 를 번갈아 되돌리고 다시 해도 같은 노드·같은 HTML (Undo → 입력 없이 Redo → Undo …)', () => {
    const { root, table } = mount(grid4());
    const original = root.innerHTML;
    const result = deleteTableStructure(table, 'row', [1]);
    if (!result.ok) throw new Error(result.reason);
    const deleted = root.innerHTML;
    for (let i = 0; i < 3; i++) {
      result.edit.undo();
      expect(root.innerHTML).toBe(original);
      result.edit.redo();
      expect(root.innerHTML).toBe(deleted);
    }
  });
});

describe('표 크기 도구 자리 — 표 밖 글자를 가리지 않는다', () => {
  const table: PlainRect = { left: 100, top: 200, right: 700, bottom: 400 };
  const size = { width: 200, height: 24 };
  const bounds: PlainRect = { left: 0, top: 0, right: 1000, bottom: 800 };
  const overlaps = (a: PlainRect, b: PlainRect) => a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
  const textAt = (...rects: PlainRect[]) => (box: PlainRect) => !rects.some(r => overlaps(box, r));

  it('위가 비어 있으면 예전 자리(표 위 왼쪽), 열 핸들과 겹치지 않는 간격', () => {
    const placed = placeTableToolbar({ table, size, bounds, isFree: () => true });
    expect(placed).toEqual({ side: 'above-left', left: 100, top: 200 - TOOLBAR_GAP_ABOVE - 24 });
    expect(200 - (placed!.top + 24)).toBeGreaterThanOrEqual(8); // 핸들은 위 테두리 ±7px
  });

  it('표 바로 위 문단(왼쪽 글자)이 있으면 위 오른쪽, 위가 꽉 차면 아래, 다 막히면 표 안', () => {
    const paragraphLeft = { left: 100, top: 170, right: 400, bottom: 195 };
    expect(placeTableToolbar({ table, size, bounds, isFree: textAt(paragraphLeft) })?.side).toBe('above-right');
    const paragraphFull = { left: 100, top: 170, right: 700, bottom: 195 };
    expect(placeTableToolbar({ table, size, bounds, isFree: textAt(paragraphFull) })?.side).toBe('below-left');
    const below = { left: 100, top: 405, right: 700, bottom: 430 };
    const inside = placeTableToolbar({ table, size, bounds, isFree: textAt(paragraphFull, below) });
    expect(inside?.side).toBe('inside');
    expect(inside!.top).toBeGreaterThanOrEqual(table.top);
    expect(inside!.left + size.width).toBeLessThanOrEqual(table.right);
  });

  it('스크롤 영역 위 끝에 붙은 표 — 위 자리가 영역 밖이면 쓰지 않는다(머리말 위에 뜨지 않음)', () => {
    const scrolled = { left: 0, top: 210, right: 1000, bottom: 800 };
    expect(placeTableToolbar({ table, size, bounds: scrolled, isFree: () => true })?.side).toBe('below-left');
  });

  it('화면 가장자리에서 잘리지 않게 가로를 당긴다', () => {
    const wide = { left: -50, top: 200, right: 1100, bottom: 400 };
    const box = toolbarBox('above-left', wide, size, bounds);
    expect(box.left).toBeGreaterThanOrEqual(bounds.left);
    const right = toolbarBox('above-right', wide, size, bounds);
    expect(right.right).toBeLessThanOrEqual(bounds.right);
  });

  it('표가 보이는 영역 밖이면 숨긴다', () => {
    expect(placeTableToolbar({ table, size, bounds: { left: 0, top: 500, right: 1000, bottom: 800 }, isFree: () => true })).toBeNull();
  });

  it('같은 표·같은 배치(스크롤만)면 고른 자리를 다시 재지 않는다 — 화면 밖으로 나가면 다시 고른다', () => {
    const isFree = vi.fn(() => true);
    expect(placeTableToolbar({ table, size, bounds, isFree, preferred: 'above-right', trustPreferred: true })?.side).toBe('above-right');
    expect(isFree).not.toHaveBeenCalled();
    const top = { left: 0, top: 190, right: 1000, bottom: 800 };
    expect(placeTableToolbar({ table, size, bounds: top, isFree, preferred: 'above-right', trustPreferred: true })?.side).toBe('below-left');
    expect(TOOLBAR_GAP_BELOW).toBeGreaterThan(0);
  });
});
