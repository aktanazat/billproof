import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { z } from "zod";
import { buildRequest, EmberError, send, type EmberDelta } from "./ember";

// Meta's streamed answers as the Responses API sends them, through a stand-in for the network: nothing reaches Meta.
const call = buildRequest({ name: "read_bill", instructions: "Read the bill.", parts: [{ type: "text", text: "bill" }], schema: z.object({ total: z.number() }), effort: "high", maxOutputTokens: 1000 });
const usage = { input_tokens: 1200, output_tokens: 300, input_tokens_details: { cached_tokens: 1000 } };
const final = (status: string, content: object[], incomplete: string | null = null) => ({ status, incomplete_details: incomplete ? { reason: incomplete } : null, output: [{ type: "message", content }], usage });
const events = (...data: (object | string)[]) => data.map((d) => `data: ${typeof d === "string" ? d : JSON.stringify(d)}\n\n`).join("");
const answer = (body: string | null, init: ResponseInit = {}) => vi.stubGlobal("fetch", vi.fn(async () => new Response(body, init)));
const failure = async (onDelta: (delta: EmberDelta) => void = () => {}) => {
  const error = await send(call, AbortSignal.timeout(5_000), onDelta).catch((e: unknown) => e);
  if (!(error instanceof EmberError)) throw new Error(`expected a Muse Ember failure, got ${String(error)}`);
  return error;
};

const key = process.env.MODEL_API_KEY;
beforeEach(() => {
  process.env.MODEL_API_KEY = "test-key";
});
afterEach(() => {
  vi.unstubAllGlobals();
  if (key === undefined) delete process.env.MODEL_API_KEY;
  else process.env.MODEL_API_KEY = key;
});

test("an answer streams its reasoning summary and output, and returns what it read and cost", async () => {
  answer(
    events(
      { type: "response.reasoning_summary_part.added" },
      { type: "response.reasoning_summary_text.delta", delta: "Reading the charges." },
      { type: "response.reasoning_summary_part.added" },
      { type: "response.reasoning_summary_text.delta", delta: "Adding them up." },
      { type: "keepalive" },
      { note: "an event without a type" },
      { type: "response.output_text.delta", delta: '{"total":' },
      { type: "response.output_text.delta", delta: "9249}" },
      { type: "response.completed", response: final("completed", [{ type: "output_text", text: '{"total":9249}' }]) },
      "[DONE]",
    ),
  );
  const deltas: EmberDelta[] = [];
  const result = await send(call, AbortSignal.timeout(5_000), (delta) => deltas.push(delta));
  expect(result.output).toEqual({ total: 9249 });
  expect(result.usage).toEqual({ inputTokens: 1200, cachedTokens: 1000, outputTokens: 300 });
  expect(result.costMicros).toBeGreaterThan(0);
  // Summary parts are separated, so the person watching sees two paragraphs, not one run-on sentence.
  expect(deltas.filter((d) => d.kind === "thinking").map((d) => d.text).join("")).toBe("Reading the charges.\n\nAdding them up.");
  expect(deltas.filter((d) => d.kind === "output").map((d) => d.text).join("")).toBe('{"total":9249}');
});

// Asking again gets the same refusal and is paid for again, so a refusal is told as declined, never "Try again".
test("a refused answer is a refusal, with what it cost", async () => {
  answer(events({ type: "response.completed", response: final("completed", [{ type: "refusal", refusal: "I can't help with that." }]) }));
  const error = await failure();
  expect(error.kind).toBe("refused");
  expect(error.billedMicros).toBeGreaterThan(0);
});

// A bill too long to read in one go is told to use the pages with the charges, not to pay for the same cut-off again.
test("an answer cut off before it finished is too long, not a broken answer, with what it cost", async () => {
  answer(events({ type: "response.incomplete", response: final("incomplete", [{ type: "output_text", text: '{"tot' }], "max_output_tokens") }));
  const error = await failure();
  expect(error.kind).toBe("truncated");
  expect(error.billedMicros).toBeGreaterThan(0);
});

test("an answer Meta marks failed is a problem on Meta's side, with what it cost", async () => {
  answer(events({ type: "response.failed", response: final("failed", []) }));
  const error = await failure();
  expect(error.kind).toBe("upstream");
  expect(error.billedMicros).toBeGreaterThan(0);
});

test("an answer that isn't JSON, or doesn't fit the form, is an incomplete answer worth retrying, with what it cost", async () => {
  answer(events({ type: "response.completed", response: final("completed", [{ type: "output_text", text: "The total is $92.49." }]) }));
  const notJson = await failure();
  answer(events({ type: "response.completed", response: final("completed", [{ type: "output_text", text: '{"total":"ninety"}' }]) }));
  const wrongForm = await failure();
  expect([notJson.kind, wrongForm.kind]).toEqual(["invalid_output", "invalid_output"]);
  expect(notJson.billedMicros).toBeGreaterThan(0);
  expect(wrongForm.billedMicros).toBeGreaterThan(0);
});

// Muse Ember is busy: the person is told when to try again.
test("a busy answer is rate limited and carries when to try again", async () => {
  answer("slow down", { status: 429, headers: { "retry-after": "30" } });
  const error = await failure();
  expect(error.kind).toBe("rate_limited");
  expect(error.retryAfterSeconds).toBe(30);
});

test("an HTTP error, an empty stream, a stream with no result and a result of the wrong shape are problems on Meta's side", async () => {
  answer("bad gateway", { status: 502 });
  const http = await failure();
  answer(null);
  const empty = await failure();
  answer(events({ type: "response.output_text.delta", delta: "{" }));
  const unfinished = await failure();
  answer(events({ type: "response.completed", response: { status: "completed" } }));
  const shapeless = await failure();
  expect([http.kind, empty.kind, unfinished.kind, shapeless.kind]).toEqual(["upstream", "upstream", "upstream", "upstream"]);
});
