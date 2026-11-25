import { beforeAll, describe, expect, test } from "vitest";
import { rasterize } from "../../scripts/samples/raster";
import { renderBillPdf } from "../../scripts/samples/render";
import { internetExpired, internetGuaranteed, mobile, type BillSpec } from "../../scripts/samples/specs";
import { checkTotals, decide, settleChallenges, type Source } from "./decide";
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
    said_at_seconds: null,
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

  test("the bill's own notice that the promotion ended does not drop a claim", () => {
    const bill = billText.get(internetGuaranteed.id)!;
    const { claims } = decide(reading, promises, bill, offer(internetGuaranteed));
    const notice = { claim_id: claims[0].id, looked_for: "an end date", verdict: "refuted" as const, counter_quote: "Your promotional pricing ended on 10/31/2026.", counter_source: "bill" as const };
    const settled = settleChallenges(claims, [notice], reading, bill, offer(internetGuaranteed));
    expect(settled.dropped).toEqual([]);
    expect(settled.claims.map((c) => c.amountCents)).toEqual([1500, 1500]);
  });

  test("a bill credit that pays the claim back drops it", () => {
    const bill: Source = { kind: "text", text: `${(billText.get(internetGuaranteed.id) as { text: string }).text}\nGateway Credit -$15.00` };
    const withCredit: Reading = { ...reading, line_items: [...reading.line_items, { id: "L99", label: "Gateway Credit", amount_cents: -1500, kind: "credit", page: 1, box: null, quote: "Gateway Credit -$15.00", prorated: false }] };
    const { claims } = decide(reading, promises, billText.get(internetGuaranteed.id)!, offer(internetGuaranteed));
    const credit = { claim_id: claims[1].id, looked_for: "a credit", verdict: "refuted" as const, counter_quote: "Gateway Credit -$15.00", counter_source: "bill" as const };
    const settled = settleChallenges(claims, [credit], withCredit, bill, offer(internetGuaranteed));
    expect(settled.dropped.map((d) => d.claim.id)).toEqual([claims[1].id]);
  });

  test("an offer rebuttal not in the offer's exact words keeps the claim for the person to confirm", () => {
    const { claims } = decide(reading, promises, billText.get(internetGuaranteed.id)!, offer(internetGuaranteed));
    const loose = { claim_id: claims[0].id, looked_for: "an exclusion", verdict: "refuted" as const, counter_quote: "The price guarantee applies to your internet plan rate.", counter_source: "offer" as const };
    const settled = settleChallenges(claims, [loose], reading, billText.get(internetGuaranteed.id)!, offer(internetGuaranteed));
    expect(settled.dropped).toEqual([]);
    expect(settled.claims[0].needsConfirmation).toBe(true);
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
    expect(decision.unused).toEqual([{ promiseId: "P1", reason: "amount_not_in_quote" }]);
  });

  test("makes no claim when the promise quote is not in the offer", () => {
    const invented = [{ ...promises[0], quote: "Monthly price: $55.00/mo forever, guaranteed" }];
    const decision = decide(reading, invented, billText.get(internetGuaranteed.id)!, offer(internetGuaranteed));
    expect(decision.claims).toEqual([]);
  });

  test("a price heard on a call becomes a claim the person must confirm", () => {
    const call: Source = { kind: "heard", text: "Absolutely. With autopay and paperless, Fiber 500 is $55 a month, and that price is locked for two years." };
    const heard = [{ ...promises[0], quote: "Fiber 500 is $55 a month, and that price is locked for two years", said_at_seconds: 15 }];
    const decision = decide(reading, heard, billText.get(internetGuaranteed.id)!, call);
    expect(decision.claims.map((c) => [c.kind, c.amountCents, c.needsConfirmation])).toEqual([["price_above_promise", 1500, true]]);
  });

  test("makes no claim from words the call never contained", () => {
    const call: Source = { kind: "heard", text: "Fiber 500 is $55 a month with autopay." };
    const heard = [{ ...promises[0], quote: "Fiber 500 is $55 a month, and that price is locked for two years", said_at_seconds: 15 }];
    const decision = decide(reading, heard, billText.get(internetGuaranteed.id)!, call);
    expect(decision.claims).toEqual([]);
  });

  test("makes no included claim on a charge the promise doesn't name", () => {
    const misLinked = [{ ...promises[1], covers_line_ids: idOf(reading, "Fiber 500 Internet") }];
    const decision = decide(reading, misLinked, billText.get(internetGuaranteed.id)!, offer(internetGuaranteed));
    expect(decision.claims).toEqual([]);
    expect(decision.unused).toEqual([{ promiseId: "P2", reason: "item_not_named" }]);
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

  test("a time-limited promise whose end date was not read raises a question, never a $15 claim", () => {
    const undated = promises.map((p) => ({ ...p, applies_until: null }));
    const decision = decide(reading, undated, billText.get(internetExpired.id)!, offer(internetExpired));
    expect(decision.claims).toEqual([]);
    expect(decision.questions.filter((q) => q.kind === "end_date_unread")).toHaveLength(2);
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

describe("decide refuses claims the evidence does not carry", () => {
  const mobileReading = readingOf(mobile);
  const mobilePlans = [...idOf(mobileReading, "Unlimited Plus - Line 1 (510) 555-0132"), ...idOf(mobileReading, "Unlimited Plus - Line 2 (510) 555-0178")];

  test("a discount amount read as the monthly price becomes a question, not a $60 claim", () => {
    const misread = promise({ kind: "monthly_price", amount_cents: 500, per_line: true, quote: "$35/line per month, minus a $5/line Autopay discount each month", covers_line_ids: mobilePlans });
    const decision = decide(mobileReading, [misread], billText.get(mobile.id)!, offer(mobile));
    expect(decision.claims).toEqual([]);
    expect(decision.questions.map((q) => q.kind)).toContain("price_gap");
  });

  test("an offer from another company yields a question, even when the names share a word", () => {
    const reading = readingOf(internetGuaranteed);
    const text = "Westline Fiber: Internet 500 for $45/mo, guaranteed through 2028";
    const other = promise({ kind: "monthly_price", amount_cents: 4500, applies_until: "2028-12-31", quote: text, covers_line_ids: idOf(reading, "Fiber 500 Internet") });
    const decision = decide(reading, [other], billText.get(internetGuaranteed.id)!, { kind: "text", text }, "Westline Fiber");
    expect(decision.claims).toEqual([]);
    expect(decision.questions.map((q) => q.kind)).toContain("provider_mismatch");
  });

  test("the same company written differently still yields the claim", () => {
    const reading = readingOf(internetGuaranteed);
    const guaranteed = promise({
      kind: "monthly_price",
      amount_cents: 5500,
      conditions: ["autopay", "paperless"],
      quote: "Monthly price: $55.00/mo with Autopay & Paperless (2-year price guarantee through 10/31/2027)",
      applies_until: "2027-10-31",
      covers_line_ids: idOf(reading, "Fiber 500 Internet"),
    });
    const decision = decide(reading, [guaranteed], billText.get(internetGuaranteed.id)!, offer(internetGuaranteed), "Bayline");
    expect(decision.claims.map((c) => c.amountCents)).toEqual([1500]);
  });

  test("a paperless condition is not proven by autopay", () => {
    const text = "Fiber 500 Internet $80.00\nAutopay is on.";
    const reading: Reading = {
      ...readingOf(internetGuaranteed),
      line_items: [{ id: "L1", label: "Fiber 500 Internet", amount_cents: 8000, kind: "plan", page: 1, box: null, quote: "Fiber 500 Internet $80.00", prorated: false }],
      autopay: { enrolled: true, quote: "Autopay is on." },
    };
    const offerText = "Fiber 500 Internet: $60/month with paperless billing";
    const paperless = promise({ kind: "monthly_price", amount_cents: 6000, conditions: ["paperless"], quote: offerText, covers_line_ids: ["L1"] });
    const decision = decide(reading, [paperless], { kind: "text", text }, { kind: "text", text: offerText });
    expect(decision.claims).toEqual([]);
    expect(decision.questions.map((q) => q.kind)).toEqual(["conditions_unproven"]);
  });

  test("a credit posted for an included item cancels its charge", () => {
    const text = "Wi-Fi Gateway Rental $15.00\nGateway Promotional Credit -$15.00";
    const reading: Reading = {
      ...readingOf(internetGuaranteed),
      line_items: [
        { id: "L1", label: "Wi-Fi Gateway Rental", amount_cents: 1500, kind: "equipment", page: 1, box: null, quote: "Wi-Fi Gateway Rental $15.00", prorated: false },
        { id: "L2", label: "Gateway Promotional Credit", amount_cents: -1500, kind: "credit", page: 1, box: null, quote: "Gateway Promotional Credit -$15.00", prorated: false },
      ],
    };
    const offerText = "Wi-Fi Gateway: included, no monthly fee";
    const included = promise({ kind: "included", quote: offerText, covers_line_ids: ["L1", "L2"] });
    expect(decide(reading, [included], { kind: "text", text }, { kind: "text", text: offerText }).claims).toEqual([]);
  });

  test("a printed total whose quote is not on the bill does not count as printed", () => {
    const reading = readingOf(internetGuaranteed);
    const invented: Reading = { ...reading, printed: { ...reading.printed, current_charges: { cents: 9999, quote: "Current charges $99.99" } } };
    expect(checkTotals(invented, billText.get(internetGuaranteed.id)!).lineSum).toBe("not_printed");
    expect(checkTotals(reading, billText.get(internetGuaranteed.id)!).lineSum).toBe("ok");
  });
});
