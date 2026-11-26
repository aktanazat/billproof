import { expect, test } from "vitest";
import { openLedger, type Ledger } from "@/lib/ledger";

// The routes share one ledger through this global; a nearly empty one stands for a demo whose budget is used.
(globalThis as typeof globalThis & { billproofLedger?: Ledger }).billproofLedger = openLedger(":memory:", 1_000);
const { POST } = await import("./route");

// A page loaded before the budget ran out still shows the button. Pressing it is refused with the reason, before the
// visitor's one run an hour is used and before 24 posts' pictures are fetched for checks that can't run.
test("a live run asked for after the demo's budget is used is refused with that reason, and nothing starts", async () => {
  const abort = new AbortController();
  const response = await POST(new Request("https://billproof.aktan.us/api/real-run", { method: "POST", headers: { "Sec-Fetch-Site": "same-origin" }, signal: abort.signal }));
  const reader = response.body!.pipeThrough(new TextDecoderStream()).getReader();
  const { value } = await reader.read();
  abort.abort();
  await reader.cancel();
  expect(JSON.parse((value ?? "").split("\n")[0])).toEqual({ type: "refused", message: "Live checks are paused: this demo has used its budget. Every saved result is below." });
  expect(response.status).toBe(503);
});
