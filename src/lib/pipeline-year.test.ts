import { expect, test, vi } from "vitest";
import type * as Ember from "./ember";
import { openLedger } from "./ledger";
import { runCheck } from "./pipeline";
import type { CheckEvent } from "./result";

// Muse Ember is replaced by fixed answers so a whole year check runs offline; this file holds only tests that need
// that, since the mock applies to every test in it.
const COST = { read_bill: 1000, read_terms: 500 } as const;
vi.mock("./ember", async (actual) => ({
  ...(await actual<typeof Ember>()),
  countInputTokens: async () => 1000,
  send: async (request: { call: { name: string }; body: { input: { content: { type: string; image_url?: string; text?: string }[] }[] } }) => {
    const name = request.call.name as keyof typeof COST;
    const content = request.body.input[0].content;
    const month = content.some((part) => part.image_url?.endsWith("B") || part.text?.includes("February")) ? "February" : "January";
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
            printed: { previous_balance: null, payments: null, current_charges: { cents: 5500, quote: "Current charges $55.00" }, total_due: null, section_totals: [] },
            line_items: [{ label: `Fiber 500 Internet, ${month}`, amount_cents: 5500, kind: "plan", page: 1, box: null, quote: "Fiber 500 Internet $55.00", prorated: false }],
            autopay: { enrolled: null, quote: null },
          }
        : {
            transcript: null,
            provider: "Bayline Fiber",
            promises: [{ kind: "monthly_price", description: "Fiber 500 at $55 a month.", amount_cents: 5500, per_line: false, conditions: [], applies_from: null, applies_until: null, quote: "Fiber 500 for $55 a month", said_at_seconds: null, covers_line_ids: ["L1"] }],
          };
    return { output, usage: { inputTokens: 1000, cachedTokens: 0, outputTokens: 100 }, costMicros: COST[name] };
  },
}));

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
});
