import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { openLedger } from "./ledger";
import { heardWithin, runCheck } from "./pipeline";
import type { CheckEvent } from "./result";

// With no model key set, the first call to Muse Ember fails before any request leaves the server, so this runs a real
// check to its failure at no cost.
const key = process.env.MODEL_API_KEY;
beforeEach(() => {
  delete process.env.MODEL_API_KEY;
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  if (key !== undefined) process.env.MODEL_API_KEY = key;
  vi.restoreAllMocks();
});

test("a failed check tells the person what happened in plain words, never the server's internals", async () => {
  const events: CheckEvent[] = [];
  const pixel = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";
  await runCheck({ bills: [{ pages: [{ image: pixel, text: null }] }], offer: { kind: "text", text: "$55 a month" } }, { ledger: openLedger(":memory:", 1_000_000), client: "test", signal: new AbortController().signal, emit: (event) => events.push(event) });
  const failure = events.find((event) => event.type === "error");
  expect(failure).toMatchObject({ type: "error", failure: "config", message: "Billproof can't reach Muse Ember right now.", retryable: false });
  expect(console.error).toHaveBeenCalledWith("check failed:", expect.objectContaining({ message: "MODEL_API_KEY is not set on the server" }));
});

// Once the demo's budget can't cover one more check, the page already says checks are paused; a check started anyway
// is refused for that reason before anything is sent to Muse Ember, so a Muse Ember failure can't take its place.
test("a check started after the demo's budget is used says so, before Muse Ember is reached", async () => {
  const events: CheckEvent[] = [];
  const pixel = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";
  await runCheck({ bills: [{ pages: [{ image: pixel, text: null }] }], offer: { kind: "text", text: "$55 a month" } }, { ledger: openLedger(":memory:", 1_000), client: "test", signal: new AbortController().signal, emit: (event) => events.push(event) });
  expect(events).toEqual([{ type: "error", failure: "budget_spent", message: "This demo has used its budget for live checks. Every saved result is still on the Real bills page.", spentMicros: 0, retryable: false }]);
  expect(console.error).not.toHaveBeenCalled();
});

// The site builds the ledger's module twice, once for its pages and once for checks, and the one ledger they share
// comes from whichever loaded first, so a check meets refusals made by the other copy. Each keeps its own reason
// rather than being taken for a dropped connection that invites a retry.
test("a refusal from the ledger keeps its reason when the ledger comes from another copy of its module", async () => {
  vi.resetModules();
  const otherCopy = await import("./ledger");
  const events: CheckEvent[] = [];
  const pixel = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";
  await runCheck({ bills: [{ pages: [{ image: pixel, text: null }] }], offer: { kind: "text", text: "$55 a month" } }, { ledger: otherCopy.openLedger(":memory:", 1_000), client: "test", signal: new AbortController().signal, emit: (event) => events.push(event) });
  expect(events).toEqual([{ type: "error", failure: "budget_spent", message: "This demo has used its budget for live checks. Every saved result is still on the Real bills page.", spentMicros: 0, retryable: false }]);
});

test("a promise keeps its moment on the call only when that moment is inside the recording", () => {
  expect(heardWithin(11, 30)).toBe(11);
  expect(heardWithin(30, 30)).toBe(30);
  // Past the end or before the start, the message would cite a moment nobody can play.
  expect(heardWithin(400, 30)).toBeNull();
  expect(heardWithin(-2, 30)).toBeNull();
  // A written offer has no recording, so a time there is invented.
  expect(heardWithin(11, null)).toBeNull();
  expect(heardWithin(null, 30)).toBeNull();
});
