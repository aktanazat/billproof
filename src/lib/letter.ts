import type { BillChange, Claim } from "./decide";
import type { Checked } from "./result";
import type { LineItem, PromiseTerm } from "./schemas";

export function usd(cents: number): string {
  const sign = cents < 0 ? "-" : "";
  return `${sign}$${(Math.abs(cents) / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

// A date the reading got wrong (month 13, day 45) is shown as written rather than as "undefined 5, 2026".
export function shortDate(iso: string): string {
  const [y, m, d] = iso.split("-").map(Number);
  const month = MONTHS[m - 1];
  return month && d >= 1 && d <= 31 ? `${month} ${d}, ${y}` : iso;
}

// A bill is named by its whole period, else the statement date the company prints, else the start date alone, else
// the due date or the charges it prints, either of which the company can find it by.
function periodText(result: Checked): string {
  const { period_start, period_end, statement_date, due_date, printed } = result.reading;
  if (period_start && period_end) return `${shortDate(period_start)} to ${shortDate(period_end)}`;
  if (statement_date) return `the statement dated ${shortDate(statement_date)}`;
  if (period_start) return `the bill starting ${shortDate(period_start)}`;
  if (due_date) return `the bill due ${shortDate(due_date)}`;
  const charges = printed.current_charges ?? printed.total_due;
  return charges ? `the ${usd(charges.cents)} bill` : "this bill";
}

function aboutText(result: Checked, account: string): string {
  const { period_start, period_end, statement_date } = result.reading;
  if (period_start && period_end) return `${account}, bill for ${shortDate(period_start)} to ${shortDate(period_end)}`;
  if (statement_date) return `${account}, statement dated ${shortDate(statement_date)}`;
  const named = periodText(result);
  return named === "this bill" ? `${account} and my latest bill` : `${account}, ${named.replace(/^the bill /, "bill ")}`;
}

function names(lines: LineItem[]): string {
  const labels = [...new Set(lines.map((line) => line.label))];
  return labels.length <= 1 ? (labels[0] ?? "this charge") : `${labels.slice(0, -1).join(", ")} and ${labels.at(-1)}`;
}

const capitalized = (text: string) => `${text[0].toUpperCase()}${text.slice(1)}`;

// A promise heard on a recorded call is cited as what the representative said, with the moment it was said; who
// "the representative" is depends on who reads it ("your representative" to the company, its name to a regulator).
function citation(promise: PromiseTerm, onCall: boolean, speaker: string): string {
  if (!onCall || promise.said_at_seconds === null) return `"${promise.quote.trim()}"`;
  const at = `${Math.floor(promise.said_at_seconds / 60)}:${String(Math.floor(promise.said_at_seconds % 60)).padStart(2, "0")}`;
  return `${speaker} told me on the call, at ${at} in my recording: "${promise.quote.trim()}"`;
}

// A claim as what happened, for a regulator, and what the company is asked to do about it. A missing credit mentions
// autopay only when the promise depends on it; many promised credits (a line discount, a promotion) do not. `period`
// names the bill the claim is on ("this bill" where the message already named it); null continues a bill named by an
// earlier claim.
function claimParts(claim: Claim, lines: LineItem[], promise: PromiseTerm, quoted: string, period: string | null): { fact: string; request: string } {
  const charged = lines.filter((line) => line.amount_cents > 0);
  const several = new Set(charged.map((line) => line.label)).size > 1;
  const dated = period !== null && period !== "this bill";
  switch (claim.kind) {
    case "price_above_promise": {
      const discounted = lines.some((line) => line.amount_cents < 0) ? " after discounts" : "";
      return {
        fact: `${period ? `For ${period}, ` : ""}${names(charged)} ${several ? "come" : "comes"} to ${usd(claim.actualCents)}${discounted}, but my plan was confirmed at ${usd(claim.expectedCents)} a month (${quoted}).`,
        request: `Please credit the ${usd(claim.amountCents)} difference and correct the rate.`,
      };
    }
    case "included_charged":
      return {
        fact: `${dated ? `For ${period}, ` : ""}I was charged ${usd(claim.amountCents)} for ${names(charged)}, which ${several ? "were" : "was"} included at no extra cost (${quoted}).`,
        request: `Please remove ${several ? "them" : "it"} and credit ${usd(claim.amountCents)}.`,
      };
    case "credit_missing": {
      const bill = dated ? (period.startsWith("the ") ? period : `the bill for ${period}`) : "this bill";
      const missing = `${claim.actualCents === 0 ? "no" : `only ${usd(claim.actualCents)} of the`} ${usd(claim.expectedCents)} monthly credit I was promised (${quoted})`;
      return {
        fact: promise.conditions.includes("autopay") ? `My account is on autopay, but ${bill} has ${missing}.` : `${capitalized(bill)} has ${missing}.`,
        request: `Please apply the missing ${usd(claim.amountCents)}.`,
      };
    }
  }
}

// The same claim in a few words, for a complaint that must be shortened to fit the regulator's form.
function shortClaim(claim: Claim, lines: LineItem[]): string {
  const charged = names(lines.filter((line) => line.amount_cents > 0));
  switch (claim.kind) {
    case "price_above_promise":
      return `${charged} billed ${usd(claim.actualCents)}, promised ${usd(claim.expectedCents)} a month`;
    case "included_charged":
      return `${charged} charged ${usd(claim.amountCents)}, promised included`;
    case "credit_missing":
      return claim.actualCents === 0 ? `promised ${usd(claim.expectedCents)} monthly credit missing` : `only ${usd(claim.actualCents)} of a promised ${usd(claim.expectedCents)} monthly credit`;
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

// With no claim, the problem names what the complaint goes on to state: a rise since the earlier bill, fees the plan
// didn't include (or that the company hasn't explained, with no offer of its own to go by), or both.
function questionProblem(fees: boolean, offerCovers: boolean, rise: boolean): string {
  const charges = fees && offerCovers ? "fees on my bill I never agreed to." : "charges on my bill the company hasn't explained.";
  if (!rise) return charges;
  return fees ? `a price increase and ${charges}` : "a price increase on my bill the company hasn't explained.";
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

// A repeated charge as a fact, for a regulator, and as a request, for the company. `where` is the bill it is printed on.
const repeatFact = (lines: LineItem[], where = "the bill") => `${names(lines)} appears ${lines.length} times on ${where} (${lines.map((line) => usd(line.amount_cents)).join(" and ")}).`;
const repeatSentence = (lines: LineItem[], where?: string) => `${repeatFact(lines, where)} Please confirm whether this is a duplicate and credit it if so.`;

// Every fee asked about goes in one sentence, each with its amount ("the Broadcast TV Fee ($47.23), Regional Sports
// Fee ($19.86) and …"), rather than the same sentence once per fee: a request to the company, a fact to a regulator.
function feeList(fees: LineItem[][]): string {
  const named = fees.map((lines) => `${names(lines)} (${lines.length > 1 ? `${usd(lines.reduce((t, line) => t + line.amount_cents, 0))}, charged ${lines.length} times` : usd(lines[0].amount_cents)})`);
  return named.length === 1 ? named[0] : `${named.slice(0, -1).join(", ")} and ${named.at(-1)}`;
}

// "Not part of the plan I agreed to" rests on the offer; when the offer is another company's, it says nothing about
// this company's plan, so the fee is only asked about.
function feeSentence(fees: LineItem[][], offerCovers: boolean): string {
  const one = fees.length === 1;
  const remove = `${one ? "it is" : "they are"} not required, please remove ${one ? "it" : "them"}.`;
  return offerCovers ? `Please explain the ${feeList(fees)}. ${one ? "It was" : "They were"} not part of the plan I agreed to; if ${remove}` : `Please explain the ${feeList(fees)}. If ${remove}`;
}

// `charges` names what printed the fees: one bill, or a year's statements.
function feeFact(fees: LineItem[][], offerCovers: boolean, charges = "The bill charges"): string {
  return offerCovers ? `${charges} the ${feeList(fees)}, which ${fees.length === 1 ? "was" : "were"} not part of the plan I agreed to.` : `${charges} the ${feeList(fees)}, which the company hasn't explained.`;
}

export type Message = { totalCents: number; chat: string; email: string; call: string; complaint: string };

// Where to file it, for the person: shown beside the complaint, not part of what the regulator receives.
export const COMPLAINT_WHERE = "File phone, internet and TV complaints at consumercomplaints.fcc.gov; electric, gas and water complaints go to your state utility commission.";

// The FCC's complaint forms take 2,000 characters of description and cut off a longer paste; 300 of them are left for
// what the person writes in place of the company's answer.
const COMPLAINT_ROOM = 1_700;

// The written complaint a regulator takes when the company won't fix it: the FCC for phone, internet and TV,
// the state utility commission for electric, gas and water. The person fills in what the company already said, and
// any company name or account number the bill didn't show: "my account" means nothing to a regulator. `factVersions`
// runs from the fullest account of what happened to the shortest; the first that fits the form is used.
function complaintText(provider: string | null, last4: string | null, problem: string, factVersions: string[][], claims: Claim[]): string {
  const totalCents = claims.reduce((total, claim) => total + claim.amountCents, 0);
  const write = (facts: string[]) =>
    [
      `Company: ${provider ?? "[company name]"}`,
      `Account: ${last4 ? `account ending ${last4}` : "[account number]"}`,
      `Problem: ${problem}`,
      "",
      "What happened:",
      ...facts.map((fact) => `- ${fact}`),
      "",
      `What the company said when I asked it to correct this: [date you contacted ${provider ?? "the company"} and their answer]`,
      "",
      totalCents > 0 ? `Resolution I'm asking for: a credit of ${usd(totalCents)} and ${claimRemedy(claims)}.` : "Resolution I'm asking for: the charges above corrected or explained in writing.",
    ].join("\n");
  const texts = factVersions.map(write);
  return texts.find((text) => text.length <= COMPLAINT_ROOM) ?? texts[texts.length - 1];
}

// When the pictures held an earlier statement and this bill is higher: the rise, naming what rose most, as a fact.
// `bill` names the statement: "This bill" alone, or one month's among a year's.
function increaseFact(change: BillChange | null, bill = "This bill"): string | null {
  if (!change || change.currentCents <= change.earlierCents) return null;
  const rose = change.lines.flatMap((line) => {
    if (line.afterCents === null || line.afterCents <= (line.beforeCents ?? 0)) return [];
    return [line.beforeCents === null ? `${line.label} (${usd(line.afterCents)}) is new` : `${line.label} went from ${usd(line.beforeCents)} to ${usd(line.afterCents)}`];
  });
  const named = rose.length > 0 ? `: ${rose.slice(0, 3).join("; ")}` : "";
  return `${bill} is ${usd(change.currentCents - change.earlierCents)} higher than the one before${named}.`;
}

// The same rise as a request to the company: the message asks why.
export function increaseSentence(change: BillChange | null, bill?: string): string | null {
  const fact = increaseFact(change, bill);
  return fact && `${fact} Please explain the increase and correct anything I didn't agree to.`;
}

// A call script's points are numbered only when there are several: read aloud, a lone "1." promises a point 2.
const numbered = (points: string[]) => (points.length > 1 ? points.map((point, i) => `${i + 1}. ${point}`) : points);

// What an email asks the company to reply with: the credit, an answer to its questions, or both.
function replyAsk(credit: boolean, questions: boolean): string {
  if (!credit) return "Please reply with an explanation of these charges and anything you will correct on my bill.";
  return questions ? "Please reply with the corrected amount, the date the credit will post, and an explanation of the charges I asked about." : "Please reply with the corrected amount and the date the credit will post.";
}

// What a call script reminds the caller to get before hanging up, by the same measure.
function callClose(credit: boolean, questions: boolean): string {
  if (!credit) return "Before ending the call, ask for a reference number and what will change on the next bill.";
  return questions ? "Before ending the call, ask for a reference number, the date the credit will post, and what will change on the next bill." : "Before ending the call, ask for a reference number and the date the credit will post.";
}

// The total adds up the claims only, so it comes right after them and before any question, which it doesn't cover.
const totalAfter = (claims: string[], total: string, rest: string[]) => [...claims, ...(total ? [total] : []), ...rest];
// The same for a call script, whose points are numbered across the total ("1.", "2.", the total, "3.").
function numberedTotalAfter(claims: string[], total: string, rest: string[]): string[] {
  const points = numbered([...claims, ...rest]);
  return totalAfter(points.slice(0, claims.length), total, points.slice(claims.length));
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
  // Only an offer from this company can show a fee wasn't part of the plan; without one, the fee is just asked about.
  const offerCovers = result.hadOffer && !result.providerMismatch;
  const questionText = [
    ...(fees.length > 0 ? [feeSentence(fees, offerCovers)] : []),
    ...included.filter((question) => question.kind === "repeated_charge").map((question) => repeatSentence(linesOf(question.lineIds))),
  ];
  const questionFacts = [
    ...(fees.length > 0 ? [feeFact(fees, offerCovers)] : []),
    ...included.filter((question) => question.kind === "repeated_charge").map((question) => repeatFact(linesOf(question.lineIds))),
  ];

  const provider = result.reading.provider;
  const account = result.reading.account_last4 ? `account ending ${result.reading.account_last4}` : "my account";
  // A total helps only when it adds up several claims; after one, it repeats the amount just asked for.
  const ask = claims.length > 1 ? `In total, please credit ${usd(totalCents)} to ${account}.` : "";
  const increase = increaseSentence(result.change);
  const asked = [...(increase ? [increase] : []), ...questionText];
  const risen = increaseFact(result.change);
  const regulatorBody = [...claimPartsFor(`${provider ?? "the company"}'s representative`, periodText(result)).map(({ fact }) => fact), ...(risen ? [risen] : []), ...questionFacts];

  const about = aboutText(result, account);
  const chat = [`Hi, I'm writing about ${about}.`, ...totalAfter(claimText, ask, asked)].join("\n\n");
  const email = [
    totalCents > 0 ? `Subject: Billing correction for ${account}` : `Subject: Questions about the charges on ${account}`,
    "",
    provider ? `Hello ${provider} billing team,` : "Hello billing team,",
    "",
    `I'm writing about ${about}.`,
    "",
    ...totalAfter(claimText, ask, asked).flatMap((sentence) => [sentence, ""]),
    replyAsk(totalCents > 0, questionText.length > 0 || increase !== null),
    "",
    "Thank you,",
    "[Your name]",
  ].join("\n");
  const call = [
    `I'm calling about ${about}.`,
    ...numberedTotalAfter(claimText, ask, asked),
    callClose(totalCents > 0, questionText.length > 0 || increase !== null),
  ]
    .filter(Boolean)
    .join("\n\n");
  const problem = claims.length > 0 ? claimProblem(claims) : questionProblem(fees.length > 0, offerCovers, risen !== null);
  const shortFacts = [...(claims.length > 0 ? [`For ${periodText(result)}: ${claims.map((claim) => shortClaim(claim, linesOf(claim.lineIds))).join("; ")}.`] : []), ...(risen ? [risen] : []), ...questionFacts];
  return { totalCents, chat, email, call, complaint: complaintText(provider, result.reading.account_last4, problem, [regulatorBody, shortFacts], claims) };
}

// One message for a year of statements: each month's claims under its statement, then the fees to ask about, then the
// total.
export function buildYearMessage(months: Checked[]): Message {
  const withClaims = months.filter((month) => month.claims.length > 0);
  const totalCents = withClaims.reduce((sum, month) => sum + month.claims.reduce((t, claim) => t + claim.amountCents, 0), 0);
  // The months are one account's, so a number or company name any of them shows stands for all; one month's unread
  // value doesn't hide it.
  const last4 = months.find((month) => month.reading.account_last4)?.reading.account_last4 ?? null;
  const account = last4 ? `account ending ${last4}` : "my account";
  // A promise already quoted for an earlier month is referred back to, not quoted again in full; a month names its
  // statement once, on its first claim. Read aloud, a call script refers back to what was said, not to "above".
  const sectionsFor = (speaker: string, asking: boolean, quotedBefore: string) => {
    const quoted = new Set<string>();
    return withClaims.map((month) => {
      const lines = new Map(month.reading.line_items.map((line) => [line.id, line]));
      const promises = new Map(month.promises.map((promise) => [promise.id, promise]));
      let named = false;
      const sentences = month.claims.flatMap((claim) => {
        const promise = promises.get(claim.promiseId);
        if (!promise) return [];
        const key = promise.quote.trim();
        const cite = quoted.has(key) ? quotedBefore : citation(promise, month.transcript !== null, speaker);
        quoted.add(key);
        const { fact, request } = claimParts(claim, claim.lineIds.flatMap((id) => lines.get(id) ?? []), promise, cite, named ? null : periodText(month));
        named = true;
        return [asking ? `${fact} ${request}` : fact];
      });
      return sentences.join(" ");
    });
  };
  const sections = sectionsFor("your representative", true, "as quoted above");
  const provider = months.find((month) => month.reading.provider)?.reading.provider ?? null;
  // A company fee recurs on every statement, so each is asked about once, at what the latest statement showing it
  // charges (the months come oldest first), rather than once a month.
  const latestFee = new Map<string, LineItem[]>();
  for (const month of months) {
    for (const question of month.questions) {
      if (question.kind !== "unagreed_fee") continue;
      const lines = question.lineIds.flatMap((id) => month.reading.line_items.find((line) => line.id === id) ?? []);
      if (lines.length > 0) latestFee.set(lines.map((line) => line.label).join("\n"), lines);
    }
  }
  const fees = [...latestFee.values()];
  const offerCovers = months.some((month) => month.hadOffer && !month.providerMismatch);
  // A charge printed twice is one statement's, so it is asked about under that statement; one that can't be named by
  // dates, due date or total is just "one bill".
  const repeatOn = (month: Checked, lines: LineItem[], sentence: typeof repeatFact) => {
    const period = periodText(month);
    if (period === "this bill") return sentence(lines, "one bill");
    return `${period.startsWith("the ") ? `On ${period}` : `On the bill for ${period}`}, ${sentence(lines)}`;
  };
  const repeats = months.flatMap((month) =>
    month.questions.flatMap((question) => {
      const lines = question.kind === "repeated_charge" ? question.lineIds.flatMap((id) => month.reading.line_items.find((line) => line.id === id) ?? []) : [];
      return lines.length > 0 ? [{ month, lines }] : [];
    }),
  );
  const feeText = [...(fees.length > 0 ? [feeSentence(fees, offerCovers)] : []), ...repeats.map(({ month, lines }) => repeatOn(month, lines, repeatSentence))];
  // A month whose pictures held an earlier statement and rose is asked about under that month's name.
  const billName = (month: Checked) => {
    const period = periodText(month);
    return period === "this bill" ? "One of the bills" : period.startsWith("the ") ? capitalized(period) : `The bill for ${period}`;
  };
  const riseText = months.flatMap((month) => increaseSentence(month.change, billName(month)) ?? []);
  const asked = [...riseText, ...feeText];
  const ask = withClaims.flatMap((month) => month.claims).length > 1 ? `In total, please credit ${usd(totalCents)} to ${account}.` : "";
  // Only an offer from this company is a plan the statements were checked against.
  const opening = offerCovers ? `I'm writing about ${account}. I checked my statements against the plan I signed up for.` : `I'm writing about ${account}.`;
  const chat = [`Hi, ${opening}`, ...totalAfter(sections, ask, asked)].join("\n\n");
  const email = [
    totalCents > 0 ? `Subject: Billing correction for ${account}` : `Subject: Questions about the charges on ${account}`,
    "",
    provider ? `Hello ${provider} billing team,` : "Hello billing team,",
    "",
    opening,
    "",
    ...totalAfter(sections, ask, asked).flatMap((s) => [s, ""]),
    replyAsk(totalCents > 0, asked.length > 0),
    "",
    "Thank you,",
    "[Your name]",
  ].join("\n");
  const call = [
    `I'm calling about ${account}.`,
    ...numberedTotalAfter(sectionsFor("your representative", true, "as I mentioned"), ask, asked),
    callClose(totalCents > 0, asked.length > 0),
  ]
    .filter(Boolean)
    .join("\n\n");
  // Shorter accounts for a complaint too long for the regulator's form: each month in a line, then each month's amount
  // with every promise quoted once, then the amounts alone.
  const regulator = `${provider ?? "the company"}'s representative`;
  const claims = withClaims.flatMap((month) => month.claims);
  const promised = [
    ...new Map(
      withClaims.flatMap((month) =>
        month.claims.flatMap((claim) => {
          const promise = month.promises.find((p) => p.id === claim.promiseId);
          return promise ? [[promise.quote.trim(), citation(promise, month.transcript !== null, regulator)] as const] : [];
        }),
      ),
    ).values(),
  ];
  const promisedLine = `What I was promised: ${promised.join("; ")}.`;
  const byMonth = withClaims.map((month) => {
    const lines = new Map(month.reading.line_items.map((line) => [line.id, line]));
    return `For ${periodText(month)}: ${month.claims.map((claim) => shortClaim(claim, claim.lineIds.flatMap((id) => lines.get(id) ?? []))).join("; ")}.`;
  });
  const amounts = withClaims.map((month) => `${capitalized(periodText(month))}: ${usd(month.claims.reduce((t, claim) => t + claim.amountCents, 0))} more than I was promised.`);
  const riseFacts = months.flatMap((month) => increaseFact(month.change, billName(month)) ?? []);
  const feeFacts = [...riseFacts, ...(fees.length > 0 ? [feeFact(fees, offerCovers, "My statements charge")] : []), ...repeats.map(({ month, lines }) => repeatOn(month, lines, repeatFact))];
  const problem = claims.length > 0 ? claimProblem(claims) : questionProblem(fees.length > 0, offerCovers, riseFacts.length > 0);
  const versions = claims.length > 0 ? [sectionsFor(regulator, false, "as quoted above"), [promisedLine, ...byMonth], [promisedLine, ...amounts], amounts] : [[]];
  const complaint = complaintText(provider, last4, problem, versions.map((facts) => [...facts, ...feeFacts]), claims);
  return { totalCents, chat, email, call, complaint };
}
