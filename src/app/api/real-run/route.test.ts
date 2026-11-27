import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { openLedger, type Ledger } from "@/lib/ledger";
import type { LiveEvent } from "@/lib/real-bills";

// Posts' pictures come from Reddit; here each post has one ready picture, so a run needs no network.
vi.mock("@/data/real-pages", () => ({
  postPages: async () => ({ pages: [{ image: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=", text: null }], positions: [0] }),
}));
// Checks run for real unless a test makes them report a cost.
vi.mock("@/lib/pipeline", async (actual) => {
  const pipeline = await actual<typeof import("@/lib/pipeline")>();
  return { ...pipeline, runCheck: vi.fn(pipeline.runCheck) };
});
const { runCheck } = await import("@/lib/pipeline");
const { POST } = await import("./route");

// The routes share one ledger through this global.
const useLedger = (budgetMicros: number) => {
  (globalThis as typeof globalThis & { billproofLedger?: Ledger }).billproofLedger = openLedger(":memory:", budgetMicros);
};

// With no model key, every check stops before anything is sent to Muse Ember, at no cost.
const key = process.env.MODEL_API_KEY;
beforeEach(() => {
  delete process.env.MODEL_API_KEY;
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  if (key !== undefined) process.env.MODEL_API_KEY = key;
  vi.restoreAllMocks();
});

const run = async (visitor: string): Promise<LiveEvent[]> => {
  const response = await POST(new Request("https://billproof.aktan.us/api/real-run", { method: "POST", headers: { "Sec-Fetch-Site": "same-origin", "X-Forwarded-For": visitor } }));
  return (await response.text()).trim().split("\n").map((line) => JSON.parse(line) as LiveEvent);
};

// A page loaded before the budget ran out still shows the button. Pressing it is refused with the reason, before the
// visitor's one run an hour is used and before 24 posts' pictures are fetched for checks that can't run.
test("a live run asked for after the demo's budget is used is refused with that reason, and nothing starts", async () => {
  useLedger(1_000);
  const abort = new AbortController();
  const response = await POST(new Request("https://billproof.aktan.us/api/real-run", { method: "POST", headers: { "Sec-Fetch-Site": "same-origin" }, signal: abort.signal }));
  const reader = response.body!.pipeThrough(new TextDecoderStream()).getReader();
  const { value } = await reader.read();
  abort.abort();
  await reader.cancel();
  expect(JSON.parse((value ?? "").split("\n")[0])).toEqual({ type: "refused", message: "Live checks are paused: this demo has used its budget. Every saved result is below." });
  expect(response.status).toBe(503);
});

// The hourly limits bound spending. A run whose every check failed before costing anything (Meta down or busy) used
// none, so it doesn't take the visitor's run for the hour or one of the site's runs.
test("a live run that spent nothing leaves the visitor and the site free to run again", async () => {
  useLedger(1_000_000);
  const first = await run("203.0.113.7");
  expect(first.at(-1)).toMatchObject({ type: "done", spentMicros: 0 });
  expect((await run("203.0.113.7"))[0]).toMatchObject({ type: "batch" });
  for (let n = 0; n < 7; n++) expect((await run(`203.0.113.${20 + n}`))[0], `visitor ${n}`).toMatchObject({ type: "batch" });
});

test("a live run that spent anything still takes the visitor's run for the hour", async () => {
  useLedger(1_000_000);
  vi.mocked(runCheck).mockImplementation(async (_input, deps) => deps.emit({ type: "error", failure: "network", message: "The connection to Muse Ember dropped. Try again.", spentMicros: 40, retryable: true }));
  expect((await run("203.0.113.50")).at(-1)).toMatchObject({ type: "done", spentMicros: 24 * 40 });
  expect(await run("203.0.113.50")).toEqual([{ type: "refused", message: "You can start one live run an hour. Try again in 60 minutes." }]);
});

// The first event a run answers with, without waiting for the run itself.
const firstEvent = async (visitor: string, site = "same-origin"): Promise<{ status: number; event: LiveEvent }> => {
  const response = await POST(new Request("https://billproof.aktan.us/api/real-run", { method: "POST", headers: { "Sec-Fetch-Site": site, "X-Forwarded-For": visitor } }));
  const reader = response.body!.pipeThrough(new TextDecoderStream()).getReader();
  const { value } = await reader.read();
  await reader.cancel();
  return { status: response.status, event: JSON.parse((value ?? "").split("\n")[0]) as LiveEvent };
};

// A run is 24 paid checks: another site's page could otherwise start them from its visitors' browsers.
test("a live run can be started only from Billproof's own page", async () => {
  useLedger(1_000_000);
  expect(await firstEvent("203.0.113.60", "cross-site")).toEqual({ status: 403, event: { type: "refused", message: "Start a live run from the Billproof page." } });
});

// Two runs at once would check the same posts twice, at twice the cost; the second waits for the first.
test("while a live run is going, another visitor's run is refused until it ends", async () => {
  useLedger(1_000_000);
  let finish = () => {};
  const held = new Promise<void>((resolve) => {
    finish = resolve;
  });
  vi.mocked(runCheck).mockImplementation(() => held);
  const first = await POST(new Request("https://billproof.aktan.us/api/real-run", { method: "POST", headers: { "Sec-Fetch-Site": "same-origin", "X-Forwarded-For": "203.0.113.61" } }));
  expect((await firstEvent("203.0.113.62")).event).toEqual({ type: "refused", message: "A live run is already going. Try again in a minute." });
  finish();
  await first.text();
});

// Each visitor gets one run an hour, so the site's own cap is what bounds many visitors together. Last in the file: it
// uses up the site's runs for the hour.
test("after six live runs that spent money this hour, a new visitor is told to come back later", async () => {
  useLedger(1_000_000);
  vi.mocked(runCheck).mockImplementation(async (_input, deps) => deps.emit({ type: "error", failure: "network", message: "The connection to Muse Ember dropped. Try again.", spentMicros: 40, retryable: true }));
  const answers: LiveEvent[] = [];
  for (let n = 0; n < 7; n++) answers.push((await run(`203.0.113.${70 + n}`))[0]);
  const refused = answers.filter((event) => event.type === "refused");
  expect(refused.length).toBeGreaterThan(0);
  expect(refused[0]).toMatchObject({ message: expect.stringMatching(/^The live run has been used a lot this hour\. Try again in \d+ minutes?\.$/) });
});
