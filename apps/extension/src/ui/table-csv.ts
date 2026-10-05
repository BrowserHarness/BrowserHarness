// Tables in an answer, turned into CSV files the person can download.
import { splitTableRow, TABLE_SEPARATOR } from "../runtime/markdown";

export interface SimpleTable {
  headers: string[];
  rows: string[][];
}

function plainCell(cell: string): string {
  return cell
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/\*([^*]+)\*/g, "$1")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, "$1 ($2)")
    .replace(/<br\s*\/?>/gi, " ")
    .trim();
}

/** Every GitHub-style markdown table in the text. */
export function markdownTables(text: string): SimpleTable[] {
  const lines = text.split(/\r?\n/);
  const tables: SimpleTable[] = [];
  for (let index = 0; index + 1 < lines.length; index += 1) {
    if (!lines[index].includes("|") || !TABLE_SEPARATOR.test(lines[index + 1])) continue;
    const headers = splitTableRow(lines[index]).map(plainCell);
    const rows: string[][] = [];
    let cursor = index + 2;
    while (cursor < lines.length && lines[cursor].includes("|") && lines[cursor].trim()) {
      rows.push(splitTableRow(lines[cursor]).map(plainCell));
      cursor += 1;
    }
    if (headers.length >= 2 && rows.length) tables.push({ headers, rows });
    index = cursor - 1;
  }
  return tables;
}

function csvCell(value: string): string {
  // Leading = + - @ would run as a formula in spreadsheet apps.
  const safe = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
  return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

export function toCsv(table: SimpleTable): string {
  return [table.headers, ...table.rows]
    .map((row) => row.map((cell) => csvCell(cell ?? "")).join(","))
    .join("\r\n");
}

export function downloadCsv(table: SimpleTable, filename: string): void {
  // The byte-order mark makes Excel read the file as UTF-8 (₹, é, 中文).
  const blob = new Blob(["﻿", toCsv(table)], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
