import { z } from "zod";
import { BRANDS, brandOf } from "./decide";
import { MAX_OFFER_TEXT } from "./limits";
import type { CheckEvent } from "./result";

// One live run over real posts, streamed: each post's check events tagged by its place in the batch, then the total.
export type LiveEvent =
  | { type: "batch"; posts: { id: string; title: string; provider: string | null; picture: string }[] }
  | { type: "post"; i: number; event: CheckEvent }
  | { type: "done"; seconds: number; spentMicros: number }
  | { type: "refused"; message: string };

const base = {
  id: z.string(),
  sub: z.string(),
  permalink: z.string(),
  created: z.number(),
  title: z.string(),
  text: z.string(),
  images: z.array(z.string()),
  ms: z.number(),
  spentMicros: z.number(),
};

// One public post about a bill, as Billproof checked it. Only what a reader needs: no names, accounts or addresses.
export const realBillSchema = z.discriminatedUnion("outcome", [
  z.object({ ...base, outcome: z.literal("error"), error: z.string().nullable() }),
  z.object({ ...base, outcome: z.literal("not_a_bill") }),
  z.object({ ...base, outcome: z.literal("could_not_check") }),
  z.object({
    ...base,
    outcome: z.literal("checked"),
    provider: z.string().nullable(),
    period: z.tuple([z.string().nullable(), z.string().nullable()]),
    lines: z.number(),
    // Whether the charges read off the bill add up to its printed current charges: the accuracy check a bill carries.
    lineSum: z.enum(["ok", "subtotal", "due", "sections", "mismatch", "not_printed"]),
    billPages: z.array(z.number()),
    // Present when the post also showed an earlier statement: the two totals of the charges Billproof read.
    change: z.object({ earlierCents: z.number(), currentCents: z.number() }).nullable().default(null),
    claims: z.array(
      z.object({
        kind: z.enum(["price_above_promise", "included_charged", "credit_missing"]),
        amountCents: z.number(),
        actualCents: z.number(),
        expectedCents: z.number(),
        lines: z.array(z.string()),
        promise: z.string().nullable(),
        needsConfirmation: z.boolean(),
      }),
    ),
    dropped: z.array(z.object({ amountCents: z.number(), counterQuote: z.string() })),
    questions: z.array(z.object({ kind: z.string(), lines: z.array(z.string()), cents: z.number() })),
    explained: z.number(),
    hadOffer: z.boolean(),
    matchedPromises: z.number(),
  }),
]);
export type RealBill = z.infer<typeof realBillSchema>;

export const realRunSchema = z.object({ ranAt: z.string(), spentMicros: z.number(), posts: z.number(), results: z.array(realBillSchema) });
export type RealRun = z.infer<typeof realRunSchema>;

export const claimedCents = (bill: RealBill) => (bill.outcome === "checked" ? bill.claims.reduce((t, claim) => t + claim.amountCents, 0) : 0);
export const unagreedFees = (bill: RealBill) => (bill.outcome === "checked" ? bill.questions.filter((q) => q.kind === "unagreed_fee") : []);
export const unagreedCents = (bill: RealBill) => unagreedFees(bill).reduce((t, fee) => t + fee.cents, 0);

// What the poster wrote is the only record of the promise; it is passed as the customer's own notes, within what a
// check takes as a written offer.
export function postNotes(post: Pick<RealBill, "title" | "text">): string {
  return `What the customer wrote publicly about this bill:\n${post.title}\n\n${post.text}`.slice(0, MAX_OFFER_TEXT);
}

const SMALL_WORDS = new Set(["by", "of", "and", "the", "for"]);

// The name as printed, unless the reading lowercased it ("optimum") or wrote it in capitals ("KINETIC BY WINDSTREAM");
// short capitals such as "DISH" are how the company writes itself and stay.
export function cased(name: string): string {
  const brand = BRANDS.find(([, canonical]) => canonical.toLowerCase() === name.toLowerCase())?.[1];
  if (brand) return brand;
  const words = name.split(" ").map((word, i) => {
    const lower = word.toLowerCase();
    if (i > 0 && SMALL_WORDS.has(lower)) return lower;
    return word === lower || (word === word.toUpperCase() && word.length > 4) ? lower.charAt(0).toUpperCase() + lower.slice(1) : word;
  });
  return words.join(" ").replace(/\bT[- ]?Mobile\b/gi, "T-Mobile");
}

// Subreddits whose company goes by a longer name than some bills print ("Google", "Metro").
const FULL_NAMES: Record<string, string> = { GoogleFi: "Google Fi", GoogleFiber: "Google Fiber", MetroPCS: "Metro by T-Mobile" };

// A bill whose company name wasn't read is named by the company of its subreddit, when the subreddit is one company's;
// a printed name that is the start of its subreddit's company name gets the whole name.
export function displayName(bill: Extract<RealBill, { outcome: "checked" }>): string | null {
  if (!bill.provider) return brandOf(bill.sub);
  const name = cased(bill.provider);
  const full = FULL_NAMES[bill.sub];
  return full && full.toLowerCase().startsWith(`${name.toLowerCase()} `) ? full : name;
}
