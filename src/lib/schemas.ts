import { z } from "zod";

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).describe("YYYY-MM-DD");
const cents = z.number().int().describe("Integer cents; credits and discounts are negative");
const quote = z.string().describe("Exact text copied character for character from the document");

export const LINE_KINDS = [
  "plan",
  "equipment",
  "company_fee",
  "government_tax",
  "usage",
  "one_time",
  "credit",
  "discount",
  "late_fee",
  "other",
] as const;
export type LineKind = (typeof LINE_KINDS)[number];

const box = z
  .object({ x0: z.number().int(), y0: z.number().int(), x1: z.number().int(), y1: z.number().int() })
  .describe("Bounding box of the whole printed line on a 0-1000 grid, (0,0) top-left of the page image");

const printedAmount = z.object({ cents, quote }).nullable();

export const billReadingSchema = z.object({
  outcome: z.enum(["bill", "not_a_bill", "unreadable"]),
  unreadable_reason: z.string().nullable(),
  provider: z.string().nullable(),
  account_last4: z.string().nullable().describe("Last 4 characters of the account number only"),
  statement_date: isoDate.nullable(),
  period_start: isoDate.nullable(),
  period_end: isoDate.nullable(),
  due_date: isoDate.nullable(),
  printed: z.object({
    previous_balance: printedAmount,
    payments: printedAmount.describe("Payments received, as a positive number"),
    current_charges: printedAmount,
    total_due: printedAmount,
  }),
  line_items: z.array(
    z.object({
      label: z.string(),
      amount_cents: cents,
      kind: z.enum(LINE_KINDS),
      page: z.number().int().min(1),
      box: box.nullable(),
      quote: quote.describe("The full printed line: label, any detail, and the amount"),
      prorated: z.boolean().describe("True when the line says it is prorated or covers a partial period"),
    }),
  ),
  autopay: z.object({
    enrolled: z.boolean().nullable().describe("True only when the bill says autopay is on; null when it does not say"),
    quote: quote.nullable(),
  }),
});
export type BillReading = z.infer<typeof billReadingSchema>;

export const PROMISE_KINDS = ["monthly_price", "included", "recurring_credit", "other"] as const;
export type PromiseKind = (typeof PROMISE_KINDS)[number];

export const termsSchema = z.object({
  provider: z.string().nullable().describe("Company named in the offer, or null"),
  promises: z.array(
    z.object({
      kind: z.enum(PROMISE_KINDS),
      description: z.string().describe("One plain sentence"),
      amount_cents: cents.nullable().describe("monthly_price: the promised monthly price; recurring_credit: the credit amount as a positive number"),
      per_line: z.boolean().describe("True when the amount is per phone line or per unit"),
      conditions: z.array(z.enum(["autopay", "paperless", "bundle", "contract", "other"])),
      applies_from: isoDate.nullable(),
      applies_until: isoDate.nullable().describe("Last day the promise applies, or null when no end is stated"),
      quote,
      covers_line_ids: z.array(z.string()).describe("IDs of the bill lines this promise governs"),
    }),
  ),
});
export type Terms = z.infer<typeof termsSchema>;

export type LineItem = BillReading["line_items"][number] & { id: string };
export type Reading = Omit<BillReading, "line_items"> & { line_items: LineItem[] };
export type PromiseTerm = Terms["promises"][number] & { id: string };
