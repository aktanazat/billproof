import { z } from "zod";
import type { BillChange, DroppedClaim, Explained, Question, TestedClaim, Totals, Unused } from "./decide";
import type { PromiseTerm, Reading, TranscriptTurn } from "./schemas";

const page = z.object({
  image: z
    .string()
    .regex(/^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/)
    .max(4_000_000),
  text: z.string().max(60_000).nullable(),
});
export type PreparedPage = z.infer<typeof page>;

export const MAX_BILLS = 12;
export const MAX_CALL_SECONDS = 240;
const CALL_SAMPLE_RATE = 16_000;

// Seconds of audio in a base64 16 kHz mono 16-bit PCM WAV with the plain 44-byte header, or null for anything else.
// The length comes from the bytes themselves, so a recording cannot claim to be shorter than it is.
export function wavSeconds(base64: string): number | null {
  if (base64.length < 60 || base64.length % 4 !== 0) return null;
  const head = Uint8Array.from(atob(base64.slice(0, 60)), (ch) => ch.charCodeAt(0));
  const view = new DataView(head.buffer);
  const text = (offset: number, length: number) => String.fromCharCode(...head.subarray(offset, offset + length));
  const padding = base64.endsWith("==") ? 2 : base64.endsWith("=") ? 1 : 0;
  const dataBytes = (base64.length / 4) * 3 - padding - 44;
  const pcm =
    text(0, 4) === "RIFF" &&
    text(8, 8) === "WAVEfmt " &&
    view.getUint16(20, true) === 1 &&
    view.getUint16(22, true) === 1 &&
    view.getUint32(24, true) === CALL_SAMPLE_RATE &&
    view.getUint16(34, true) === 16 &&
    text(36, 4) === "data" &&
    view.getUint32(40, true) === dataBytes;
  return pcm && dataBytes > 0 ? dataBytes / (CALL_SAMPLE_RATE * 2) : null;
}

export const checkInputSchema = z.object({
  bills: z.array(z.object({ pages: z.array(page).min(1).max(6) })).min(1).max(MAX_BILLS),
  offer: z
    .discriminatedUnion("kind", [
      z.object({ kind: z.literal("text"), text: z.string().trim().min(1).max(20_000) }),
      z.object({ kind: z.literal("pages"), pages: z.array(page).min(1).max(4) }),
      // 16 kHz mono WAV, base64 without a data: prefix.
      z.object({ kind: z.literal("audio"), wav: z.string().regex(/^[A-Za-z0-9+/=]+$/).max(10_500_000) }).refine((offer) => {
        const seconds = wavSeconds(offer.wav);
        return seconds !== null && seconds <= MAX_CALL_SECONDS;
      }, "The recording must be 16 kHz mono WAV, at most 4 minutes"),
    ])
    .nullable(),
});
export type CheckInput = z.infer<typeof checkInputSchema>;
export type OfferInput = NonNullable<CheckInput["offer"]>;
export const MAX_UPLOAD_BYTES = 40_000_000;

export type Stage = "sorting" | "reading_bill" | "rereading_bill" | "reading_offer" | "comparing" | "challenging";

// What each uploaded picture turned out to be: part of the bill, proof of a promise (a chat, an offer, an email), or neither.
export type PageKind = "bill" | "older_bill" | "promise" | "other";

// What the person sees while a check runs: Muse Ember's reasoning summary and each item as soon as it is read.
export type SeenLine = { label: string; amount_cents: number; kind: string; page: number; box: { x0: number; y0: number; x1: number; y1: number } | null };
export type SeenPromise = { kind: string; description: string; amount_cents: number | null };
export type SeenChallenge = { claim_id: string; looked_for: string };

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

export type Checked = {
  outcome: "checked";
  reading: Reading;
  totals: Totals;
  offerProvider: string | null;
  providerMismatch: boolean;
  promises: PromiseTerm[];
  transcript: TranscriptTurn[] | null;
  claims: TestedClaim[];
  dropped: DroppedClaim[];
  questions: Question[];
  explained: Explained[];
  unused: Unused[];
  matchedPromiseIds: string[];
  billIsImage: boolean;
  // Indices of the uploaded pages that make up the bill, in reading order; line items' page numbers count within these.
  billPages: number[];
  // When the pictures also hold an earlier statement: what moved between it and this bill.
  change: BillChange | null;
  hadOffer: boolean;
  spentMicros: number;
  calls: CallRecord[];
};

export type SingleResult = { outcome: "not_a_bill"; spentMicros: number } | { outcome: "could_not_check"; reason: string; spentMicros: number } | Checked;

export type Month = { bill: number; result: SingleResult };
export type YearResult = { outcome: "year"; months: Month[]; spentMicros: number; calls: CallRecord[] };

export type CheckResult = SingleResult | YearResult;

export type CheckEvent =
  | { type: "stage"; stage: Stage }
  // A bill is being read a second time: the lines already streamed for it are replaced, not added to.
  | { type: "reread"; bill: number }
  | { type: "sorted"; bill: number; kinds: PageKind[] }
  | { type: "spent"; micros: number }
  | { type: "thinking"; stage: Stage; text: string }
  | { type: "line"; bill: number; line: SeenLine }
  | { type: "promise"; promise: SeenPromise }
  | { type: "heard"; turn: TranscriptTurn }
  | { type: "challenge"; challenge: SeenChallenge }
  | { type: "month"; bill: number; result: SingleResult }
  | { type: "result"; result: CheckResult }
  | { type: "error"; failure: CheckFailure; message: string; spentMicros: number; retryable: boolean };
