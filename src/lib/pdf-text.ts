import type { TextContent, TextItem } from "pdfjs-dist/types/src/display/api";

// Joins a page's text items into lines the way they were drawn. Quotes are later matched against this text
// with reorder tolerance, so cell order inside a table row does not need to follow the visual order.
export function pageText(content: TextContent): string {
  let text = "";
  for (const item of content.items) {
    if (!("str" in item)) continue;
    const textItem: TextItem = item;
    text += textItem.str;
    text += textItem.hasEOL ? "\n" : " ";
  }
  return text.replace(/[ \t]+/g, " ").replace(/ ?\n ?/g, "\n").trim();
}
