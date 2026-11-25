export type Section = "service" | "equipment" | "fees" | "taxes" | "credits";

export type Line = { label: string; cents: number; section: Section; detail?: string };

export type Expected = {
  claims: { kind: "price_above_promise" | "included_charged" | "credit_missing"; labels: string[]; amountCents: number }[];
  questions: { kind: "unagreed_fee" | "repeated_charge" | "partial_period" | "conditions_unproven"; labels: string[] }[];
  explained: { kind: "promise_ended"; labels: string[] }[];
};

export type BillSpec = {
  id: string;
  provider: { name: string; address: string; phone: string; web: string };
  customer: { name: string; address: string };
  account: string;
  statementDate: string;
  period: { start: string; end: string };
  dueDate: string;
  previousBalanceCents: number;
  paymentCents: number;
  lines: Line[];
  notices: string[];
  proof: string;
  expected: Expected;
};

const customer = { name: "Jordan Lee", address: "418 Alder St, Apt 3, Oakland, CA 94610" };

const bayline = {
  name: "Bayline Fiber",
  address: "PO Box 2211, San Jose, CA 95109",
  phone: "1-866-555-0144",
  web: "bayline.example",
};

const baylineBill = {
  provider: bayline,
  customer,
  account: "8317 2209 4415",
  statementDate: "2026-11-10",
  period: { start: "2026-11-12", end: "2026-12-11" },
  dueDate: "2026-12-01",
  previousBalanceCents: 6249,
  paymentCents: 6249,
  lines: [
    { label: "Fiber 500 Internet", cents: 7500, section: "service", detail: "Nov 12 - Dec 11" },
    { label: "Wi-Fi Gateway Rental", cents: 1500, section: "equipment", detail: "Nov 12 - Dec 11" },
    { label: "Network Enhancement Fee", cents: 399, section: "fees" },
    { label: "Autopay & Paperless Discount", cents: -500, section: "credits" },
    { label: "CA Communications Users Tax", cents: 251, section: "taxes" },
    { label: "Regulatory Recovery Fee", cents: 99, section: "taxes" },
  ],
  notices: [
    "Your promotional pricing ended on 10/31/2026. Your service now bills at the standard rate.",
    "Questions about your bill? Visit bayline.example/help or call 1-866-555-0144.",
  ],
} satisfies Partial<BillSpec>;

export const internetGuaranteed: BillSpec = {
  ...baylineBill,
  id: "internet-guaranteed",
  proof: [
    "From: Bayline Fiber <orders@bayline.example>",
    "Subject: Your Bayline order is confirmed",
    "Date: October 28, 2025",
    "",
    "Hi Jordan, thanks for choosing Bayline Fiber.",
    "",
    "Your plan: Fiber 500 Internet",
    "Monthly price: $55.00/mo with Autopay & Paperless (2-year price guarantee through 10/31/2027)",
    "Wi-Fi Gateway: included at no extra cost",
    "Installation: free",
    "",
    "Price excludes taxes and government fees. The 2-year price guarantee applies to your internet plan rate.",
  ].join("\n"),
  expected: {
    claims: [
      { kind: "price_above_promise", labels: ["Fiber 500 Internet", "Autopay & Paperless Discount"], amountCents: 1500 },
      { kind: "included_charged", labels: ["Wi-Fi Gateway Rental"], amountCents: 1500 },
    ],
    questions: [
      { kind: "unagreed_fee", labels: ["Network Enhancement Fee"] },
      { kind: "unagreed_fee", labels: ["Regulatory Recovery Fee"] },
    ],
    explained: [],
  },
};

export const internetExpired: BillSpec = {
  ...baylineBill,
  id: "internet-expired",
  proof: [
    "From: Bayline Fiber <orders@bayline.example>",
    "Subject: Your Bayline order is confirmed",
    "Date: October 28, 2025",
    "",
    "Hi Jordan, thanks for choosing Bayline Fiber.",
    "",
    "Your plan: Fiber 500 Internet",
    "Promotional price: $55.00/mo with Autopay & Paperless for 12 months (through 10/31/2026)",
    "Wi-Fi Gateway: included for 12 months (through 10/31/2026)",
    "Installation: free",
    "",
    "After the promotional period, regular rates apply. Price excludes taxes and government fees.",
  ].join("\n"),
  expected: {
    claims: [],
    questions: [
      { kind: "unagreed_fee", labels: ["Network Enhancement Fee"] },
      { kind: "unagreed_fee", labels: ["Regulatory Recovery Fee"] },
    ],
    explained: [
      { kind: "promise_ended", labels: ["Fiber 500 Internet", "Autopay & Paperless Discount"] },
      { kind: "promise_ended", labels: ["Wi-Fi Gateway Rental"] },
    ],
  },
};

export const mobile: BillSpec = {
  id: "mobile-autopay",
  provider: {
    name: "Northstar Wireless",
    address: "1200 Market St, Suite 400, San Francisco, CA 94102",
    phone: "1-800-555-0199",
    web: "northstar.example",
  },
  customer,
  account: "5521-0937",
  statementDate: "2026-11-03",
  period: { start: "2026-11-04", end: "2026-12-03" },
  dueDate: "2026-11-24",
  previousBalanceCents: 7188,
  paymentCents: 7188,
  lines: [
    { label: "Unlimited Plus - Line 1 (510) 555-0132", cents: 3500, section: "service" },
    { label: "Unlimited Plus - Line 2 (510) 555-0178", cents: 3500, section: "service" },
    { label: "Device Protection - Line 1", cents: 900, section: "service" },
    { label: "Device Protection - Line 1", cents: 900, section: "service" },
    { label: "Administrative & Telco Recovery Charge", cents: 698, section: "fees", detail: "$3.49 x 2 lines" },
    { label: "Federal Universal Service Fund", cents: 112, section: "taxes" },
    { label: "State 911 Surcharge", cents: 70, section: "taxes" },
  ],
  notices: ["Autopay is on. Your payment of the total due will be drafted on 11/24/2026."],
  proof: [
    "Northstar Wireless - Plan summary",
    "Unlimited Plus, 2 lines",
    "$35/line per month, minus a $5/line Autopay discount each month",
    "Taxes & fees extra.",
  ].join("\n"),
  expected: {
    claims: [
      {
        kind: "credit_missing",
        labels: ["Unlimited Plus - Line 1 (510) 555-0132", "Unlimited Plus - Line 2 (510) 555-0178"],
        amountCents: 1000,
      },
    ],
    questions: [
      { kind: "repeated_charge", labels: ["Device Protection - Line 1"] },
      { kind: "unagreed_fee", labels: ["Administrative & Telco Recovery Charge"] },
    ],
    explained: [],
  },
};

export const demoBills = [internetGuaranteed, internetExpired, mobile] as const;
