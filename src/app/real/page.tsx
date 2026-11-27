import type { Metadata } from "next";
import Link from "next/link";
import { connection } from "next/server";
import { Suspense } from "react";
import { realRun } from "@/data/real-bills";
import { formatMicros } from "@/lib/cost";
import { brandOf } from "@/lib/decide";
import { usd } from "@/lib/letter";
import { cased, claimedCents, displayName, unagreedCents, unagreedFees, type RealBill } from "@/lib/real-bills";
import { livePaused } from "@/lib/server-ledger";
import { Thumbnail } from "../bill-page";
import { alt as cardAlt, size as cardSize } from "../opengraph-image";
import { SiteHeader } from "../site-header";
import { LiveRun } from "./live-run";

// The live run's button is read on every visit, so it is off once the demo's budget can't cover a check.
async function LiveRunNow() {
  await connection();
  return <LiveRun paused={livePaused()} />;
}

const realDescription = "Bills people posted publicly about Xfinity, Spectrum, AT&T, Verizon and others, each checked by Muse Ember against what the poster says they were promised.";

export const metadata: Metadata = {
  title: "Real bills — Billproof",
  description: realDescription,
  // Setting this page's own card text replaces the inherited one, image included, so the image is named again, with
  // its size and description as the site's own card gives them.
  openGraph: { siteName: "Billproof", type: "website", title: "Real bills — Billproof", description: realDescription, images: { url: "/opengraph-image", ...cardSize, alt: cardAlt } },
};

type Checked = Extract<RealBill, { outcome: "checked" }>;

// A date the reading got wrong gives an invalid date; the label is then left out rather than read "Invalid Date".
const monthName = (iso: string | null) => {
  const date = iso ? new Date(`${iso}T12:00:00Z`) : null;
  return date && !Number.isNaN(date.getTime()) ? date.toLocaleDateString("en-US", { month: "short", year: "numeric", timeZone: "UTC" }) : null;
};

// Fee names repeat with small differences across companies; the leaderboard groups them by their words, without a final
// "fee", "charge" or "surcharge" and with California as CA ("California Cost Recovery Charge" is "CA Cost Recovery Charge").
const feeKey = (label: string) =>
  label.toLowerCase().replace(/\bcalifornia\b/, "ca").replace(/[^a-z ]/g, "").replace(/\s+/g, " ").trim().replace(/ (fee|charge|surcharge)$/, "");

// Bills name the same company many ways ("xfinity", "Comcast", "Verizon Fios"); the table groups them by brand.
const companyOf = (provider: string | null) => (provider ? (brandOf(provider) ?? cased(provider)) : "Unknown");

// Every real post whose author later wrote in the thread that the company paid them back for a charge Billproof
// checks, in their own words. Found by reading the posters' own comments on every bill in the run; a roaming fee,
// a charge after cancelling, and one that never says what was wrong are left out.
const PAID_BACK: { id: string; said: string }[] = [
  { id: "1jgjds8", said: "Already confirmed with them it was an error on their end and they credited my account the difference." },
  { id: "1tg9m9y", said: "The rep ended up giving me the 7.50 discount for 2 months per line." },
  { id: "1p6xawo", said: "This was eventually corrected by the retention team." },
  { id: "1kqr1p8", said: "Problem is resolved already, they fixed the promo issue, took 2 business days." },
];

// Bills found by eye to have been read from the wrong picture: their charges add up, but to that picture's total, so
// they are named instead of counted among the bills that add up.
const MISREAD: { id: string; what: string }[] = [{ id: "1p6x994", what: "a Spectrum post read from its order rather than its bill" }];

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
            <span className="font-semibold text-red tabular-nums">{usd(claim.amountCents)}</span>{" "}
            {claim.kind === "credit_missing"
              ? `credit missing: credited ${usd(claim.actualCents)} on ${claim.lines.join(", ")}, promised ${usd(claim.expectedCents)}`
              : claim.kind === "included_charged"
                ? `charged for ${claim.lines.join(", ")}, promised as included`
                : `above the promise: billed ${usd(claim.actualCents)} for ${claim.lines.join(", ")}, promised ${usd(claim.expectedCents)}`}
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
          {namedOnce(fees.flatMap((fee) => fee.lines))} ({usd(fees.reduce((t, fee) => t + fee.cents, 0))})
        </span>
      </p>
    );
  }
  const asked = [...new Set(bill.questions.map((question) => (question.kind === "repeated_charge" ? namedOnce(question.lines) : [...new Set(question.lines)].join(", "))))];
  return <p className="text-[13px] leading-[18px] text-text-2">{asked.length > 0 ? <>Worth asking about: <span className="text-text">{asked.join(", ")}</span></> : "Nothing above what the poster describes"}</p>;
}

// A fee printed several times (once per phone line or TV box) is named once: "Company fees & surcharges, charged 8 times".
function namedOnce(labels: string[]): string {
  const counts = new Map<string, number>();
  for (const label of labels) counts.set(label, (counts.get(label) ?? 0) + 1);
  const repeats = [...counts.values()].some((n) => n > 1);
  return [...counts].map(([label, n]) => (n > 1 ? `${label}, charged ${n} times` : label)).join(repeats ? "; " : ", ");
}

export default function RealBills() {
  // Posts whose pictures were deleted before the run can't be read and aren't counted.
  const results = realRun.results.filter((bill) => !(bill.outcome === "error" && bill.error === "images unavailable"));
  const gone = (realRun.results.length - results.length).toLocaleString("en-US");
  const bills = results.filter((bill): bill is Checked => bill.outcome === "checked");
  const notBills = results.filter((bill) => bill.outcome === "not_a_bill").length.toLocaleString("en-US");
  const unread = results.filter((bill) => bill.outcome === "could_not_check").length;
  const claimed = bills.filter((bill) => claimedCents(bill) > 0);
  // The summary names what the claims are: a missing credit is not a charge above a promise.
  const onlyCredits = claimed.every((bill) => bill.claims.every((claim) => claim.kind === "credit_missing"));
  const claimedTotal = usd(claimed.reduce((t, bill) => t + claimedCents(bill), 0));
  const claimSummary =
    claimed.length === 0
      ? "No dollar claim was made on any post, because no poster quoted a promise the bill could be held to; Billproof asks instead of guessing."
      : claimed.length === 1
        ? `1 post ${onlyCredits ? "was missing a credit" : "had a charge above a promise"} the poster quoted, ${claimedTotal}, waiting for the poster to confirm the marked line.`
        : `${claimed.length} posts ${onlyCredits ? "were missing credits" : "were billed against a promise"} the posters quoted, ${claimedTotal} in all, each waiting for the poster to confirm the marked line.`;
  const fees = bills.flatMap(unagreedFees);
  const feeCents = fees.reduce((t, fee) => t + fee.cents, 0);
  const billsWithFees = bills.filter((bill) => unagreedFees(bill).length > 0).length;
  // realRun.spentMicros is every census pass, partial re-runs included; each post keeps only its own final cost.
  const checksCost = results.reduce((t, bill) => t + bill.spentMicros, 0);
  const perBill = checksCost / Math.max(1, results.length);
  // The bill's own arithmetic is the accuracy check on real data: the charges read must add up to its printed total.
  const withTotal = bills.filter((bill) => bill.lineSum !== "not_printed");
  const misread = withTotal.filter((bill) => MISREAD.some((m) => m.id === bill.id));
  const addsUp = withTotal.filter((bill) => !misread.includes(bill) && (bill.lineSum === "ok" || bill.lineSum === "due" || bill.lineSum === "sections")).length;
  const addsUpToSubtotal = withTotal.filter((bill) => bill.lineSum === "subtotal").length;
  const withEarlier = bills.filter((bill) => bill.change).length;
  const paidBack = PAID_BACK.flatMap((post) => {
    const bill = bills.find((b) => b.id === post.id);
    return bill ? [{ ...post, bill }] : [];
  });

  // A fee printed once per phone line is still one bill's fee, so each bill counts once for each fee it carries.
  const leaderboard = [
    ...bills
      .flatMap((bill) => [...new Map(unagreedFees(bill).flatMap((fee) => fee.lines.map((label) => [feeKey(label), label] as const))).entries()])
      .reduce((map, [key, label]) => map.set(key, { label: map.get(key)?.label ?? label, count: (map.get(key)?.count ?? 0) + 1 }), new Map<string, { label: string; count: number }>())
      .values(),
  ]
    .sort((a, b) => b.count - a.count)
    .slice(0, 8);

  const groups = [
    ...bills
      .reduce((map, bill) => {
        const name = companyOf(bill.provider);
        const seen = map.get(name) ?? { name, bills: 0, withFees: 0, feeCents: 0 };
        const cents = unagreedCents(bill);
        return map.set(name, { name, bills: seen.bills + 1, withFees: seen.withFees + (cents > 0 ? 1 : 0), feeCents: seen.feeCents + cents });
      }, new Map<string, { name: string; bills: number; withFees: number; feeCents: number }>())
      .values(),
  ];
  const companies = groups
    .filter((company) => company.name !== "Unknown")
    .sort((a, b) => b.bills - a.bills || b.feeCents - a.feeCents)
    .slice(0, 10);
  // The rest, with the bills whose company couldn't be read, get one row so the table adds up to the page's totals.
  const others = groups
    .filter((company) => !companies.includes(company))
    .reduce((t, company) => ({ bills: t.bills + company.bills, withFees: t.withFees + company.withFees, feeCents: t.feeCents + company.feeCents }), { bills: 0, withFees: 0, feeCents: 0 });

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
          <h1 className="text-[40px] font-semibold leading-[1.1] tracking-[-0.025em] max-[320px]:text-[28px]">Real bills people posted, checked</h1>
          <p className="mt-4 text-[17px] leading-[26px] text-text-2 text-pretty">
            {results.length.toLocaleString("en-US")} public Reddit posts about phone, internet and TV bills, from Xfinity, Spectrum, AT&amp;T, Verizon and others. Muse Ember sorted every picture, read each real bill line by line, and checked it against what the poster wrote they were promised. Those checks cost {formatMicros(checksCost)}; with every earlier pass and re-read as the checks were improved, the census cost {formatMicros(realRun.spentMicros)} in all.
          </p>
        </div>

        {/* As many columns as fit: two on a phone, one when it's zoomed in, so a figure never runs into the next. */}
        <dl className="mt-10 grid grid-cols-[repeat(auto-fill,minmax(7.5rem,1fr))] divide-line rounded-xl bg-fill sm:grid-cols-5 sm:divide-x">
          {stats.map(([label, value]) => (
            <div key={label} className="flex flex-col gap-1 p-4">
              <dt className="text-[13px] text-text-2">{label}</dt>
              <dd className="text-[24px] font-semibold tracking-[-0.01em] tabular-nums">{value}</dd>
            </div>
          ))}
        </dl>
        <p className="mt-3 text-[13px] text-text-2">
          {notBills} posts showed chats, app screens or ads rather than a bill{unread > 0 ? `, ${unread} showed a bill whose charges couldn't be read reliably, so ${unread === 1 ? "it wasn't" : "they weren't"} checked` : ""}, and {gone} more had their pictures deleted. On {addsUp} of the {withTotal.length} bills that print a total, an amount due or subtotals for every part, the charges Muse Ember read add up to them to the cent{misread.length > 0 ? `, not counting ${misread.map((bill) => MISREAD.find((m) => m.id === bill.id)?.what).join(" and ")}` : ""}{addsUpToSubtotal > 0 ? `, and on ${addsUpToSubtotal} more the first charges add up to a subtotal the bill prints before the rest` : ""}. {withEarlier} posts also showed an earlier bill; Billproof read only the newest one and lists what moved since. {claimSummary}
        </p>

        <Suspense fallback={<LiveRun paused={false} />}>
          <LiveRunNow />
        </Suspense>

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
                  <p className="text-[15px] leading-snug wrap-anywhere">“{said}”</p>
                  <Finding bill={bill} />
                  <Change bill={bill} />
                  <div className="mt-1 flex flex-wrap gap-2">
                    {/* Spoken names start with the words shown, for voice control, then name the post, so a list of the page's links tells them apart. */}
                    <Link href={`/?post=${id}`} rel="nofollow" prefetch={false} aria-label={`Check it live: ${bill.title}`} className="inline-flex min-h-8 items-center rounded-lg bg-text px-3 py-1 text-[13px] font-medium text-white hover:bg-black">
                      Check it live
                    </Link>
                    <a href={bill.permalink} aria-label={`Original post: ${bill.title}`} className="inline-flex min-h-8 items-center rounded-lg px-2 py-1 text-[13px] text-text-2 hover:bg-fill hover:text-text">
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

        <section className="mt-14 grid grid-cols-[minmax(0,1fr)] gap-8 lg:grid-cols-[minmax(0,1fr)_minmax(0,2fr)]">
          <div>
            <h2 className="text-[17px] font-semibold">By company</h2>
            <p className="mt-1 text-[13px] leading-[18px] text-text-2">Real bills from each company, and the fees on them the poster never mentions agreeing to.</p>
          </div>
          {/* Scrolls on its own when the screen is too narrow for its columns (a phone zoomed in), not the whole page. */}
          <div className="overflow-x-auto">
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
              {others.bills > 0 && (
                <tr className="border-t border-line text-text-2">
                  <td className="py-2">Other companies, or none named</td>
                  <td className="py-2 text-right">{others.bills}</td>
                  <td className="py-2 text-right">{others.withFees}</td>
                  <td className="py-2 text-right">{others.feeCents > 0 ? usd(others.feeCents) : "—"}</td>
                </tr>
              )}
            </tbody>
          </table>
          </div>
        </section>

        <section className="mt-14">
          <h2 className="text-[17px] font-semibold">Every bill</h2>
          <ol className="mt-3 flex flex-col">
            {ordered.map((bill) => (
              <li key={bill.id} className="grid grid-cols-[72px_minmax(0,1fr)] gap-4 border-b border-line py-4 sm:grid-cols-[72px_minmax(0,1fr)_auto]">
                <div className="h-[88px] w-[72px] overflow-hidden rounded-[4px] bg-white outline-1 -outline-offset-1 outline-line">
                  <Thumbnail src={`/api/real-image/${bill.id}/${bill.billPages[0] ?? 0}`} lazy />
                </div>
                {/* Beside the thumbnail on a phone zoomed in, this column can be narrower than a fee's longest word. */}
                <div className="flex min-w-0 flex-col gap-1 wrap-break-word">
                  <p className="text-[13px] text-text-2">
                    {[displayName(bill), monthName(bill.period[0])].filter(Boolean).join(", ") || "Bill"}
                  </p>
                  <p className="text-[15px] font-medium leading-snug wrap-anywhere">“{bill.title}”</p>
                  <Finding bill={bill} />
                  <Change bill={bill} />
                </div>
                <div className="col-start-2 flex flex-wrap items-center gap-2 sm:col-start-3 sm:flex-col sm:items-end">
                  <Link href={`/?post=${bill.id}`} rel="nofollow" prefetch={false} aria-label={`Check it live: ${bill.title}`} className="inline-flex min-h-8 items-center rounded-lg bg-text px-3 py-1 text-[13px] font-medium text-white hover:bg-black">
                    Check it live
                  </Link>
                  <a href={bill.permalink} aria-label={`Original post: ${bill.title}`} className="inline-flex min-h-8 items-center rounded-lg px-2 py-1 text-[13px] text-text-2 hover:bg-fill hover:text-text">
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
