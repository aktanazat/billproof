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
