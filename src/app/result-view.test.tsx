import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";
import { checkTotals } from "@/lib/decide";
import type { Checked } from "@/lib/result";
import type { LineItem, Reading } from "@/lib/schemas";
import { ResultView } from "./result-view";

const line = (id: string, label: string, cents: number, kind: LineItem["kind"]): LineItem => ({ id, label, amount_cents: cents, kind, page: 1, box: null, quote: `${label} $${(cents / 100).toFixed(2)}`, prorated: false });

function checked(lines: LineItem[], questions: Checked["questions"]): Checked {
  const reading: Reading = {
    outcome: "bill",
    unreadable_reason: null,
    provider: "AT&T",
    account_last4: null,
    statement_date: null,
    period_start: null,
    period_end: null,
    due_date: null,
    printed: { previous_balance: null, payments: null, current_charges: null, total_due: null, section_totals: [] },
    autopay: { enrolled: null, quote: null },
    line_items: lines,
  };
  return {
    outcome: "checked",
    reading,
    totals: checkTotals(reading, { kind: "image" }),
    offerProvider: null,
    providerMismatch: false,
    promises: [],
    transcript: null,
    claims: [],
    dropped: [],
    questions,
    explained: [],
    unused: [],
    matchedPromiseIds: [],
    billIsImage: true,
    billPages: [0],
    change: null,
    hadOffer: true,
    spentMicros: 0,
    calls: [],
  };
}

const page = (result: Checked, selection: Parameters<typeof ResultView>[0]["selection"] = { claims: {}, questions: {} }) =>
  renderToStaticMarkup(createElement(ResultView, { result, bill: 0, pages: [], callUrl: null, selection, dispatch: () => {}, backLabel: "Check another bill", onBack: () => {} })).replace(/&#x27;/g, "'").replace(/&amp;/g, "&");

describe("the result page's wording", () => {
  test("a bill with one charge says it compared 1 charge", () => {
    expect(page(checked([line("L1", "Internet 1000", 4479, "plan")], []))).toContain("Compared 1 charge with 0 promises.");
  });

  test("a question over discount lines only names the discounts", () => {
    const lines = [line("L1", "Internet 1000", 8000, "plan"), line("L2", "Discount for switching to AT&T", -1000, "discount")];
    const html = page(checked(lines, [{ id: "Q1", kind: "end_date_unread", lineIds: ["L2"], promiseId: "P1" }]));
    expect(html).toContain("The end date of your offer for Discount for switching to AT&T couldn't be read");
  });

  test("a fee printed twice is one question that says so, with both copies' total", () => {
    const lines = [line("L1", "Entertainment", 12200, "plan"), line("F1", "TV Access Fee", 700, "company_fee"), line("F2", "TV Access Fee", 700, "company_fee")];
    const html = page(checked(lines, [{ id: "Q1", kind: "unagreed_fee", lineIds: ["F1", "F2"], promiseId: null }]));
    expect(html).toContain("TV Access Fee isn't in your offer, charged 2 times");
    expect(html).toContain("$14.00");
  });

  test("a claim waiting on one marked line asks to confirm the marked line", () => {
    const result: Checked = {
      ...checked([line("L1", "Number share plan", 1500, "plan")], []),
      claims: [{ id: "C1", kind: "credit_missing", lineIds: ["L1"], promiseId: "P1", actualCents: 0, expectedCents: 750, amountCents: 750, needsConfirmation: true, lookedFor: null }],
    };
    expect(page(result, { claims: { C1: "needs_confirmation" }, questions: {} })).toContain("once you confirm the marked line<");
  });

  test("an offer with no price or promise in it is headed so, not as a failed match", () => {
    const html = page(checked([line("L1", "Internet 1000", 4479, "plan")], []));
    expect(html).toContain("No price or promise found to check the bill against");
    expect(html).not.toContain("Couldn't match your offer");
  });

  test("one charge that adds up to the printed total is said in the singular", () => {
    const base = checked([line("L1", "AT&T Unlimited Premium PL plan", 4479, "plan")], []);
    const reading: Reading = { ...base.reading, printed: { ...base.reading.printed, current_charges: { cents: 4479, quote: "Monthly charges $44.79" } } };
    expect(page({ ...base, reading, totals: checkTotals(reading, { kind: "image" }) })).toContain("Read 1 charge that adds up to the $44.79 printed on the bill.");
  });

  test("a condition the reading can't name is asked about plainly", () => {
    const result: Checked = {
      ...checked([line("L1", "Spectrum Internet Premier", 3000, "plan")], [{ id: "Q1", kind: "conditions_unproven", lineIds: ["L1"], promiseId: "P1" }]),
      promises: [{ id: "P1", kind: "monthly_price", description: "", amount_cents: 3000, per_line: false, conditions: ["other"], applies_from: null, applies_until: null, quote: "$30 a month", said_at_seconds: null, covers_line_ids: ["L1"] }],
    };
    expect(page(result)).toContain("The bill doesn't show that you meet your offer's conditions");
  });
});
