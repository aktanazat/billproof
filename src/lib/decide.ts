import { quoteFoundIn, quoteHasAmount, tokens } from "./evidence";
import type { LineItem, LineKind, PromiseTerm, Reading } from "./schemas";

export type Source = { kind: "text"; text: string } | { kind: "image" };

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

export type QuestionKind = "unagreed_fee" | "repeated_charge" | "partial_period" | "conditions_unproven" | "overlapping_claim";
export type Question = { id: string; kind: QuestionKind; lineIds: string[]; promiseId: string | null };

export type Explained = { id: string; kind: "promise_ended"; lineIds: string[]; promiseId: string; endedOn: string };

export type Unused = { promiseId: string; reason: string };

export type Decision = {
  claims: Claim[];
  questions: Question[];
  explained: Explained[];
  unused: Unused[];
  matchedPromiseIds: string[];
};

type KindSet = Partial<Record<LineKind, true>>;
const CREDIT_KINDS: KindSet = { credit: true, discount: true };
const COVERABLE: Record<Exclude<PromiseTerm["kind"], "other">, KindSet> = {
  monthly_price: { plan: true, discount: true, credit: true },
  included: { equipment: true, company_fee: true, one_time: true, plan: true, other: true },
  recurring_credit: { plan: true, credit: true, discount: true },
};

export function lineIsEvidenced(line: LineItem, bill: Source): boolean {
  if (!quoteHasAmount(line.quote, line.amount_cents)) return false;
  return bill.kind === "text" ? quoteFoundIn(line.quote, bill.text) : line.box !== null;
}

function promiseEvidenceProblem(promise: PromiseTerm, proof: Source): string | null {
  if (proof.kind === "text" && !quoteFoundIn(promise.quote, proof.text)) return "its quote is not in the offer";
  if (promise.amount_cents !== null && !quoteHasAmount(promise.quote, promise.amount_cents)) {
    return "its amount is not in the quoted text";
  }
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

// E1: the lines add up to the printed current charges. E2: previous balance − payments + current charges = total due.
export function checkTotals(reading: Reading): Totals {
  const { previous_balance, payments, current_charges, total_due } = reading.printed;
  const lineSumCents = sum(reading.line_items);
  const lineSum: Equation = current_charges === null ? "not_printed" : Math.abs(current_charges.cents - lineSumCents) <= 1 ? "ok" : "mismatch";
  let balance: Equation = "not_printed";
  if (previous_balance && payments && current_charges && total_due) {
    const computed = previous_balance.cents - Math.abs(payments.cents) + current_charges.cents;
    balance = Math.abs(computed - total_due.cents) <= 1 ? "ok" : "mismatch";
  }
  return { lineSum, balance, lineSumCents };
}

const sum = (lines: LineItem[]) => lines.reduce((total, line) => total + line.amount_cents, 0);

type Draft = Omit<Claim, "id">;

export function decide(reading: Reading, promises: PromiseTerm[], bill: Source, proof: Source): Decision {
  const lines = new Map(reading.line_items.map((line) => [line.id, line]));
  const drafts: Draft[] = [];
  const questions: Omit<Question, "id">[] = [];
  const explained: Omit<Explained, "id">[] = [];
  const unused: Unused[] = [];
  const governed = new Set<string>();
  const matchedPromiseIds: string[] = [];
  const photoEvidence = bill.kind === "image" || proof.kind === "image";

  for (const promise of promises) {
    if (promise.kind === "other") {
      unused.push({ promiseId: promise.id, reason: "this kind of promise is not checked yet" });
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
      unused.push({ promiseId: promise.id, reason: "no charge on this bill matches it" });
      continue;
    }
    const unevidenced = covered.filter((line) => !lineIsEvidenced(line, bill));
    if (unevidenced.length > 0) {
      unused.push({ promiseId: promise.id, reason: "a matching line could not be found on the bill as quoted" });
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
      unused.push({ promiseId: promise.id, reason: "it starts after this bill's period" });
      continue;
    }
    if (when.state !== "active" || covered.some((line) => line.prorated)) {
      questions.push({ kind: "partial_period", lineIds, promiseId: promise.id });
      continue;
    }

    const planLines = covered.filter((line) => line.kind === "plan");
    const units = promise.per_line ? Math.max(planLines.length, 1) : 1;
    const autopayProven = reading.autopay.enrolled === true && reading.autopay.quote !== null && (bill.kind === "image" || quoteFoundIn(reading.autopay.quote, bill.text));
    const needsAutopay = promise.conditions.includes("autopay") || promise.conditions.includes("paperless");

    if (promise.kind === "monthly_price") {
      if (promise.amount_cents === null || planLines.length === 0) {
        unused.push({ promiseId: promise.id, reason: "it names no price for a plan on this bill" });
        continue;
      }
      const discountPosted = covered.some((line) => CREDIT_KINDS[line.kind]);
      if (needsAutopay && !discountPosted && !autopayProven) {
        questions.push({ kind: "conditions_unproven", lineIds, promiseId: promise.id });
        continue;
      }
      const expected = promise.amount_cents * units;
      const actual = sum(covered);
      if (actual > expected) {
        drafts.push({ kind: "price_above_promise", lineIds, promiseId: promise.id, actualCents: actual, expectedCents: expected, amountCents: actual - expected, needsConfirmation: photoEvidence });
      }
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
      unused.push({ promiseId: promise.id, reason: "it names no credit amount" });
      continue;
    }
    if (needsAutopay && !autopayProven) {
      questions.push({ kind: "conditions_unproven", lineIds, promiseId: promise.id });
      continue;
    }
    const expected = Math.abs(promise.amount_cents) * units;
    const posted = -sum(covered.filter((line) => CREDIT_KINDS[line.kind]));
    if (posted < expected) {
      drafts.push({ kind: "credit_missing", lineIds, promiseId: promise.id, actualCents: posted, expectedCents: expected, amountCents: expected - posted, needsConfirmation: photoEvidence });
    }
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
  };
}
