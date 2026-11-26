import type { Metadata } from "next";
import Link from "next/link";
import { realRun } from "@/data/real-bills";
import { formatMicros } from "@/lib/cost";
import { usd } from "@/lib/letter";
import { claimedCents, unagreedFees, type RealBill } from "@/lib/real-bills";
import { SiteHeader } from "../site-header";

export const metadata: Metadata = {
  title: "Real bills — Billproof",
  description: "Bills people posted publicly about Xfinity, Spectrum, AT&T, Verizon and others, each checked by Muse Ember against what the poster says they were promised.",
};

type Checked = Extract<RealBill, { outcome: "checked" }>;

const monthName = (iso: string | null) => (iso ? new Date(`${iso}T12:00:00Z`).toLocaleDateString("en-US", { month: "short", year: "numeric", timeZone: "UTC" }) : null);

// Fee names repeat with small differences across companies; the leaderboard groups them by their words.
const feeKey = (label: string) => label.toLowerCase().replace(/[^a-z ]/g, "").replace(/\s+/g, " ").trim();

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
  return <p className="text-[13px] leading-[18px] text-text-2">{bill.questions.length > 0 ? `${bill.questions.length} ${bill.questions.length === 1 ? "charge" : "charges"} worth asking about` : "Nothing above what the poster describes"}</p>;
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

  const leaderboard = [...fees.flatMap((fee) => fee.lines).reduce((map, label) => map.set(feeKey(label), { label, count: (map.get(feeKey(label))?.count ?? 0) + 1 }), new Map<string, { label: string; count: number }>()).values()]
    .sort((a, b) => b.count - a.count)
    .slice(0, 8);

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
            {results.length} public Reddit posts about phone, internet and TV bills, from Xfinity, Spectrum, AT&amp;T, Verizon and others. Muse Ember sorted every picture, read each real bill line by line, and checked it against what the poster wrote they were promised. The whole run took {minutes} {minutes === 1 ? "minute" : "minutes"} and cost {formatMicros(realRun.spentMicros)}.
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
          {notBills} posts showed chats, app screens or ads rather than a bill, and {gone} more had their pictures deleted. {claimed.length === 0 ? "No dollar claim was made on any post, because no poster quoted a promise the bill could be held to; Billproof asks instead of guessing." : `${claimed.length} ${claimed.length === 1 ? "post had a charge" : "posts had charges"} above a promise the poster quoted, ${usd(claimed.reduce((t, bill) => t + claimedCents(bill), 0))} in all, each waiting for the poster to confirm the marked line.`}
        </p>

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
                  <span className="text-[13px] text-text-2 tabular-nums">
                    {fee.count} {fee.count === 1 ? "bill" : "bills"}
                  </span>
                </li>
              ))}
            </ol>
          </section>
        )}

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
