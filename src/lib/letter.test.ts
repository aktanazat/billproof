import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { checkTotals } from "./decide";
import { buildMessage, buildYearMessage } from "./letter";
import type { CheckEvent, Checked } from "./result";
import type { LineItem, PromiseTerm, Reading } from "./schemas";

// Every message format for every result of the 2026-11-26 test-set run, with every claim and question selected, is
// free of the slips that string assembly makes: doubled spaces or punctuation, empty quotes, leaked placeholders.
test("no message built from a saved result has a doubled space, stray punctuation, an empty quote or a placeholder", () => {
  const run = JSON.parse(readFileSync(path.join(import.meta.dirname, "../../eval/run-2026-11-26.json"), "utf8")) as { raw: { id: string; events: CheckEvent[] }[] };
  const slips: [string, RegExp][] = [
    ["doubled space", /[^\n ] {2,}[^ ]/],
    ["space before punctuation", / [,.;:)]/],
    ["doubled punctuation", /(?<!\.)\.\.(?!\.)|,,|;;|\.,|,\./],
    ["empty quote or brackets", /""|“”|\(\s*\)|\[\s*\]/],
    ["placeholder", /\bundefined\b|\bNaN\b|\bnull\b|\[object/],
  ];
  const messages = run.raw.flatMap((entry) => {
    const event = entry.events.find((e) => e.type === "result");
    if (event?.type !== "result") return [];
    const all = (r: Checked) => buildMessage(r, new Set(r.claims.map((c) => c.id)), new Set(r.questions.map((q) => q.id)));
    if (event.result.outcome === "checked") return [all(event.result)];
    if (event.result.outcome !== "year") return [];
    const months = event.result.months.flatMap((m) => (m.result.outcome === "checked" ? [m.result] : []));
    return [buildYearMessage(months), ...months.map(all)];
  });
  expect(messages.length).toBeGreaterThan(30);
  const found = messages.flatMap((message) => [message.chat, message.email, message.call, message.complaint]).flatMap((body) => slips.filter(([, slip]) => slip.test(body)).map(([name]) => `${name}: ${body.slice(0, 80)}`));
  expect(found).toEqual([]);
});

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
    hadOffer: true,
    spentMicros: 0,
    calls: [],
  };
}

test("a date the reading got wrong is shown as written, never as 'undefined'", () => {
  const base = billWith([fee("F1", "Broadcast TV Fee", 4723)]);
  const misread: Checked = { ...base, reading: { ...base.reading, period_start: "2026-13-05", period_end: "2026-12-04" } };
  const { chat } = buildMessage(misread, new Set(), new Set(["Q1"]));
  expect(chat).toContain("bill for 2026-13-05 to Dec 4, 2026");
  expect(chat).not.toContain("undefined");
});

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

  test("with no offer, or another company's, a fee is asked about without claiming it wasn't agreed to", () => {
    for (const unrelated of [{ ...result, hadOffer: false }, { ...result, providerMismatch: true, offerProvider: "Westline Cable" }]) {
      const message = buildMessage(unrelated, new Set(), new Set(["Q3"]));
      expect(message.chat).toContain("Please explain the Regional Sports Fee ($19.86). If it is not required, please remove it.");
      expect(`${message.chat}\n${message.complaint}`).not.toContain("agreed to");
      expect(message.complaint).toContain("Problem: charges on my bill the company hasn't explained.");
      expect(message.complaint).toContain("- The bill charges the Regional Sports Fee ($19.86), which the company hasn't explained.");
    }
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
    expect(message.email).toMatch(/^Subject: Questions about the charges on my account\n/);
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
    expect(message.complaint).toContain("Resolution I'm asking for: a credit of $7.50 and the promised credit on future bills.");
    expect(message.complaint).toContain('- This bill has no $7.50 monthly credit I was promised ("50% discount that showed -$7.50 per line").\n');
    expect(message.chat).not.toContain("autopay");
    expect(message.complaint).not.toContain("Please");
    expect(message.chat).toContain("Please apply the missing $7.50.");
    expect(message.chat).not.toContain("In total");
    expect(message.email).toMatch(/^Subject: Billing correction for my account\n/);
  });

  test("a missing credit mentions autopay only when the promise depends on it", () => {
    const onAutopay = buildMessage({ ...result, promises: [{ ...promise, conditions: ["autopay"] }] }, new Set(["C1"]), new Set());
    expect(onAutopay.chat).toContain('My account is on autopay, but this bill has no $7.50 monthly credit I was promised ("50% discount that showed -$7.50 per line"). Please apply the missing $7.50.');
  });

  test("an unread company name or account number is left for the person to fill in, never written as 'your company' or 'my account' to a regulator", () => {
    expect(message.email).toContain("Hello billing team,");
    expect(message.complaint).toContain("Company: [company name]");
    expect(message.complaint).toContain("Account: [account number]");
    expect(message.complaint).toContain("[date you contacted the company and their answer]");
    expect(`${message.email}\n${message.complaint}`).not.toContain("your company");
    expect(message.chat).toContain("my account");
    const withAccount = buildMessage({ ...result, reading: { ...result.reading, account_last4: "4415" } }, new Set(["C1"]), new Set());
    expect(withAccount.complaint).toContain("Account: account ending 4415");
  });
});

describe("a price claim across several lines on a dated bill", () => {
  const planLine = (id: string, label: string): LineItem => ({ id, label, amount_cents: 3000, kind: "plan", page: 1, box: { x0: 80, y0: 400, x1: 920, y1: 420 }, quote: `${label} $30.00`, prorated: false });
  const lines = [planLine("L1", "Unlimited Basic - Line 1"), planLine("L2", "Unlimited Basic - Line 2"), planLine("L3", "Unlimited Basic - Line 3")];
  const promise: PromiseTerm = { id: "P1", kind: "monthly_price", description: "", amount_cents: 2500, per_line: true, conditions: [], applies_from: null, applies_until: null, quote: "$25/line per month", said_at_seconds: null, covers_line_ids: ["L1", "L2", "L3"] };
  const base = billWith(lines);
  const result: Checked = {
    ...base,
    reading: { ...base.reading, period_start: "2026-11-08", period_end: "2026-12-07" },
    questions: [],
    promises: [promise],
    matchedPromiseIds: ["P1"],
    claims: [{ id: "C1", kind: "price_above_promise", lineIds: ["L1", "L2", "L3"], promiseId: "P1", actualCents: 9000, expectedCents: 7500, amountCents: 1500, needsConfirmation: false, lookedFor: null }],
  };
  const message = buildMessage(result, new Set(["C1"]), new Set());

  test("the chat names the period once, in its opening, and the lines take a plural verb", () => {
    expect(message.chat).toContain("bill for Nov 8, 2026 to Dec 7, 2026.\n\nFor this bill, Unlimited Basic - Line 1, Unlimited Basic - Line 2 and Unlimited Basic - Line 3 come to $90.00, but my plan was confirmed at $75.00 a month");
    expect(message.chat.split("Nov 8, 2026")).toHaveLength(2);
  });

  test("the complaint, which has no such opening, gives the period with the claim", () => {
    expect(message.complaint).toContain("- For Nov 8, 2026 to Dec 7, 2026, Unlimited Basic - Line 1, Unlimited Basic - Line 2 and Unlimited Basic - Line 3 come to $90.00");
    expect(message.complaint).toContain("Resolution I'm asking for: a credit of $15.00 and the promised rate on future bills.");
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
    expect(chat).toMatch(/In total, please credit \$\d+\.\d{2} to /);
  });

  test("a year email opens by saying which account and what was checked, as its chat does", () => {
    const { email } = buildYearMessage([month("2026-10-12", "2026-11-11"), month("2026-11-12", "2026-12-11")]);
    expect(email).toMatch(/billing team,\n\nI'm writing about .+\. I checked my statements against the plan I signed up for\.\n\nFor /);
  });

  test("a year message takes the company and account from any month that shows them", () => {
    const unread = month("2026-10-12", "2026-11-11");
    const read = month("2026-11-12", "2026-12-11");
    const { email, complaint } = buildYearMessage([{ ...unread, reading: { ...unread.reading, provider: null } }, { ...read, reading: { ...read.reading, account_last4: "4415" } }]);
    expect(email).toContain("Hello Bayline Fiber billing team,");
    expect(email).toContain("Subject: Billing correction for account ending 4415");
    expect(complaint).toContain("Company: Bayline Fiber");
  });

  test("a month whose period end wasn't read is still named by the start date that was", () => {
    const started = month("2026-10-12", "2026-11-11");
    const { chat, email } = buildYearMessage([{ ...started, reading: { ...started.reading, period_end: null } }, month("2026-11-12", "2026-12-11")]);
    expect(chat).toContain("For the bill starting Oct 12, 2026, Fiber 500 Internet");
    expect(email).not.toContain("For this bill");
  });
});

describe("the complaint a regulator receives", () => {
  const plan: LineItem = { id: "L1", label: "Fiber 500 Internet", amount_cents: 7000, kind: "plan", page: 1, box: { x0: 80, y0: 400, x1: 920, y1: 420 }, quote: "Fiber 500 Internet $70.00", prorated: false };
  const gateway: LineItem = { id: "L2", label: "Wi-Fi Gateway Rental", amount_cents: 1500, kind: "equipment", page: 1, box: { x0: 80, y0: 440, x1: 920, y1: 460 }, quote: "Wi-Fi Gateway Rental $15.00", prorated: false };
  const price: PromiseTerm = { id: "P1", kind: "monthly_price", description: "", amount_cents: 5500, per_line: false, conditions: [], applies_from: null, applies_until: null, quote: "Monthly price: $55.00/mo with Autopay & Paperless (2-year price guarantee through 10/31/2027)", said_at_seconds: null, covers_line_ids: ["L1"] };
  const included: PromiseTerm = { id: "P2", kind: "included", description: "", amount_cents: null, per_line: false, conditions: [], applies_from: null, applies_until: null, quote: "Wi-Fi Gateway: included at no extra cost for as long as you keep Fiber 500", said_at_seconds: null, covers_line_ids: ["L2"] };
  const priceClaim: Checked["claims"][number] = { id: "C1", kind: "price_above_promise", lineIds: ["L1"], promiseId: "P1", actualCents: 7000, expectedCents: 5500, amountCents: 1500, needsConfirmation: false, lookedFor: null };
  const gatewayClaim: Checked["claims"][number] = { id: "C2", kind: "included_charged", lineIds: ["L2"], promiseId: "P2", actualCents: 1500, expectedCents: 0, amountCents: 1500, needsConfirmation: false, lookedFor: null };
  // Month m runs from the 12th to the 11th of the next month.
  const month = (m: number, claims: Checked["claims"]): Checked => {
    const base = billWith([plan, gateway]);
    const on = (mm: number, day: number) => `2026-${String(((mm - 1) % 12) + 1).padStart(2, "0")}-${day}`;
    return { ...base, reading: { ...base.reading, provider: "Bayline Fiber", account_last4: "4415", period_start: on(m, 12), period_end: on(m + 1, 11) }, promises: [price, included], questions: [], claims };
  };

  // The FCC's description box takes 2,000 characters and cuts off anything pasted past that, so a complaint leaves room
  // within it for what the person writes in place of the company's answer.
  test("a year with two claims every month still fits the FCC's description box, naming each month and the total", () => {
    const year = Array.from({ length: 12 }, (_, i) => month(i + 1, [priceClaim, gatewayClaim]));
    const { complaint } = buildYearMessage(year);
    expect(complaint.length).toBeLessThanOrEqual(1_700);
    for (const m of ["Jan 12, 2026", "Jun 12, 2026", "Dec 12, 2026"]) expect(complaint).toContain(m);
    expect(complaint).toContain("a credit of $360.00");
  });

  test("a month whose only claim is an included charge says which statement it is", () => {
    const { chat, complaint } = buildYearMessage([month(10, [priceClaim]), month(11, [gatewayClaim])]);
    expect(chat).toContain("For Nov 12, 2026 to Dec 11, 2026, I was charged $15.00 for Wi-Fi Gateway Rental");
    expect(complaint).toContain("For Nov 12, 2026 to Dec 11, 2026, I was charged $15.00 for Wi-Fi Gateway Rental");
  });

  test("a single bill's complaint names the bill for any claim, and holds only what goes to the regulator", () => {
    const { complaint } = buildMessage(month(11, [gatewayClaim]), new Set(["C2"]), new Set());
    expect(complaint).toContain("- For Nov 12, 2026 to Dec 11, 2026, I was charged $15.00 for Wi-Fi Gateway Rental");
    // Where to file is advice for the person, shown beside the complaint, not text the regulator receives.
    expect(complaint).not.toContain("consumercomplaints.fcc.gov");
  });

  // A photo can lose a statement's period and date yet keep its due date or its total, either of which the company
  // can find the statement by; "this bill" twice in one message tells it nothing.
  test("statements whose dates weren't read are named by their due date, else their total", () => {
    const undated = (m: number, reading: Partial<Checked["reading"]>) => {
      const base = month(m, [priceClaim]);
      return { ...base, reading: { ...base.reading, period_start: null, period_end: null, statement_date: null, ...reading } };
    };
    const due = undated(10, { due_date: "2026-11-05" });
    const total = undated(11, { printed: { ...due.reading.printed, current_charges: { cents: 9249, quote: "Current charges $92.49" } } });
    const { chat } = buildYearMessage([due, total]);
    expect(chat).toContain("For the bill due Nov 5, 2026, Fiber 500 Internet");
    expect(chat).toContain("For the $92.49 bill, Fiber 500 Internet");
    expect(buildMessage(due, new Set(["C1"]), new Set()).chat).toContain("I'm writing about account ending 4415, bill due Nov 5, 2026.");
  });
});
