import { expect, test, vi } from "vitest";
import type * as Ember from "./ember";
import { openLedger } from "./ledger";
import { buildMessage } from "./letter";
import { runCheck } from "./pipeline";
import type { CheckEvent } from "./result";

// Muse Ember is replaced by fixed answers so whole checks run offline; this file holds only tests that need that,
// since the mock applies to every test in it. `scenario` sets what the bill charges and prints, what a second reading
// returns, what the company's side quotes, and the size of each request.
const COST = { sort_pages: 200, read_bill: 1000, reread_bill: 2000, read_terms: 500, challenge: 700 } as const;
const scenario = {
  billedCents: 5500,
  printedCents: null as number | null,
  reread: null as { billedCents: number; printedCents: number } | null,
  outcome: "bill" as "bill" | "not_a_bill" | "unreadable",
  inputTokens: 1000,
  // What each picture is, in order, when several are sent to be sorted.
  sorted: [] as ("bill" | "older_bill" | "promise" | "other")[],
  counterQuote: null as string | null,
  tooLong: null as string | null,
  declined: null as string | null,
  // A month whose pictures Muse Ember reads as not a bill.
  notBillMonth: null as string | null,
};
// The pictures the last offer reading was sent, so a test can see which pictures were read as the offer.
const seen = { offerPictures: 0 };
// A failure thrown here is built from the same module copy the pipeline is given, so it is recognised as Muse Ember's.
vi.mock("./ember", async (actual) => {
  const real = await actual<typeof Ember>();
  return {
  ...real,
  countInputTokens: async () => scenario.inputTokens,
  send: async (request: { call: { name: string }; body: { input: { content: { type: string; image_url?: string; text?: string }[] }[] } }) => {
    const name = request.call.name as keyof typeof COST;
    const content = request.body.input[0].content;
    const month = content.some((part) => part.image_url?.endsWith("B") || part.text?.includes("February")) ? "February" : "January";
    // Too long for both readings, the first and the second with twice the room.
    if ((name === "read_bill" || (name as string) === "reread_bill") && month === scenario.tooLong) throw new real.EmberError("truncated", "max_output_tokens", 900);
    if (name === "read_bill" && month === scenario.declined) throw new real.EmberError("refused", "refusal", 900);
    if (name === "sort_pages") return { output: { pages: scenario.sorted.map((kind, i) => ({ page: i + 1, kind })) }, usage: { inputTokens: 1000, cachedTokens: 0, outputTokens: 50 }, costMicros: COST.sort_pages };
    if (name === "read_terms") seen.offerPictures = content.filter((part) => part.image_url).length;
    if (name === "challenge") {
      const ids = content.flatMap((part) => [...(part.text ?? "").matchAll(/^Claim (\S+) \(/gm)].map((m) => m[1]));
      const challenges = ids.map((id) => ({ claim_id: id, looked_for: "A later price in the offer.", verdict: scenario.counterQuote ? "refuted" : "stands", counter_quote: scenario.counterQuote, counter_source: scenario.counterQuote ? "offer" : null }));
      return { output: { challenges }, usage: { inputTokens: 1000, cachedTokens: 0, outputTokens: 100 }, costMicros: COST.challenge };
    }
    const second = name === "reread_bill" && scenario.reread;
    const billed = second ? second.billedCents : scenario.billedCents;
    const printed = second ? second.printedCents : (scenario.printedCents ?? scenario.billedCents);
    const output =
      name === "read_bill" || name === "reread_bill"
        ? {
            outcome: month === scenario.notBillMonth ? "not_a_bill" : scenario.outcome,
            unreadable_reason: scenario.outcome === "unreadable" ? "The picture is too blurry to read the amounts." : null,
            provider: "Bayline Fiber",
            account_last4: "4415",
            statement_date: null,
            period_start: month === "January" ? "2026-01-12" : "2026-02-12",
            period_end: null,
            due_date: null,
            printed: { previous_balance: null, payments: null, current_charges: { cents: printed, quote: `Current charges $${(printed / 100).toFixed(2)}` }, total_due: null, section_totals: [] },
            line_items: [{ label: `Fiber 500 Internet, ${month}`, amount_cents: billed, kind: "plan", page: 1, box: { x0: 100, y0: 400, x1: 900, y1: 430 }, quote: `Fiber 500 Internet $${(billed / 100).toFixed(2)}`, prorated: false }],
            autopay: { enrolled: null, quote: null },
          }
        : {
            transcript: null,
            provider: "Bayline Fiber",
            promises: [{ kind: "monthly_price", description: "Fiber 500 at $55 a month.", amount_cents: 5500, per_line: false, conditions: [], applies_from: null, applies_until: null, quote: "Fiber 500 for $55 a month", said_at_seconds: null, covers_line_ids: ["L1"] }],
          };
    return { output, usage: { inputTokens: 1000, cachedTokens: 0, outputTokens: 100 }, costMicros: COST[name] };
  },
  };
});

test("each month of a year check reports its own Muse Ember steps and cost; the year reports them all", async () => {
  const events: CheckEvent[] = [];
  const page = (tag: string) => ({ image: `data:image/png;base64,iVBORw0KGgo${tag}`, text: null });
  await runCheck(
    { bills: [{ pages: [page("A")] }, { pages: [page("B")] }], offer: { kind: "text", text: "Fiber 500 for $55 a month" } },
    { ledger: openLedger(":memory:", 1_000_000), client: "test", signal: new AbortController().signal, emit: (event) => events.push(event) },
  );
  const done = events.find((event) => event.type === "result");
  if (done?.type !== "result" || done.result.outcome !== "year") throw new Error(`no year result: ${JSON.stringify(events.at(-1))}`);
  for (const { result } of done.result.months) {
    expect(result.outcome).toBe("checked");
    if (result.outcome !== "checked") continue;
    expect(result.calls.map((call) => call.name)).toEqual(["read_bill", "read_terms"]);
    expect(result.spentMicros).toBe(COST.read_bill + COST.read_terms);
  }
  expect(done.result.calls).toHaveLength(4);
  expect(done.result.spentMicros).toBe(2 * (COST.read_bill + COST.read_terms));
  // The running cost shown while bills are read side by side is what finished calls cost: it only rises, and never
  // passes the final cost, as it did while other bills' calls still held their worst-case reservations.
  const running = events.flatMap((event) => (event.type === "spent" ? [event.micros] : []));
  expect(running.length).toBeGreaterThan(0);
  expect(running).toEqual([...running].sort((a, b) => a - b));
  expect(Math.max(...running)).toBeLessThanOrEqual(done.result.spentMicros);
});

test("a claim the company's side defeats with the offer's own words is dropped, with that quote, and asks for nothing", async () => {
  scenario.billedCents = 7000;
  scenario.counterQuote = "The price rises to $70 a month after 6 months.";
  const events: CheckEvent[] = [];
  await runCheck(
    { bills: [{ pages: [{ image: "data:image/png;base64,iVBORw0KGgoC", text: null }] }], offer: { kind: "text", text: "Fiber 500 for $55 a month. The price rises to $70 a month after 6 months." } },
    { ledger: openLedger(":memory:", 1_000_000), client: "test", signal: new AbortController().signal, emit: (event) => events.push(event) },
  );
  const done = events.find((event) => event.type === "result");
  if (done?.type !== "result" || done.result.outcome !== "checked") throw new Error(`no result: ${JSON.stringify(events.at(-1))}`);
  expect(done.result.calls.map((call) => call.name)).toEqual(["read_bill", "read_terms", "challenge"]);
  expect(done.result.claims).toEqual([]);
  expect(done.result.dropped).toMatchObject([{ claim: { kind: "price_above_promise", amountCents: 1500 }, counterQuote: scenario.counterQuote, source: "offer" }]);
  const message = buildMessage(done.result, new Set(done.result.dropped.map((d) => d.claim.id)), new Set());
  expect(`${message.chat}\n${message.complaint}`).not.toContain("$15.00");
});

// A year stops at its first failure. One that belongs to a single bill says which, so the page can name its file and
// the person can fix that one; "This bill is too long" alone, among twelve, leaves them guessing at another paid try.
test("a year stopped by one bill's failure names that bill by its place in the list", async () => {
  scenario.billedCents = 5500;
  scenario.counterQuote = null;
  scenario.tooLong = "February";
  const events: CheckEvent[] = [];
  const page = (tag: string) => ({ image: `data:image/png;base64,iVBORw0KGgo${tag}`, text: null });
  await runCheck(
    // Pages no other test sends, so no reading remembered from an earlier test answers for them.
    { bills: [{ pages: [page("AA")] }, { pages: [page("BB")] }], offer: { kind: "text", text: "Fiber 500 for $55 a month" } },
    { ledger: openLedger(":memory:", 1_000_000), client: "test", signal: new AbortController().signal, emit: (event) => events.push(event) },
  );
  scenario.tooLong = null;
  expect(events.at(-1)).toMatchObject({ type: "error", failure: "truncated", message: "This bill is too long for Muse Ember to read in one check. Use the pages with the charges.", bill: 1, retryable: false });
});

// A year names the bill Muse Ember declined; "declined to read these files" beside one file's name read as if every
// file had been declined. A single bill's check sends the bill and the offer together, where "these files" is right.
test("a declined bill in a year is told as that bill; a declined single check keeps the files", async () => {
  scenario.declined = "February";
  const page = (tag: string) => ({ image: `data:image/png;base64,iVBORw0KGgo${tag}`, text: null });
  const run = async (bills: { pages: ReturnType<typeof page>[] }[]) => {
    const events: CheckEvent[] = [];
    await runCheck({ bills, offer: { kind: "text", text: "Fiber 500 for $55 a month" } }, { ledger: openLedger(":memory:", 1_000_000), client: "test", signal: new AbortController().signal, emit: (event) => events.push(event) });
    return events.at(-1);
  };
  const year = await run([{ pages: [page("CC")] }, { pages: [page("DB")] }]);
  const single = await run([{ pages: [page("EEB")] }]);
  scenario.declined = null;
  expect(year).toMatchObject({ type: "error", failure: "refused", message: "Muse Ember declined to read this bill.", bill: 1 });
  expect(single).toMatchObject({ type: "error", failure: "refused", message: "Muse Ember declined to read these files." });
});

// One bill checked against the $55 offer, the pages named by `tag` so no reading from another test is reused; returns
// the last event and the Muse Ember steps taken.
const checkOneBill = async (tag: string) => {
  const events: CheckEvent[] = [];
  await runCheck({ bills: [{ pages: [{ image: `data:image/png;base64,iVBORw0KGgo${tag}`, text: null }] }], offer: { kind: "text", text: "Fiber 500 for $55 a month" } }, { ledger: openLedger(":memory:", 1_000_000), client: "test", signal: new AbortController().signal, emit: (event) => events.push(event) });
  const last = events.at(-1);
  return { last, steps: last?.type === "result" && last.result.outcome === "checked" ? last.result.calls.map((call) => call.name) : [] };
};

// A reading whose charges don't add up to the bill's printed total is read again; two readings that still disagree
// end the check rather than claim from either, and a second reading that adds up is the one used.
test("charges that don't add up are read again: two disagreeing readings stop the check, an agreeing one is used", async () => {
  scenario.printedCents = 7000;
  scenario.reread = { billedCents: 6000, printedCents: 7000 };
  const disagree = await checkOneBill("RA");
  scenario.reread = { billedCents: 7000, printedCents: 7000 };
  const agree = await checkOneBill("RB");
  scenario.printedCents = null;
  scenario.reread = null;
  expect(disagree.last).toMatchObject({ type: "result", result: { outcome: "could_not_check", reason: "The charges on this bill could not be read the same way twice." } });
  expect(agree.steps).toEqual(["read_bill", "reread_bill", "read_terms", "challenge"]);
  expect(agree.last).toMatchObject({ type: "result", result: { outcome: "checked", claims: [{ kind: "price_above_promise", amountCents: 1500 }] } });
});

// A picture Muse Ember finds isn't a bill, or can't read, ends there with that outcome and its reason, before the
// offer is read for nothing.
test("a picture that isn't a bill, or can't be read, ends with that outcome before the offer is read", async () => {
  scenario.outcome = "not_a_bill";
  const notABill = await checkOneBill("NA");
  scenario.outcome = "unreadable";
  const unreadable = await checkOneBill("NB");
  scenario.outcome = "bill";
  expect(notABill.last).toMatchObject({ type: "result", result: { outcome: "not_a_bill", spentMicros: COST.read_bill } });
  expect(unreadable.last).toMatchObject({ type: "result", result: { outcome: "could_not_check", reason: "The picture is too blurry to read the amounts.", spentMicros: COST.read_bill } });
});

// Past Muse Ember's long-context threshold every token costs more; such files are refused before anything is sent.
test("files too large to read in one check are refused before anything is spent", async () => {
  scenario.inputTokens = 250_000;
  const { last } = await checkOneBill("TL");
  scenario.inputTokens = 1000;
  expect(last).toMatchObject({ type: "error", failure: "bad_input", message: "These files are too large to read in one check.", spentMicros: 0 });
});

// Several pictures dropped as one bill, sorted as `kinds`; the tags keep each test's pictures its own. Returns the last
// event, the Muse Ember steps taken, and how many pictures the offer reading was sent.
const checkPictures = async (tag: string, kinds: typeof scenario.sorted, offer: { kind: "text"; text: string } | null) => {
  scenario.sorted = kinds;
  seen.offerPictures = 0;
  const events: CheckEvent[] = [];
  const pages = kinds.map((_, i) => ({ image: `data:image/png;base64,iVBORw0KGgo${tag}${i}`, text: null }));
  await runCheck({ bills: [{ pages }], offer }, { ledger: openLedger(":memory:", 1_000_000), client: "test", signal: new AbortController().signal, emit: (event) => events.push(event) });
  scenario.sorted = [];
  const last = events.at(-1);
  const checked = last?.type === "result" && last.result.outcome === "checked" ? last.result : null;
  return { last, steps: checked?.calls.map((call) => call.name) ?? [], hadOffer: checked?.hadOffer ?? null, offerPictures: seen.offerPictures };
};

// Pictures that turn out to hold no current bill (an earlier statement, a chat) are no bill to check, and nothing more
// is paid for: the bill isn't read.
test("pictures sorted as holding no current bill end as not a bill, without reading one", async () => {
  const { last } = await checkPictures("SN", ["older_bill", "other"], null);
  expect(last).toMatchObject({ type: "result", result: { outcome: "not_a_bill", spentMicros: COST.sort_pages } });
});

// A screenshot of the offer dropped with the bill is the offer when none was given, read with the bill; pictures that
// are all bill leave the check with no offer, so nothing is held to a promise nobody gave.
test("an offer picture among the bill's pictures is read as the offer; with none, the check has no offer", async () => {
  const withPromise = await checkPictures("SP", ["bill", "promise"], null);
  expect(withPromise).toMatchObject({ hadOffer: true, offerPictures: 1 });
  expect(withPromise.steps).toContain("read_terms");
  const billOnly = await checkPictures("SQ", ["bill", "bill"], null);
  expect(billOnly.hadOffer).toBe(false);
  expect(billOnly.steps).not.toContain("read_terms");
});

// The person's own words about the offer and a screenshot of it among the bill's pictures are read together, so a
// promise only the screenshot shows still counts.
test("an offer picture among the bill's pictures is read together with the offer the person wrote", async () => {
  const { offerPictures, steps } = await checkPictures("SW", ["bill", "promise"], { kind: "text", text: "They said $55 a month" });
  expect(steps).toContain("read_terms");
  expect(offerPictures).toBe(1);
});

// A bill (January) with an earlier statement (February, by its picture's name) among its pictures, which shows only
// what moved since and never makes a claim.
const checkWithEarlier = async (tag: string) => {
  scenario.sorted = ["bill", "older_bill"];
  const events: CheckEvent[] = [];
  const pages = [`${tag}A`, `${tag}B`].map((name) => ({ image: `data:image/png;base64,iVBORw0KGgo${name}`, text: null }));
  await runCheck({ bills: [{ pages }], offer: { kind: "text", text: "Fiber 500 for $55 a month" } }, { ledger: openLedger(":memory:", 1_000_000), client: "test", signal: new AbortController().signal, emit: (event) => events.push(event) });
  scenario.sorted = [];
  return events.at(-1);
};

// An earlier statement that can't be read (too long, or not a bill after all) leaves the comparison out; the check of
// the current bill goes on, and nothing is compared against charges never read.
test("an earlier statement that can't be read leaves out the comparison, never the check", async () => {
  scenario.tooLong = "February";
  const cutOff = await checkWithEarlier("EC");
  scenario.tooLong = null;
  scenario.notBillMonth = "February";
  const notABill = await checkWithEarlier("ED");
  scenario.notBillMonth = null;
  const readable = await checkWithEarlier("EE");
  for (const last of [cutOff, notABill]) expect(last).toMatchObject({ type: "result", result: { outcome: "checked", change: null } });
  expect(readable).toMatchObject({ type: "result", result: { outcome: "checked", change: { earlierCents: 5500, currentCents: 5500 } } });
});
