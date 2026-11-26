import { readFileSync } from "node:fs";
import path from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";
import { initialState, reduce, type CheckState } from "@/lib/check-machine";
import { checkTotals } from "@/lib/decide";
import type { CheckEvent, CheckResult, Checked, SingleResult } from "@/lib/result";
import type { LineItem, Reading } from "@/lib/schemas";
import { ResultView } from "./result-view";
import { YearView } from "./year-view";

// Every result of the 2026-11-26 test-set run, as its page shows it once the check finishes: no placeholder leaks into
// the text, and one of something is never written with a plural.
test("no result page from a saved result shows a placeholder or '1' before a plural", () => {
  const run = JSON.parse(readFileSync(path.join(import.meta.dirname, "../../eval/run-2026-11-26.json"), "utf8")) as { raw: { id: string; events: CheckEvent[] }[] };
  const done = (result: CheckResult) => {
    const running = { s: "running", inputs: initialState.inputs, attempts: 1, attempt: 1, stage: null, spentMicros: 0, live: {} } as unknown as CheckState;
    const state = reduce(running, { type: "finished", attempt: 1, result });
    if (state.s !== "done") throw new Error("the finished check did not become a done state");
    return state;
  };
  const single = (result: SingleResult) => renderToStaticMarkup(createElement(ResultView, { result, bill: 0, pages: [], omittedPages: { bill: 0, offer: 0 }, callUrl: null, selection: done(result).selections[0], dispatch: () => {}, backLabel: "Check another bill", onBack: () => {} }));
  const pages = run.raw.flatMap((entry) => {
    const event = entry.events.find((e) => e.type === "result");
    if (event?.type !== "result") return [];
    if (event.result.outcome !== "year") return [single(event.result)];
    const year = renderToStaticMarkup(createElement(YearView, { state: done(event.result), result: event.result, dispatch: () => {} }));
    return [year, ...event.result.months.map((month) => single(month.result))];
  });
  expect(pages.length).toBeGreaterThan(30);
  const words = pages.map((html) => html.replace(/<!-- -->/g, "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " "));
  const slips = words.flatMap((page) => [...page.matchAll(/\bundefined\b|\bNaN\b|\bnull\b|\[object|\b1 (?:charges|lines|months|statements|times|fees|credits|bills|pages|promises|pictures)\b/g)].map((m) => page.slice(Math.max(0, m.index - 40), m.index + 30)));
  expect(slips).toEqual([]);
});

// The result replaces the check screen, so its heading (with the amount to ask back, when there is one) takes focus
// when it appears: a screen reader reads it, and the keyboard continues from there. That needs an element that allows
// focus, either the heading or the block holding it, before any other text on the page.
test("every result's heading, and the year's, sits in an element that can take focus when the result appears", () => {
  const run = JSON.parse(readFileSync(path.join(import.meta.dirname, "../../eval/run-2026-11-26.json"), "utf8")) as { raw: { id: string; variant?: string; events: CheckEvent[] }[] };
  const resultOf = (id: string, variant?: string) => run.raw.find((r) => r.id === id && (!variant || r.variant === variant))?.events.find((e) => e.type === "result");
  const done = (result: CheckResult) => {
    const running = { s: "running", inputs: initialState.inputs, attempts: 1, attempt: 1, stage: null, spentMicros: 0, live: {} } as unknown as CheckState;
    const state = reduce(running, { type: "finished", attempt: 1, result });
    if (state.s !== "done") throw new Error("the finished check did not become a done state");
    return state;
  };
  const single = (result: SingleResult) => renderToStaticMarkup(createElement(ResultView, { result, bill: 0, pages: [], omittedPages: { bill: 0, offer: 0 }, callUrl: null, selection: done(result).selections[0], dispatch: () => {}, backLabel: "Check another bill", onBack: () => {} }));
  const claims = resultOf("internet-guaranteed", "pdf");
  const verdict = resultOf("internet-expired", "pdf");
  const year = resultOf("year-12");
  if (claims?.type !== "result" || claims.result.outcome !== "checked" || verdict?.type !== "result" || verdict.result.outcome !== "checked" || year?.type !== "result" || year.result.outcome !== "year") throw new Error("missing saved results");
  const pages = [single(claims.result), single(verdict.result), single({ outcome: "not_a_bill", spentMicros: 0 }), renderToStaticMarkup(createElement(YearView, { state: done(year.result), result: year.result, dispatch: () => {} }))];
  for (const html of pages) {
    const target = html.indexOf('tabindex="-1"');
    expect(target).toBeGreaterThan(-1);
    expect(target).toBeLessThan(html.indexOf(">", html.indexOf("<h1")));
    expect(html.slice(html.lastIndexOf("<", target), target)).toMatch(/^<(h1|div)\b/);
  }
});

// Screen reader users move through a page by its headings, so the main heading of a result with money to ask back
// says the amount itself, not only the words beside it.
test("the main heading of a result with money to ask back, single or year, names the amount", () => {
  const run = JSON.parse(readFileSync(path.join(import.meta.dirname, "../../eval/run-2026-11-26.json"), "utf8")) as { raw: { id: string; variant?: string; events: CheckEvent[] }[] };
  const resultOf = (id: string, variant?: string) => run.raw.find((r) => r.id === id && (!variant || r.variant === variant))?.events.find((e) => e.type === "result");
  const done = (result: CheckResult) => {
    const running = { s: "running", inputs: initialState.inputs, attempts: 1, attempt: 1, stage: null, spentMicros: 0, live: {} } as unknown as CheckState;
    const state = reduce(running, { type: "finished", attempt: 1, result });
    if (state.s !== "done") throw new Error("the finished check did not become a done state");
    return state;
  };
  const claims = resultOf("internet-guaranteed", "pdf");
  const year = resultOf("year-12");
  if (claims?.type !== "result" || claims.result.outcome !== "checked" || year?.type !== "result" || year.result.outcome !== "year") throw new Error("missing saved results");
  const pages = [
    renderToStaticMarkup(createElement(ResultView, { result: claims.result, bill: 0, pages: [], omittedPages: { bill: 0, offer: 0 }, callUrl: null, selection: done(claims.result).selections[0], dispatch: () => {}, backLabel: "Check another bill", onBack: () => {} })),
    renderToStaticMarkup(createElement(YearView, { state: done(year.result), result: year.result, dispatch: () => {} })),
  ];
  const headings = pages.map((html) => html.match(/<h1\b[^>]*>([\s\S]*?)<\/h1>/)?.[1].replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim());
  expect(headings).toEqual([expect.stringMatching(/^\$\d[\d,]*\.\d\d to ask back from \S/), expect.stringMatching(/^\$\d[\d,]*\.\d\d to ask back from \S/)]);
});

// HTML lets a button hold only inline content, and a tab must name the panel it shows; otherwise browsers repair the
// markup their own ways and screen readers announce tabs that lead nowhere. Checked on every saved result page.
test("every saved result page keeps its buttons to inline content and gives each tab its panel", () => {
  const run = JSON.parse(readFileSync(path.join(import.meta.dirname, "../../eval/run-2026-11-26.json"), "utf8")) as { raw: { id: string; events: CheckEvent[] }[] };
  const done = (result: CheckResult) => {
    const running = { s: "running", inputs: initialState.inputs, attempts: 1, attempt: 1, stage: null, spentMicros: 0, live: {} } as unknown as CheckState;
    const state = reduce(running, { type: "finished", attempt: 1, result });
    if (state.s !== "done") throw new Error("the finished check did not become a done state");
    return state;
  };
  const pages = run.raw.flatMap((entry) => {
    const event = entry.events.find((e) => e.type === "result");
    if (event?.type !== "result") return [];
    if (event.result.outcome === "year") return [renderToStaticMarkup(createElement(YearView, { state: done(event.result), result: event.result, dispatch: () => {} }))];
    if (event.result.outcome !== "checked") return [];
    return [renderToStaticMarkup(createElement(ResultView, { result: event.result, bill: 0, pages: [], omittedPages: { bill: 0, offer: 0 }, callUrl: null, selection: done(event.result).selections[0], dispatch: () => {}, backLabel: "Check another bill", onBack: () => {} }))];
  });
  expect(pages.length).toBeGreaterThan(20);
  for (const html of pages) {
    const blocks = [...html.matchAll(/<button\b[^>]*>([\s\S]*?)<\/button>/g)].filter((m) => /<(div|p|section|ul|ol|li|h[1-6]|table)\b/.test(m[1]));
    expect(blocks.map((m) => m[0].slice(0, 80))).toEqual([]);
    const panels = new Set([...html.matchAll(/<[^>]*role="tabpanel"[^>]*>/g)].map((m) => m[0].match(/\bid="([^"]+)"/)?.[1]));
    const tabs = [...html.matchAll(/<[^>]*role="tab"[^>]*>/g)].map((m) => m[0].match(/aria-controls="([^"]+)"/)?.[1]);
    expect(tabs.filter((target) => !target || !panels.has(target))).toEqual([]);
  }
});

// Each charge and question has its own "In message" or "Ask in message" box; a screen reader listing them hears only
// that, over and over, unless each also names its row. The name starts with the words shown, for voice control.
test("each charge's and question's control is named after its row, starting with the words shown", () => {
  const run = JSON.parse(readFileSync(path.join(import.meta.dirname, "../../eval/run-2026-11-26.json"), "utf8")) as { raw: { id: string; variant?: string; events: CheckEvent[] }[] };
  const event = run.raw.find((r) => r.id === "internet-guaranteed" && r.variant === "pdf")?.events.find((e) => e.type === "result");
  if (event?.type !== "result" || event.result.outcome !== "checked") throw new Error("missing saved result");
  const running = { s: "running", inputs: initialState.inputs, attempts: 1, attempt: 1, stage: null, spentMicros: 0, live: {} } as unknown as CheckState;
  const done = reduce(running, { type: "finished", attempt: 1, result: event.result });
  if (done.s !== "done") throw new Error("the finished check did not become a done state");
  const html = renderToStaticMarkup(createElement(ResultView, { result: event.result, bill: 0, pages: [], omittedPages: { bill: 0, offer: 0 }, callUrl: null, selection: done.selections[0], dispatch: () => {}, backLabel: "Check another bill", onBack: () => {} }));
  const boxes = [...html.matchAll(/(<input\b[^>]*type="checkbox"[^>]*>)([^<]*)/g)].map((m) => ({ name: m[1].match(/aria-label="([^"]*)"/)?.[1] ?? m[2].trim(), shown: m[2].trim() }));
  expect(boxes.length).toBe(event.result.claims.length + event.result.questions.length);
  expect(new Set(boxes.map((box) => box.name)).size).toBe(boxes.length);
  for (const box of boxes) expect(box.name.startsWith(`${box.shown}: `)).toBe(true);
});

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
  renderToStaticMarkup(createElement(ResultView, { result, bill: 0, pages: [], omittedPages: { bill: 0, offer: 0 }, callUrl: null, selection, dispatch: () => {}, backLabel: "Check another bill", onBack: () => {} })).replace(/&#x27;/g, "'").replace(/&amp;/g, "&");

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
    expect(before.match(/<h1\b[^>]*>([\s\S]*?)<\/h1>/)?.[1].replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim()).toBe("$30.00 to ask back from AT&T");
    expect(before).toContain("In total, please credit $30.00 to my account.");
    const after = page(result, one.selections[0]);
    expect(after.match(/<h1\b[^>]*>([\s\S]*?)<\/h1>/)?.[1].replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim()).toBe("$15.00 to ask back from AT&T");
    expect(after).not.toContain("I was charged $15.00 for Wi-Fi Gateway Rental");
    expect(after).not.toContain("In total");
    expect(after).toContain("Fiber 500 Internet comes to $70.00, but my plan was confirmed at $55.00 a month");
  });

  test("the page shows the picture the check sorted as the bill, not the first one in the pile", () => {
    const picture = (name: string) => ({ image: `data:image/png;base64,${name}`, text: null, rows: null });
    const result: Checked = { ...checked([line("L1", "Internet 1000", 8000, "plan")], []), billPages: [1] };
    const html = renderToStaticMarkup(createElement(ResultView, { result, bill: 0, pages: [picture("Q0hBVA=="), picture("QklMTA==")], omittedPages: { bill: 0, offer: 0 }, callUrl: null, selection: { claims: {}, questions: {} }, dispatch: () => {}, backLabel: "Check another bill", onBack: () => {} }));
    expect(html).toContain("data:image/png;base64,QklMTA==");
    expect(html).not.toContain("data:image/png;base64,Q0hBVA==");
    expect(html).toContain("Read 1 of the 2 pictures as this bill; the other one was read as the offer or an earlier bill, or set aside.");
    const single = renderToStaticMarkup(createElement(ResultView, { result: { ...result, billPages: [0] }, bill: 0, pages: [picture("QklMTA==")], omittedPages: { bill: 0, offer: 0 }, callUrl: null, selection: { claims: {}, questions: {} }, dispatch: () => {}, backLabel: "Check another bill", onBack: () => {} }));
    expect(single).not.toContain("pictures as this bill");
    expect(single).not.toContain("pages of this PDF");
  });

  test("a long PDF read from its first pages, bill or offer, says how many were left out", () => {
    const pdfPage = (n: number) => ({ image: `data:image/png;base64,UA${n}`, text: "Bayline Fiber", rows: null });
    const result: Checked = { ...checked([line("L1", "Internet 1000", 8000, "plan")], []), billPages: [0, 1, 2, 3, 4, 5] };
    const render = (omittedPages: { bill: number; offer: number }) => renderToStaticMarkup(createElement(ResultView, { result, bill: 0, pages: [0, 1, 2, 3, 4, 5].map(pdfPage), omittedPages, callUrl: null, selection: { claims: {}, questions: {} }, dispatch: () => {}, backLabel: "Check another bill", onBack: () => {} }));
    expect(render({ bill: 3, offer: 0 })).toContain("Read the first 6 of 9 pages of this PDF; charges on the rest aren&#x27;t included.");
    const offer = render({ bill: 0, offer: 3 });
    expect(offer).toContain("Read the first 4 of 7 pages of the offer; promises on the rest aren&#x27;t included.");
    expect(offer).not.toContain("pages of this PDF");
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

  // A price too far from the promise to claim is judged against the promise, so the note shows what was promised.
  test("a price too far from the promise to claim shows the promise beside it", () => {
    const result: Checked = {
      ...checked([line("L1", "Fiber 1 Gig", 12000, "plan")], [{ id: "Q1", kind: "price_gap", lineIds: ["L1"], promiseId: "P1" }]),
      promises: [{ id: "P1", kind: "monthly_price", description: "", amount_cents: 3000, per_line: false, conditions: [], applies_from: null, applies_until: null, quote: "Fiber 300 for $30 a month", said_at_seconds: null, covers_line_ids: ["L1"] }],
    };
    const html = page(result);
    expect(html).toContain("Fiber 1 Gig is too far from the promised amount to claim");
    expect(html).toContain("Promised: “Fiber 300 for $30 a month”");
  });

  // Every note judged against a promise shows it: its dates for one starting, ending or of unread end, its conditions
  // for one the bill doesn't show are met. A fee or a repeat has no promise and shows none.
  test("each note tied to a promise shows the promise, and a fee note shows none", () => {
    const promise = { id: "P1", kind: "monthly_price" as const, description: "", amount_cents: 3000, per_line: false, conditions: ["autopay" as const], applies_from: null, applies_until: null, quote: "$30 a month with autopay for 12 months", said_at_seconds: null, covers_line_ids: ["L1"] };
    for (const kind of ["end_date_unread", "partial_period", "conditions_unproven"] as const) {
      const result: Checked = { ...checked([line("L1", "Fiber 300", 3000, "plan")], [{ id: "Q1", kind, lineIds: ["L1"], promiseId: "P1" }]), promises: [promise] };
      expect(page(result), kind).toContain("Promised: “$30 a month with autopay for 12 months”");
    }
    const fee: Checked = { ...checked([line("L1", "Fiber 300", 3000, "plan"), line("F1", "Network Fee", 399, "company_fee")], [{ id: "Q1", kind: "unagreed_fee", lineIds: ["F1"], promiseId: null }]), promises: [promise] };
    expect(page(fee)).not.toContain("Promised:");
  });

  // A promise heard on a call can be played from where it was said, under a note as under a claim.
  test("a note's promise heard on a call can be played from the moment it was said", () => {
    const promise = { id: "P1", kind: "monthly_price" as const, description: "", amount_cents: 3000, per_line: false, conditions: [], applies_from: null, applies_until: null, quote: "$30 a month for 12 months", said_at_seconds: 13, covers_line_ids: ["L1"] };
    const result: Checked = {
      ...checked([line("L1", "Fiber 300", 3000, "plan")], [{ id: "Q1", kind: "partial_period", lineIds: ["L1"], promiseId: "P1" }]),
      promises: [promise],
      transcript: [
        { speaker: "company", start_seconds: 13, text: "$30 a month for 12 months." },
        { speaker: "customer", start_seconds: 20, text: "Thanks." },
      ],
    };
    expect(page(result)).toContain('aria-label="Play what was said at 0:13"');
  });
});

describe("the result page's heading", () => {
  const plan = line("L1", "Internet 1000", 8000, "plan");
  const promise: Checked["promises"][number] = { id: "P1", kind: "monthly_price", description: "", amount_cents: 7000, per_line: false, conditions: [], applies_from: null, applies_until: null, quote: "$70 a month", said_at_seconds: null, covers_line_ids: ["L1"] };
  // The result's header as read: its heading (with the amount, when there is one) and the lines under it.
  const heading = (result: Checked, selection?: Parameters<typeof ResultView>[0]["selection"]) =>
    page(result, selection).match(/<header\b[\s\S]*?<\/header>/)?.[0].replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim() ?? "";

  test.each([
    ["no offer was given", { ...checked([plan], []), hadOffer: false }, "Nothing to flag on this bill"],
    ["the offer is another company's", { ...checked([plan], []), providerMismatch: true, offerProvider: "Westline Cable" }, "The offer is from Westline Cable, not AT&T"],
    ["one question is worth asking", checked([plan, line("F1", "Network Fee", 399, "company_fee")], [{ id: "Q1", kind: "unagreed_fee", lineIds: ["F1"], promiseId: null }]), "1 charge worth asking about"],
    ["no promise matched a line", { ...checked([plan], []), promises: [promise] }, "Couldn't match your offer to this bill"],
    ["every promise was kept", { ...checked([plan], []), promises: [promise], matchedPromiseIds: ["P1"] }, "Nothing is billed above your offer"],
    // A rise since the earlier bill is what the page's message asks about, so the heading can't say there's nothing.
    ["the bill rose and there was no offer", { ...checked([plan], []), hadOffer: false, change: { earlierCents: 6000, currentCents: 8000, lines: [{ label: "Internet", beforeCents: 6000, afterCents: 8000 }] } }, "This bill is $20.00 higher than the one before"],
    ["the bill rose though the offer matches", { ...checked([plan], []), promises: [promise], matchedPromiseIds: ["P1"], change: { earlierCents: 6000, currentCents: 8000, lines: [{ label: "Internet", beforeCents: 6000, afterCents: 8000 }] } }, "This bill is $20.00 higher than the one before"],
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

  // Lines can move while the total stays put; "Up $0.00" says it rose when it didn't.
  test("a bill with the same total but changed lines says the total is the same", () => {
    const result: Checked = { ...checked([line("L1", "Plan", 5000, "plan")], []), change: { earlierCents: 6000, currentCents: 6000, lines: [{ label: "Plan", beforeCents: 5000, afterCents: 6000 }, { label: "Discount", beforeCents: 1000, afterCents: 0 }] } };
    const t = text(page(result));
    expect(t).not.toContain("Up $0.00");
    expect(t).toContain("Same total as the earlier bill");
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

  // An ended promise is the whole reason a charge has no claim; heard on a call, it can be played like a claim's quote,
  // rather than found again in the transcript.
  test("an ended promise from a call can be played from the moment it was said", () => {
    const promise: Checked["promises"][number] = { id: "P1", kind: "monthly_price", description: "", amount_cents: 5500, per_line: false, conditions: [], applies_from: null, applies_until: "2026-10-27", quote: "Fiber 500 is $55 a month for your first 12 months", said_at_seconds: 13, covers_line_ids: ["L1"] };
    const result: Checked = {
      ...checked([line("L1", "Fiber 500 Internet", 7000, "plan")], []),
      promises: [promise],
      matchedPromiseIds: ["P1"],
      explained: [{ id: "E1", kind: "promise_ended", lineIds: ["L1"], promiseId: "P1", endedOn: "2026-10-27" }],
      transcript: [
        { speaker: "customer", start_seconds: 7, text: "How much is Fiber 500?" },
        { speaker: "company", start_seconds: 13, text: "Fiber 500 is $55 a month for your first 12 months." },
        { speaker: "customer", start_seconds: 23, text: "Thanks." },
      ],
    };
    expect(page(result)).toContain('aria-label="Play what was said at 0:13"');
  });

  test("a picture that isn't a bill, or a bill that can't be read, says what to add instead", () => {
    const render = (result: Parameters<typeof ResultView>[0]["result"]) => text(renderToStaticMarkup(createElement(ResultView, { result, bill: 0, pages: [], omittedPages: { bill: 0, offer: 0 }, callUrl: null, selection: { claims: {}, questions: {} }, dispatch: () => {}, backLabel: "Check another bill", onBack: () => {} })).replace(/&#x27;/g, "'"));
    expect(render({ outcome: "not_a_bill", spentMicros: 0 })).toContain("This isn't a bill Add the statement itself: the PDF, or screenshots of the page that shows the billing period and each charge.");
    const unread = render({ outcome: "could_not_check", reason: "The page image is entirely black.", spentMicros: 0 });
    expect(unread).toContain("Couldn't check this bill The page image is entirely black. Try the PDF from the company's website, or screenshots that show every charge and the total, uncropped.");
  });

  test("a long PDF that couldn't be checked says only its first pages were read and how to add the rest", () => {
    const pdfPage = (n: number) => ({ image: `data:image/png;base64,UA${n}`, text: "Bayline Fiber", rows: null });
    const result = { outcome: "could_not_check" as const, reason: "The charges on this bill could not be read the same way twice.", spentMicros: 0 };
    const html = text(renderToStaticMarkup(createElement(ResultView, { result, bill: 0, pages: [0, 1, 2, 3, 4, 5].map(pdfPage), omittedPages: { bill: 3, offer: 0 }, callUrl: null, selection: { claims: {}, questions: {} }, dispatch: () => {}, backLabel: "Check another bill", onBack: () => {} })).replace(/&#x27;/g, "'"));
    expect(html).toContain("Only the first 6 of 9 pages were read. Add the pages with the charges as their own PDF, or as screenshots.");
    expect(html).not.toContain("Try the PDF from the company's website");
  });
});
