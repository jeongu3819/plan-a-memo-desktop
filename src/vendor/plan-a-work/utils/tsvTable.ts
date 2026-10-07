/**
 * 탭으로 구분된 텍스트(TSV) → HTML 표.
 *
 * 왜 필요한가:
 *   Excel 표를 붙여넣을 때 브라우저·Excel 버전에 따라 `text/html` 이 아예 없거나,
 *   있어도 `<table>` 껍데기 없는 조각이라 표 구조가 살아남지 못할 수 있다.
 *   하지만 `text/plain` 은 **항상** 온다 — 탭으로 열을, 줄바꿈으로 행을 구분한 형태다.
 *   그래서 HTML 경로가 표를 만들어 내지 못했을 때의 마지막 안전망으로 쓴다.
 *   "적어도 Excel 의 값과 행·열 구조는 언제나 붙여넣을 수 있다"를 보장하는 것이 목적이다.
 *
 * 무엇을 하지 않는가:
 *   서식은 복원하지 않는다(text/plain 에는 서식이 없다). 문장 안에 탭이 하나 있다고
 *   거대한 표를 만들지도 않는다 — 아래 판정 규칙을 통과할 때만 표로 본다.
 */

import Papa from 'papaparse';

/** 표로 볼 수 있는 모양인가(행/열 수와 규칙성으로만 판단한다). */
export interface TsvGrid {
    rows: string[][];
    columns: number;
}

/** Excel 셀 안의 줄바꿈은 따옴표로 감싸져 온다 — 그 줄바꿈은 행 구분이 아니다. */
function splitTsvRows(text: string): string[] {
    const rows: string[] = [];
    let current = '';
    let quoted = false;
    for (let i = 0; i < text.length; i += 1) {
        const char = text[i];
        if (char === '"') {
            // `""` 는 셀 안의 따옴표 하나다.
            if (quoted && text[i + 1] === '"') {
                current += '""';
                i += 1;
                continue;
            }
            quoted = !quoted;
            current += char;
            continue;
        }
        if (!quoted && (char === '\n' || char === '\r')) {
            if (char === '\r' && text[i + 1] === '\n') i += 1;
            rows.push(current);
            current = '';
            continue;
        }
        current += char;
    }
    rows.push(current);
    return rows;
}

/** 셀 값에서 Excel 이 씌운 따옴표를 벗긴다. */
function unquoteCell(value: string): string {
    const trimmed = value.trim();
    if (trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"')) {
        return trimmed.slice(1, -1).replace(/""/g, '"');
    }
    return value;
}

/**
 * text/plain → 표 격자. 표로 보기 어려우면 null.
 *
 * 판정 규칙(오탐 방지):
 *   · 탭이 하나도 없으면 표가 아니다.
 *   · 행이 2개 이상이면서 **모든** 행에 탭이 있어야 한다(설명 문장 + 표 한 줄 같은
 *     혼합 텍스트를 통째로 표로 만들지 않는다).
 *   · 행이 1개뿐이면 열이 2개 이상이어야 한다.
 *   · 열 수가 행마다 다르면 최대 열 수에 맞춰 빈 셀로 채운다.
 */
export function parseTsvGrid(text?: string | null): TsvGrid | null {
    // 끝의 줄바꿈만 버린다. `\s+$` 로 지우면 마지막 행의 빈 셀(끝 탭)까지 사라져
    // "모든 행에 탭이 있는가" 판정이 뒤집힌다.
    const source = (text || '').replace(/[\r\n]+$/, '');
    if (!source || !source.includes('\t')) return null;

    const lines = splitTsvRows(source);
    // 마지막 빈 줄은 버린다(Excel 은 마지막 행 뒤에 줄바꿈을 붙인다).
    while (lines.length > 0 && lines[lines.length - 1].trim() === '') lines.pop();
    if (lines.length === 0) return null;

    if (lines.length > 1 && !lines.every((line) => line.includes('\t'))) return null;

    const rows = lines.map((line) => line.split('\t').map(unquoteCell));
    const columns = rows.reduce((max, row) => Math.max(max, row.length), 0);
    if (columns < 2) return null;
    if (rows.length === 1 && columns < 2) return null;

    return {
        rows: rows.map((row) => {
            const filled = row.slice(0, columns);
            while (filled.length < columns) filled.push('');
            return filled;
        }),
        columns,
    };
}

function escapeHtml(value: string): string {
    return value
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

/** 격자 → 편집기에 넣을 표 HTML(서식 없이 구조만). */
export function tsvGridToTableHtml(grid: TsvGrid): string {
    const rows = grid.rows.map((row) => {
        const cells = row
            .map((cell) => `<td>${escapeHtml(cell).replace(/\r?\n/g, '<br>') || '<br>'}</td>`)
            .join('');
        return `<tr>${cells}</tr>`;
    }).join('');
    return `<table><tbody>${rows}</tbody></table>`;
}

/** text/plain 이 표 모양이면 표 HTML 로, 아니면 null. */
export function tsvTextToTableHtml(text?: string | null): string | null {
    const grid = parseTsvGrid(text) || parseCsvGrid(text);
    return grid ? tsvGridToTableHtml(grid) : null;
}

/** CSV has values only. Require a rectangular multi-row source, not a lone comma. */
export function parseCsvGrid(text?: string | null): TsvGrid | null {
    if (!text?.includes(',') || !/[\r\n]/.test(text) || text.includes('\t')) return null;
    const parsed = Papa.parse<string[]>(text, { delimiter: ',', skipEmptyLines: true });
    const columns = parsed.data[0]?.length || 0;
    if (parsed.errors.length || parsed.data.length < 2 || columns < 2
        || !parsed.data.every(row => row.length === columns)) return null;
    return { rows: parsed.data, columns };
}
