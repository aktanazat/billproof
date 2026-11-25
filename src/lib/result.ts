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

export type CheckFailure =
  | "over_budget"
  | "rate_limited"
  | "upstream"
  | "truncated"
  | "invalid_output"
  | "config"
  | "too_many_checks"
  | "bad_input"
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
    };

export type CheckEvent =
  | { type: "stage"; stage: Stage }
  | { type: "spent"; micros: number }
  | { type: "result"; result: CheckResult }
  | { type: "error"; failure: CheckFailure; message: string; spentMicros: number; retryable: boolean };
