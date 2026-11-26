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

// A claim as what happened, for a regulator, and what the company is asked to do about it. A missing credit mentions
// autopay only when the promise depends on it; many promised credits (a line discount, a promotion) do not.
function claimParts(claim: Claim, lines: LineItem[], promise: PromiseTerm, quoted: string, period: string): { fact: string; request: string } {
  const charged = lines.filter((line) => line.amount_cents > 0);
  const several = new Set(charged.map((line) => line.label)).size > 1;
  switch (claim.kind) {
    case "price_above_promise": {
      const discounted = lines.some((line) => line.amount_cents < 0) ? " after discounts" : "";
      return {
        fact: `For ${period}, ${names(charged)} ${several ? "come" : "comes"} to ${usd(claim.actualCents)}${discounted}, but my plan was confirmed at ${usd(claim.expectedCents)} a month (${quoted}).`,
        request: `Please credit the ${usd(claim.amountCents)} difference and correct the rate.`,
      };
    }
    case "included_charged":
      return {
        fact: `I was charged ${usd(claim.amountCents)} for ${names(charged)}, which ${several ? "were" : "was"} included at no extra cost (${quoted}).`,
        request: `Please remove ${several ? "them" : "it"} and credit ${usd(claim.amountCents)}.`,
      };
    case "credit_missing": {
      const missing = `${claim.actualCents === 0 ? "no" : `only ${usd(claim.actualCents)} of the`} ${usd(claim.expectedCents)} monthly credit I was promised (${quoted})`;
      return {
        fact: promise.conditions.includes("autopay") ? `My account is on autopay, but this bill has ${missing}.` : `This bill has ${missing}.`,
        request: `Please apply the missing ${usd(claim.amountCents)}.`,
      };
    }
  }
}

// A complaint names the problem its claims raise; claims of different kinds share the broader one.
const PROBLEM: Record<Claim["kind"], string> = {
  price_above_promise: "billed above the price I was promised.",
  included_charged: "charged for something included in my plan.",
  credit_missing: "a credit I was promised is missing from my bill.",
};
function claimProblem(claims: Claim[]): string {
  const kinds = new Set(claims.map((claim) => claim.kind));
  return kinds.size === 1 ? PROBLEM[claims[0].kind] : "billed more than I was promised.";
}

// What the complaint asks for on future bills, by the same rule: a price is a rate, a credit is applied, an included
// item is not charged.
const REMEDY: Record<Claim["kind"], string> = {
  price_above_promise: "the promised rate on future bills",
  included_charged: "no charge for what was included on future bills",
  credit_missing: "the promised credit on future bills",
};
function claimRemedy(claims: Claim[]): string {
  const kinds = new Set(claims.map((claim) => claim.kind));
  return kinds.size === 1 ? REMEDY[claims[0].kind] : "future bills charged as promised";
}

// A repeated charge as a fact, for a regulator, and as a request, for the company.
const repeatFact = (lines: LineItem[]) => `${names(lines)} appears ${lines.length} times on the bill (${lines.map((line) => usd(line.amount_cents)).join(" and ")}).`;
const repeatSentence = (lines: LineItem[]) => `${repeatFact(lines)} Please confirm whether this is a duplicate and credit it if so.`;

// Every fee asked about goes in one sentence, each with its amount ("the Broadcast TV Fee ($47.23), Regional Sports
// Fee ($19.86) and …"), rather than the same sentence once per fee: a request to the company, a fact to a regulator.
function feeList(fees: LineItem[][]): string {
  const named = fees.map((lines) => `${names(lines)} (${lines.length > 1 ? `${usd(lines.reduce((t, line) => t + line.amount_cents, 0))}, charged ${lines.length} times` : usd(lines[0].amount_cents)})`);
  return named.length === 1 ? named[0] : `${named.slice(0, -1).join(", ")} and ${named.at(-1)}`;
}

function feeSentence(fees: LineItem[][]): string {
  return fees.length === 1
    ? `Please explain the ${feeList(fees)}. It was not part of the plan I agreed to; if it is not required, please remove it.`
    : `Please explain the ${feeList(fees)}. They were not part of the plan I agreed to; if they are not required, please remove them.`;
}

function feeFact(fees: LineItem[][]): string {
  return `The bill charges the ${feeList(fees)}, which ${fees.length === 1 ? "was" : "were"} not part of the plan I agreed to.`;
}

export type Message = { totalCents: number; chat: string; email: string; call: string; complaint: string };

// The written complaint a regulator takes when the company won't fix it: the FCC for phone, internet and TV,
// the state utility commission for electric, gas and water. The person fills in what the company already said.
function complaintText(provider: string | null, account: string, problem: string, facts: string[], claims: Claim[]): string {
  const totalCents = claims.reduce((total, claim) => total + claim.amountCents, 0);
  return [
    `Company: ${provider ?? "[company name]"}`,
    `Account: ${account}`,
    `Problem: ${problem}`,
    "",
    "What happened:",
    ...facts.map((fact) => `- ${fact}`),
    "",
    `What the company said when I asked it to correct this: [date you contacted ${provider ?? "the company"} and their answer]`,
    "",
    totalCents > 0 ? `Resolution I'm asking for: a credit of ${usd(totalCents)} and ${claimRemedy(claims)}.` : "Resolution I'm asking for: the charges above corrected or explained in writing.",
    "",
    "File phone, internet and TV complaints at consumercomplaints.fcc.gov; electric, gas and water complaints go to your state utility commission.",
  ].join("\n");
}

// When the pictures held an earlier statement and this bill is higher: the rise, naming what rose most, as a fact.
function increaseFact(change: BillChange | null): string | null {
  if (!change || change.currentCents <= change.earlierCents) return null;
  const rose = change.lines.flatMap((line) => {
    if (line.afterCents === null || line.afterCents <= (line.beforeCents ?? 0)) return [];
    return [line.beforeCents === null ? `${line.label} (${usd(line.afterCents)}) is new` : `${line.label} went from ${usd(line.beforeCents)} to ${usd(line.afterCents)}`];
  });
  const named = rose.length > 0 ? `: ${rose.slice(0, 3).join("; ")}` : "";
  return `This bill is ${usd(change.currentCents - change.earlierCents)} higher than the one before${named}.`;
}

// The same rise as a request to the company: the message asks why.
export function increaseSentence(change: BillChange | null): string | null {
  const fact = increaseFact(change);
  return fact && `${fact} Please explain the increase and correct anything I didn't agree to.`;
}

export function buildMessage(result: Checked, selectedClaimIds: ReadonlySet<string>, includedQuestionIds: ReadonlySet<string>): Message {
  const lines = new Map(result.reading.line_items.map((line) => [line.id, line]));
  const promises = new Map(result.promises.map((promise) => [promise.id, promise]));
  const linesOf = (ids: string[]) => ids.flatMap((id) => lines.get(id) ?? []);

  const claims = result.claims.filter((claim) => selectedClaimIds.has(claim.id));
  const totalCents = claims.reduce((total, claim) => total + claim.amountCents, 0);
  // The chat, email and call open by naming the bill's period, so their claims say "this bill"; the complaint has no
  // such opening and gives the period itself.
  const claimPartsFor = (speaker: string, period: string) =>
    claims.flatMap((claim) => {
      const promise = promises.get(claim.promiseId);
      return promise ? [claimParts(claim, linesOf(claim.lineIds), promise, citation(promise, result.transcript !== null, speaker), period)] : [];
    });
  const claimText = claimPartsFor("your representative", "this bill").map(({ fact, request }) => `${fact} ${request}`);
  const included = result.questions.filter((question) => includedQuestionIds.has(question.id));
  const fees = included.filter((question) => question.kind === "unagreed_fee").map((question) => linesOf(question.lineIds)).filter((lines) => lines.length > 0);
  const questionText = [
    ...(fees.length > 0 ? [feeSentence(fees)] : []),
    ...included.filter((question) => question.kind === "repeated_charge").map((question) => repeatSentence(linesOf(question.lineIds))),
  ];
  const questionFacts = [
    ...(fees.length > 0 ? [feeFact(fees)] : []),
    ...included.filter((question) => question.kind === "repeated_charge").map((question) => repeatFact(linesOf(question.lineIds))),
  ];

  const provider = result.reading.provider;
  const account = result.reading.account_last4 ? `account ending ${result.reading.account_last4}` : "my account";
  // A total helps only when it adds up several claims; after one, it repeats the amount just asked for.
  const ask = claims.length > 1 ? `In total, please credit ${usd(totalCents)} to ${account}.` : "";
  const increase = increaseSentence(result.change);
  const body = [...claimText, ...(increase ? [increase] : []), ...questionText];
  const risen = increaseFact(result.change);
  const regulatorBody = [...claimPartsFor(`${provider ?? "the company"}'s representative`, periodText(result)).map(({ fact }) => fact), ...(risen ? [risen] : []), ...questionFacts];

  const about = aboutText(result, account);
  const chat = [`Hi, I'm writing about ${about}.`, ...body, ask].filter(Boolean).join("\n\n");
  const email = [
    `Subject: Billing correction for ${account}`,
    "",
    provider ? `Hello ${provider} billing team,` : "Hello billing team,",
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
  const problem = claims.length > 0 ? claimProblem(claims) : fees.length > 0 ? "fees on my bill I never agreed to." : "charges on my bill the company hasn't explained.";
  return { totalCents, chat, email, call, complaint: complaintText(provider, account, problem, regulatorBody, claims) };
}

// One message for a year of statements: each month's claims under its statement, then the total.
export function buildYearMessage(months: Checked[]): Message {
  const withClaims = months.filter((month) => month.claims.length > 0);
  const totalCents = withClaims.reduce((sum, month) => sum + month.claims.reduce((t, claim) => t + claim.amountCents, 0), 0);
  const first = withClaims[0]?.reading;
  const account = first?.account_last4 ? `account ending ${first.account_last4}` : "my account";
  // A promise already quoted for an earlier month is referred back to, not quoted again in full.
  const sectionsFor = (speaker: string, asking: boolean) => {
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
        const { fact, request } = claimParts(claim, claim.lineIds.flatMap((id) => lines.get(id) ?? []), promise, cite, periodText(month));
        return [asking ? `${fact} ${request}` : fact];
      });
      return sentences.join(" ");
    });
  };
  const sections = sectionsFor("your representative", true);
  const provider = first?.provider ?? null;
  const ask = withClaims.flatMap((month) => month.claims).length > 1 ? `In total, please credit ${usd(totalCents)} to ${account}.` : "";
  const opening = `I'm writing about ${account}. I checked my statements against the plan I signed up for.`;
  const chat = [`Hi, ${opening}`, ...sections, ask].filter(Boolean).join("\n\n");
  const email = [`Subject: Billing correction for ${account}`, "", provider ? `Hello ${provider} billing team,` : "Hello billing team,", "", opening, "", ...sections.flatMap((s) => [s, ""]), ...(ask ? [ask, ""] : []), "Please reply with the corrected amount and the date the credit will post.", "", "Thank you,", "[Your name]"].join("\n");
  const call = [`I'm calling about ${account}.`, ...sections.map((s, i) => `${i + 1}. ${s}`), ask, "Before ending the call, ask for a reference number and the date the credit will post."].filter(Boolean).join("\n\n");
  return { totalCents, chat, email, call, complaint: complaintText(provider, account, claimProblem(withClaims.flatMap((month) => month.claims)), sectionsFor(`${provider ?? "the company"}'s representative`, false), withClaims.flatMap((month) => month.claims)) };
}
