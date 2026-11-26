import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";
import { initialState, reduce, type CheckState } from "@/lib/check-machine";
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

  test("with no offer, or another company's, a fee is titled as one the company added, not as missing from the offer", () => {
    const result = checked([line("L1", "Entertainment", 12200, "plan"), line("F1", "Broadcast TV Fee", 2150, "company_fee")], [{ id: "Q1", kind: "unagreed_fee", lineIds: ["F1"], promiseId: null }]);
    for (const unrelated of [{ ...result, hadOffer: false }, { ...result, providerMismatch: true, offerProvider: "Westline Cable" }]) {
      const html = page(unrelated);
      expect(html).toContain("Broadcast TV Fee is a fee the company added");
      expect(html).not.toContain("isn't in your offer");
    }
  });

  test("a charge listed twice shows what one copy costs, since only the extra copy is in question", () => {
    const lines = [line("L1", "Boost Protect", 1800, "other"), line("L2", "Boost Protect", 1800, "other")];
    const t = page(checked(lines, [{ id: "Q1", kind: "repeated_charge", lineIds: ["L1", "L2"], promiseId: null }])).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
    expect(t).toContain("Boost Protect is charged 2 times $18.00 each");
    expect(t).not.toContain("$36.00");
  });

  test("unticking a question takes it out of the message, and unticking every one removes the message", () => {
    const lines = [line("L1", "Entertainment", 12200, "plan"), line("F1", "Broadcast TV Fee", 2150, "company_fee"), line("F2", "Regional Sports Fee", 1986, "company_fee")];
    const result = checked(lines, [
      { id: "Q1", kind: "unagreed_fee", lineIds: ["F1"], promiseId: null },
      { id: "Q2", kind: "unagreed_fee", lineIds: ["F2"], promiseId: null },
    ]);
    const after = (...ids: string[]) => {
      const running = { s: "running", inputs: initialState.inputs, attempts: 1, attempt: 1, stage: null, spentMicros: 0, live: {} } as unknown as CheckState;
      const done = ids.reduce((state, id) => reduce(state, { type: "toggle_question", bill: 0, id }), reduce(running, { type: "finished", attempt: 1, result }));
      if (done.s !== "done") throw new Error("the finished check did not become a done state");
      return page(result, done.selections[0]);
    };
    expect(after()).toContain("Please explain the Broadcast TV Fee ($21.50) and Regional Sports Fee ($19.86).");
    expect(after("Q2")).toContain("Please explain the Broadcast TV Fee ($21.50). It was not part of the plan I agreed to");
    expect(after("Q2")).not.toContain("Regional Sports Fee ($19.86)");
    expect(after("Q1", "Q2")).not.toContain("Message to send");
  });

  test("confirming the marked line drops 'once you confirm' from the heading and puts the claim in the message", () => {
    const promise: Checked["promises"][number] = { id: "P1", kind: "recurring_credit", description: "", amount_cents: 750, per_line: false, conditions: [], applies_from: null, applies_until: null, quote: "-$7.50 per line", said_at_seconds: null, covers_line_ids: ["L1"] };
    const result: Checked = {
      ...checked([line("L1", "Number share plan", 1500, "plan")], []),
      promises: [promise],
      matchedPromiseIds: ["P1"],
      claims: [{ id: "C1", kind: "credit_missing", lineIds: ["L1"], promiseId: "P1", actualCents: 0, expectedCents: 750, amountCents: 750, needsConfirmation: true, lookedFor: null }],
    };
    const running = { s: "running", inputs: initialState.inputs, attempts: 1, attempt: 1, stage: null, spentMicros: 0, live: {} } as unknown as CheckState;
    const waiting = reduce(running, { type: "finished", attempt: 1, result });
    const confirmed = reduce(waiting, { type: "confirm_claim", bill: 0, id: "C1" });
    if (waiting.s !== "done" || confirmed.s !== "done") throw new Error("the finished check did not become a done state");
    const before = page(result, waiting.selections[0]);
    expect(before).toContain("to ask back from AT&T, once you confirm the marked line<");
    expect(before).not.toContain("Message to send");
    const after = page(result, confirmed.selections[0]);
    expect(after).toContain("to ask back from AT&T<");
    expect(after.replace(/&quot;/g, '"')).toContain('This bill has no $7.50 monthly credit I was promised ("-$7.50 per line"). Please apply the missing $7.50.');
  });

  test("unticking one of two claims lowers the heading total and takes that claim and the total line out of the message", () => {
    const price: Checked["promises"][number] = { id: "P1", kind: "monthly_price", description: "", amount_cents: 5500, per_line: false, conditions: [], applies_from: null, applies_until: null, quote: "$55 a month", said_at_seconds: null, covers_line_ids: ["L1"] };
    const gateway: Checked["promises"][number] = { id: "P2", kind: "included", description: "", amount_cents: 0, per_line: false, conditions: [], applies_from: null, applies_until: null, quote: "Wi-Fi Gateway included", said_at_seconds: null, covers_line_ids: ["L2"] };
    const result: Checked = {
      ...checked([line("L1", "Fiber 500 Internet", 7000, "plan"), line("L2", "Wi-Fi Gateway Rental", 1500, "equipment")], []),
      promises: [price, gateway],
      matchedPromiseIds: ["P1", "P2"],
      claims: [
        { id: "C1", kind: "price_above_promise", lineIds: ["L1"], promiseId: "P1", actualCents: 7000, expectedCents: 5500, amountCents: 1500, needsConfirmation: false, lookedFor: null },
        { id: "C2", kind: "included_charged", lineIds: ["L2"], promiseId: "P2", actualCents: 1500, expectedCents: 0, amountCents: 1500, needsConfirmation: false, lookedFor: null },
      ],
    };
    const running = { s: "running", inputs: initialState.inputs, attempts: 1, attempt: 1, stage: null, spentMicros: 0, live: {} } as unknown as CheckState;
    const both = reduce(running, { type: "finished", attempt: 1, result });
    const one = reduce(both, { type: "toggle_claim", bill: 0, id: "C2" });
    if (both.s !== "done" || one.s !== "done") throw new Error("the finished check did not become a done state");
    const before = page(result, both.selections[0]);
    expect(before).toMatch(/>\$30\.00<\/p><h1[^>]*>to ask back from AT&T</);
    expect(before).toContain("In total, please credit $30.00 to my account.");
    const after = page(result, one.selections[0]);
    expect(after).toMatch(/>\$15\.00<\/p><h1[^>]*>to ask back from AT&T</);
    expect(after).not.toContain("I was charged $15.00 for Wi-Fi Gateway Rental");
    expect(after).not.toContain("In total");
    expect(after).toContain("Fiber 500 Internet comes to $70.00, but my plan was confirmed at $55.00 a month");
  });

  test("the page shows the picture the check sorted as the bill, not the first one in the pile", () => {
    const picture = (name: string) => ({ image: `data:image/png;base64,${name}`, text: null, rows: null });
    const result: Checked = { ...checked([line("L1", "Internet 1000", 8000, "plan")], []), billPages: [1] };
    const html = renderToStaticMarkup(createElement(ResultView, { result, bill: 0, pages: [picture("Q0hBVA=="), picture("QklMTA==")], callUrl: null, selection: { claims: {}, questions: {} }, dispatch: () => {}, backLabel: "Check another bill", onBack: () => {} }));
    expect(html).toContain("data:image/png;base64,QklMTA==");
    expect(html).not.toContain("data:image/png;base64,Q0hBVA==");
    expect(html).toContain("Read 1 of the 2 pictures as this bill; the other one was read as the offer or an earlier bill, or set aside.");
    const single = renderToStaticMarkup(createElement(ResultView, { result: { ...result, billPages: [0] }, bill: 0, pages: [picture("QklMTA==")], callUrl: null, selection: { claims: {}, questions: {} }, dispatch: () => {}, backLabel: "Check another bill", onBack: () => {} }));
    expect(single).not.toContain("pictures as this bill");
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

  test("a call transcript counts its lines rather than showing when the last one starts, and names who spoke", () => {
    const promise: Checked["promises"][number] = { id: "P1", kind: "monthly_price", description: "", amount_cents: 5500, per_line: false, conditions: [], applies_from: null, applies_until: null, quote: "Fiber 500 is $55 a month", said_at_seconds: 11, covers_line_ids: ["L1"] };
    const result: Checked = {
      ...checked([line("L1", "Fiber 500 Internet", 7000, "plan")], []),
      promises: [promise],
      matchedPromiseIds: ["P1"],
      claims: [{ id: "C1", kind: "price_above_promise", lineIds: ["L1"], promiseId: "P1", actualCents: 7000, expectedCents: 5500, amountCents: 1500, needsConfirmation: false, lookedFor: null }],
      transcript: [
        { speaker: "company", start_seconds: 0, text: "Thanks for calling." },
        { speaker: "customer", start_seconds: 6, text: "How much is Fiber 500?" },
        { speaker: "company", start_seconds: 22, text: "Fiber 500 is $55 a month." },
      ],
    };
    const t = text(page(result, { claims: { C1: "selected" }, questions: {} }));
    expect(t).toContain("Call transcript 3 lines");
    expect(t).not.toContain("Call transcript 0:22");
    expect(t).toContain("AT&T: Thanks for calling.");
    expect(t).toContain("You: How much is Fiber 500?");
  });

  test("a picture that isn't a bill, or a bill that can't be read, says what to add instead", () => {
    const render = (result: Parameters<typeof ResultView>[0]["result"]) => text(renderToStaticMarkup(createElement(ResultView, { result, bill: 0, pages: [], callUrl: null, selection: { claims: {}, questions: {} }, dispatch: () => {}, backLabel: "Check another bill", onBack: () => {} })).replace(/&#x27;/g, "'"));
    expect(render({ outcome: "not_a_bill", spentMicros: 0 })).toContain("This isn't a bill Add the statement itself: the PDF, or screenshots of the page that shows the billing period and each charge.");
    const unread = render({ outcome: "could_not_check", reason: "The page image is entirely black.", spentMicros: 0 });
    expect(unread).toContain("Couldn't check this bill The page image is entirely black. Try the PDF from the company's website, or screenshots that show every charge and the total, uncropped.");
  });
});
