import type { Claim, Question } from "./decide";
import type { Checked } from "./result";
import type { LineItem, PromiseTerm } from "./schemas";

export function usd(cents: number): string {
  const sign = cents < 0 ? "-" : "";
  return `${sign}$${(Math.abs(cents) / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export function shortDate(iso: string): string {
  const [y, m, d] = iso.split("-").map(Number);
  return `${MONTHS[m - 1]} ${d}, ${y}`;
}

function periodText(result: Checked): string {
  const { period_start, period_end, statement_date } = result.reading;
  if (period_start && period_end) return `${shortDate(period_start)} to ${shortDate(period_end)}`;
  return statement_date ? `the statement dated ${shortDate(statement_date)}` : "this bill";
}

function names(lines: LineItem[]): string {
  const labels = [...new Set(lines.map((line) => line.label))];
  return labels.length <= 1 ? (labels[0] ?? "this charge") : `${labels.slice(0, -1).join(", ")} and ${labels.at(-1)}`;
}

function claimSentence(claim: Claim, lines: LineItem[], promise: PromiseTerm, period: string, onCall: boolean): string {
  // A promise heard on a recorded call is cited as what the representative said, with the moment it was said.
  const quoted = onCall && promise.said_at_seconds !== null ? `your representative told me on the call, at ${Math.floor(promise.said_at_seconds / 60)}:${String(Math.floor(promise.said_at_seconds % 60)).padStart(2, "0")} in my recording: "${promise.quote.trim()}"` : `"${promise.quote.trim()}"`;
  switch (claim.kind) {
    case "price_above_promise": {
      const discounted = lines.some((line) => line.amount_cents < 0) ? " after discounts" : "";
      return `For ${period}, ${names(lines.filter((line) => line.amount_cents > 0))} comes to ${usd(claim.actualCents)}${discounted}, but my plan was confirmed at ${usd(claim.expectedCents)} a month (${quoted}). Please credit the ${usd(claim.amountCents)} difference and correct the rate.`;
    }
    case "included_charged":
      return `I was charged ${usd(claim.amountCents)} for ${names(lines.filter((line) => line.amount_cents > 0))}, which was included at no extra cost (${quoted}). Please remove it and credit ${usd(claim.amountCents)}.`;
    case "credit_missing":
      return `My account is on autopay, but this bill has ${claim.actualCents === 0 ? "no" : `only ${usd(claim.actualCents)} of the`} ${usd(claim.expectedCents)} monthly credit I was promised (${quoted}). Please apply the missing ${usd(claim.amountCents)}.`;
  }
}

function questionSentence(question: Question, lines: LineItem[]): string | null {
  switch (question.kind) {
    case "unagreed_fee":
      return `Please explain the ${names(lines)} (${usd(lines[0].amount_cents)}). It was not part of the plan I agreed to; if it is not required, please remove it.`;
    case "repeated_charge":
      return `${names(lines)} appears ${lines.length} times (${lines.map((line) => usd(line.amount_cents)).join(" and ")}). Please confirm whether this is a duplicate and credit it if so.`;
    default:
      return null;
  }
}

export type Message = { totalCents: number; chat: string; email: string; call: string };

export function buildMessage(result: Checked, selectedClaimIds: ReadonlySet<string>, includedQuestionIds: ReadonlySet<string>): Message {
  const lines = new Map(result.reading.line_items.map((line) => [line.id, line]));
  const promises = new Map(result.promises.map((promise) => [promise.id, promise]));
  const period = periodText(result);
  const linesOf = (ids: string[]) => ids.flatMap((id) => lines.get(id) ?? []);

  const claims = result.claims.filter((claim) => selectedClaimIds.has(claim.id));
  const totalCents = claims.reduce((total, claim) => total + claim.amountCents, 0);
  const claimText = claims.flatMap((claim) => {
    const promise = promises.get(claim.promiseId);
    return promise ? [claimSentence(claim, linesOf(claim.lineIds), promise, period, result.transcript !== null)] : [];
  });
  const questionText = result.questions
    .filter((question) => includedQuestionIds.has(question.id))
    .flatMap((question) => questionSentence(question, linesOf(question.lineIds)) ?? []);

  const provider = result.reading.provider ?? "your company";
  const account = result.reading.account_last4 ? `account ending ${result.reading.account_last4}` : "my account";
  const ask = totalCents > 0 ? `In total, please credit ${usd(totalCents)} to ${account}.` : "";
  const body = [...claimText, ...questionText];

  const chat = [`Hi, I'm writing about ${account}, bill for ${period}.`, ...body, ask].filter(Boolean).join("\n\n");
  const email = [
    `Subject: Billing correction for ${account}`,
    "",
    `Hello ${provider} billing team,`,
    "",
    `I'm writing about ${account}, bill for ${period}.`,
    "",
    ...body.flatMap((sentence) => [sentence, ""]),
    ...(ask ? [ask, ""] : []),
    "Please reply with the corrected amount and the date the credit will post.",
    "",
    "Thank you,",
    "[Your name]",
  ].join("\n");
  const call = [
    `I'm calling about ${account}, bill for ${period}.`,
    ...body.map((sentence, i) => `${i + 1}. ${sentence}`),
    ask,
    "Before ending the call, ask for a reference number and the date the credit will post.",
  ]
    .filter(Boolean)
    .join("\n\n");

  return { totalCents, chat, email, call };
}

// One message for a year of statements: each month's claims under its statement, then the total.
export function buildYearMessage(months: Checked[]): Message {
  const withClaims = months.filter((month) => month.claims.length > 0);
  const totalCents = withClaims.reduce((sum, month) => sum + month.claims.reduce((t, claim) => t + claim.amountCents, 0), 0);
  const first = withClaims[0]?.reading;
  const account = first?.account_last4 ? `account ending ${first.account_last4}` : "my account";
  const sections = withClaims.map((month) => {
    const lines = new Map(month.reading.line_items.map((line) => [line.id, line]));
    const promises = new Map(month.promises.map((promise) => [promise.id, promise]));
    const sentences = month.claims.flatMap((claim) => {
      const promise = promises.get(claim.promiseId);
      return promise ? [claimSentence(claim, claim.lineIds.flatMap((id) => lines.get(id) ?? []), promise, periodText(month), month.transcript !== null)] : [];
    });
    return sentences.join(" ");
  });
  const ask = totalCents > 0 ? `In total, please credit ${usd(totalCents)} to ${account}.` : "";
  const chat = [`Hi, I'm writing about ${account}. I checked my statements against the plan I signed up for.`, ...sections, ask].filter(Boolean).join("\n\n");
  const email = [`Subject: Billing correction for ${account}`, "", `Hello ${first?.provider ?? "billing"} team,`, "", ...sections.flatMap((s) => [s, ""]), ...(ask ? [ask, ""] : []), "Please reply with the corrected amount and the date the credit will post.", "", "Thank you,", "[Your name]"].join("\n");
  const call = [`I'm calling about ${account}.`, ...sections.map((s, i) => `${i + 1}. ${s}`), ask, "Before ending the call, ask for a reference number and the date the credit will post."].filter(Boolean).join("\n\n");
  return { totalCents, chat, email, call };
}
