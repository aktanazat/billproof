import type { TextContent } from "pdfjs-dist/types/src/display/api";
import { expect, test } from "vitest";
import { pageText } from "./pdf-text";

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
