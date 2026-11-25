import { beforeAll, describe, expect, test } from "vitest";
import { rasterize } from "../../scripts/samples/raster";
import { renderBillPdf } from "../../scripts/samples/render";
import { internetExpired, internetGuaranteed, mobile, type BillSpec } from "../../scripts/samples/specs";
import { decide, type Source } from "./decide";
import type { LineItem, LineKind, PromiseTerm, Reading } from "./schemas";

const KIND_BY_LABEL: Record<string, LineKind> = {
  "Fiber 500 Internet": "plan",
  "Wi-Fi Gateway Rental": "equipment",
  "Network Enhancement Fee": "company_fee",
  "Autopay & Paperless Discount": "discount",
  "CA Communications Users Tax": "government_tax",
  "Regulatory Recovery Fee": "company_fee",
  "Unlimited Plus - Line 1 (510) 555-0132": "plan",
  "Unlimited Plus - Line 2 (510) 555-0178": "plan",
  "Device Protection - Line 1": "other",
  "Administrative & Telco Recovery Charge": "company_fee",
  "Federal Universal Service Fund": "government_tax",
  "State 911 Surcharge": "government_tax",
};

const usd = (cents: number) => `${cents < 0 ? "-" : ""}$${(Math.abs(cents) / 100).toFixed(2)}`;

// What a correct model reading of the rendered sample looks like.
function readingOf(spec: BillSpec): Reading {
  const lines: LineItem[] = spec.lines.map((line, i) => ({
    id: `L${i + 1}`,
    label: line.label,
    amount_cents: line.cents,
    kind: KIND_BY_LABEL[line.label],
    page: 1,
    box: null,
    quote: [line.label, line.detail, usd(line.cents)].filter(Boolean).join(" "),
    prorated: false,
  }));
  const current = spec.lines.reduce((sum, line) => sum + line.cents, 0);
  const autopayNotice = spec.notices.find((notice) => notice.startsWith("Autopay is on"));
  return {
    outcome: "bill",
    unreadable_reason: null,
    provider: spec.provider.name,
    account_last4: spec.account.slice(-4),
    statement_date: spec.statementDate,
    period_start: spec.period.start,
    period_end: spec.period.end,
    due_date: spec.dueDate,
    printed: {
      previous_balance: { cents: spec.previousBalanceCents, quote: `Previous balance ${usd(spec.previousBalanceCents)}` },
      payments: { cents: spec.paymentCents, quote: `Payment received - thank you ${usd(-spec.paymentCents)}` },
      current_charges: { cents: current, quote: `Current charges ${usd(current)}` },
      total_due: { cents: current, quote: `Total amount due ${usd(current)}` },
    },
    line_items: lines,
    autopay: autopayNotice ? { enrolled: true, quote: "Autopay is on." } : { enrolled: null, quote: null },
  };
}

const idOf = (reading: Reading, label: string) => reading.line_items.filter((line) => line.label === label).map((line) => line.id);

function promise(overrides: Partial<PromiseTerm> & Pick<PromiseTerm, "kind" | "quote" | "covers_line_ids">): PromiseTerm {
  return {
    id: "P1",
    description: "",
    amount_cents: null,
    per_line: false,
    conditions: [],
    applies_from: null,
    applies_until: null,
    ...overrides,
  };
}

const billText = new Map<string, Source>();

beforeAll(async () => {
  for (const spec of [internetGuaranteed, mobile]) {
    billText.set(spec.id, { kind: "text", text: (await rasterize(await renderBillPdf(spec), 800)).text });
  }
  billText.set(internetExpired.id, billText.get(internetGuaranteed.id)!);
});

const offer = (spec: BillSpec): Source => ({ kind: "text", text: spec.proof });

describe("decide on the internet bill with an active price guarantee", () => {
  const reading = readingOf(internetGuaranteed);
  const promises = [
    promise({
      id: "P1",
      kind: "monthly_price",
      amount_cents: 5500,
      conditions: ["autopay", "paperless"],
      applies_until: "2027-10-31",
      quote: "Monthly price: $55.00/mo with Autopay & Paperless (2-year price guarantee through 10/31/2027)",
      covers_line_ids: idOf(reading, "Fiber 500 Internet"),
    }),
    promise({
      id: "P2",
      kind: "included",
      quote: "Wi-Fi Gateway: included at no extra cost",
      covers_line_ids: idOf(reading, "Wi-Fi Gateway Rental"),
    }),
  ];

  test("claims the price net of the autopay discount and the charged gateway", () => {
    const decision = decide(reading, promises, billText.get(internetGuaranteed.id)!, offer(internetGuaranteed));
    expect(decision.claims.map((c) => [c.kind, c.amountCents])).toEqual([
      ["price_above_promise", 1500],
      ["included_charged", 1500],
    ]);
  });

  test("asks about company fees no promise covers, never about taxes", () => {
    const decision = decide(reading, promises, billText.get(internetGuaranteed.id)!, offer(internetGuaranteed));
    const asked = decision.questions.filter((q) => q.kind === "unagreed_fee").flatMap((q) => q.lineIds);
    expect(asked).toEqual([...idOf(reading, "Network Enhancement Fee"), ...idOf(reading, "Regulatory Recovery Fee")]);
  });

  test("makes no claim when the promised amount is not in the quoted promise", () => {
    const misread = [{ ...promises[0], amount_cents: 4500 }];
    const decision = decide(reading, misread, billText.get(internetGuaranteed.id)!, offer(internetGuaranteed));
    expect(decision.claims).toEqual([]);
    expect(decision.unused).toEqual([{ promiseId: "P1", reason: "its amount is not in the quoted text" }]);
  });

  test("makes no claim when the promise quote is not in the offer", () => {
    const invented = [{ ...promises[0], quote: "Monthly price: $55.00/mo forever, guaranteed" }];
    const decision = decide(reading, invented, billText.get(internetGuaranteed.id)!, offer(internetGuaranteed));
    expect(decision.claims).toEqual([]);
  });

  test("never counts a linked tax toward the promised price", () => {
    const withTax = [{ ...promises[0], covers_line_ids: [...idOf(reading, "Fiber 500 Internet"), ...idOf(reading, "CA Communications Users Tax")] }];
    const decision = decide(reading, withTax, billText.get(internetGuaranteed.id)!, offer(internetGuaranteed));
    expect(decision.claims.map((c) => c.amountCents)).toEqual([1500]);
  });

  test("makes no claim when a line's quote is not on the bill", () => {
    const tampered: Reading = {
      ...reading,
      line_items: reading.line_items.map((line) => (line.label === "Wi-Fi Gateway Rental" ? { ...line, quote: "Wi-Fi Gateway Rental Nov 12 - Dec 11 $25.00", amount_cents: 2500 } : line)),
    };
    const decision = decide(tampered, promises, billText.get(internetGuaranteed.id)!, offer(internetGuaranteed));
    expect(decision.claims.map((c) => c.kind)).toEqual(["price_above_promise"]);
  });

  test("a photo bill's claims wait for the person to confirm them", () => {
    const withBoxes: Reading = { ...reading, line_items: reading.line_items.map((line) => ({ ...line, box: { x0: 80, y0: 400, x1: 920, y1: 420 } })) };
    const decision = decide(withBoxes, promises, { kind: "image" }, offer(internetGuaranteed));
    expect(decision.claims.map((c) => c.needsConfirmation)).toEqual([true, true]);
  });
});

describe("decide on the same bill after a 12-month promotion ended", () => {
  const reading = readingOf(internetExpired);
  const promises = [
    promise({
      id: "P1",
      kind: "monthly_price",
      amount_cents: 5500,
      conditions: ["autopay", "paperless"],
      applies_until: "2026-10-31",
      quote: "Promotional price: $55.00/mo with Autopay & Paperless for 12 months (through 10/31/2026)",
      covers_line_ids: [...idOf(reading, "Fiber 500 Internet"), ...idOf(reading, "Autopay & Paperless Discount")],
    }),
    promise({
      id: "P2",
      kind: "included",
      applies_until: "2026-10-31",
      quote: "Wi-Fi Gateway: included for 12 months (through 10/31/2026)",
      covers_line_ids: idOf(reading, "Wi-Fi Gateway Rental"),
    }),
  ];

  test("explains both price changes and claims nothing", () => {
    const decision = decide(reading, promises, billText.get(internetExpired.id)!, offer(internetExpired));
    expect(decision.claims).toEqual([]);
    expect(decision.explained.map((e) => [e.promiseId, e.endedOn])).toEqual([
      ["P1", "2026-10-31"],
      ["P2", "2026-10-31"],
    ]);
  });

  test("a promise ending inside the bill period becomes a question, not a claim", () => {
    const midPeriod = promises.map((p) => ({ ...p, applies_until: "2026-11-30" }));
    const decision = decide(reading, midPeriod, billText.get(internetExpired.id)!, { kind: "text", text: internetExpired.proof });
    expect(decision.claims).toEqual([]);
    expect(decision.questions.filter((q) => q.kind === "partial_period")).toHaveLength(2);
  });
});

describe("decide on the mobile bill with autopay on", () => {
  const reading = readingOf(mobile);
  const planLines = [...idOf(reading, "Unlimited Plus - Line 1 (510) 555-0132"), ...idOf(reading, "Unlimited Plus - Line 2 (510) 555-0178")];
  const price = promise({
    id: "P1",
    kind: "monthly_price",
    amount_cents: 3500,
    per_line: true,
    quote: "$35/line per month, minus a $5/line Autopay discount each month",
    covers_line_ids: planLines,
  });
  const credit = promise({
    id: "P2",
    kind: "recurring_credit",
    amount_cents: 500,
    per_line: true,
    conditions: ["autopay"],
    quote: "$35/line per month, minus a $5/line Autopay discount each month",
    covers_line_ids: planLines,
  });

  test("claims the missing per-line autopay credit once", () => {
    const decision = decide(reading, [price, credit], billText.get(mobile.id)!, offer(mobile));
    expect(decision.claims.map((c) => [c.kind, c.amountCents])).toEqual([["credit_missing", 1000]]);
  });

  test("without proof of autopay on the bill, the missing credit is a question", () => {
    const noNotice: Reading = { ...reading, autopay: { enrolled: null, quote: null } };
    const decision = decide(noNotice, [credit], billText.get(mobile.id)!, offer(mobile));
    expect(decision.claims).toEqual([]);
    expect(decision.questions.map((q) => q.kind)).toContain("conditions_unproven");
  });

  test("asks about the line charged twice", () => {
    const decision = decide(reading, [price, credit], billText.get(mobile.id)!, offer(mobile));
    const repeated = decision.questions.filter((q) => q.kind === "repeated_charge");
    expect(repeated.map((q) => q.lineIds)).toEqual([idOf(reading, "Device Protection - Line 1")]);
  });

  test("the same missing $10 is claimed once when two promises describe it", () => {
    const text = "$30/line per month with Autopay.\nIncludes a $5/line Autopay discount each month.";
    const netPrice = promise({ ...price, amount_cents: 3000, conditions: ["autopay"], quote: "$30/line per month with Autopay." });
    const sameCredit = promise({ ...credit, quote: "Includes a $5/line Autopay discount each month." });
    const decision = decide(reading, [netPrice, sameCredit], billText.get(mobile.id)!, { kind: "text", text });
    expect(decision.claims.map((c) => c.amountCents)).toEqual([1000]);
    expect(decision.questions.map((q) => q.kind)).toContain("overlapping_claim");
  });
});
