import { describe, expect, test } from "vitest";
import { checkTotals } from "./decide";
import { buildMessage, buildYearMessage } from "./letter";
import type { Checked } from "./result";
import type { LineItem, PromiseTerm, Reading } from "./schemas";

const fee = (id: string, label: string, cents: number): LineItem => ({ id, label, amount_cents: cents, kind: "company_fee", page: 1, box: { x0: 80, y0: 400, x1: 920, y1: 420 }, quote: `${label} $${(cents / 100).toFixed(2)}`, prorated: false });

function billWith(lines: LineItem[]): Checked {
  const reading: Reading = {
    outcome: "bill",
    unreadable_reason: null,
    provider: "Xfinity",
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
    questions: [
      { id: "Q1", kind: "unagreed_fee", lineIds: ["F1"], promiseId: null },
      { id: "Q2", kind: "unagreed_fee", lineIds: ["F2", "F3"], promiseId: null },
      { id: "Q3", kind: "unagreed_fee", lineIds: ["F4"], promiseId: null },
    ],
    explained: [],
    unused: [],
    matchedPromiseIds: [],
    billIsImage: true,
    billPages: [0],
    change: null,
    hadOffer: false,
    spentMicros: 0,
    calls: [],
  };
}

describe("the message's fee questions", () => {
  const result = billWith([fee("F1", "Broadcast TV Fee", 4723), fee("F2", "TV Access Fee", 700), fee("F3", "TV Access Fee", 700), fee("F4", "Regional Sports Fee", 1986)]);

  test("several fees are asked about in one request, each with its amount", () => {
    const { chat } = buildMessage(result, new Set(), new Set(["Q1", "Q2", "Q3"]));
    expect(chat).toContain("Please explain the Broadcast TV Fee ($47.23), TV Access Fee ($14.00, charged 2 times) and Regional Sports Fee ($19.86). They were not part of the plan I agreed to; if they are not required, please remove them.");
    expect(chat.match(/Please explain/g)).toHaveLength(1);
  });

  test("one fee keeps the singular request", () => {
    const { chat } = buildMessage(result, new Set(), new Set(["Q3"]));
    expect(chat).toContain("Please explain the Regional Sports Fee ($19.86). It was not part of the plan I agreed to; if it is not required, please remove it.");
  });
});

describe("a message with no dollar claim", () => {
  const result = billWith([fee("F1", "Broadcast TV Fee", 4723), fee("F2", "TV Access Fee", 700), fee("F3", "TV Access Fee", 700), fee("F4", "Regional Sports Fee", 1986)]);

  test("names fees as the complaint's problem and asks for no credit", () => {
    const message = buildMessage(result, new Set(), new Set(["Q1"]));
    expect(message.complaint).toContain("Problem: fees on my bill I never agreed to.");
    expect(message.complaint).not.toContain("billed above the price I was promised");
    expect(message.email).toContain("Please reply with an explanation of these charges and anything you will correct on my bill.");
    expect(`${message.email}\n${message.call}`).not.toContain("the date the credit will post");
  });

  test("the complaint states the fees as facts for the regulator, while the email asks the company", () => {
    const message = buildMessage(result, new Set(), new Set(["Q1", "Q2"]));
    expect(message.complaint).toContain("- The bill charges the Broadcast TV Fee ($47.23) and TV Access Fee ($14.00, charged 2 times), which were not part of the plan I agreed to.");
    expect(message.complaint).not.toContain("Please explain");
    expect(message.email).toContain("Please explain the Broadcast TV Fee ($47.23) and TV Access Fee ($14.00, charged 2 times).");
  });
});

describe("a missing autopay credit on a bill with no company name", () => {
  const credit: LineItem = { id: "L1", label: "Apple Watch line", amount_cents: 1500, kind: "plan", page: 1, box: { x0: 80, y0: 400, x1: 920, y1: 420 }, quote: "Apple Watch line $15.00", prorated: false };
  const promise: PromiseTerm = { id: "P1", kind: "recurring_credit", description: "", amount_cents: 750, per_line: false, conditions: [], applies_from: null, applies_until: null, quote: "50% discount that showed -$7.50 per line", said_at_seconds: null, covers_line_ids: ["L1"] };
  const base = billWith([credit]);
  const result: Checked = {
    ...base,
    reading: { ...base.reading, provider: null },
    questions: [],
    promises: [promise],
    matchedPromiseIds: ["P1"],
    claims: [{ id: "C1", kind: "credit_missing", lineIds: ["L1"], promiseId: "P1", actualCents: 0, expectedCents: 750, amountCents: 750, needsConfirmation: false, lookedFor: null }],
  };
  const message = buildMessage(result, new Set(["C1"]), new Set());

  test("the complaint names a missing credit as the problem and states it without asking the regulator for it", () => {
    expect(message.complaint).toContain("Problem: a credit I was promised is missing from my bill.");
    expect(message.complaint).toContain('- My account is on autopay, but this bill has no $7.50 monthly credit I was promised ("50% discount that showed -$7.50 per line").\n');
    expect(message.complaint).not.toContain("Please");
    expect(message.chat).toContain("Please apply the missing $7.50.");
  });

  test("an unread company name is left for the person to fill in, never written as 'your company'", () => {
    expect(message.email).toContain("Hello billing team,");
    expect(message.complaint).toContain("Company: [company name]");
    expect(message.complaint).toContain("[date you contacted the company and their answer]");
    expect(`${message.email}\n${message.complaint}`).not.toContain("your company");
  });
});

describe("a claim on a promise heard on a call", () => {
  const plan: LineItem = { id: "L1", label: "Fiber 500 Internet", amount_cents: 7000, kind: "plan", page: 1, box: { x0: 80, y0: 400, x1: 920, y1: 420 }, quote: "Fiber 500 Internet $70.00", prorated: false };
  const heard: PromiseTerm = { id: "P1", kind: "monthly_price", description: "", amount_cents: 5500, per_line: false, conditions: [], applies_from: null, applies_until: null, quote: "Fiber 500 is $55 a month", said_at_seconds: 14, covers_line_ids: ["L1"] };
  const month = (start: string, end: string): Checked => {
    const base = billWith([plan]);
    return {
      ...base,
      reading: { ...base.reading, provider: "Bayline Fiber", period_start: start, period_end: end },
      promises: [heard],
      transcript: [{ speaker: "company", text: "Fiber 500 is $55 a month", start_seconds: 14 }],
      questions: [],
      claims: [{ id: "C1", kind: "price_above_promise", lineIds: ["L1"], promiseId: "P1", actualCents: 7000, expectedCents: 5500, amountCents: 1500, needsConfirmation: false, lookedFor: null }],
    };
  };

  test("names the company's representative to a regulator and says 'your representative' to the company", () => {
    const message = buildMessage(month("2026-11-12", "2026-12-11"), new Set(["C1"]), new Set());
    expect(message.email).toContain("your representative told me on the call, at 0:14");
    expect(message.complaint).toContain("Bayline Fiber's representative told me on the call, at 0:14");
    expect(message.complaint).not.toContain("your representative");
  });

  test("a year message quotes the same promise once and refers back to it after", () => {
    const { chat } = buildYearMessage([month("2026-10-12", "2026-11-11"), month("2026-11-12", "2026-12-11")]);
    expect(chat.match(/"Fiber 500 is \$55 a month"/g)).toHaveLength(1);
    expect(chat).toContain("confirmed at $55.00 a month (as quoted above)");
  });
});
