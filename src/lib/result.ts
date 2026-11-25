import { z } from "zod";
import type { Claim, Explained, Question, Totals, Unused } from "./decide";
import type { PromiseTerm, Reading } from "./schemas";

const page = z.object({
  image: z
    .string()
    .regex(/^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/)
    .max(4_000_000),
  text: z.string().max(60_000).nullable(),
});
export type PreparedPage = z.infer<typeof page>;

export const checkInputSchema = z.object({
  bill: z.object({ pages: z.array(page).min(1).max(6) }),
  offer: z
    .discriminatedUnion("kind", [
      z.object({ kind: z.literal("text"), text: z.string().trim().min(1).max(20_000) }),
      z.object({ kind: z.literal("pages"), pages: z.array(page).min(1).max(4) }),
    ])
    .nullable(),
});
export type CheckInput = z.infer<typeof checkInputSchema>;
export const MAX_UPLOAD_BYTES = 12_000_000;

export type Stage = "reading_bill" | "rereading_bill" | "reading_offer" | "comparing";

// What the person sees while a check runs: Muse Ember's reasoning summary and each item as soon as it is read.
export type SeenLine = { label: string; amount_cents: number; kind: string; page: number; box: { x0: number; y0: number; x1: number; y1: number } | null };
export type SeenPromise = { kind: string; description: string; amount_cents: number | null };

export type CallRecord = {
  name: string;
  effort: string;
  inputTokens: number;
  cachedTokens: number;
  outputTokens: number;
  costMicros: number;
  reused: boolean;
};

export type CheckFailure =
  | "over_budget"
  | "rate_limited"
  | "upstream"
  | "truncated"
  | "invalid_output"
  | "config"
  | "too_many_checks"
  | "bad_input"
  | "refused"
  | "network";

export type CheckResult =
  | { outcome: "not_a_bill"; spentMicros: number }
  | { outcome: "could_not_check"; reason: string; spentMicros: number }
  | {
      outcome: "checked";
      reading: Reading;
      totals: Totals;
      offerProvider: string | null;
      providerMismatch: boolean;
      promises: PromiseTerm[];
      claims: Claim[];
      questions: Question[];
      explained: Explained[];
      unused: Unused[];
      matchedPromiseIds: string[];
      billIsImage: boolean;
      hadOffer: boolean;
      spentMicros: number;
      calls: CallRecord[];
    };

export type CheckEvent =
  | { type: "stage"; stage: Stage }
  | { type: "spent"; micros: number }
  | { type: "thinking"; stage: Stage; text: string }
  | { type: "line"; line: SeenLine }
  | { type: "promise"; promise: SeenPromise }
  | { type: "result"; result: CheckResult }
  | { type: "error"; failure: CheckFailure; message: string; spentMicros: number; retryable: boolean };
