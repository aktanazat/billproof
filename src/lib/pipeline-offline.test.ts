import { expect, test, vi } from "vitest";
import type * as Ember from "./ember";
import { openLedger } from "./ledger";
import { buildMessage } from "./letter";
import { runCheck } from "./pipeline";
import type { CheckEvent } from "./result";

// Muse Ember is replaced by fixed answers so whole checks run offline; this file holds only tests that need that,
// since the mock applies to every test in it. `scenario` sets what the bill charges and what the company's side quotes.
const COST = { read_bill: 1000, read_terms: 500, challenge: 700 } as const;
const scenario = { billedCents: 5500, counterQuote: null as string | null, tooLong: null as string | null };
// A failure thrown here is built from the same module copy the pipeline is given, so it is recognised as Muse Ember's.
vi.mock("./ember", async (actual) => {
  const real = await actual<typeof Ember>();
  return {
  ...real,
  countInputTokens: async () => 1000,
  send: async (request: { call: { name: string }; body: { input: { content: { type: string; image_url?: string; text?: string }[] }[] } }) => {
    const name = request.call.name as keyof typeof COST;
    const content = request.body.input[0].content;
    const month = content.some((part) => part.image_url?.endsWith("B") || part.text?.includes("February")) ? "February" : "January";
    // Too long for both readings, the first and the second with twice the room.
    if ((name === "read_bill" || (name as string) === "reread_bill") && month === scenario.tooLong) throw new real.EmberError("truncated", "max_output_tokens", 900);
    if (name === "challenge") {
      const ids = content.flatMap((part) => [...(part.text ?? "").matchAll(/^Claim (\S+) \(/gm)].map((m) => m[1]));
      const challenges = ids.map((id) => ({ claim_id: id, looked_for: "A later price in the offer.", verdict: scenario.counterQuote ? "refuted" : "stands", counter_quote: scenario.counterQuote, counter_source: scenario.counterQuote ? "offer" : null }));
      return { output: { challenges }, usage: { inputTokens: 1000, cachedTokens: 0, outputTokens: 100 }, costMicros: COST.challenge };
    }
    const output =
      name === "read_bill"
        ? {
            outcome: "bill",
            unreadable_reason: null,
            provider: "Bayline Fiber",
            account_last4: "4415",
            statement_date: null,
            period_start: month === "January" ? "2026-01-12" : "2026-02-12",
            period_end: null,
            due_date: null,
            printed: { previous_balance: null, payments: null, current_charges: { cents: scenario.billedCents, quote: `Current charges $${(scenario.billedCents / 100).toFixed(2)}` }, total_due: null, section_totals: [] },
            line_items: [{ label: `Fiber 500 Internet, ${month}`, amount_cents: scenario.billedCents, kind: "plan", page: 1, box: { x0: 100, y0: 400, x1: 900, y1: 430 }, quote: `Fiber 500 Internet $${(scenario.billedCents / 100).toFixed(2)}`, prorated: false }],
            autopay: { enrolled: null, quote: null },
          }
        : {
            transcript: null,
            provider: "Bayline Fiber",
            promises: [{ kind: "monthly_price", description: "Fiber 500 at $55 a month.", amount_cents: 5500, per_line: false, conditions: [], applies_from: null, applies_until: null, quote: "Fiber 500 for $55 a month", said_at_seconds: null, covers_line_ids: ["L1"] }],
          };
    return { output, usage: { inputTokens: 1000, cachedTokens: 0, outputTokens: 100 }, costMicros: COST[name] };
  },
  };
});

test("each month of a year check reports its own Muse Ember steps and cost; the year reports them all", async () => {
  const events: CheckEvent[] = [];
  const page = (tag: string) => ({ image: `data:image/png;base64,iVBORw0KGgo${tag}`, text: null });
  await runCheck(
    { bills: [{ pages: [page("A")] }, { pages: [page("B")] }], offer: { kind: "text", text: "Fiber 500 for $55 a month" } },
    { ledger: openLedger(":memory:", 1_000_000), client: "test", signal: new AbortController().signal, emit: (event) => events.push(event) },
  );
  const done = events.find((event) => event.type === "result");
  if (done?.type !== "result" || done.result.outcome !== "year") throw new Error(`no year result: ${JSON.stringify(events.at(-1))}`);
  for (const { result } of done.result.months) {
    expect(result.outcome).toBe("checked");
    if (result.outcome !== "checked") continue;
    expect(result.calls.map((call) => call.name)).toEqual(["read_bill", "read_terms"]);
    expect(result.spentMicros).toBe(COST.read_bill + COST.read_terms);
  }
  expect(done.result.calls).toHaveLength(4);
  expect(done.result.spentMicros).toBe(2 * (COST.read_bill + COST.read_terms));
  // The running cost shown while bills are read side by side is what finished calls cost: it only rises, and never
  // passes the final cost, as it did while other bills' calls still held their worst-case reservations.
  const running = events.flatMap((event) => (event.type === "spent" ? [event.micros] : []));
  expect(running.length).toBeGreaterThan(0);
  expect(running).toEqual([...running].sort((a, b) => a - b));
  expect(Math.max(...running)).toBeLessThanOrEqual(done.result.spentMicros);
});

test("a claim the company's side defeats with the offer's own words is dropped, with that quote, and asks for nothing", async () => {
  scenario.billedCents = 7000;
  scenario.counterQuote = "The price rises to $70 a month after 6 months.";
  const events: CheckEvent[] = [];
  await runCheck(
    { bills: [{ pages: [{ image: "data:image/png;base64,iVBORw0KGgoC", text: null }] }], offer: { kind: "text", text: "Fiber 500 for $55 a month. The price rises to $70 a month after 6 months." } },
    { ledger: openLedger(":memory:", 1_000_000), client: "test", signal: new AbortController().signal, emit: (event) => events.push(event) },
  );
  const done = events.find((event) => event.type === "result");
  if (done?.type !== "result" || done.result.outcome !== "checked") throw new Error(`no result: ${JSON.stringify(events.at(-1))}`);
  expect(done.result.calls.map((call) => call.name)).toEqual(["read_bill", "read_terms", "challenge"]);
  expect(done.result.claims).toEqual([]);
  expect(done.result.dropped).toMatchObject([{ claim: { kind: "price_above_promise", amountCents: 1500 }, counterQuote: scenario.counterQuote, source: "offer" }]);
  const message = buildMessage(done.result, new Set(done.result.dropped.map((d) => d.claim.id)), new Set());
  expect(`${message.chat}\n${message.complaint}`).not.toContain("$15.00");
});

// A year stops at its first failure. One that belongs to a single bill says which, so the page can name its file and
// the person can fix that one; "This bill is too long" alone, among twelve, leaves them guessing at another paid try.
test("a year stopped by one bill's failure names that bill by its place in the list", async () => {
  scenario.billedCents = 5500;
  scenario.counterQuote = null;
  scenario.tooLong = "February";
  const events: CheckEvent[] = [];
  const page = (tag: string) => ({ image: `data:image/png;base64,iVBORw0KGgo${tag}`, text: null });
  await runCheck(
    // Pages no other test sends, so no reading remembered from an earlier test answers for them.
    { bills: [{ pages: [page("AA")] }, { pages: [page("BB")] }], offer: { kind: "text", text: "Fiber 500 for $55 a month" } },
    { ledger: openLedger(":memory:", 1_000_000), client: "test", signal: new AbortController().signal, emit: (event) => events.push(event) },
  );
  scenario.tooLong = null;
  expect(events.at(-1)).toMatchObject({ type: "error", failure: "truncated", message: "This bill is too long for Muse Ember to read in one check. Use the pages with the charges.", bill: 1, retryable: false });
});
