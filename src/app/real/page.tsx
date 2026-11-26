import type { Metadata } from "next";
import Link from "next/link";
import { realRun } from "@/data/real-bills";
import { formatMicros } from "@/lib/cost";
import { usd } from "@/lib/letter";
import { claimedCents, unagreedFees, type RealBill } from "@/lib/real-bills";
import { SiteHeader } from "../site-header";
import { LiveRun } from "./live-run";

export const metadata: Metadata = {
  title: "Real bills — Billproof",
  description: "Bills people posted publicly about Xfinity, Spectrum, AT&T, Verizon and others, each checked by Muse Ember against what the poster says they were promised.",
};

type Checked = Extract<RealBill, { outcome: "checked" }>;

const monthName = (iso: string | null) => (iso ? new Date(`${iso}T12:00:00Z`).toLocaleDateString("en-US", { month: "short", year: "numeric", timeZone: "UTC" }) : null);

// Fee names repeat with small differences across companies; the leaderboard groups them by their words.
const feeKey = (label: string) => label.toLowerCase().replace(/[^a-z ]/g, "").replace(/\s+/g, " ").trim();

// Bills name the same company many ways ("xfinity", "Comcast", "Verizon Fios"); the table groups them by brand.
const BRANDS: [RegExp, string][] = [
  [/xfinity|comcast/i, "Xfinity"],
  [/verizon|fios/i, "Verizon"],
  [/at&t|\batt\b/i, "AT&T"],
  [/spectrum|charter/i, "Spectrum"],
  [/t-?mobile|metro/i, "T-Mobile"],
  [/google/i, "Google Fi"],
  [/directv/i, "DirecTV"],
  [/starlink/i, "Starlink"],
];
const companyOf = (provider: string | null) => (provider ? (BRANDS.find(([pattern]) => pattern.test(provider))?.[1] ?? provider) : "Unknown");

// Every real post whose author later wrote in the thread that the company paid them back for a charge Billproof
// checks, in their own words. Found by reading the posters' own comments on every bill in the run; a roaming fee,
// a charge after cancelling, and one that never says what was wrong are left out.
const PAID_BACK: { id: string; said: string }[] = [
  { id: "1jgjds8", said: "Already confirmed with them it was an error on their end and they credited my account the difference." },
  { id: "1tg9m9y", said: "The rep ended up giving me the 7.50 discount for 2 months per line." },
  { id: "1p6xawo", said: "This was eventually corrected by the retention team." },
  { id: "1kqr1p8", said: "Problem is resolved already, they fixed the promo issue, took 2 business days." },
];

function Change({ bill }: { bill: Checked }) {
  if (!bill.change || bill.change.currentCents === bill.change.earlierCents) return null;
  const moved = bill.change.currentCents - bill.change.earlierCents;
  return (
    <p className="text-[13px] leading-[18px] text-text-2">
      {moved > 0 ? "Up" : "Down"} <span className="text-text tabular-nums">{usd(Math.abs(moved))}</span> from the earlier bill in the same post
    </p>
  );
}

function Finding({ bill }: { bill: Checked }) {
  const fees = unagreedFees(bill);
  if (bill.claims.length > 0) {
    return (
      <ul className="flex flex-col gap-1">
        {bill.claims.map((claim, i) => (
          <li key={i} className="text-[13px] leading-[18px]">
            <span className="font-semibold text-red tabular-nums">{usd(claim.amountCents)}</span> above the promise: billed {usd(claim.actualCents)} for {claim.lines.join(", ")}, promised {usd(claim.expectedCents)}
          </li>
        ))}
      </ul>
    );
  }
  if (fees.length > 0) {
    return (
      <p className="text-[13px] leading-[18px] text-text-2">
        Company fees the poster never mentions agreeing to:{" "}
        <span className="text-text">
          {fees.flatMap((fee) => fee.lines).join(", ")} ({usd(fees.reduce((t, fee) => t + fee.cents, 0))})
        </span>
      </p>
    );
  }
  const asked = [...new Set(bill.questions.flatMap((question) => question.lines))];
  return <p className="text-[13px] leading-[18px] text-text-2">{asked.length > 0 ? <>Worth asking about: <span className="text-text">{asked.join(", ")}</span></> : "Nothing above what the poster describes"}</p>;
}

export default function RealBills() {
  // Posts whose pictures were deleted before the run can't be read and aren't counted.
  const results = realRun.results.filter((bill) => !(bill.outcome === "error" && bill.error === "images unavailable"));
  const gone = realRun.results.length - results.length;
  const bills = results.filter((bill): bill is Checked => bill.outcome === "checked");
  const notBills = results.filter((bill) => bill.outcome === "not_a_bill").length;
  const claimed = bills.filter((bill) => claimedCents(bill) > 0);
  const fees = bills.flatMap(unagreedFees);
  const feeCents = fees.reduce((t, fee) => t + fee.cents, 0);
  const billsWithFees = bills.filter((bill) => unagreedFees(bill).length > 0).length;
  const minutes = Math.max(1, Math.round(realRun.seconds / 60));
  const perBill = realRun.spentMicros / Math.max(1, results.length);
  // The bill's own arithmetic is the accuracy check on real data: the charges read must add up to its printed total.
  const withTotal = bills.filter((bill) => bill.lineSum !== "not_printed");
  const addsUp = withTotal.filter((bill) => bill.lineSum === "ok" || bill.lineSum === "due").length;
  const addsUpToSubtotal = withTotal.filter((bill) => bill.lineSum === "subtotal").length;
  const withEarlier = bills.filter((bill) => bill.change).length;
  const paidBack = PAID_BACK.flatMap((post) => {
    const bill = bills.find((b) => b.id === post.id);
    return bill ? [{ ...post, bill }] : [];
  });

  const leaderboard = [...fees.flatMap((fee) => fee.lines).reduce((map, label) => map.set(feeKey(label), { label, count: (map.get(feeKey(label))?.count ?? 0) + 1 }), new Map<string, { label: string; count: number }>()).values()]
    .sort((a, b) => b.count - a.count)
    .slice(0, 8);

  const companies = [
    ...bills
      .reduce((map, bill) => {
        const name = companyOf(bill.provider);
        const seen = map.get(name) ?? { name, bills: 0, withFees: 0, feeCents: 0 };
        const cents = unagreedFees(bill).reduce((t, fee) => t + fee.cents, 0);
        return map.set(name, { name, bills: seen.bills + 1, withFees: seen.withFees + (cents > 0 ? 1 : 0), feeCents: seen.feeCents + cents });
      }, new Map<string, { name: string; bills: number; withFees: number; feeCents: number }>())
      .values(),
  ]
    .filter((company) => company.name !== "Unknown")
    .sort((a, b) => b.bills - a.bills || b.feeCents - a.feeCents)
    .slice(0, 10);

  const ordered = [...bills].sort((a, b) => claimedCents(b) - claimedCents(a) || unagreedFees(b).length - unagreedFees(a).length || b.created - a.created);

  const stats = [
    ["Posts read", results.length.toLocaleString("en-US")],
    ["Real bills among them", bills.length.toLocaleString("en-US")],
    ["Bills with fees nobody agreed to", billsWithFees.toLocaleString("en-US")],
    ["Those fees, per month", usd(feeCents)],
    ["Cost per post", formatMicros(perBill)],
  ];

  return (
    <main className="flex min-h-full flex-col">
      <SiteHeader current="real" />
      <section className="mx-auto w-full max-w-[1120px] px-6 pb-24">
        <div className="max-w-[46rem] pt-12">
          <h1 className="text-[40px] font-semibold leading-[1.1] tracking-[-0.025em]">Real bills people posted, checked</h1>
          <p className="mt-4 text-[17px] leading-[26px] text-text-2 text-pretty">
            {results.length.toLocaleString("en-US")} public Reddit posts about phone, internet and TV bills, from Xfinity, Spectrum, AT&amp;T, Verizon and others. Muse Ember sorted every picture, read each real bill line by line, and checked it against what the poster wrote they were promised. The whole run took {minutes} {minutes === 1 ? "minute" : "minutes"} and cost {formatMicros(realRun.spentMicros)}.
          </p>
        </div>

        <dl className="mt-10 grid grid-cols-2 divide-line rounded-xl bg-fill sm:grid-cols-5 sm:divide-x">
          {stats.map(([label, value]) => (
            <div key={label} className="flex flex-col gap-1 p-4">
              <dt className="text-[13px] text-text-2">{label}</dt>
              <dd className="text-[24px] font-semibold tracking-[-0.01em] tabular-nums">{value}</dd>
            </div>
          ))}
        </dl>
        <p className="mt-3 text-[13px] text-text-2">
          {notBills} posts showed chats, app screens or ads rather than a bill, and {gone} more had their pictures deleted. On {addsUp} of the {withTotal.length} bills that print a total or an amount due, the charges Muse Ember read add up to it to the cent{addsUpToSubtotal > 0 ? `, and on ${addsUpToSubtotal} more the first charges add up to a subtotal the bill prints before the rest` : ""}. {withEarlier} posts also showed an earlier bill; Billproof read only the newest one and lists what moved since. {claimed.length === 0 ? "No dollar claim was made on any post, because no poster quoted a promise the bill could be held to; Billproof asks instead of guessing." : `${claimed.length} ${claimed.length === 1 ? "post had a charge" : "posts had charges"} above a promise the poster quoted, ${usd(claimed.reduce((t, bill) => t + claimedCents(bill), 0))} in all, each waiting for the poster to confirm the marked line.`}
        </p>

        <LiveRun />

        {paidBack.length > 0 && (
          <section className="mt-14 grid gap-8 lg:grid-cols-[minmax(0,1fr)_minmax(0,2fr)]">
            <div>
              <h2 className="text-[17px] font-semibold">When the company paid back</h2>
              <p className="mt-1 text-[13px] leading-[18px] text-text-2">Posters who later wrote that the company fixed their bill, and what Billproof found on the bill they posted, before anyone knew the outcome.</p>
            </div>
            <ol className="flex flex-col">
              {paidBack.map(({ id, said, bill }) => (
                <li key={id} className="flex flex-col gap-1 border-b border-line py-3">
                  <p className="text-[13px] text-text-2">{companyOf(bill.provider ?? bill.sub)}</p>
                  <p className="text-[15px] leading-snug">“{said}”</p>
                  <Change bill={bill} />
                  <Finding bill={bill} />
                  <div className="mt-1 flex gap-2">
                    <Link href={`/?post=${id}`} className="inline-flex h-8 items-center rounded-lg bg-text px-3 text-[13px] font-medium text-white hover:bg-black">
                      Check it live
                    </Link>
                    <a href={bill.permalink} className="inline-flex h-8 items-center rounded-lg px-2 text-[13px] text-text-2 hover:bg-fill hover:text-text">
                      Original post
                    </a>
                  </div>
                </li>
              ))}
            </ol>
          </section>
        )}

        {leaderboard.length > 0 && (
          <section className="mt-14 grid gap-8 lg:grid-cols-[minmax(0,1fr)_minmax(0,2fr)]">
            <div>
              <h2 className="text-[17px] font-semibold">Fees that showed up most</h2>
              <p className="mt-1 text-[13px] leading-[18px] text-text-2">Company charges printed next to taxes, that the poster never mentions agreeing to. Billproof lists them as questions to ask, never as overcharges.</p>
            </div>
            <ol className="flex flex-col">
              {leaderboard.map((fee) => (
                <li key={fee.label} className="flex items-baseline justify-between gap-4 border-b border-line py-2 text-[15px]">
                  <span>{fee.label}</span>
                  <span className="shrink-0 whitespace-nowrap text-[13px] text-text-2 tabular-nums">
                    {fee.count} {fee.count === 1 ? "bill" : "bills"}
                  </span>
                </li>
              ))}
            </ol>
          </section>
        )}

        <section className="mt-14 grid gap-8 lg:grid-cols-[minmax(0,1fr)_minmax(0,2fr)]">
          <div>
            <h2 className="text-[17px] font-semibold">By company</h2>
            <p className="mt-1 text-[13px] leading-[18px] text-text-2">Real bills from each company, and the fees on them the poster never mentions agreeing to.</p>
          </div>
          <table className="w-full text-left text-[15px] tabular-nums">
            <thead>
              <tr className="text-[13px] text-text-2">
                <th className="py-2 font-normal">Company</th>
                <th className="py-2 text-right font-normal">Real bills</th>
                <th className="py-2 text-right font-normal">With fees</th>
                <th className="py-2 text-right font-normal">Fees per month</th>
              </tr>
            </thead>
            <tbody>
              {companies.map((company) => (
                <tr key={company.name} className="border-t border-line">
                  <td className="py-2">{company.name}</td>
                  <td className="py-2 text-right">{company.bills}</td>
                  <td className="py-2 text-right">{company.withFees}</td>
                  <td className="py-2 text-right">{company.feeCents > 0 ? usd(company.feeCents) : "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>

        <section className="mt-14">
          <h2 className="text-[17px] font-semibold">Every bill</h2>
          <ol className="mt-3 flex flex-col">
            {ordered.map((bill) => (
              <li key={bill.id} className="grid grid-cols-[72px_minmax(0,1fr)] gap-4 border-b border-line py-4 sm:grid-cols-[72px_minmax(0,1fr)_auto]">
                <div className="h-[88px] w-[72px] overflow-hidden rounded-[4px] bg-white shadow-[inset_0_0_0_1px_var(--line)]">
                  <img src={`/api/real-image/${bill.id}/${bill.billPages[0] ?? 0}`} alt="" loading="lazy" className="h-full w-full object-cover object-top" />
                </div>
                <div className="flex min-w-0 flex-col gap-1">
                  <p className="text-[13px] text-text-2">
                    {[bill.provider, monthName(bill.period[0])].filter(Boolean).join(", ") || "Bill"}
                  </p>
                  <p className="text-[15px] font-medium leading-snug">“{bill.title}”</p>
                  <Finding bill={bill} />
                  <Change bill={bill} />
                </div>
                <div className="col-start-2 flex items-center gap-2 sm:col-start-3 sm:flex-col sm:items-end">
                  <Link href={`/?post=${bill.id}`} className="inline-flex h-8 items-center rounded-lg bg-text px-3 text-[13px] font-medium text-white hover:bg-black">
                    Check it live
                  </Link>
                  <a href={bill.permalink} className="inline-flex h-8 items-center rounded-lg px-2 text-[13px] text-text-2 hover:bg-fill hover:text-text">
                    Original post
                  </a>
                </div>
              </li>
            ))}
          </ol>
        </section>
      </section>
    </main>
  );
}
