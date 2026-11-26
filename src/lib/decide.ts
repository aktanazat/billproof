import { moneyIn, quoteExactIn, quoteFoundIn, quoteHasAmount, tokens } from "./evidence";
import type { Challenge, LineItem, LineKind, PromiseTerm, Reading } from "./schemas";

// "heard" is a transcript Muse Ember made from a recording: quotes are checked against it, but a person confirms
// what was said before a claim built on it is used.
export type Source = { kind: "text"; text: string } | { kind: "image" } | { kind: "heard"; text: string };

export type ClaimKind = "price_above_promise" | "included_charged" | "credit_missing";
export type Claim = {
  id: string;
  kind: ClaimKind;
  lineIds: string[];
  promiseId: string;
  actualCents: number;
  expectedCents: number;
  amountCents: number;
  needsConfirmation: boolean;
};

// A claim after Muse Ember tried to disprove it: what it searched for, or null when no challenge ran.
export type TestedClaim = Claim & { lookedFor: string | null };
export type DroppedClaim = { claim: Claim; lookedFor: string; counterQuote: string; source: "bill" | "offer" };

export type QuestionKind =
  | "unagreed_fee"
  | "repeated_charge"
  | "partial_period"
  | "conditions_unproven"
  | "overlapping_claim"
  | "price_gap"
  | "provider_mismatch"
  | "end_date_unread";
export type Question = { id: string; kind: QuestionKind; lineIds: string[]; promiseId: string | null };

export type Explained = { id: string; kind: "promise_ended"; lineIds: string[]; promiseId: string; endedOn: string };

export type UnusedReason =
  | "kind_not_checked"
  | "quote_not_in_offer"
  | "amount_not_in_quote"
  | "no_matching_charge"
  | "line_not_on_bill"
  | "starts_later"
  | "no_price"
  | "no_credit_amount"
  | "item_not_named"
  | "amount_approximate";
export type Unused = { promiseId: string; reason: UnusedReason };

export type Decision = {
  claims: Claim[];
  questions: Question[];
  explained: Explained[];
  unused: Unused[];
  matchedPromiseIds: string[];
  providerMismatch: boolean;
};

type KindSet = Partial<Record<LineKind, true>>;
const CREDIT_KINDS: KindSet = { credit: true, discount: true };

// Words in a bill label that say nothing about which item it is.
const GENERIC_WORDS = new Set(["fee", "fees", "rental", "rent", "charge", "charges", "monthly", "service", "services", "plan", "line", "the", "and", "for", "with"]);

// An "included" promise names its item ("Wi-Fi Gateway: included"); a charge whose label shares no specific word
// with the quote is some other item the model linked by mistake. The company's own name says nothing about the item.
function quoteNamesLine(quote: string, label: string, provider: string | null): boolean {
  const said = new Set(tokens(quote));
  const company = new Set(tokens(provider ?? ""));
  return tokens(label).some((word) => word.length >= 3 && !GENERIC_WORDS.has(word) && !company.has(word) && said.has(word));
}

// A plan's own price is never "included": a promise of a free item linked to the plan line is about something else.
const COVERABLE: Record<Exclude<PromiseTerm["kind"], "other">, KindSet> = {
  monthly_price: { plan: true, discount: true, credit: true },
  included: { equipment: true, company_fee: true, one_time: true, other: true, credit: true, discount: true },
  recurring_credit: { plan: true, credit: true, discount: true },
};

// A line counts when its quote carries its amount and, on a PDF, appears in the text. A picture has no text to check
// against, so a quote that leaves the amount out is taken on its box alone; one that quotes another amount is not.
export function lineIsEvidenced(line: LineItem, bill: Source): boolean {
  if (bill.kind === "image") return line.box !== null && (quoteHasAmount(line.quote, line.amount_cents) || moneyIn(line.quote).length === 0);
  return quoteHasAmount(line.quote, line.amount_cents) && quoteFoundIn(line.quote, bill.text);
}

// "About $20", "approximately $269": a guess at a price is not a promise of it.
const APPROXIMATE = /(\b(approximately|approx\.?|around|roughly|about|supposedly|estimated)\s+|~\s*)\$?\d/i;

function promiseEvidenceProblem(promise: PromiseTerm, proof: Source): UnusedReason | null {
  if (proof.kind !== "image" && !quoteFoundIn(promise.quote, proof.text)) return "quote_not_in_offer";
  if (promise.amount_cents !== null && !quoteHasAmount(promise.quote, promise.amount_cents)) return "amount_not_in_quote";
  if (promise.amount_cents !== null && APPROXIMATE.test(promise.quote)) return "amount_approximate";
  return null;
}

type Activity = { state: "active" } | { state: "ended"; on: string } | { state: "not_started" } | { state: "partial" } | { state: "unknown" };

function activity(promise: PromiseTerm, reading: Reading): Activity {
  const from = promise.applies_from;
  const until = promise.applies_until;
  if (!from && !until) return { state: "active" };
  const start = reading.period_start ?? reading.statement_date;
  const end = reading.period_end ?? reading.statement_date;
  if (!start || !end) return { state: "unknown" };
  if (until && until < start) return { state: "ended", on: until };
  if (from && from > end) return { state: "not_started" };
  if ((until && until < end) || (from && from > start)) return { state: "partial" };
  return { state: "active" };
}

export type Equation = "ok" | "mismatch" | "not_printed";
// "subtotal": the first `subtotalLines` charges add up to the printed amount, a subtotal printed before the rest
// (taxes, a later section). Those lines are confirmed; the ones after it are not checked by the bill.
// "due": no printed current charges match, but the charges plus the unpaid balance carried over (`carriedCents`)
// come to the printed amount due.
// "sections": the charges, in order, add up to each total the bill prints for a part of them (a section, a person),
// every charge in one part.
export type LineSum = Equation | "subtotal" | "due" | "sections";
export type Totals = { lineSum: LineSum; balance: Equation; lineSumCents: number; subtotalLines: number | null; carriedCents: number };

// A printed summary value counts only when its quote carries the amount and, on a PDF, appears on the bill.
function printedValue(value: Reading["printed"]["total_due"], bill: Source): number | null {
  if (!value || !quoteHasAmount(value.quote, value.cents)) return null;
  return bill.kind === "image" || quoteFoundIn(value.quote, bill.text) ? value.cents : null;
}

// How many leading lines add up to the printed amount (the most that do), when at least two do and some lines
// come after them.
function subtotalLength(lines: LineItem[], printed: number): number | null {
  let running = 0;
  let longest: number | null = null;
  for (let i = 0; i < lines.length - 1; i++) {
    running += lines[i].amount_cents;
    if (i >= 1 && printed !== 0 && Math.abs(running - printed) <= 1) longest = i + 1;
  }
  return longest;
}

const near = (a: number, b: number) => Math.abs(a - b) <= 1;

type PartRuns = { runs: Map<string, number>; complete: boolean };

// Which part total each line falls under when the lines, in printed order, split into runs that add up to each part
// total in turn; $0 lines after the last part belong to it. complete is whether every line falls under a part; lines
// after the last part with an amount are left without one. Null when a part total isn't met.
function partRuns(lines: LineItem[], parts: number[]): PartRuns | null {
  if (parts.length === 0 || lines.length === 0) return null;
  const runs = new Map<string, number>();
  let at = 0;
  for (const [index, part] of parts.entries()) {
    let running = 0;
    let taken = 0;
    while (at < lines.length && (taken === 0 || !near(running, part))) {
      running += lines[at].amount_cents;
      runs.set(lines[at].id, index);
      at += 1;
      taken += 1;
    }
    if (!near(running, part)) return null;
  }
  const rest = lines.slice(at);
  const complete = rest.every((line) => line.amount_cents === 0);
  if (complete) for (const line of rest) runs.set(line.id, parts.length - 1);
  return { runs, complete };
}

// Part totals nest ("Services & Equipment $58.00" over "Services $22.00" and "Equipment $36.00"); a total that equals
// the totals printed right after it, or two or more printed right before it, is their parent and is left out.
function innermostParts(parts: number[]): number[] {
  const parentOf = (part: number, others: number[], fewest: number) => {
    let running = 0;
    return others.some((other, n) => near((running += other), part) && n + 1 >= fewest);
  };
  return parts.filter((part, i) => !parentOf(part, parts.slice(i + 1), 1) && !parentOf(part, parts.slice(0, i).reverse(), 2));
}

// The part each line falls under, from the part totals the bill prints, or their innermost ones when they nest; a
// split that uses every line is preferred.
function linesByPart(reading: Reading, bill: Source): PartRuns | null {
  const parts = (reading.printed.section_totals ?? []).map((part) => printedValue(part, bill));
  if (parts.some((part) => part === null)) return null;
  const printed = parts.filter((part) => part !== null);
  const asPrinted = partRuns(reading.line_items, printed);
  const innermost = partRuns(reading.line_items, innermostParts(printed));
  return asPrinted?.complete ? asPrinted : innermost?.complete ? innermost : (asPrinted ?? innermost);
}

// E1: the lines add up to the printed current charges, a printed subtotal, or, with what was carried over, the
// amount due. E2: previous balance − payments + current charges = total due.
export function checkTotals(reading: Reading, bill: Source): Totals {
  const previous = printedValue(reading.printed.previous_balance, bill);
  const payments = printedValue(reading.printed.payments, bill);
  const current = printedValue(reading.printed.current_charges, bill);
  const due = printedValue(reading.printed.total_due, bill);
  const lines = reading.line_items;
  const lineSumCents = sum(lines);
  // A balance printed without its payment counts as unpaid; a bill with no balance printed carries nothing.
  const carriedCents = previous === null ? 0 : previous - Math.abs(payments ?? 0);
  const currentMatches = current !== null && near(current, lineSumCents);
  const subtotalLines = current === null || currentMatches || lines.length === 0 ? null : subtotalLength(lines, current);
  const partsMatch = linesByPart(reading, bill)?.complete === true;
  // A bill that shows only its totals has no charges for them to check. A printed total the charges miss is a
  // mismatch even when part totals agree: something the parts don't show is on the bill.
  const lineSum: LineSum =
    lines.length === 0 ? "not_printed"
    : currentMatches ? "ok"
    : due !== null && near(carriedCents + lineSumCents, due) ? "due"
    : subtotalLines !== null ? "subtotal"
    : current !== null ? "mismatch"
    : partsMatch ? "sections"
    : "not_printed";
  const newCharges = lineSum === "subtotal" ? lineSumCents : current;
  let balance: Equation = "not_printed";
  if (previous !== null && payments !== null && newCharges !== null && due !== null) {
    balance = near(previous - Math.abs(payments) + newCharges, due) ? "ok" : "mismatch";
  }
  return { lineSum, balance, lineSumCents, subtotalLines, carriedCents };
}

// A heading read as a charge ("Apple TV $3.00" over "Apple TV $12.99" and "Apple TV Discount -$9.99") counts its
// lines twice. A line whose amount equals the lines right after it, the first of which starts with the same word,
// is such a heading; they are dropped only when that makes the lines add up to the printed total, so a charge
// that really is billed twice stays.
export function withoutHeadings(reading: Reading, bill: Source): Reading | null {
  const lines = reading.line_items;
  const firstWord = (label: string) => tokens(label)[0] ?? "";
  const headings = new Set<string>();
  lines.forEach((line, i) => {
    if (i + 1 >= lines.length || firstWord(lines[i + 1].label) !== firstWord(line.label)) return;
    let below = 0;
    for (let j = i + 1; j < lines.length; j++) {
      below += lines[j].amount_cents;
      if (near(below, line.amount_cents)) {
        headings.add(line.id);
        return;
      }
    }
  });
  if (headings.size === 0) return null;
  const kept: Reading = { ...reading, line_items: lines.filter((line) => !headings.has(line.id)).map((line, i) => ({ ...line, id: `L${i + 1}` })) };
  return checkTotals(kept, bill).lineSum === "ok" ? kept : null;
}

const sum = (lines: LineItem[]) => lines.reduce((total, line) => total + line.amount_cents, 0);

export type BillChange = { earlierCents: number; currentCents: number; lines: { label: string; beforeCents: number | null; afterCents: number | null }[] };

// Amounts in parentheses ("2 Product Discount (-$20.00)") are detail, not part of the name.
const labelKey = (label: string) => label.toLowerCase().replace(/\([^)]*\)/g, " ").replace(/\s+/g, " ").trim();

function centsByLabel(reading: Reading): Map<string, { label: string; cents: number }> {
  const totals = new Map<string, { label: string; cents: number }>();
  for (const line of reading.line_items) {
    const key = labelKey(line.label);
    const seen = totals.get(key);
    totals.set(key, { label: seen?.label ?? line.label, cents: (seen?.cents ?? 0) + line.amount_cents });
  }
  return totals;
}

// What moved between an earlier statement and this one: lines with the same label are summed, and only lines
// whose amount changed, appeared or went away are kept, the biggest move first. A line one month prints with extra
// words after its name ("2 Product Discount" then "2 Product Discount Automatic Payments…") is the same line.
export function compareBills(earlier: Reading, current: Reading): BillChange {
  const before = centsByLabel(earlier);
  const after = centsByLabel(current);
  for (const key of [...before.keys()].filter((k) => !after.has(k))) {
    const longer = [...after.keys()].filter((k) => !before.has(k) && (k.startsWith(`${key} `) || key.startsWith(`${k} `)));
    const entry = before.get(key);
    if (longer.length !== 1 || !entry) continue;
    before.delete(key);
    before.set(longer[0], entry);
  }
  const move = (line: BillChange["lines"][number]) => Math.abs((line.afterCents ?? 0) - (line.beforeCents ?? 0));
  const lines = [...new Set([...before.keys(), ...after.keys()])]
    .map((key) => ({ label: after.get(key)?.label ?? before.get(key)?.label ?? key, beforeCents: before.get(key)?.cents ?? null, afterCents: after.get(key)?.cents ?? null }))
    .filter((line) => line.beforeCents !== line.afterCents)
    .sort((a, b) => move(b) - move(a));
  return { earlierCents: sum(earlier.line_items), currentCents: sum(current.line_items), lines };
}

const GENERIC_PROVIDER_WORDS = new Set(["fiber", "cable", "internet", "wireless", "mobile", "power", "energy", "electric", "gas", "water", "tv", "communications", "telecom", "broadband", "inc", "llc", "co", "corp", "company", "the", "and", "of"]);

function distinctiveWords(name: string): Set<string> {
  return new Set(tokens(name).filter((word) => word.length > 1 && !GENERIC_PROVIDER_WORDS.has(word)));
}

// True only when both names are known and share no distinctive word ("Bayline Fiber" vs "Westline Fiber").
export function providersDiffer(billProvider: string | null, offerProvider: string | null): boolean {
  if (!billProvider || !offerProvider) return false;
  const bill = distinctiveWords(billProvider);
  const offer = distinctiveWords(offerProvider);
  if (bill.size === 0 || offer.size === 0) return false;
  return ![...offer].some((word) => bill.has(word));
}

// A promised price under half of what the covered lines cost, or a promised credit over half the plan price, is
// more likely a misread amount than a real overcharge; it becomes a question.
const MAX_PLAUSIBLE_SHARE = 0.5;

// Wording that limits a promise in time. When the quote has it but no end date was read, the promise may
// already have ended, so it can only raise a question.
const TIME_LIMIT = /\b(through|thru|until|ends?|ending|expires?|for (\d+|a|one|two|three) (months?|mos?|years?|yrs?)|\d+[- ](months?|mos?|years?)|promo(tional)?|\d{1,2}\/\d{1,2}\/\d{2,4}|(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.? \d{1,2},? \d{4})\b/i;

// Charges a government sets and the company only collects, whatever kind the reading gave them, including combined
// "Taxes & fees" lines. "Tax Recovery" and "Regulatory Cost Recovery" fees are the company's own and don't match.
const GOVERNMENT_FEE = /\b(franchise fee|peg|9-?1-?1|988|universal service|taxes|sales (and use )?tax|users? tax|excise tax|public,? educ)/i;
// A fee the company adds reads like one; a service ("WiFi Service") does not. Penalties for a bounced or late payment
// follow from what the customer did, not from the plan.
const FEE_WORDS = /\b(fees?|surcharges?|charges?|recovery|cost)\b/i;
const PENALTY = /\b(return(ed)? payment|late (payment )?fee|insufficient funds|nsf)\b/i;
const isCompanyAddedFee = (label: string) => FEE_WORDS.test(label) && !GOVERNMENT_FEE.test(label) && !PENALTY.test(label);

type Draft = Omit<Claim, "id">;

export function decide(reading: Reading, promises: PromiseTerm[], bill: Source, proof: Source, offerProvider: string | null = null): Decision {
  const lines = new Map(reading.line_items.map((line) => [line.id, line]));
  const drafts: Draft[] = [];
  const questions: Omit<Question, "id">[] = [];
  const explained: Omit<Explained, "id">[] = [];
  const unused: Unused[] = [];
  const governed = new Set<string>();
  const matchedPromiseIds: string[] = [];
  const photoEvidence = bill.kind === "image" || proof.kind !== "text";

  for (const promise of promises) {
    if (promise.kind === "other") {
      unused.push({ promiseId: promise.id, reason: "kind_not_checked" });
      continue;
    }
    const problem = promiseEvidenceProblem(promise, proof);
    if (problem) {
      unused.push({ promiseId: promise.id, reason: problem });
      continue;
    }
    const allowed = COVERABLE[promise.kind];
    const linked = [...new Set(promise.covers_line_ids)]
      .map((id) => lines.get(id))
      .filter((line): line is LineItem => line !== undefined && allowed[line.kind] === true);
    // A price promised "with autopay" is net of that discount even when the discount line was not linked.
    const conditionCredits =
      promise.kind === "monthly_price" && promise.conditions.some((c) => c === "autopay" || c === "paperless")
        ? reading.line_items.filter((line) => CREDIT_KINDS[line.kind] && !linked.includes(line) && /auto\s?pay|paperless/i.test(line.label))
        : [];
    const covered = [...linked, ...conditionCredits];
    if (covered.length === 0) {
      unused.push({ promiseId: promise.id, reason: "no_matching_charge" });
      continue;
    }
    const unevidenced = covered.filter((line) => !lineIsEvidenced(line, bill));
    if (unevidenced.length > 0) {
      unused.push({ promiseId: promise.id, reason: "line_not_on_bill" });
      continue;
    }
    matchedPromiseIds.push(promise.id);
    for (const line of covered) governed.add(line.id);
    const lineIds = covered.map((line) => line.id);

    const when = activity(promise, reading);
    if (when.state === "ended") {
      explained.push({ kind: "promise_ended", lineIds, promiseId: promise.id, endedOn: when.on });
      continue;
    }
    if (when.state === "not_started") {
      unused.push({ promiseId: promise.id, reason: "starts_later" });
      continue;
    }
    if (when.state !== "active" || covered.some((line) => line.prorated)) {
      questions.push({ kind: "partial_period", lineIds, promiseId: promise.id });
      continue;
    }
    if (promise.applies_until === null && TIME_LIMIT.test(promise.quote)) {
      questions.push({ kind: "end_date_unread", lineIds, promiseId: promise.id });
      continue;
    }

    const planLines = covered.filter((line) => line.kind === "plan");
    // A $0 plan line (a free line, a paused tablet) gets no per-line price or credit.
    const units = promise.per_line ? Math.max(planLines.filter((line) => line.amount_cents > 0).length, 1) : 1;
    const autopayProven = reading.autopay.enrolled === true && reading.autopay.quote !== null && (bill.kind === "image" || quoteFoundIn(reading.autopay.quote, bill.text));
    // Only autopay can be proven from a bill; paperless, bundle and contract terms cannot.
    const unproven = promise.conditions.filter((condition) => !(condition === "autopay" && autopayProven));

    if (promise.kind === "monthly_price") {
      if (promise.amount_cents === null || planLines.length === 0) {
        unused.push({ promiseId: promise.id, reason: "no_price" });
        continue;
      }
      // A posted discount on the covered lines shows the company already counts the conditions as met.
      const discountPosted = covered.some((line) => CREDIT_KINDS[line.kind]);
      if (unproven.length > 0 && !discountPosted) {
        questions.push({ kind: "conditions_unproven", lineIds, promiseId: promise.id });
        continue;
      }
      const expected = promise.amount_cents * units;
      const actual = sum(covered);
      if (actual <= expected) continue;
      if (expected < actual * MAX_PLAUSIBLE_SHARE) {
        questions.push({ kind: "price_gap", lineIds, promiseId: promise.id });
        continue;
      }
      drafts.push({ kind: "price_above_promise", lineIds, promiseId: promise.id, actualCents: actual, expectedCents: expected, amountCents: actual - expected, needsConfirmation: photoEvidence });
      continue;
    }

    if (promise.kind === "included") {
      const named = covered.filter((line) => line.amount_cents > 0 && quoteNamesLine(promise.quote, line.label, reading.provider));
      // A discount printed right under the item for exactly its amount pays it back, even when it wasn't linked.
      const offsets = reading.line_items.filter((line, i) => CREDIT_KINDS[line.kind] && i > 0 && !covered.includes(line) && named.some((item) => item.id === reading.line_items[i - 1].id && near(item.amount_cents, -line.amount_cents)));
      const credits = [...covered.filter((line) => line.amount_cents < 0), ...offsets];
      const actual = sum([...named, ...credits]);
      if (named.length === 0 && covered.some((line) => line.amount_cents > 0)) unused.push({ promiseId: promise.id, reason: "item_not_named" });
      else if (actual > 0) {
        drafts.push({ kind: "included_charged", lineIds: [...named, ...credits].map((line) => line.id), promiseId: promise.id, actualCents: actual, expectedCents: 0, amountCents: actual, needsConfirmation: photoEvidence });
      }
      continue;
    }

    if (promise.amount_cents === null) {
      unused.push({ promiseId: promise.id, reason: "no_credit_amount" });
      continue;
    }
    if (unproven.length > 0) {
      questions.push({ kind: "conditions_unproven", lineIds, promiseId: promise.id });
      continue;
    }
    const expected = Math.abs(promise.amount_cents) * units;
    const posted = -sum(covered.filter((line) => CREDIT_KINDS[line.kind]));
    if (posted >= expected) continue;
    if (expected > sum(planLines) * MAX_PLAUSIBLE_SHARE) {
      questions.push({ kind: "price_gap", lineIds, promiseId: promise.id });
      continue;
    }
    drafts.push({ kind: "credit_missing", lineIds, promiseId: promise.id, actualCents: posted, expectedCents: expected, amountCents: expected - posted, needsConfirmation: photoEvidence });
  }

  // An offer from another company proves nothing about this bill.
  const providerMismatch = providersDiffer(reading.provider, offerProvider);
  if (providerMismatch) {
    for (const draft of drafts.splice(0)) questions.push({ kind: "provider_mismatch", lineIds: draft.lineIds, promiseId: draft.promiseId });
  }

  // Each line can back one dollar claim; the larger claim keeps it.
  const claimed = new Set<string>();
  const claims: Claim[] = [];
  for (const draft of [...drafts].sort((a, b) => b.amountCents - a.amountCents)) {
    if (draft.lineIds.some((id) => claimed.has(id))) {
      questions.push({ kind: "overlapping_claim", lineIds: draft.lineIds, promiseId: draft.promiseId });
      continue;
    }
    for (const id of draft.lineIds) claimed.add(id);
    claims.push({ ...draft, id: `C${claims.length + 1}` });
  }

  for (const line of reading.line_items) {
    if (line.kind === "company_fee" && line.amount_cents > 0 && !governed.has(line.id) && isCompanyAddedFee(line.label) && lineIsEvidenced(line, bill)) {
      questions.push({ kind: "unagreed_fee", lineIds: [line.id], promiseId: null });
    }
  }

  // A charge printed once for each person or phone line is not a repeat: when the bill's own part totals split its
  // lines, copies that fall under different parts belong to different people. Copies on different pictures are
  // either separate tabs or the same line pictured twice by overlapping screenshots; on a PDF, pages are one statement.
  const partOf = linesByPart(reading, bill)?.runs ?? null;
  const samePlace = (a: LineItem, b: LineItem) =>
    (bill.kind !== "image" || a.page === b.page) && (partOf === null || !partOf.has(a.id) || !partOf.has(b.id) || partOf.get(a.id) === partOf.get(b.id));
  const byKey = new Map<string, LineItem[]>();
  for (const line of reading.line_items) {
    if (line.kind === "government_tax" || line.amount_cents <= 0) continue;
    const key = `${tokens(line.label).join(" ")}|${line.amount_cents}`;
    byKey.set(key, [...(byKey.get(key) ?? []), line]);
  }
  for (const group of byKey.values()) {
    const repeated = group.some((line, i) => group.slice(i + 1).some((other) => samePlace(line, other)));
    if (repeated && !group.every((line) => claimed.has(line.id))) {
      questions.push({ kind: "repeated_charge", lineIds: group.map((line) => line.id), promiseId: null });
    }
  }

  // Two promises on the same lines (a price and its discount) raise the same question once, not twice in the same words.
  const asked = new Set<string>();
  const distinct = questions.filter((q) => {
    if (q.promiseId === null) return true;
    const key = `${q.kind}|${[...q.lineIds].sort().join(",")}`;
    if (asked.has(key)) return false;
    asked.add(key);
    return true;
  });

  return {
    claims,
    questions: distinct.map((q, i) => ({ ...q, id: `Q${i + 1}` })),
    explained: explained.map((e, i) => ({ ...e, id: `E${i + 1}` })),
    unused,
    matchedPromiseIds,
    providerMismatch,
  };
}

// The bill is the company's own account, so its notices ("your promotional pricing ended") restate the dispute rather
// than settle it. From the bill, only a credit line that pays the claim back can defeat it.
function billPaysBack(claim: Claim, quote: string, reading: Reading): boolean {
  const quoted = moneyIn(quote).map(Math.abs);
  return reading.line_items.some(
    (line) => line.amount_cents < 0 && !claim.lineIds.includes(line.id) && -line.amount_cents >= claim.amountCents && quoted.includes(-line.amount_cents) && quoteFoundIn(line.label, quote),
  );
}

// A claim survives unless Muse Ember, arguing for the company, quotes the offer word for word against it, or quotes a
// bill credit that pays it back. A rebuttal from the offer whose words can't be found keeps the claim but sends it to
// the person to confirm.
export function settleChallenges(claims: Claim[], challenges: Challenge[], reading: Reading, bill: Source, proof: Source): { claims: TestedClaim[]; dropped: DroppedClaim[] } {
  const kept: TestedClaim[] = [];
  const dropped: DroppedClaim[] = [];
  for (const claim of claims) {
    const challenge = challenges.find((c) => c.claim_id === claim.id);
    if (!challenge) {
      kept.push({ ...claim, lookedFor: null });
      continue;
    }
    const quote = challenge.counter_quote;
    if (challenge.verdict !== "refuted" || !quote || !challenge.counter_source) {
      kept.push({ ...claim, lookedFor: challenge.looked_for });
      continue;
    }
    const where = challenge.counter_source === "bill" ? bill : proof;
    // Exact words only: a fuzzy match would accept a quote missing a "not".
    const onSource = where.kind !== "image" && quoteExactIn(quote, where.text);
    if (challenge.counter_source === "bill") {
      if (onSource && billPaysBack(claim, quote, reading)) dropped.push({ claim, lookedFor: challenge.looked_for, counterQuote: quote, source: "bill" });
      else kept.push({ ...claim, lookedFor: challenge.looked_for });
      continue;
    }
    if (onSource || offerChargeExplains(claim, quote, where)) dropped.push({ claim, lookedFor: challenge.looked_for, counterQuote: quote, source: "offer" });
    else kept.push({ ...claim, lookedFor: challenge.looked_for, needsConfirmation: true });
  }
  return { claims: kept, dropped };
}

// A picture of an offer has no text to hold a rebuttal to, but a fee or tax the offer itself lists for exactly the
// amount a price claim is over ("California Cost Recovery Charge $1.25") is a charge the customer was shown, and a
// bill line that rolls it into the price is not above the promise.
function offerChargeExplains(claim: Claim, quote: string, offer: Source): boolean {
  return offer.kind === "image" && claim.kind === "price_above_promise" && (FEE_WORDS.test(quote) || /\btax(es)?\b/i.test(quote)) && moneyIn(quote).map(Math.abs).includes(claim.amountCents);
}
