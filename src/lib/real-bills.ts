import { z } from "zod";

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
    billPages: z.array(z.number()),
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

export const realRunSchema = z.object({ ranAt: z.string(), seconds: z.number(), spentMicros: z.number(), posts: z.number(), results: z.array(realBillSchema) });
export type RealRun = z.infer<typeof realRunSchema>;

export const claimedCents = (bill: RealBill) => (bill.outcome === "checked" ? bill.claims.reduce((t, claim) => t + claim.amountCents, 0) : 0);
export const unagreedFees = (bill: RealBill) => (bill.outcome === "checked" ? bill.questions.filter((q) => q.kind === "unagreed_fee") : []);

// What the poster wrote is the only record of the promise; it is passed as the customer's own notes.
export function postNotes(post: Pick<RealBill, "title" | "text">): string {
  return `What the customer wrote publicly about this bill:\n${post.title}\n\n${post.text}`.slice(0, 20_000);
}
