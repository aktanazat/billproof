import { demoBills, type BillSpec, type Expected, type Line } from "./specs";

const customer = { name: "Sam Rivera", address: "77 Linden Ave, Fresno, CA 93704" };
const none: Expected = { claims: [], questions: [], explained: [] };

const bayline = { name: "Bayline Fiber", address: "PO Box 2211, San Jose, CA 95109", phone: "1-866-555-0144", web: "bayline.example" };
const northstar = { name: "Northstar Wireless", address: "1200 Market St, Suite 400, San Francisco, CA 94102", phone: "1-800-555-0199", web: "northstar.example" };
const summit = { name: "Summit Cable & TV", address: "PO Box 4410, Reno, NV 89505", phone: "1-888-555-0123", web: "summitcable.example" };
const valley = { name: "Pacific Valley Power", address: "PO Box 9900, Sacramento, CA 95899", phone: "1-800-555-0110", web: "pvpower.example" };

function bill(id: string, provider: BillSpec["provider"], lines: Line[], notices: string[], proof: string, expected: Expected): BillSpec {
  const previous = 5000 + id.length * 137;
  return {
    id,
    provider,
    customer,
    account: `44${id.length}1 9083 ${1000 + id.length * 7}`,
    statementDate: "2026-11-06",
    period: { start: "2026-11-08", end: "2026-12-07" },
    dueDate: "2026-11-27",
    previousBalanceCents: previous,
    paymentCents: previous,
    lines,
    notices,
    proof,
    expected,
  };
}

const offerEmail = (provider: string, body: string[]) =>
  [`From: ${provider} <orders@example.com>`, "Subject: Your order is confirmed", "Date: December 2, 2025", "", ...body, "", "Taxes and fees are extra."].join("\n");

export const evalBills: BillSpec[] = [
  ...demoBills,
  bill(
    "internet-honored",
    bayline,
    [
      { label: "Fiber 300 Internet", cents: 6000, section: "service" },
      { label: "Autopay Discount", cents: -500, section: "credits" },
      { label: "CA Communications Users Tax", cents: 189, section: "taxes" },
    ],
    ["Thank you for using autopay."],
    offerEmail("Bayline Fiber", ["Fiber 300 Internet: $55/mo with autopay, price locked through 12/31/2027."]),
    none,
  ),
  bill(
    "internet-gateway-credited",
    bayline,
    [
      { label: "Fiber 500 Internet", cents: 6500, section: "service" },
      { label: "Wi-Fi Gateway Rental", cents: 1500, section: "equipment" },
      { label: "Gateway Promotional Credit", cents: -1500, section: "credits" },
      { label: "CA Communications Users Tax", cents: 210, section: "taxes" },
    ],
    [],
    offerEmail("Bayline Fiber", ["Fiber 500 Internet: $65.00/mo", "Wi-Fi Gateway: included, no monthly fee"]),
    none,
  ),
  bill(
    "internet-autopay-unproven",
    bayline,
    [
      { label: "Fiber 300 Internet", cents: 6000, section: "service" },
      { label: "CA Communications Users Tax", cents: 189, section: "taxes" },
    ],
    [],
    offerEmail("Bayline Fiber", ["Fiber 300 Internet: $55/mo with autopay ($5 off with autopay), through 12/31/2027."]),
    { claims: [], questions: [{ kind: "conditions_unproven", labels: ["Fiber 300 Internet"] }], explained: [] },
  ),
  bill(
    "mobile-credit-posted",
    northstar,
    [
      { label: "Essentials - Line 1", cents: 3000, section: "service" },
      { label: "Essentials - Line 2", cents: 3000, section: "service" },
      { label: "Autopay Discount", cents: -1000, section: "credits", detail: "$5 x 2 lines" },
      { label: "Federal Universal Service Fund", cents: 96, section: "taxes" },
    ],
    ["Autopay is on."],
    ["Northstar Wireless plan summary", "Essentials, 2 lines: $30/line per month", "Autopay discount: $5/line per month"].join("\n"),
    none,
  ),
  bill(
    "mobile-price-over",
    northstar,
    [
      { label: "Unlimited Basic - Line 1", cents: 3000, section: "service" },
      { label: "Unlimited Basic - Line 2", cents: 3000, section: "service" },
      { label: "Unlimited Basic - Line 3", cents: 3000, section: "service" },
      { label: "State 911 Surcharge", cents: 105, section: "taxes" },
    ],
    [],
    ["Northstar Wireless - order summary", "Unlimited Basic for 3 lines at $25/line per month (price guaranteed for 3 years)", "Order date: 2026-03-14"].join("\n"),
    { claims: [{ kind: "price_above_promise", labels: ["Unlimited Basic - Line 1", "Unlimited Basic - Line 2", "Unlimited Basic - Line 3"], amountCents: 1500 }], questions: [], explained: [] },
  ),
  bill(
    "tv-box-waived",
    summit,
    [
      { label: "TV Select Package", cents: 5999, section: "service" },
      { label: "HD Receiver Rental", cents: 999, section: "equipment" },
      { label: "Broadcast TV Fee", cents: 2150, section: "fees" },
      { label: "NV Franchise Fee", cents: 455, section: "taxes" },
    ],
    [],
    offerEmail("Summit Cable & TV", ["TV Select Package: $59.99/mo for 24 months (through 11/30/2027)", "HD Receiver rental fee waived for 24 months"]),
    {
      claims: [{ kind: "included_charged", labels: ["HD Receiver Rental"], amountCents: 999 }],
      questions: [{ kind: "unagreed_fee", labels: ["Broadcast TV Fee"] }],
      explained: [],
    },
  ),
  bill(
    "internet-promo-midcycle",
    bayline,
    [
      { label: "Fiber 300 Internet", cents: 7000, section: "service" },
      { label: "CA Communications Users Tax", cents: 221, section: "taxes" },
    ],
    [],
    offerEmail("Bayline Fiber", ["Fiber 300 Internet: $50/mo for 12 months (through 11/20/2026)"]),
    { claims: [], questions: [{ kind: "partial_period", labels: ["Fiber 300 Internet"] }], explained: [] },
  ),
  bill(
    "electric-fixed-rate",
    valley,
    [
      { label: "Basic Service Charge", cents: 1200, section: "service" },
      { label: "Electric Usage (412 kWh @ $0.2210)", cents: 9105, section: "service" },
      { label: "Utility Users Tax (7.5%)", cents: 773, section: "taxes" },
    ],
    [],
    ["Pacific Valley Power - Fixed Rate Plan enrollment", "Your energy rate: $0.199 per kWh, fixed for 12 months starting 2026-06-01."].join("\n"),
    none,
  ),
  bill(
    "offer-other-company",
    bayline,
    [
      { label: "Fiber 500 Internet", cents: 7500, section: "service" },
      { label: "CA Communications Users Tax", cents: 251, section: "taxes" },
    ],
    [],
    offerEmail("Westline Cable", ["Westline Cable: Internet 500 for $45/mo, guaranteed through 2028"]),
    none,
  ),
];
