import { readFileSync } from "node:fs";
import path from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, test } from "vitest";
import { initialState, reduce, type CheckState } from "@/lib/check-machine";
import type { CheckEvent, YearResult } from "@/lib/result";
import { YearView } from "./year-view";

// The year sample as the real pipeline returned it in the 2026-11-26 test-set run: twelve statements, the price rising
// in August and a gateway charge appearing in October.
const run = JSON.parse(readFileSync(path.join(import.meta.dirname, "../../eval/run-2026-11-26.json"), "utf8")) as { raw: { id: string; events: CheckEvent[] }[] };
const event = run.raw.find((r) => r.id === "year-12")?.events.find((e) => e.type === "result");
const year = event?.type === "result" && event.result.outcome === "year" ? (event.result as YearResult) : null;

// The year page as the app shows it once the check finishes, through its own state machine.
function yearPage(): string {
  if (!year) throw new Error("the saved run has no year result");
  const running = { s: "running", inputs: initialState.inputs, attempts: 1, attempt: 1, stage: null, spentMicros: 0, live: {} } as unknown as CheckState;
  const done = reduce(running, { type: "finished", attempt: 1, result: year });
  if (done.s !== "done") throw new Error("the finished year did not become a done state");
  return renderToStaticMarkup(createElement(YearView, { state: done, result: year, dispatch: () => {} }));
}

test("a year of statements is headed with its total and the month the overcharge began", () => {
  const html = yearPage();
  expect(html).toContain("$70.00");
  expect(html).toContain("to ask back from Bayline Fiber across 12 statements");
  expect(html).toContain("Overcharged from August 2026");
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
