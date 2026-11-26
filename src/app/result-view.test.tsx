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

describe("the result page's heading", () => {
  const plan = line("L1", "Internet 1000", 8000, "plan");
  const promise: Checked["promises"][number] = { id: "P1", kind: "monthly_price", description: "", amount_cents: 7000, per_line: false, conditions: [], applies_from: null, applies_until: null, quote: "$70 a month", said_at_seconds: null, covers_line_ids: ["L1"] };
  const heading = (result: Checked, selection?: Parameters<typeof ResultView>[0]["selection"]) => {
    const html = page(result, selection);
    return [...html.matchAll(/<(h1|p)[^>]*>([^<]*(?:<[^h/][^>]*>[^<]*)*)<\/\1>/g)].slice(0, 2).map((m) => m[2].replace(/<[^>]+>/g, "")).join(" ");
  };

  test.each([
    ["no offer was given", { ...checked([plan], []), hadOffer: false }, "Nothing to flag on this bill"],
    ["the offer is another company's", { ...checked([plan], []), providerMismatch: true, offerProvider: "Westline Cable" }, "The offer is from Westline Cable, not AT&T"],
    ["one question is worth asking", checked([plan, line("F1", "Network Fee", 399, "company_fee")], [{ id: "Q1", kind: "unagreed_fee", lineIds: ["F1"], promiseId: null }]), "1 charge worth asking about"],
    ["no promise matched a line", { ...checked([plan], []), promises: [promise] }, "Couldn't match your offer to this bill"],
    ["every promise was kept", { ...checked([plan], []), promises: [promise], matchedPromiseIds: ["P1"] }, "Nothing is billed above your offer"],
  ])("when %s", (_case, result, expected) => {
    expect(heading(result)).toContain(expected);
  });

  test("a claim is headed with the amount to ask back and the company", () => {
    const result: Checked = {
      ...checked([plan], []),
      promises: [promise],
      matchedPromiseIds: ["P1"],
      claims: [{ id: "C1", kind: "price_above_promise", lineIds: ["L1"], promiseId: "P1", actualCents: 8000, expectedCents: 7000, amountCents: 1000, needsConfirmation: false, lookedFor: null }],
    };
    expect(heading(result, { claims: { C1: "selected" }, questions: {} })).toContain("$10.00 to ask back from AT&T");
  });
});

describe("the result page's other sections", () => {
  const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");

  test("an earlier bill lists what rose, what is new and what is gone", () => {
    const result: Checked = {
      ...checked([line("L1", "Internet: Gigabit", 16525, "plan")], []),
      change: { earlierCents: 18802, currentCents: 28314, lines: [{ label: "Internet: Gigabit", beforeCents: 10900, afterCents: 16525 }, { label: "Transfer Service", beforeCents: null, afterCents: 5000 }, { label: "2 Product Discount", beforeCents: -3000, afterCents: null }] },
    };
    const t = text(page(result));
    expect(t).toContain("Up $95.12 since the earlier bill");
    expect(t).toContain("Internet: Gigabit $109.00 → $165.25");
    expect(t).toContain("Transfer Service new → $50.00");
    expect(t).toContain("2 Product Discount -$30.00 → gone");
  });

  test("a lower bill is listed as down", () => {
    const result: Checked = { ...checked([line("L1", "Plan", 5000, "plan")], []), change: { earlierCents: 6286, currentCents: 5000, lines: [{ label: "Plan", beforeCents: 6286, afterCents: 5000 }] } };
    expect(text(page(result))).toContain("Down $12.86 since the earlier bill");
  });

  test("the checking notes say when the charges miss the printed total and why a promise went unused", () => {
    const base = checked([line("L1", "Internet 1000", 8000, "plan")], []);
    const reading: Reading = { ...base.reading, printed: { ...base.reading.printed, current_charges: { cents: 9000, quote: "Total $90.00" } } };
    const result: Checked = {
      ...base,
      reading,
      totals: checkTotals(reading, { kind: "image" }),
      promises: [
        { id: "P1", kind: "monthly_price", description: "Phone at $32.22 a month", amount_cents: 3222, per_line: false, conditions: [], applies_from: null, applies_until: null, quote: "Due monthly $32.22", said_at_seconds: null, covers_line_ids: ["L1"] },
        { id: "P2", kind: "other", description: "Spectrum offered a $20 credit.", amount_cents: 2000, per_line: false, conditions: [], applies_from: null, applies_until: null, quote: "We'll credit $20", said_at_seconds: null, covers_line_ids: [] },
      ],
      unused: [
        { promiseId: "P1", reason: "device_or_cart_total" },
        { promiseId: "P2", reason: "kind_not_checked" },
      ],
    };
    const t = text(page(result));
    expect(t).toContain("The charges add up to $80.00, but the bill prints $90.00.");
    expect(t).toContain("Not used: Phone at $32.22 a month (it's a device payment or order total, not a plan price).");
    expect(t).toContain("Not used: Spectrum offered a $20 credit (this kind of promise isn't checked yet).");
  });

  test("a claim dropped after checking the company's side shows struck through with the quote that answered it", () => {
    const promise: Checked["promises"][number] = { id: "P1", kind: "included", description: "", amount_cents: 0, per_line: false, conditions: [], applies_from: null, applies_until: null, quote: "Xumo Stream Box included", said_at_seconds: null, covers_line_ids: ["L1"] };
    const claim: Checked["claims"][number] = { id: "C1", kind: "included_charged", lineIds: ["L1"], promiseId: "P1", actualCents: 500, expectedCents: 0, amountCents: 500, needsConfirmation: true, lookedFor: null };
    const result: Checked = {
      ...checked([line("L1", "Xumo Stream Box", 500, "equipment")], []),
      promises: [promise],
      matchedPromiseIds: ["P1"],
      dropped: [{ claim, lookedFor: "a discount for the box", counterQuote: "Xumo Stream Box Discount -$5.00", source: "bill" }],
    };
    const html = page(result);
    const t = text(html);
    expect(t).toContain("Dropped after checking the company's side Xumo Stream Box was supposed to be included $5.00 The bill says “Xumo Stream Box Discount -$5.00”");
    expect(html).toMatch(/line-through[^>]*>\$5\.00</);
    expect(t).toContain("Nothing is billed above your offer");
  });

  test("a missing credit is titled as missing and shows what was credited against what was promised", () => {
    const credit: Checked["promises"][number] = { id: "P1", kind: "recurring_credit", description: "", amount_cents: 750, per_line: false, conditions: [], applies_from: null, applies_until: null, quote: "-$7.50 per line", said_at_seconds: null, covers_line_ids: ["L1"] };
    const missing: Checked["claims"][number] = { id: "C1", kind: "credit_missing", lineIds: ["L1"], promiseId: "P1", actualCents: 0, expectedCents: 750, amountCents: 750, needsConfirmation: false, lookedFor: null };
    const result: Checked = { ...checked([line("L1", "Number share plan", 1500, "plan")], []), promises: [credit], matchedPromiseIds: ["P1"], claims: [missing] };
    const t = text(page(result, { claims: { C1: "selected" }, questions: {} }));
    expect(t).toContain("Missing from the bill");
    expect(t).toContain("Credited $0.00 Number share plan $15.00 Promised $7.50");
    expect(t).not.toContain("Charged above the promise");
  });

  test("a claim's title agrees with how many charges it names", () => {
    const promise: Checked["promises"][number] = { id: "P1", kind: "monthly_price", description: "", amount_cents: 2500, per_line: true, conditions: [], applies_from: null, applies_until: null, quote: "$25/line per month", said_at_seconds: null, covers_line_ids: ["L1", "L2", "L3"] };
    const lines = [line("L1", "Unlimited Basic - Line 1", 3000, "plan"), line("L2", "Unlimited Basic - Line 2", 3000, "plan"), line("L3", "Unlimited Basic - Line 3", 3000, "plan")];
    const claim = (lineIds: string[], actualCents: number, expectedCents: number): Checked["claims"][number] => ({ id: "C1", kind: "price_above_promise", lineIds, promiseId: "P1", actualCents, expectedCents, amountCents: actualCents - expectedCents, needsConfirmation: false, lookedFor: null });
    const render = (c: Checked["claims"][number]) => text(page({ ...checked(lines, []), promises: [promise], matchedPromiseIds: ["P1"], claims: [c] }, { claims: { C1: "selected" }, questions: {} }));
    expect(render(claim(["L1", "L2", "L3"], 9000, 7500))).toContain("Unlimited Basic - Line 1, Unlimited Basic - Line 2 and Unlimited Basic - Line 3 are billed above the promised price");
    expect(render(claim(["L1"], 3000, 2500))).toContain("Unlimited Basic - Line 1 is billed above the promised price");
  });
});
