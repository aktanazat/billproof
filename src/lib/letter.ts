import type { BillChange, Claim } from "./decide";
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

function aboutText(result: Checked, account: string): string {
  const { period_start, period_end, statement_date } = result.reading;
  if (period_start && period_end) return `${account}, bill for ${shortDate(period_start)} to ${shortDate(period_end)}`;
  return statement_date ? `${account}, statement dated ${shortDate(statement_date)}` : `${account} and my latest bill`;
}

function names(lines: LineItem[]): string {
  const labels = [...new Set(lines.map((line) => line.label))];
  return labels.length <= 1 ? (labels[0] ?? "this charge") : `${labels.slice(0, -1).join(", ")} and ${labels.at(-1)}`;
}

// A promise heard on a recorded call is cited as what the representative said, with the moment it was said; who
// "the representative" is depends on who reads it ("your representative" to the company, its name to a regulator).
function citation(promise: PromiseTerm, onCall: boolean, speaker: string): string {
  if (!onCall || promise.said_at_seconds === null) return `"${promise.quote.trim()}"`;
  const at = `${Math.floor(promise.said_at_seconds / 60)}:${String(Math.floor(promise.said_at_seconds % 60)).padStart(2, "0")}`;
  return `${speaker} told me on the call, at ${at} in my recording: "${promise.quote.trim()}"`;
}

function claimSentence(claim: Claim, lines: LineItem[], quoted: string, period: string): string {
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

function repeatSentence(lines: LineItem[]): string {
  return `${names(lines)} appears ${lines.length} times (${lines.map((line) => usd(line.amount_cents)).join(" and ")}). Please confirm whether this is a duplicate and credit it if so.`;
}

// Every fee asked about goes in one request, each with its amount ("the Broadcast TV Fee ($47.23), Regional Sports
// Fee ($19.86) and …"), rather than the same sentence once per fee.
function feeSentence(fees: LineItem[][]): string {
  const named = fees.map((lines) => `${names(lines)} (${lines.length > 1 ? `${usd(lines.reduce((t, line) => t + line.amount_cents, 0))}, charged ${lines.length} times` : usd(lines[0].amount_cents)})`);
  const list = named.length === 1 ? named[0] : `${named.slice(0, -1).join(", ")} and ${named.at(-1)}`;
  return fees.length === 1
    ? `Please explain the ${list}. It was not part of the plan I agreed to; if it is not required, please remove it.`
    : `Please explain the ${list}. They were not part of the plan I agreed to; if they are not required, please remove them.`;
}

export type Message = { totalCents: number; chat: string; email: string; call: string; complaint: string };

// The written complaint a regulator takes when the company won't fix it: the FCC for phone, internet and TV,
// the state utility commission for electric, gas and water. The person fills in what the company already said.
function complaintText(provider: string, account: string, problem: string, facts: string[], totalCents: number): string {
  return [
    `Company: ${provider}`,
    `Account: ${account}`,
    `Problem: ${problem}`,
    "",
    "What happened:",
    ...facts.map((fact) => `- ${fact}`),
    "",
    `What the company said when I asked it to correct this: [date you contacted ${provider} and their answer]`,
    "",
    totalCents > 0 ? `Resolution I'm asking for: a credit of ${usd(totalCents)} and the promised rate on future bills.` : "Resolution I'm asking for: the charges above corrected or explained in writing.",
    "",
    "File phone, internet and TV complaints at consumercomplaints.fcc.gov; electric, gas and water complaints go to your state utility commission.",
  ].join("\n");
}

// When the pictures held an earlier statement and this bill is higher, the message asks why, naming what rose most.
export function increaseSentence(change: BillChange | null): string | null {
  if (!change || change.currentCents <= change.earlierCents) return null;
  const rose = change.lines.flatMap((line) => {
    if (line.afterCents === null || line.afterCents <= (line.beforeCents ?? 0)) return [];
    return [line.beforeCents === null ? `${line.label} (${usd(line.afterCents)}) is new` : `${line.label} went from ${usd(line.beforeCents)} to ${usd(line.afterCents)}`];
  });
  const named = rose.length > 0 ? `: ${rose.slice(0, 3).join("; ")}` : "";
  return `This bill is ${usd(change.currentCents - change.earlierCents)} higher than the one before${named}. Please explain the increase and correct anything I didn't agree to.`;
}

export function buildMessage(result: Checked, selectedClaimIds: ReadonlySet<string>, includedQuestionIds: ReadonlySet<string>): Message {
  const lines = new Map(result.reading.line_items.map((line) => [line.id, line]));
  const promises = new Map(result.promises.map((promise) => [promise.id, promise]));
  const period = periodText(result);
  const linesOf = (ids: string[]) => ids.flatMap((id) => lines.get(id) ?? []);

  const claims = result.claims.filter((claim) => selectedClaimIds.has(claim.id));
  const totalCents = claims.reduce((total, claim) => total + claim.amountCents, 0);
  const claimTextFor = (speaker: string) =>
    claims.flatMap((claim) => {
      const promise = promises.get(claim.promiseId);
      return promise ? [claimSentence(claim, linesOf(claim.lineIds), citation(promise, result.transcript !== null, speaker), period)] : [];
    });
  const claimText = claimTextFor("your representative");
  const included = result.questions.filter((question) => includedQuestionIds.has(question.id));
  const fees = included.filter((question) => question.kind === "unagreed_fee").map((question) => linesOf(question.lineIds)).filter((lines) => lines.length > 0);
  const questionText = [
    ...(fees.length > 0 ? [feeSentence(fees)] : []),
    ...included.filter((question) => question.kind === "repeated_charge").map((question) => repeatSentence(linesOf(question.lineIds))),
  ];

  const provider = result.reading.provider ?? "your company";
  const account = result.reading.account_last4 ? `account ending ${result.reading.account_last4}` : "my account";
  const ask = totalCents > 0 ? `In total, please credit ${usd(totalCents)} to ${account}.` : "";
  const increase = increaseSentence(result.change);
  const body = [...claimText, ...(increase ? [increase] : []), ...questionText];
  const regulatorBody = [...claimTextFor(`${result.reading.provider ?? "the company"}'s representative`), ...(increase ? [increase] : []), ...questionText];

  const about = aboutText(result, account);
  const chat = [`Hi, I'm writing about ${about}.`, ...body, ask].filter(Boolean).join("\n\n");
  const email = [
    `Subject: Billing correction for ${account}`,
    "",
    `Hello ${provider} billing team,`,
    "",
    `I'm writing about ${about}.`,
    "",
    ...body.flatMap((sentence) => [sentence, ""]),
    ...(ask ? [ask, ""] : []),
    totalCents > 0 ? "Please reply with the corrected amount and the date the credit will post." : "Please reply with an explanation of these charges and anything you will correct on my bill.",
    "",
    "Thank you,",
    "[Your name]",
  ].join("\n");
  const call = [
    `I'm calling about ${about}.`,
    ...body.map((sentence, i) => `${i + 1}. ${sentence}`),
    ask,
    totalCents > 0 ? "Before ending the call, ask for a reference number and the date the credit will post." : "Before ending the call, ask for a reference number and what will change on the next bill.",
  ]
    .filter(Boolean)
    .join("\n\n");
  // A complaint names the problem the message raises: a price above a promise, fees never agreed to, or charges unexplained.
  const problem = totalCents > 0 ? "billed above the price I was promised." : fees.length > 0 ? "fees on my bill I never agreed to." : "charges on my bill the company hasn't explained.";
  return { totalCents, chat, email, call, complaint: complaintText(provider, account, problem, regulatorBody, totalCents) };
}

// One message for a year of statements: each month's claims under its statement, then the total.
export function buildYearMessage(months: Checked[]): Message {
  const withClaims = months.filter((month) => month.claims.length > 0);
  const totalCents = withClaims.reduce((sum, month) => sum + month.claims.reduce((t, claim) => t + claim.amountCents, 0), 0);
  const first = withClaims[0]?.reading;
  const account = first?.account_last4 ? `account ending ${first.account_last4}` : "my account";
  // A promise already quoted for an earlier month is referred back to, not quoted again in full.
  const sectionsFor = (speaker: string) => {
    const quoted = new Set<string>();
    return withClaims.map((month) => {
      const lines = new Map(month.reading.line_items.map((line) => [line.id, line]));
      const promises = new Map(month.promises.map((promise) => [promise.id, promise]));
      const sentences = month.claims.flatMap((claim) => {
        const promise = promises.get(claim.promiseId);
        if (!promise) return [];
        const key = promise.quote.trim();
        const cite = quoted.has(key) ? "as quoted above" : citation(promise, month.transcript !== null, speaker);
        quoted.add(key);
        return [claimSentence(claim, claim.lineIds.flatMap((id) => lines.get(id) ?? []), cite, periodText(month))];
      });
      return sentences.join(" ");
    });
  };
  const sections = sectionsFor("your representative");
  const ask = totalCents > 0 ? `In total, please credit ${usd(totalCents)} to ${account}.` : "";
  const chat = [`Hi, I'm writing about ${account}. I checked my statements against the plan I signed up for.`, ...sections, ask].filter(Boolean).join("\n\n");
  const email = [`Subject: Billing correction for ${account}`, "", `Hello ${first?.provider ?? "billing"} team,`, "", ...sections.flatMap((s) => [s, ""]), ...(ask ? [ask, ""] : []), "Please reply with the corrected amount and the date the credit will post.", "", "Thank you,", "[Your name]"].join("\n");
  const call = [`I'm calling about ${account}.`, ...sections.map((s, i) => `${i + 1}. ${s}`), ask, "Before ending the call, ask for a reference number and the date the credit will post."].filter(Boolean).join("\n\n");
  return { totalCents, chat, email, call, complaint: complaintText(first?.provider ?? "the company", account, "billed above the price I was promised.", sectionsFor(`${first?.provider ?? "the company"}'s representative`), totalCents) };
}
