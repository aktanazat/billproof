import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, test } from "vitest";
import { Checker, type Sample } from "./checker";
import { formatClock, inPlainWords } from "./evidence";

// HTML lets a button hold only inline content; a block inside one is invalid markup, which browsers repair in their own
// ways and some assistive technology reads poorly. The start screen's samples, made up and real, are buttons.
test("no button on the start screen holds block content", () => {
  const madeUp: Sample = { id: "internet-guaranteed", title: "Internet, price guaranteed", outcome: "$30.00 to ask back", image: "/samples/internet-guaranteed.jpg", bills: ["/samples/internet-guaranteed.pdf"], offer: { kind: "text", text: "$55 a month" } };
  const real: Sample = { id: "1wen4kx", title: "Help with Trade in", outcome: "$10.40 in fees nobody agreed to", image: "/api/real-image/1wen4kx/0", bills: [], pictures: ["/api/real-image/1wen4kx/0"], offer: { kind: "text", text: "" } };
  const html = renderToStaticMarkup(createElement(Checker, { samples: [madeUp], realSamples: [real], startWith: null }));
  const buttons = [...html.matchAll(/<button\b[^>]*>([\s\S]*?)<\/button>/g)].map((m) => m[1]);
  expect(buttons.length).toBeGreaterThanOrEqual(2);
  expect(buttons.filter((inner) => /<(div|p|section|ul|ol|li|h[1-6]|table)\b/.test(inner))).toEqual([]);
});

// A moment in a call (a play button's "0:11", a transcript line, a recording's length) reads as minutes and two-digit
// seconds, at the second it falls in.
test("a moment in a call reads as minutes and two-digit seconds", () => {
  expect([9, 11.8, 71, 240, -2].map(formatClock)).toEqual(["0:09", "0:11", "1:11", "4:00", "0:00"]);
});

// Muse Ember's thinking summary, shown while a check runs, names fields of the reading format in 14 of the 93 saved
// summaries ("applies_from"); a visitor reads plain words.
test("a thinking summary shows plain words for the reading format's field names", () => {
  expect(inPlainWords("Resolving applies_from by inferring the start date from the order date while keeping applies_until explicit.")).toBe("Resolving start date by inferring the start date from the order date while keeping end date explicit.");
  expect(inPlainWords("Checking section_totals against total_due.")).toBe("Checking section totals against total due.");
  expect(inPlainWords("Reading the bill's charges.")).toBe("Reading the bill's charges.");
});

// 111 of the 470 saved summaries call the reading format by its technical name ("JSON schema"), which means nothing
// to most people watching a check.
test("a thinking summary calls the reading format by a plain name, not 'JSON schema'", () => {
  expect(inPlainWords("Extracting billing fields from printed text and mapping them to JSON schema with quoted exact values.")).toBe("Extracting billing fields from printed text and mapping them to the reading format with quoted exact values.");
  expect(inPlainWords("Extracting concrete pricing and service promises from the bill and order document to populate the required JSON schema fields.")).toBe("Extracting concrete pricing and service promises from the bill and order document to populate the reading format.");
  expect(inPlainWords("Extracting bill fields to JSON and mapping payments as a positive integer in cents per schema.")).toBe("Extracting bill fields to the reading format and mapping payments as a positive integer in cents, as the format asks.");
});
