import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, test } from "vitest";
import RealBills from "./page";

// The real-bills page as built from the saved run, reduced to its text.
const text = renderToStaticMarkup(createElement(RealBills))
  .replace(/<[^>]+>/g, "\n")
  .replace(/&amp;/g, "&")
  .replace(/&#x27;/g, "'")
  .split("\n")
  .map((part) => part.trim())
  .filter(Boolean);

test("counts of a thousand or more are written with a comma", () => {
  const unformatted = text.filter((part) => /(^|\s)\d{4,} (posts|bills)\b/.test(part));
  expect(unformatted).toEqual([]);
});

test("no question on a bill names the same line twice in a row", () => {
  const asked = text.filter((part) => part.startsWith("Worth asking about:") || /^[^:]+$/.test(part)).join("\n");
  const repeats = [...asked.matchAll(/(?:^|, )([^,\n]{4,}), \1(?=,|$|\n)/gm)].map((m) => m[1]);
  expect(repeats).toEqual([]);
});

test("one of something is never written with a plural", () => {
  expect(text.filter((part) => /\b1 (bills|charges|posts|times|lines)\b/.test(part))).toEqual([]);
});
