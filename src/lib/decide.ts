import { quoteFoundIn, quoteHasAmount, tokens } from "./evidence";
import type { LineItem, LineKind, PromiseTerm, Reading } from "./schemas";

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
  | "no_credit_amount";
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
const COVERABLE: Record<Exclude<PromiseTerm["kind"], "other">, KindSet> = {
  monthly_price: { plan: true, discount: true, credit: true },
  included: { equipment: true, company_fee: true, one_time: true, plan: true, other: true, credit: true, discount: true },
  recurring_credit: { plan: true, credit: true, discount: true },
};

export function lineIsEvidenced(line: LineItem, bill: Source): boolean {
  if (!quoteHasAmount(line.quote, line.amount_cents)) return false;
  return bill.kind === "image" ? line.box !== null : quoteFoundIn(line.quote, bill.text);
}

function promiseEvidenceProblem(promise: PromiseTerm, proof: Source): UnusedReason | null {
  if (proof.kind !== "image" && !quoteFoundIn(promise.quote, proof.text)) return "quote_not_in_offer";
  if (promise.amount_cents !== null && !quoteHasAmount(promise.quote, promise.amount_cents)) return "amount_not_in_quote";
  return null;
}

type Activity = { state: "active" } | { state: "ended"; on: string } | { state: "not_started" } | { state: "partial" } | { state: "unknown" };

function activity(promise: PromiseTerm, reading: Reading): Activity {
  const start = reading.period_start ?? reading.statement_date;
  const end = reading.period_end ?? reading.statement_date;
  if (!start || !end) return { state: "unknown" };
  const from = promise.applies_from;
  const until = promise.applies_until;
  if (until && until < start) return { state: "ended", on: until };
  if (from && from > end) return { state: "not_started" };
  if ((until && until < end) || (from && from > start)) return { state: "partial" };
  return { state: "active" };
}

export type Equation = "ok" | "mismatch" | "not_printed";
export type Totals = { lineSum: Equation; balance: Equation; lineSumCents: number };

// A printed summary value counts only when its quote carries the amount and, on a PDF, appears on the bill.
function printedValue(value: Reading["printed"]["total_due"], bill: Source): number | null {
  if (!value || !quoteHasAmount(value.quote, value.cents)) return null;
  return bill.kind === "image" || quoteFoundIn(value.quote, bill.text) ? value.cents : null;
}

// E1: the lines add up to the printed current charges. E2: previous balance − payments + current charges = total due.
export function checkTotals(reading: Reading, bill: Source): Totals {
  const previous = printedValue(reading.printed.previous_balance, bill);
  const payments = printedValue(reading.printed.payments, bill);
  const current = printedValue(reading.printed.current_charges, bill);
  const due = printedValue(reading.printed.total_due, bill);
  const lineSumCents = sum(reading.line_items);
  const lineSum: Equation = current === null ? "not_printed" : Math.abs(current - lineSumCents) <= 1 ? "ok" : "mismatch";
  let balance: Equation = "not_printed";
  if (previous !== null && payments !== null && current !== null && due !== null) {
    balance = Math.abs(previous - Math.abs(payments) + current - due) <= 1 ? "ok" : "mismatch";
  }
  return { lineSum, balance, lineSumCents };
}

const sum = (lines: LineItem[]) => lines.reduce((total, line) => total + line.amount_cents, 0);

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
const TIME_LIMIT = /\b(through|thru|until|ends?|ending|expires?|for \d+ (months?|years?)|\d+[- ](month|year)|promo(tional)?|\d{1,2}\/\d{1,2}\/\d{2,4}|(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.? \d{1,2},? \d{4})\b/i;

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
    const units = promise.per_line ? Math.max(planLines.length, 1) : 1;
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
      const actual = sum(covered);
      if (actual > 0) {
        drafts.push({ kind: "included_charged", lineIds, promiseId: promise.id, actualCents: actual, expectedCents: 0, amountCents: actual, needsConfirmation: photoEvidence });
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
    if (line.kind === "company_fee" && line.amount_cents > 0 && !governed.has(line.id) && lineIsEvidenced(line, bill)) {
      questions.push({ kind: "unagreed_fee", lineIds: [line.id], promiseId: null });
    }
  }

  const byKey = new Map<string, LineItem[]>();
  for (const line of reading.line_items) {
    if (line.kind === "government_tax" || line.amount_cents <= 0) continue;
    const key = `${tokens(line.label).join(" ")}|${line.amount_cents}`;
    byKey.set(key, [...(byKey.get(key) ?? []), line]);
  }
  for (const group of byKey.values()) {
    if (group.length > 1 && !group.every((line) => claimed.has(line.id))) {
      questions.push({ kind: "repeated_charge", lineIds: group.map((line) => line.id), promiseId: null });
    }
  }

  return {
    claims,
    questions: questions.map((q, i) => ({ ...q, id: `Q${i + 1}` })),
    explained: explained.map((e, i) => ({ ...e, id: `E${i + 1}` })),
    unused,
    matchedPromiseIds,
    providerMismatch,
  };
}
