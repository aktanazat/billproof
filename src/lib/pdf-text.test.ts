import type { TextContent } from "pdfjs-dist/types/src/display/api";
import { expect, test } from "vitest";
import { pageRows, pageText } from "./pdf-text";

// Items as pdf.js returned them for a hand-built page, with their x, baseline and width.
const item = (str: string, x: number, width: number, hasEOL = false) => ({ str, dir: "ltr", width, height: 12, transform: [12, 0, 0, 12, x, 700], fontName: "F1", hasEOL });
const page = (...items: ReturnType<typeof item>[]) => ({ items, styles: {}, lang: null }) as unknown as TextContent;

// pdf.js starts a new item where the font changes, even inside a word ("Fib" then "er 500"); a space put between them
// split the word, and no quote of the line matched the bill's text.
test("a word whose font changes partway reads as one word", () => {
  expect(pageText(page(item("Fib", 72, 16.67), item("er 500 Internet $70.00", 88.67, 122.06)))).toBe("Fiber 500 Internet $70.00");
});

// Between table columns pdf.js puts its own space item across the gap; the words on either side stay apart.
test("cells in separate table columns stay separate words", () => {
  expect(pageText(page(item("Fiber 500 Internet", 72, 94.72), item(" ", 166.72, 233.28), item("$70.00", 400, 36.7)))).toBe("Fiber 500 Internet $70.00");
  expect(pageText(page(item("Fiber 500 Internet", 72, 94.72), item("$70.00", 400, 36.7)))).toBe("Fiber 500 Internet $70.00");
});

// Rows place a charge's mark on its printed line by finding the line's name in a row; "Fib er" hid it, and the mark
// fell back to the model's own box, which can be a row off.
test("a printed row keeps a word whole when its font changes partway, and table columns apart", () => {
  const viewport = { width: 612, height: 792, convertToViewportPoint: (x: number, y: number) => [x, 792 - y] } as unknown as Parameters<typeof pageRows>[1];
  expect(pageRows(page(item("Fib", 72, 16.67), item("er 500 Internet $70.00", 88.67, 122.06)), viewport).map((row) => row.text)).toEqual(["Fiber 500 Internet $70.00"]);
  expect(pageRows(page(item("Fiber 500 Internet", 72, 94.72), item("$70.00", 400, 36.7)), viewport).map((row) => row.text)).toEqual(["Fiber 500 Internet $70.00"]);
});
