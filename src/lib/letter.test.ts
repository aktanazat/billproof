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

// The total adds up the claims only, so it follows them: after the fee questions it read as if the fees were in it.
test("the total to credit follows the claims it adds up, before any fee question", () => {
  const run = JSON.parse(readFileSync(path.join(import.meta.dirname, "../../eval/run-2026-11-26.json"), "utf8")) as { raw: { id: string; variant?: string; events: CheckEvent[] }[] };
  const event = run.raw.find((r) => r.id === "internet-guaranteed" && r.variant === "pdf")?.events.find((e) => e.type === "result");
  if (event?.type !== "result" || event.result.outcome !== "checked") throw new Error("the saved run has no guaranteed-price result");
  const result = event.result;
  const message = buildMessage(result, new Set(result.claims.map((c) => c.id)), new Set(result.questions.map((q) => q.id)));
  for (const body of [message.chat, message.email, message.call]) {
    expect(body.indexOf("In total, please credit $30.00")).toBeGreaterThan(-1);
    expect(body.indexOf("In total, please credit $30.00")).toBeLessThan(body.indexOf("Please explain the Network Enhancement Fee"));
  }
  expect(message.call).toContain("In total, please credit $30.00 to account ending 4415.\n\n3. Please explain the Network Enhancement Fee");
  // The complaint goes on to state the fees too, so its problem names them after the claims.
  expect(message.complaint).toContain("Problem: billed more than I was promised, and fees on my bill I never agreed to.");
  expect(buildMessage(result, new Set(result.claims.map((c) => c.id)), new Set()).complaint).toContain("Problem: billed more than I was promised.");
  // And its resolution asks for the fees to be dealt with as well as the credit.
  expect(message.complaint).toContain("Resolution I'm asking for: a credit of $30.00, future bills charged as promised, and the other charges above corrected or explained in writing.");
  expect(buildMessage(result, new Set(result.claims.map((c) => c.id)), new Set()).complaint).toContain("Resolution I'm asking for: a credit of $30.00 and future bills charged as promised.");
  // The complaint names the bill's period on its first claim only, as the year's names each month's once.
  expect(message.complaint.match(/Nov 12, 2026 to Dec 11, 2026/g)).toHaveLength(1);
  expect(message.complaint).toContain("- I was charged $15.00 for Wi-Fi Gateway Rental, which was included at no extra cost");
});

// Read aloud on a call with the company, "on the call" sounds like this one; the script says the earlier call.
test("a call script cites what the representative said on an earlier call, not 'on the call'", () => {
  const run = JSON.parse(readFileSync(path.join(import.meta.dirname, "../../eval/run-2026-11-26.json"), "utf8")) as { raw: { id: string; events: CheckEvent[] }[] };
  const event = run.raw.find((r) => r.id === "call-two-years")?.events.find((e) => e.type === "result");
  if (event?.type !== "result" || event.result.outcome !== "checked") throw new Error("the saved run has no call result");
  const result = event.result;
  const message = buildMessage(result, new Set(result.claims.map((c) => c.id)), new Set());
  expect(message.call).toContain("your representative told me on an earlier call, at 0:11 in my recording");
  expect(message.call).not.toContain("on the call");
  expect(message.email).toContain("your representative told me on the call, at 0:11 in my recording");
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

  // Read aloud, a lone "1." has the caller looking for a point 2 that isn't there.
  test("a call script with one point leaves it unnumbered", () => {
    const message = buildMessage(result, new Set(), new Set(["Q1"]));
    expect(message.call).not.toMatch(/^1\. /m);
    expect(message.call).toMatch(/^Please explain /m);
  });

  test("the complaint states the fees as facts for the regulator, while the email asks the company", () => {
    const message = buildMessage(result, new Set(), new Set(["Q1", "Q2"]));
    expect(message.complaint).toContain("- The bill charges the Broadcast TV Fee ($47.23) and TV Access Fee ($14.00, charged 2 times), which were not part of the plan I agreed to.");
    expect(message.complaint).not.toContain("Please explain");
    expect(message.email).toContain("Please explain the Broadcast TV Fee ($47.23) and TV Access Fee ($14.00, charged 2 times).");
  });

  // A rise since the earlier bill is the first fact the regulator reads, so the problem names it too.
  test("a price rise is named in the complaint's problem, with the fees or alone", () => {
    const risen: Checked = { ...result, change: { earlierCents: 7249, currentCents: 9249, lines: [{ label: "Fiber 500 Internet", beforeCents: 5500, afterCents: 7500 }] } };
    expect(buildMessage(risen, new Set(), new Set(["Q1"])).complaint).toContain("Problem: a price increase and fees on my bill I never agreed to.");
    expect(buildMessage(risen, new Set(), new Set()).complaint).toContain("Problem: a price increase on my bill the company hasn't explained.");
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

  // The call script is read aloud to a representative, who has no "above" to look at.
  test("a year call script refers back to a promise as said, not as quoted above", () => {
    const { call } = buildYearMessage([month("2026-10-12", "2026-11-11"), month("2026-11-12", "2026-12-11")]);
    expect(call.match(/"Fiber 500 is \$55 a month"/g)).toHaveLength(1);
    expect(call).not.toContain("as quoted above");
    expect(call).toContain("confirmed at $55.00 a month (as I mentioned)");
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

// A year's statements usually all carry the same company fees. Its heading counts the statements with fees worth asking
// about, so its message asks about them too: once each, at what the latest statement charges, not once a month.
describe("a year message with fees to ask about", () => {
  const statement = (start: string, end: string, lines: LineItem[], questions: Checked["questions"]): Checked => {
    const base = billWith(lines);
    return { ...base, reading: { ...base.reading, provider: "Xfinity", account_last4: "2271", period_start: start, period_end: end }, questions };
  };
  const october = statement("2026-10-01", "2026-10-31", [fee("F1", "Broadcast TV Fee", 2950)], [{ id: "Q1", kind: "unagreed_fee", lineIds: ["F1"], promiseId: null }]);
  const november = statement("2026-11-01", "2026-11-30", [fee("F1", "Broadcast TV Fee", 3150), fee("F2", "Regional Sports Fee", 1986)], [
    { id: "Q1", kind: "unagreed_fee", lineIds: ["F1"], promiseId: null },
    { id: "Q2", kind: "unagreed_fee", lineIds: ["F2"], promiseId: null },
  ]);

  test("asks about each fee once, at the latest statement's amount, and asks for no credit", () => {
    const message = buildYearMessage([october, november]);
    expect(message.chat).toContain("Please explain the Broadcast TV Fee ($31.50) and Regional Sports Fee ($19.86).");
    expect(message.chat.match(/Broadcast TV Fee/g)).toHaveLength(1);
    expect(message.email).toMatch(/^Subject: Questions about the charges on account ending 2271\n/);
    expect(`${message.email}\n${message.call}`).not.toContain("the date the credit will post");
    expect(message.complaint).toContain("Problem: fees on my bill I never agreed to.");
  });

  test("follows the month-by-month claims when there are claims too", () => {
    const claimed: Checked = { ...november, claims: [{ id: "C1", kind: "price_above_promise", lineIds: ["F2"], promiseId: "P1", actualCents: 1986, expectedCents: 0, amountCents: 1986, needsConfirmation: false, lookedFor: null }], promises: [{ id: "P1", kind: "included", description: "", amount_cents: 0, per_line: false, conditions: [], applies_from: null, applies_until: null, quote: "Sports included", said_at_seconds: null, covers_line_ids: ["F2"] }], questions: [november.questions[0]] };
    const { chat } = buildYearMessage([october, claimed]);
    expect(chat.indexOf("Please explain the Broadcast TV Fee ($31.50).")).toBeGreaterThan(chat.indexOf("For Nov 1, 2026 to Nov 30, 2026"));
  });

  // A charge printed twice is one statement's, so the year message asks about it under that statement's period.
  test("a charge printed twice on one statement is asked about under that statement", () => {
    const doubled = statement("2026-11-01", "2026-11-30", [fee("F1", "Modem Rental", 1500), fee("F2", "Modem Rental", 1500)], [{ id: "Q1", kind: "repeated_charge", lineIds: ["F1", "F2"], promiseId: null }]);
    const message = buildYearMessage([october, doubled]);
    expect(message.chat).toContain("On the bill for Nov 1, 2026 to Nov 30, 2026, Modem Rental appears 2 times on the bill ($15.00 and $15.00). Please confirm whether this is a duplicate and credit it if so.");
    expect(message.complaint).toContain("On the bill for Nov 1, 2026 to Nov 30, 2026, Modem Rental appears 2 times");
  });

  // A statement with no dates, due date or printed total can't be named, so the charge alone is asked about, without
  // "On the bill for this bill"; one with a due date is named by it.
  test("a charge printed twice on a statement that can't be named reads plainly", () => {
    const doubled = (reading: Partial<Checked["reading"]>) => {
      const base = statement("2026-11-01", "2026-11-30", [fee("F1", "Modem Rental", 1500), fee("F2", "Modem Rental", 1500)], [{ id: "Q1", kind: "repeated_charge", lineIds: ["F1", "F2"], promiseId: null }]);
      return { ...base, reading: { ...base.reading, period_start: null, period_end: null, ...reading } };
    };
    const unnamed = buildYearMessage([october, doubled({})]);
    expect(unnamed.chat).not.toContain("this bill");
    expect(unnamed.chat).toContain("Modem Rental appears 2 times on one bill ($15.00 and $15.00).");
    expect(buildYearMessage([october, doubled({ due_date: "2026-12-05" })]).chat).toContain("On the bill due Dec 5, 2026, Modem Rental appears 2 times");
  });

  // Without an offer from this company there was no plan to check the statements against, so the opening doesn't say so.
  test("a year checked without an offer doesn't open by saying it was checked against the plan", () => {
    const noOffer = buildYearMessage([{ ...october, hadOffer: false }, { ...november, hadOffer: false }]);
    expect(`${noOffer.chat}\n${noOffer.email}`).not.toContain("against the plan I signed up for");
    expect(noOffer.chat).toMatch(/^Hi, I'm writing about account ending 2271\.\n/);
    expect(buildYearMessage([october, november]).chat).toContain("I checked my statements against the plan I signed up for.");
  });

  // A year's complaint covers many statements, so its fees are said of the statements, not of "the bill".
  test("a year complaint says its fees are on the statements", () => {
    const { complaint } = buildYearMessage([october, november]);
    expect(complaint).toContain("- My statements charge the Broadcast TV Fee ($31.50) and Regional Sports Fee ($19.86), which were not part of the plan I agreed to.");
  });

  // With claims and fees together, the reply asked for covers both: the credit, and an answer about the fees.
  test("an email with claims and fees asks for the credit and for an answer about the fees", () => {
    const claimed: Checked = { ...november, claims: [{ id: "C1", kind: "price_above_promise", lineIds: ["F2"], promiseId: "P1", actualCents: 1986, expectedCents: 0, amountCents: 1986, needsConfirmation: false, lookedFor: null }], promises: [{ id: "P1", kind: "included", description: "", amount_cents: 0, per_line: false, conditions: [], applies_from: null, applies_until: null, quote: "Sports included", said_at_seconds: null, covers_line_ids: ["F2"] }], questions: [november.questions[0]] };
    const reply = "Please reply with the corrected amount, the date the credit will post, and an explanation of the charges I asked about.";
    expect(buildMessage(claimed, new Set(["C1"]), new Set(["Q1"])).email).toContain(reply);
    expect(buildYearMessage([october, claimed]).email).toContain(reply);
    expect(buildMessage(claimed, new Set(["C1"]), new Set()).email).toContain("Please reply with the corrected amount and the date the credit will post.");
    // The call script ends the same way: the credit's date, and what the fee answers change.
    const close = "Before ending the call, ask for a reference number, the date the credit will post, and what will change on the next bill.";
    expect(buildMessage(claimed, new Set(["C1"]), new Set(["Q1"])).call).toContain(close);
    expect(buildYearMessage([october, claimed]).call).toContain(close);
    expect(buildMessage(claimed, new Set(["C1"]), new Set()).call).toContain("Before ending the call, ask for a reference number and the date the credit will post.");
  });

  // A month whose pictures held an earlier statement can show a rise; the year message asks about it under that month,
  // as the month's own message does, and the complaint states it.
  test("a month's rise since the bill before is asked about in the year message", () => {
    const risen: Checked = { ...november, questions: [], change: { earlierCents: 6000, currentCents: 8000, lines: [{ label: "Fiber 500 Internet", beforeCents: 5500, afterCents: 7500 }] } };
    const message = buildYearMessage([{ ...october, questions: [] }, risen]);
    expect(message.chat).toContain("The bill for Nov 1, 2026 to Nov 30, 2026 is $20.00 higher than the one before: Fiber 500 Internet went from $55.00 to $75.00. Please explain the increase and correct anything I didn't agree to.");
    expect(message.email).toMatch(/^Subject: Questions about the charges on /);
    expect(message.complaint).toContain("- The bill for Nov 1, 2026 to Nov 30, 2026 is $20.00 higher than the one before");
    expect(message.complaint).toContain("Problem: a price increase on my bill the company hasn't explained.");
  });
});
