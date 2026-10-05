// Read data tables from the page (including shadow DOM and same-origin
// frames) as plain rows, so the agent can return them and the person can
// download them as CSV.
import { collectRoots, isHtmlElement, queryAllDeep } from "./page-roots";

export interface ExtractedTable {
  index: number;
  caption: string;
  headers: string[];
  rows: string[][];
  row_count: number;
  truncated: boolean;
}

const MAX_TABLES = 10;
const MAX_ROWS = 300;
const MAX_COLUMNS = 30;
const MAX_CELL = 300;

function cellText(cell: Element): string {
  const text = isHtmlElement(cell) ? cell.innerText : cell.textContent || "";
  return text.replace(/\s+/g, " ").trim().slice(0, MAX_CELL);
}

function rowsOf(table: Element): Element[] {
  return Array.from(table.querySelectorAll('tr, [role="row"]')).filter(
    // Rows of a nested table belong to that table.
    (row) => row.closest('table, [role="table"], [role="grid"], [role="treegrid"]') === table
  );
}

function cellsOf(row: Element): Element[] {
  return Array.from(
    row.querySelectorAll('th, td, [role="cell"], [role="gridcell"], [role="columnheader"], [role="rowheader"]')
  )
    .filter((cell) => cell.closest('tr, [role="row"]') === row)
    .slice(0, MAX_COLUMNS);
}

function isHeaderRow(row: Element, cells: Element[]): boolean {
  return (
    row.closest("thead") !== null ||
    (cells.length > 0 &&
      cells.every((cell) => cell.tagName === "TH" || cell.getAttribute("role") === "columnheader"))
  );
}

export function extractTables(maxTables = MAX_TABLES): ExtractedTable[] {
  const found = queryAllDeep<Element>(
    'table, [role="table"], [role="grid"], [role="treegrid"]',
    collectRoots()
  )
    .map(({ element }) => element)
    .filter((table) => !isHtmlElement(table) || table.offsetParent !== null || table.getClientRects().length > 0);

  const tables: ExtractedTable[] = [];
  for (const table of found) {
    const rowElements = rowsOf(table);
    let headers: string[] = [];
    const rows: string[][] = [];
    for (const row of rowElements) {
      const cells = cellsOf(row);
      if (!cells.length) continue;
      const values = cells.map(cellText);
      if (!headers.length && !rows.length && isHeaderRow(row, cells)) {
        headers = values;
      } else {
        rows.push(values);
      }
    }
    // Layout tables (one column, or no real data) are not data tables.
    const width = Math.max(headers.length, ...rows.map((row) => row.length), 0);
    if (rows.length === 0 || width < 2) continue;
    const caption =
      table.querySelector("caption")?.textContent?.trim() ||
      table.getAttribute("aria-label") ||
      "";
    tables.push({
      index: tables.length + 1,
      caption: caption.slice(0, 200),
      headers,
      rows: rows.slice(0, MAX_ROWS),
      row_count: rows.length,
      truncated: rows.length > MAX_ROWS
    });
    if (tables.length >= maxTables) break;
  }
  return tables;
}
