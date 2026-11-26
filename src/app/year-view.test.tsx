import { readFileSync } from "node:fs";
import path from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, test } from "vitest";
import { initialState, reduce, type CheckAction, type CheckState } from "@/lib/check-machine";
import type { CheckEvent, YearResult } from "@/lib/result";
import { YearView } from "./year-view";

// The year sample as the real pipeline returned it in the 2026-11-26 test-set run: twelve statements, the price rising
// in August and a gateway charge appearing in October.
const run = JSON.parse(readFileSync(path.join(import.meta.dirname, "../../eval/run-2026-11-26.json"), "utf8")) as { raw: { id: string; events: CheckEvent[] }[] };
const event = run.raw.find((r) => r.id === "year-12")?.events.find((e) => e.type === "result");
const year = event?.type === "result" && event.result.outcome === "year" ? (event.result as YearResult) : null;

// The year page as the app shows it once the check finishes, through its own state machine, after any ticks the
// person changes.
function yearPage(actions: CheckAction[] = []): string {
  if (!year) throw new Error("the saved run has no year result");
  const running = { s: "running", inputs: initialState.inputs, attempts: 1, attempt: 1, stage: null, spentMicros: 0, live: {} } as unknown as CheckState;
  const done = actions.reduce(reduce, reduce(running, { type: "finished", attempt: 1, result: year }));
  if (done.s !== "done") throw new Error("the finished year did not become a done state");
  return renderToStaticMarkup(createElement(YearView, { state: done, result: year, dispatch: () => {} }));
}

test("unticking a month's claim takes it out of the total and the message, but not out of the month list", () => {
  if (!year) throw new Error("the saved run has no year result");
  const august = year.months.find((month) => month.result.outcome === "checked" && month.result.reading.period_start?.startsWith("2026-08"));
  if (!august || august.result.outcome !== "checked") throw new Error("the sample has no August statement");
  const html = yearPage(august.result.claims.map((claim) => ({ type: "toggle_claim", bill: august.bill, id: claim.id })));
  expect(html).toMatch(/>\$65\.00<\/p><h1[^>]*>to ask back from Bayline Fiber across 12 statements/);
  expect(html).not.toContain("In total, please credit $70.00");
  expect(html).not.toContain("For Aug 12, 2026 to Sep 11, 2026");
  expect(html).toContain("In total, please credit $65.00");
  expect(html).toContain("August 2026: $5.00 overcharged");
});

test("a duplicate, another account's bill and an unreadable one are named as not counted and left out of the total", () => {
  if (!year) throw new Error("the saved run has no year result");
  const august = year.months.find((month) => month.result.outcome === "checked" && month.result.reading.period_start?.startsWith("2026-08"));
  if (!august || august.result.outcome !== "checked") throw new Error("the sample has no August statement");
  const extra: YearResult = {
    ...year,
    months: [
      ...year.months,
      { bill: 12, result: august.result },
      { bill: 13, result: { ...august.result, reading: { ...august.result.reading, account_last4: "9999" } } },
      { bill: 14, result: { outcome: "could_not_check", reason: "The page image is entirely black.", spentMicros: 0 } },
    ],
  };
  const bills = Array.from({ length: 15 }, (_, i) => ({ id: `b${i}`, name: i === 14 ? "december.jpg" : `bill-${i + 1}.pdf`, status: "preparing" as const }));
  const running = { s: "running", inputs: { ...initialState.inputs, bills }, attempts: 1, attempt: 1, stage: null, spentMicros: 0, live: {} } as unknown as CheckState;
  const done = reduce(running, { type: "finished", attempt: 1, result: extra });
  if (done.s !== "done") throw new Error("the finished year did not become a done state");
  const html = renderToStaticMarkup(createElement(YearView, { state: done, result: extra, dispatch: () => {} }));
  expect(html).toContain("Not counted: december.jpg couldn&#x27;t be read, 1 duplicate statement, 1 from another account");
  expect(html).toMatch(/>\$70\.00<\/p><h1[^>]*>to ask back from Bayline Fiber across 12 statements/);
  expect([...html.matchAll(/aria-label="August 2026: /g)]).toHaveLength(1);
});

test("a statement whose account number couldn't be read counts with the year's account, and the message keeps the number", () => {
  if (!year) throw new Error("the saved run has no year result");
  const august = year.months.find((month) => month.result.outcome === "checked" && month.result.reading.period_start?.startsWith("2026-08"));
  if (!august || august.result.outcome !== "checked") throw new Error("the sample has no August statement");
  const unread = { ...august.result, reading: { ...august.result.reading, account_last4: null } };
  const blurred: YearResult = { ...year, months: year.months.map((month) => (month.bill === august.bill ? { ...month, result: unread } : month)) };
  const running = { s: "running", inputs: initialState.inputs, attempts: 1, attempt: 1, stage: null, spentMicros: 0, live: {} } as unknown as CheckState;
  const done = reduce(running, { type: "finished", attempt: 1, result: blurred });
  if (done.s !== "done") throw new Error("the finished year did not become a done state");
  const html = renderToStaticMarkup(createElement(YearView, { state: done, result: blurred, dispatch: () => {} }));
  expect(html).toMatch(/>\$70\.00<\/p><h1[^>]*>to ask back from Bayline Fiber across 12 statements/);
  expect(html).not.toContain("another account");
  expect(html).toContain("In total, please credit $70.00 to account ending 4415.");
});

test("a year with nothing owed shows no $0.00, and says plainly when there was no offer to check against", () => {
  if (!year) throw new Error("the saved run has no year result");
  const clean = (hadOffer: boolean): YearResult => ({ ...year, months: year.months.map((month) => (month.result.outcome === "checked" ? { ...month, result: { ...month.result, claims: [], hadOffer, promises: hadOffer ? month.result.promises : [], matchedPromiseIds: hadOffer ? month.result.matchedPromiseIds : [] } } : month)) });
  const render = (result: YearResult) => {
    const running = { s: "running", inputs: initialState.inputs, attempts: 1, attempt: 1, stage: null, spentMicros: 0, live: {} } as unknown as CheckState;
    const done = reduce(running, { type: "finished", attempt: 1, result });
    if (done.s !== "done") throw new Error("the finished year did not become a done state");
    return renderToStaticMarkup(createElement(YearView, { state: done, result, dispatch: () => {} }));
  };
  const matched = render(clean(true));
  expect(matched).toContain(">All 12 statements match the offer</h1>");
  expect(matched).not.toContain("$0.00");
  const noOffer = render(clean(false));
  expect(noOffer).toContain(">Read 12 statements; there was no offer to check them against</h1>");
  expect(noOffer).not.toContain("match the offer");
  expect(noOffer).not.toContain("matches the offer");
  expect(noOffer).toContain("August 2026: no offer to compare");
});

test("a year of statements is headed with its total and the month the overcharge began", () => {
  const html = yearPage();
  expect(html).toContain("$70.00");
  expect(html).toContain("to ask back from Bayline Fiber across 12 statements");
  expect(html).toContain("Overcharged from August 2026");
});

test("a month whose date was misread is labeled as written, never 'undefined'", () => {
  if (!year) throw new Error("the saved run has no year result");
  const misread: YearResult = { ...year, months: year.months.map((month, i) => (i === 0 && month.result.outcome === "checked" ? { ...month, result: { ...month.result, reading: { ...month.result.reading, period_start: "2026-13-12" } } } : month)) };
  const running = { s: "running", inputs: initialState.inputs, attempts: 1, attempt: 1, stage: null, spentMicros: 0, live: {} } as unknown as CheckState;
  const done = reduce(running, { type: "finished", attempt: 1, result: misread });
  if (done.s !== "done") throw new Error("the finished year did not become a done state");
  const html = renderToStaticMarkup(createElement(YearView, { state: done, result: misread, dispatch: () => {} }));
  expect(html).toContain('aria-label="2026-13-12: ');
  expect(html).not.toContain("undefined");
});

test("each month is listed in order with what it overcharged, adding up to the year's total", () => {
  const months = [...yearPage().matchAll(/aria-label="([^"]*(?:overcharged|matches the offer))"/g)].map((m) => m[1]);
  expect(months).toEqual([
    "December 2025: matches the offer",
    "January 2026: matches the offer",
    "February 2026: matches the offer",
    "March 2026: matches the offer",
    "April 2026: matches the offer",
    "May 2026: matches the offer",
    "June 2026: matches the offer",
    "July 2026: matches the offer",
    "August 2026: $5.00 overcharged",
    "September 2026: $5.00 overcharged",
    "October 2026: $30.00 overcharged",
    "November 2026: $30.00 overcharged",
  ]);
});
