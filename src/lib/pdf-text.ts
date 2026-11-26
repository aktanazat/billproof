import type { PageViewport } from "pdfjs-dist";
import type { TextContent, TextItem } from "pdfjs-dist/types/src/display/api";

// One printed row of a PDF page, positioned on the same 0-1000 grid as Muse Ember's boxes.
export type TextRow = { text: string; box: { x0: number; y0: number; x1: number; y1: number } };

const SAME_ROW = 4;

// Groups a page's text items into printed rows by baseline. Rows let the page mark the exact printed line a
// charge came from, where the model's own box can be off by a row.
export function pageRows(content: TextContent, viewport: PageViewport): TextRow[] {
  const cells = content.items.flatMap((item) => {
    if (!("str" in item) || !item.str.trim()) return [];
    const [x, y] = viewport.convertToViewportPoint(item.transform[4], item.transform[5]);
    const left = (x / viewport.width) * 1000;
    const base = (y / viewport.height) * 1000;
    return [{ text: item.str, x0: left, x1: left + (item.width / viewport.width) * 1000, top: base - (item.height / viewport.height) * 1000, base }];
  });
  cells.sort((a, b) => a.base - b.base || a.x0 - b.x0);
  const rows: (typeof cells)[] = [];
  for (const cell of cells) {
    const row = rows.at(-1);
    if (row && Math.abs(row[0].base - cell.base) < SAME_ROW) row.push(cell);
    else rows.push([cell]);
  }
  return rows.map((row) => {
    row.sort((a, b) => a.x0 - b.x0);
    return {
      text: row.map((cell) => cell.text).join(" "),
      box: { x0: Math.min(...row.map((c) => c.x0)), x1: Math.max(...row.map((c) => c.x1)), y0: Math.min(...row.map((c) => c.top)), y1: Math.max(...row.map((c) => c.base)) + 2 },
    };
  });
}

// Joins a page's text items into lines the way they were drawn. Quotes are later matched against this text
// with reorder tolerance, so cell order inside a table row does not need to follow the visual order. An item that
// starts where the one before it ends on the same baseline continues it: pdf.js starts a new item where the font
// changes, even inside a word, and puts its own space item across a real gap.
export function pageText(content: TextContent): string {
  let text = "";
  let end: { x: number; y: number } | null = null;
  for (const item of content.items) {
    if (!("str" in item)) continue;
    const textItem: TextItem = item;
    const [x, y] = [textItem.transform[4], textItem.transform[5]];
    if (end && text.endsWith(" ") && Math.abs(end.y - y) < 0.5 && Math.abs(end.x - x) < 0.5 && /\S$/.test(text.slice(0, -1)) && /^\S/.test(textItem.str)) text = text.slice(0, -1);
    text += textItem.str;
    text += textItem.hasEOL ? "\n" : " ";
    end = textItem.hasEOL ? null : { x: x + textItem.width, y };
  }
  return text.replace(/[ \t]+/g, " ").replace(/ ?\n ?/g, "\n").trim();
}
