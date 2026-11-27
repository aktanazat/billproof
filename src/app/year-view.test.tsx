import { readFileSync } from "node:fs";
import path from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, test } from "vitest";
import { initialState, reduce, type CheckAction, type CheckState } from "@/lib/check-machine";
import type { CheckEvent, YearResult } from "@/lib/result";
import { YearView } from "./year-view";

// The year sample as the real pipeline returned it in the 2026-11-26 test-set run: twelve statements, the price rising
// in August and a gateway charge appearing in October.
const run = JSON.parse(readFileSync(path.join(import.meta.dirname, "../../eval/run-2026-11-26.json"), "utf8")) as { raw: { id: string; events: CheckEvent[] }[] };
const event = run.raw.find((r) => r.id === "year-12")?.events.find((e) => e.type === "result");
const year = event?.type === "result" && event.result.outcome === "year" ? (event.result as YearResult) : null;

// The year page as the app shows it once the check finishes, through its own state machine, after any ticks the
// person changes.
function yearPage(actions: CheckAction[] = []): string {
  if (!year) throw new Error("the saved run has no year result");
  const running = { s: "running", inputs: initialState.inputs, attempts: 1, attempt: 1, stage: null, spentMicros: 0, live: {} } as unknown as CheckState;
  const done = actions.reduce(reduce, reduce(running, { type: "finished", attempt: 1, result: year }));
  if (done.s !== "done") throw new Error("the finished year did not become a done state");
  return renderToStaticMarkup(createElement(YearView, { state: done, result: year, dispatch: () => {} }));
}

// The page's main heading as a screen reader reads it: the amount and the words after it.
const heading = (html: string) => html.match(/<h1\b[^>]*>([\s\S]*?)<\/h1>/)?.[1].replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();

test("unticking a month's claim takes it out of the total and the message, but not out of the month list", () => {
  if (!year) throw new Error("the saved run has no year result");
  const august = year.months.find((month) => month.result.outcome === "checked" && month.result.reading.period_start?.startsWith("2026-08"));
  if (!august || august.result.outcome !== "checked") throw new Error("the sample has no August statement");
  const html = yearPage(august.result.claims.map((claim) => ({ type: "toggle_claim", bill: august.bill, id: claim.id })));
  expect(heading(html)).toMatch(/^\$65\.00 to ask back from Bayline Fiber across 12 statements/);
  expect(html).not.toContain("In total, please credit $70.00");
  expect(html).not.toContain("For Aug 12, 2026 to Sep 11, 2026");
  expect(html).toContain("In total, please credit $65.00");
  expect(html).toContain("Aug 26 $5.00, August 2026: overcharged");
});

test("a duplicate, another account's bill and an unreadable one are named as not counted and left out of the total", () => {
  if (!year) throw new Error("the saved run has no year result");
  const august = year.months.find((month) => month.result.outcome === "checked" && month.result.reading.period_start?.startsWith("2026-08"));
  if (!august || august.result.outcome !== "checked") throw new Error("the sample has no August statement");
  const extra: YearResult = {
    ...year,
    months: [
      ...year.months,
      { bill: 12, result: august.result },
      { bill: 13, result: { ...august.result, reading: { ...august.result.reading, account_last4: "9999" } } },
      { bill: 14, result: { outcome: "could_not_check", reason: "The page image is entirely black.", spentMicros: 0 } },
    ],
  };
  const bills = Array.from({ length: 15 }, (_, i) => ({ id: `b${i}`, name: i === 14 ? "december.jpg" : `bill-${i + 1}.pdf`, status: "preparing" as const }));
  const running = { s: "running", inputs: { ...initialState.inputs, bills }, attempts: 1, attempt: 1, stage: null, spentMicros: 0, live: {} } as unknown as CheckState;
  const done = reduce(running, { type: "finished", attempt: 1, result: extra });
  if (done.s !== "done") throw new Error("the finished year did not become a done state");
  const html = renderToStaticMarkup(createElement(YearView, { state: done, result: extra, dispatch: () => {} }));
  // Another account's statement is named by file with what to do, as an unreadable one is: added together with this
  // account's (a phone bill beside an internet bill), its own finding would otherwise go unseen.
  expect(html).toContain("Not counted: december.jpg couldn&#x27;t be read, 1 duplicate statement, bill-14.pdf is from another account (check it on its own)");
  // The month can't be opened from the year, so its reason is shown here, or the person can't tell what to fix.
  expect(html).toContain("december.jpg: The page image is entirely black.");
  expect(heading(html)).toMatch(/^\$70\.00 to ask back from Bayline Fiber across 12 statements/);
  expect([...html.matchAll(/aria-label="Aug 26 \$5\.00, August 2026: /g)]).toHaveLength(1);
});

// Each group of files set aside is joined with "and", so the note says where one group ends and the next begins; with
// commas alone, "a.jpg, b.jpg couldn't be read, c.png, d.png aren't bills" ran the groups together.
test("several files set aside for each reason are listed group by group", () => {
  if (!year) throw new Error("the saved run has no year result");
  const unreadable = { outcome: "could_not_check" as const, reason: "The page image is entirely black.", spentMicros: 0 };
  const notABill = { outcome: "not_a_bill" as const, spentMicros: 0 };
  const extra: YearResult = { ...year, months: [...year.months, { bill: 12, result: unreadable }, { bill: 13, result: unreadable }, { bill: 14, result: notABill }, { bill: 15, result: notABill }] };
  const names = ["a.jpg", "b.jpg", "c.png", "d.png"];
  const bills = Array.from({ length: 16 }, (_, i) => ({ id: `b${i}`, name: i >= 12 ? names[i - 12] : `bill-${i + 1}.pdf`, status: "preparing" as const }));
  const running = { s: "running", inputs: { ...initialState.inputs, bills }, attempts: 1, attempt: 1, stage: null, spentMicros: 0, live: {} } as unknown as CheckState;
  const done = reduce(running, { type: "finished", attempt: 1, result: extra });
  if (done.s !== "done") throw new Error("the finished year did not become a done state");
  const html = renderToStaticMarkup(createElement(YearView, { state: done, result: extra, dispatch: () => {} }));
  expect(html).toContain("Not counted: a.jpg and b.jpg couldn&#x27;t be read, c.png and d.png aren&#x27;t bills");
});

// A phone bill dropped beside the internet bill being checked: one statement each, so neither account has more. The one
// the offer is about is the one being checked; the earlier statement used to win, setting the internet bill aside.
test("with one statement per account, the account the offer is about is counted", () => {
  if (!year) throw new Error("the saved run has no year result");
  const months = year.months.filter((month) => month.result.outcome === "checked");
  const oct = months.find((month) => month.result.outcome === "checked" && month.result.reading.period_start?.startsWith("2026-10"));
  const aug = months.find((month) => month.result.outcome === "checked" && month.result.reading.period_start?.startsWith("2026-08"));
  if (oct?.result.outcome !== "checked" || aug?.result.outcome !== "checked") throw new Error("the sample has no August or October statement");
  const phone = { ...aug.result, providerMismatch: true, offerProvider: "Bayline Fiber", reading: { ...aug.result.reading, provider: "Northstar Wireless", account_last4: "0937" } };
  const mixed: YearResult = { ...year, months: [{ bill: 0, result: phone }, { bill: 1, result: oct.result }] };
  const bills = [
    { id: "p", name: "Phone-August.pdf", status: "preparing" as const },
    { id: "i", name: "Internet-October.pdf", status: "preparing" as const },
  ];
  const running = { s: "running", inputs: { ...initialState.inputs, bills }, attempts: 1, attempt: 1, stage: null, spentMicros: 0, live: {} } as unknown as CheckState;
  const done = reduce(running, { type: "finished", attempt: 1, result: mixed });
  if (done.s !== "done") throw new Error("the finished year did not become a done state");
  const html = renderToStaticMarkup(createElement(YearView, { state: done, result: mixed, dispatch: () => {} }));
  expect(heading(html)).toMatch(/^\$30\.00 to ask back from Bayline Fiber across 1 statement/);
  expect(html).toContain("Not counted: Phone-August.pdf is from another account (check it on its own)");
});

// Copies of one statement are one statement: three copies of another account's bill used to outvote this account's two,
// setting both of them aside and checking the copy.
test("copies of another account's statement don't outvote this account's statements", () => {
  if (!year) throw new Error("the saved run has no year result");
  const start = (prefix: string) => year.months.find((month) => month.result.outcome === "checked" && month.result.reading.period_start?.startsWith(prefix));
  const oct = start("2026-10");
  const nov = start("2026-11");
  const aug = start("2026-08");
  if (oct?.result.outcome !== "checked" || nov?.result.outcome !== "checked" || aug?.result.outcome !== "checked") throw new Error("the sample has no August, October or November statement");
  const other = { ...aug.result, reading: { ...aug.result.reading, account_last4: "9999" } };
  const mixed: YearResult = { ...year, months: [{ bill: 0, result: oct.result }, { bill: 1, result: nov.result }, { bill: 2, result: other }, { bill: 3, result: other }, { bill: 4, result: other }] };
  const bills = ["October.pdf", "November.pdf", "Other.pdf", "Other (1).pdf", "Other (2).pdf"].map((name, i) => ({ id: `b${i}`, name, status: "preparing" as const }));
  const running = { s: "running", inputs: { ...initialState.inputs, bills }, attempts: 1, attempt: 1, stage: null, spentMicros: 0, live: {} } as unknown as CheckState;
  const done = reduce(running, { type: "finished", attempt: 1, result: mixed });
  if (done.s !== "done") throw new Error("the finished year did not become a done state");
  const html = renderToStaticMarkup(createElement(YearView, { state: done, result: mixed, dispatch: () => {} }));
  expect(heading(html)).toMatch(/^\$60\.00 to ask back from Bayline Fiber across 2 statements/);
  // Each is named, however many: told to check them on their own, the person has to know which files they are.
  expect(html).toContain("Not counted: Other.pdf, Other (1).pdf and Other (2).pdf are from another account (check them on their own)");
});

// A phone bill dropped beside the internet statements, its account number not read: a different company's bill can't
// be this account's. Counted with the year, it turned the heading into "The offer is from Bayline Fiber, not Bayline
// Fiber".
test("another company's statement among the offer company's is set aside, even with no account number read", () => {
  if (!year) throw new Error("the saved run has no year result");
  const start = (prefix: string) => year.months.find((month) => month.result.outcome === "checked" && month.result.reading.period_start?.startsWith(prefix));
  const [mar, apr, may] = ["2026-03", "2026-04", "2026-05"].map(start);
  if (mar?.result.outcome !== "checked" || apr?.result.outcome !== "checked" || may?.result.outcome !== "checked") throw new Error("the sample has no March, April or May statement");
  const phone = { ...may.result, providerMismatch: true, offerProvider: "Bayline Fiber", reading: { ...may.result.reading, provider: "Northstar Wireless", account_last4: null } };
  const mixed: YearResult = {
    ...year,
    months: [{ bill: 0, result: mar.result }, { bill: 1, result: apr.result }, { bill: 2, result: phone }, { bill: 3, result: { outcome: "could_not_check", reason: "The amounts on this bill could not be read.", spentMicros: 0 } }],
  };
  const bills = ["March.pdf", "April.pdf", "Phone.pdf", "Blurry.jpg"].map((name, i) => ({ id: `b${i}`, name, status: "preparing" as const }));
  const running = { s: "running", inputs: { ...initialState.inputs, bills }, attempts: 1, attempt: 1, stage: null, spentMicros: 0, live: {} } as unknown as CheckState;
  const done = reduce(running, { type: "finished", attempt: 1, result: mixed });
  if (done.s !== "done") throw new Error("the finished year did not become a done state");
  const html = renderToStaticMarkup(createElement(YearView, { state: done, result: mixed, dispatch: () => {} }));
  expect(heading(html)).toBe("All 2 statements match the offer");
  expect(html).toContain("Not counted: Blurry.jpg couldn&#x27;t be read, Phone.pdf is from another account (check it on its own)");
});

test("a statement whose account number couldn't be read counts with the year's account, and the message keeps the number", () => {
  if (!year) throw new Error("the saved run has no year result");
  const august = year.months.find((month) => month.result.outcome === "checked" && month.result.reading.period_start?.startsWith("2026-08"));
  if (!august || august.result.outcome !== "checked") throw new Error("the sample has no August statement");
  const unread = { ...august.result, reading: { ...august.result.reading, account_last4: null } };
  const blurred: YearResult = { ...year, months: year.months.map((month) => (month.bill === august.bill ? { ...month, result: unread } : month)) };
  const running = { s: "running", inputs: initialState.inputs, attempts: 1, attempt: 1, stage: null, spentMicros: 0, live: {} } as unknown as CheckState;
  const done = reduce(running, { type: "finished", attempt: 1, result: blurred });
  if (done.s !== "done") throw new Error("the finished year did not become a done state");
  const html = renderToStaticMarkup(createElement(YearView, { state: done, result: blurred, dispatch: () => {} }));
  expect(heading(html)).toMatch(/^\$70\.00 to ask back from Bayline Fiber across 12 statements/);
  expect(html).not.toContain("another account");
  expect(html).toContain("In total, please credit $70.00 to account ending 4415.");
});

test("two statements whose dates couldn't be read are both counted, not taken for one statement twice", () => {
  if (!year) throw new Error("the saved run has no year result");
  const undated = (start: string) => year.months.find((month) => month.result.outcome === "checked" && month.result.reading.period_start?.startsWith(start));
  const blank = new Set([undated("2026-08")?.bill, undated("2026-09")?.bill]);
  if (blank.has(undefined)) throw new Error("the sample has no August or September statement");
  const months = year.months.map((month) => (blank.has(month.bill) && month.result.outcome === "checked" ? { ...month, result: { ...month.result, reading: { ...month.result.reading, period_start: null, period_end: null, statement_date: null } } } : month));
  const blurred: YearResult = { ...year, months };
  const running = { s: "running", inputs: initialState.inputs, attempts: 1, attempt: 1, stage: null, spentMicros: 0, live: {} } as unknown as CheckState;
  const done = reduce(running, { type: "finished", attempt: 1, result: blurred });
  if (done.s !== "done") throw new Error("the finished year did not become a done state");
  const html = renderToStaticMarkup(createElement(YearView, { state: done, result: blurred, dispatch: () => {} }));
  expect(heading(html)).toMatch(/^\$70\.00 to ask back from Bayline Fiber across 12 statements/);
  expect(html).not.toContain("duplicate");
});

// Statements with no date read come first in the chart. Named "Unknown", the chart's heading read "Overcharged from
// Unknown" and two bars sounded the same to a screen reader; each now says "No date" and gives its file.
test("a statement with no date read is labeled as such, by its file, and never names the month an overcharge began", () => {
  if (!year) throw new Error("the saved run has no year result");
  const at = (start: string) => year.months.find((month) => month.result.outcome === "checked" && month.result.reading.period_start?.startsWith(start))?.result;
  const [jan, oct, mar] = [at("2026-01"), at("2026-10"), at("2026-03")];
  if (jan?.outcome !== "checked" || oct?.outcome !== "checked" || mar?.outcome !== "checked") throw new Error("the sample has no January, October or March statement");
  const undated = (result: typeof jan) => ({ ...result, reading: { ...result.reading, period_start: null, period_end: null, statement_date: null } });
  const mixed: YearResult = { ...year, months: [{ bill: 0, result: undated(jan) }, { bill: 1, result: undated(oct) }, { bill: 2, result: mar }] };
  const bills = ["scan-1.jpg", "scan-2.jpg", "march.pdf"].map((name, i) => ({ id: `b${i}`, name, status: "preparing" as const }));
  const running = { s: "running", inputs: { ...initialState.inputs, bills }, attempts: 1, attempt: 1, stage: null, spentMicros: 0, live: {} } as unknown as CheckState;
  const done = reduce(running, { type: "finished", attempt: 1, result: mixed });
  if (done.s !== "done") throw new Error("the finished year did not become a done state");
  const html = renderToStaticMarkup(createElement(YearView, { state: done, result: mixed, dispatch: () => {} }));
  expect(html).not.toContain("Unknown");
  expect(html).toContain(">Overcharge by month</h2>");
  expect(html).toContain('aria-label="No date $30.00, scan-2.jpg: overcharged"');
  expect(html).toContain('aria-label="No date, scan-1.jpg: matches the offer"');
});

test("a year with nothing owed shows no $0.00, and says plainly when there was no offer to check against", () => {
  if (!year) throw new Error("the saved run has no year result");
  const clean = (hadOffer: boolean): YearResult => ({ ...year, months: year.months.map((month) => (month.result.outcome === "checked" ? { ...month, result: { ...month.result, claims: [], hadOffer, promises: hadOffer ? month.result.promises : [], matchedPromiseIds: hadOffer ? month.result.matchedPromiseIds : [] } } : month)) });
  const render = (result: YearResult) => {
    const running = { s: "running", inputs: initialState.inputs, attempts: 1, attempt: 1, stage: null, spentMicros: 0, live: {} } as unknown as CheckState;
    const done = reduce(running, { type: "finished", attempt: 1, result });
    if (done.s !== "done") throw new Error("the finished year did not become a done state");
    return renderToStaticMarkup(createElement(YearView, { state: done, result, dispatch: () => {} }));
  };
  const matched = render(clean(true));
  expect(matched).toContain(">All 12 statements match the offer</h1>");
  expect(matched).toContain("12 bills read in parallel, 12 checked against the offer.");
  expect(matched).not.toContain("$0.00");
  const noOffer = render(clean(false));
  expect(noOffer).toContain(">Read 12 statements; there was no offer to check them against</h1>");
  expect(noOffer).not.toContain("match the offer");
  expect(noOffer).not.toContain("matches the offer");
  expect(noOffer).toContain("August 2026: no offer to compare");
  expect(noOffer).not.toContain("checked against the offer");
  expect(noOffer).toContain("12 bills read in parallel.");
});

test("a year where no file could be checked says so, never 'Read 0 statements'", () => {
  if (!year) throw new Error("the saved run has no year result");
  const none: YearResult = { ...year, months: year.months.map((month) => ({ ...month, result: { outcome: "not_a_bill" as const, spentMicros: 0 } })) };
  const bills = Array.from({ length: 12 }, (_, i) => ({ id: `b${i}`, name: `bill-${i + 1}.pdf`, status: "preparing" as const }));
  const running = { s: "running", inputs: { ...initialState.inputs, bills }, attempts: 1, attempt: 1, stage: null, spentMicros: 0, live: {} } as unknown as CheckState;
  const done = reduce(running, { type: "finished", attempt: 1, result: none });
  if (done.s !== "done") throw new Error("the finished year did not become a done state");
  const html = renderToStaticMarkup(createElement(YearView, { state: done, result: none, dispatch: () => {} })).replace(/&#x27;/g, "'");
  expect(html).toContain(">None of the 12 files could be checked</h1>");
  expect(html).not.toContain("0 statements");
  expect(html).not.toContain("Overcharge by month");
});

test("a year with one statement checked says 'statement', never '1 statements'", () => {
  if (!year) throw new Error("the saved run has no year result");
  const render = (keep: string, change: (result: Extract<YearResult["months"][number]["result"], { outcome: "checked" }>) => object = () => ({})) => {
    const months = year.months.map((month) => (month.result.outcome === "checked" && month.result.reading.period_start?.startsWith(keep) ? { ...month, result: { ...month.result, ...change(month.result) } } : { ...month, result: { outcome: "not_a_bill" as const, spentMicros: 0 } }));
    const result: YearResult = { ...year, months };
    const running = { s: "running", inputs: initialState.inputs, attempts: 1, attempt: 1, stage: null, spentMicros: 0, live: {} } as unknown as CheckState;
    const done = reduce(running, { type: "finished", attempt: 1, result });
    if (done.s !== "done") throw new Error("the finished year did not become a done state");
    return renderToStaticMarkup(createElement(YearView, { state: done, result, dispatch: () => {} }));
  };
  expect(render("2026-08")).toContain("to ask back from Bayline Fiber across 1 statement<");
  expect(render("2026-07")).toContain(">The 1 statement matches the offer</h1>");
  expect(render("2026-07", () => ({ hadOffer: false, promises: [], matchedPromiseIds: [] }))).toContain(">Read 1 statement; there was no offer to check it against</h1>");
  for (const html of [render("2026-08"), render("2026-07")]) expect(html).not.toContain("1 statements");
});

test("a year whose offer couldn't be compared says why, never that every statement matches", () => {
  if (!year) throw new Error("the saved run has no year result");
  const variant = (change: (result: Extract<YearResult["months"][number]["result"], { outcome: "checked" }>) => object): YearResult => ({ ...year, months: year.months.map((month) => (month.result.outcome === "checked" ? { ...month, result: { ...month.result, claims: [], ...change(month.result) } } : month)) });
  const render = (result: YearResult) => {
    const running = { s: "running", inputs: initialState.inputs, attempts: 1, attempt: 1, stage: null, spentMicros: 0, live: {} } as unknown as CheckState;
    const done = reduce(running, { type: "finished", attempt: 1, result });
    if (done.s !== "done") throw new Error("the finished year did not become a done state");
    return renderToStaticMarkup(createElement(YearView, { state: done, result, dispatch: () => {} }));
  };
  const otherCompany = render(variant(() => ({ providerMismatch: true, offerProvider: "Westline Cable", matchedPromiseIds: [] })));
  expect(otherCompany).toContain(">The offer is from Westline Cable, not Bayline Fiber</h1>");
  const noPromise = render(variant(() => ({ promises: [], matchedPromiseIds: [] })));
  expect(noPromise).toContain(">No price or promise found to check the statements against</h1>");
  const unmatched = render(variant(() => ({ matchedPromiseIds: [] })));
  expect(unmatched).toContain(">Couldn&#x27;t match your offer to these statements</h1>");
  for (const html of [otherCompany, noPromise, unmatched]) {
    expect(html).not.toContain("match the offer");
    expect(html).not.toContain("matches the offer");
    expect(html).toContain("August 2026: not compared with the offer");
  }
});

test("a year with no claims but fees worth asking about says so, not that every statement matches", () => {
  if (!year) throw new Error("the saved run has no year result");
  const asking = new Set(["2026-08", "2026-09"]);
  const months = year.months.map((month) => {
    if (month.result.outcome !== "checked") return month;
    const fee = asking.has(month.result.reading.period_start?.slice(0, 7) ?? "") ? [{ id: "Q1", kind: "unagreed_fee" as const, lineIds: [month.result.reading.line_items[0].id], promiseId: null }] : [];
    return { ...month, result: { ...month.result, claims: [], questions: fee } };
  });
  const result: YearResult = { ...year, months };
  const running = { s: "running", inputs: initialState.inputs, attempts: 1, attempt: 1, stage: null, spentMicros: 0, live: {} } as unknown as CheckState;
  const done = reduce(running, { type: "finished", attempt: 1, result });
  if (done.s !== "done") throw new Error("the finished year did not become a done state");
  const html = renderToStaticMarkup(createElement(YearView, { state: done, result, dispatch: () => {} }));
  expect(html).toContain(">Charges worth asking about on 2 of 12 statements</h1>");
  expect(html).not.toContain("All 12 statements match the offer");
  expect(html).toContain("August 2026: charges worth asking about");
  expect(html).toContain("July 2026: matches the offer");
});

test("a year of statements is headed with its total and the month the overcharge began", () => {
  const html = yearPage();
  expect(html).toContain("$70.00");
  expect(html).toContain("to ask back from Bayline Fiber across 12 statements");
  expect(html).toContain("Overcharged from August 2026");
});

test("a month missing its statement date stays in its place by billing period, so the overcharge still begins in August", () => {
  if (!year) throw new Error("the saved run has no year result");
  const november = year.months.find((month) => month.result.outcome === "checked" && month.result.reading.period_start?.startsWith("2026-11"));
  if (!november || november.result.outcome !== "checked") throw new Error("the sample has no November statement");
  const undated = { ...november.result, reading: { ...november.result.reading, statement_date: null } };
  const blurred: YearResult = { ...year, months: year.months.map((month) => (month.bill === november.bill ? { ...month, result: undated } : month)) };
  const running = { s: "running", inputs: initialState.inputs, attempts: 1, attempt: 1, stage: null, spentMicros: 0, live: {} } as unknown as CheckState;
  const done = reduce(running, { type: "finished", attempt: 1, result: blurred });
  if (done.s !== "done") throw new Error("the finished year did not become a done state");
  const html = renderToStaticMarkup(createElement(YearView, { state: done, result: blurred, dispatch: () => {} }));
  expect(html).toContain("Overcharged from August 2026");
  const months = [...html.matchAll(/aria-label="[^,"]+, ([A-Z][a-z]+ \d{4}): /g)].map((m) => m[1]);
  expect(months.at(0)).toBe("December 2025");
  expect(months.at(-1)).toBe("November 2026");
});

test("a company name missing from some statements is taken from the others for the heading", () => {
  if (!year) throw new Error("the saved run has no year result");
  const starting = (prefix: string) => year.months.find((month) => month.result.outcome === "checked" && month.result.reading.period_start?.startsWith(prefix))?.bill;
  const blank = new Set([starting("2025-12"), starting("2026-08")]);
  if (blank.has(undefined)) throw new Error("the sample has no December or August statement");
  const months = year.months.map((month) => (blank.has(month.bill) && month.result.outcome === "checked" ? { ...month, result: { ...month.result, reading: { ...month.result.reading, provider: null } } } : month));
  const blurred: YearResult = { ...year, months };
  const running = { s: "running", inputs: initialState.inputs, attempts: 1, attempt: 1, stage: null, spentMicros: 0, live: {} } as unknown as CheckState;
  const done = reduce(running, { type: "finished", attempt: 1, result: blurred });
  if (done.s !== "done") throw new Error("the finished year did not become a done state");
  const html = renderToStaticMarkup(createElement(YearView, { state: done, result: blurred, dispatch: () => {} }));
  expect(html).toContain("to ask back from Bayline Fiber across 12 statements");
});

test("months whose claims wait for confirmation are marked, so the person knows which to open", () => {
  if (!year) throw new Error("the saved run has no year result");
  const august = year.months.find((month) => month.result.outcome === "checked" && month.result.reading.period_start?.startsWith("2026-08"));
  if (!august || august.result.outcome !== "checked") throw new Error("the sample has no August statement");
  const photo = { ...august.result, claims: august.result.claims.map((claim) => ({ ...claim, needsConfirmation: true })) };
  const waiting: YearResult = { ...year, months: year.months.map((month) => (month.bill === august.bill ? { ...month, result: photo } : month)) };
  const running = { s: "running", inputs: initialState.inputs, attempts: 1, attempt: 1, stage: null, spentMicros: 0, live: {} } as unknown as CheckState;
  const done = reduce(running, { type: "finished", attempt: 1, result: waiting });
  if (done.s !== "done") throw new Error("the finished year did not become a done state");
  const html = renderToStaticMarkup(createElement(YearView, { state: done, result: waiting, dispatch: () => {} }));
  expect(html).toContain('aria-label="Aug 26 $5.00 To confirm, August 2026: overcharged"');
  expect(html).toContain('aria-label="Sep 26 $5.00, September 2026: overcharged"');
  expect([...html.matchAll(/>To confirm</g)]).toHaveLength(1);
  expect(html).toContain("Open a month marked “To confirm” and confirm its marked lines to add them to the message.");
});

test("a month whose date was misread is labeled as written, never 'undefined'", () => {
  if (!year) throw new Error("the saved run has no year result");
  const misread: YearResult = { ...year, months: year.months.map((month, i) => (i === 0 && month.result.outcome === "checked" ? { ...month, result: { ...month.result, reading: { ...month.result.reading, period_start: "2026-13-12" } } } : month)) };
  const running = { s: "running", inputs: initialState.inputs, attempts: 1, attempt: 1, stage: null, spentMicros: 0, live: {} } as unknown as CheckState;
  const done = reduce(running, { type: "finished", attempt: 1, result: misread });
  if (done.s !== "done") throw new Error("the finished year did not become a done state");
  const html = renderToStaticMarkup(createElement(YearView, { state: done, result: misread, dispatch: () => {} }));
  expect(html).toContain('aria-label="2026-13-12: ');
  expect(html).not.toContain("undefined");
});

test("each month is listed in order with what it overcharged, adding up to the year's total", () => {
  const months = [...yearPage().matchAll(/aria-label="([^"]*(?:overcharged|matches the offer))"/g)].map((m) => m[1]);
  expect(months).toEqual([
    "Dec 25, December 2025: matches the offer",
    "Jan 26, January 2026: matches the offer",
    "Feb 26, February 2026: matches the offer",
    "Mar 26, March 2026: matches the offer",
    "Apr 26, April 2026: matches the offer",
    "May 26, May 2026: matches the offer",
    "Jun 26, June 2026: matches the offer",
    "Jul 26, July 2026: matches the offer",
    "Aug 26 $5.00, August 2026: overcharged",
    "Sep 26 $5.00, September 2026: overcharged",
    "Oct 26 $30.00, October 2026: overcharged",
    "Nov 26 $30.00, November 2026: overcharged",
  ]);
});

test("each month button's spoken name starts with the words shown on it, so voice control can reach it", () => {
  if (!year) throw new Error("the saved run has no year result");
  const august = year.months.find((month) => month.result.outcome === "checked" && month.result.reading.period_start?.startsWith("2026-08"));
  if (!august || august.result.outcome !== "checked") throw new Error("the sample has no August statement");
  const photo = { ...august.result, claims: august.result.claims.map((claim) => ({ ...claim, needsConfirmation: true })) };
  const waiting: YearResult = { ...year, months: year.months.map((month) => (month.bill === august.bill ? { ...month, result: photo } : month)) };
  const running = { s: "running", inputs: initialState.inputs, attempts: 1, attempt: 1, stage: null, spentMicros: 0, live: {} } as unknown as CheckState;
  const done = reduce(running, { type: "finished", attempt: 1, result: waiting });
  if (done.s !== "done") throw new Error("the finished year did not become a done state");
  const html = renderToStaticMarkup(createElement(YearView, { state: done, result: waiting, dispatch: () => {} }));
  // The button's text as a browser has it: the spans' words with only the spaces the markup holds.
  const buttons = [...html.matchAll(/<button[^>]*aria-label="([^"]*)"[^>]*>(.*?)<\/button>/g)].map((m) => ({ name: m[1], shown: m[2].replace(/<[^>]+>/g, "").split(/\s+/).filter((word) => word && word !== "—").join(" ") }));
  expect(buttons).toHaveLength(12);
  for (const { name, shown } of buttons) expect(name.startsWith(shown), `${name} / ${shown}`).toBe(true);
  expect(html).toContain('aria-label="Aug 26 $5.00 To confirm, August 2026: overcharged"');
  expect(html).toContain('aria-label="Jul 26, July 2026: matches the offer"');
});

// A month whose pictures held an earlier statement and rose is not a match; its button, the year's heading and the
// message say so, as its own page does.
test("a month that rose since the bill before is called higher, and the year offers a message about it", () => {
  if (!year) throw new Error("the saved run has no year result");
  const flat: YearResult = { ...year, months: year.months.map((month) => (month.result.outcome === "checked" ? { ...month, result: { ...month.result, claims: [], questions: [] } } : month)) };
  const july = flat.months.find((month) => month.result.outcome === "checked" && month.result.reading.period_start?.startsWith("2026-07"));
  if (!july || july.result.outcome !== "checked") throw new Error("the sample has no July statement");
  const rose: YearResult = { ...flat, months: flat.months.map((month) => (month.bill === july.bill && month.result.outcome === "checked" ? { ...month, result: { ...month.result, change: { earlierCents: 7249, currentCents: 9249, lines: [{ label: "Fiber 500 Internet", beforeCents: 5500, afterCents: 7500 }] } } } : month)) };
  const running = { s: "running", inputs: initialState.inputs, attempts: 1, attempt: 1, stage: null, spentMicros: 0, live: {} } as unknown as CheckState;
  const done = reduce(running, { type: "finished", attempt: 1, result: rose });
  if (done.s !== "done") throw new Error("the finished year did not become a done state");
  const html = renderToStaticMarkup(createElement(YearView, { state: done, result: rose, dispatch: () => {} }));
  expect(html).toContain('aria-label="Jul 26, July 2026: higher than the bill before"');
  expect(heading(html)).toBe("Higher than the bill before on 1 of 12 statements");
  expect(html).toContain("is $20.00 higher than the one before: Fiber 500 Internet went from $55.00 to $75.00.");
});
