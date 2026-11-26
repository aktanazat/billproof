"use client";

import { useState } from "react";
import type { CheckAction, CheckState } from "@/lib/check-machine";
import { buildYearMessage, usd } from "@/lib/letter";
import type { CallRecord, Checked, YearResult } from "@/lib/result";
import { MessageBox, ResultView, Trace } from "./result-view";

type Done = Extract<CheckState, { s: "done" }>;

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const LONG_MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

// A statement is placed and named by when its billing starts, or its statement date when the period wasn't read.
const dateOf = (result: Checked) => result.reading.period_start ?? result.reading.statement_date;

function monthOf(result: Checked, long = false): string {
  const iso = dateOf(result);
  if (!iso) return "Unknown";
  const [y, m] = iso.split("-").map(Number);
  // A month the reading got wrong (13) is shown as written rather than as "undefined".
  if (!MONTHS[m - 1]) return iso;
  return long ? `${LONG_MONTHS[m - 1]} ${y}` : `${MONTHS[m - 1]} ${String(y).slice(2)}`;
}

const claimed = (result: Checked) => result.claims.reduce((t, claim) => t + claim.amountCents, 0);

function summarize(calls: CallRecord[]): CallRecord[] {
  const byName = new Map<string, CallRecord>();
  for (const call of calls) {
    const seen = byName.get(call.name);
    byName.set(
      call.name,
      seen
        ? { ...seen, inputTokens: seen.inputTokens + call.inputTokens, cachedTokens: seen.cachedTokens + call.cachedTokens, outputTokens: seen.outputTokens + call.outputTokens, costMicros: seen.costMicros + call.costMicros, reused: seen.reused && call.reused }
        : call,
    );
  }
  return [...byName.values()];
}

export function YearView({ state, result, dispatch }: { state: Done; result: YearResult; dispatch: (action: CheckAction) => void }) {
  const [open, setOpen] = useState<number | null>(null);
  const read = result.months.flatMap((month) => (month.result.outcome === "checked" ? [{ bill: month.bill, result: month.result }] : [])).sort((a, b) => (dateOf(a.result) ?? "").localeCompare(dateOf(b.result) ?? ""));
  // A bill left out is named by its file, so the person knows which one to replace; a count stands in when a name is missing.
  const leftOut = (outcome: "not_a_bill" | "could_not_check", one: string, many: string) => {
    const months = result.months.filter((month) => month.result.outcome === outcome);
    if (months.length === 0) return null;
    const names = months.map((month) => state.inputs.bills[month.bill]?.name);
    const verb = months.length === 1 ? one : many;
    return names.every(Boolean) ? `${names.join(", ")} ${verb}` : `${months.length} ${months.length === 1 ? "file" : "files"} ${verb}`;
  };

  // Statements are counted once, and only for the account most of them show. One whose number couldn't be read is
  // counted with it: only a different number printed on the bill makes it another account's.
  const tally = new Map<string, number>();
  for (const month of read) {
    const number = month.result.reading.account_last4;
    if (number) tally.set(number, (tally.get(number) ?? 0) + 1);
  }
  const account = [...tally.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
  const anotherAccount = (month: (typeof read)[number]) => Boolean(account && month.result.reading.account_last4 && month.result.reading.account_last4 !== account);
  const seen = new Set<string>();
  const checked: typeof read = [];
  const skippedMonths = { duplicates: 0, otherAccount: 0 };
  for (const month of read) {
    const { period_start, period_end, statement_date } = month.result.reading;
    // A statement with no date read can't be shown to repeat another, so it is always counted.
    const key = period_start || period_end || statement_date ? [period_start, period_end, statement_date].join("|") : null;
    if (anotherAccount(month)) skippedMonths.otherAccount += 1;
    else if (key !== null && seen.has(key)) skippedMonths.duplicates += 1;
    else {
      if (key !== null) seen.add(key);
      checked.push(month);
    }
  }
  const { duplicates, otherAccount } = skippedMonths;

  const markOf = (bill: number, id: string) => state.selections[bill]?.claims[id];
  const asked = (month: (typeof read)[number]) => month.result.claims.reduce((t, claim) => t + (markOf(month.bill, claim.id) === "unselected" ? 0 : claim.amountCents), 0);
  const waiting = checked.some((month) => month.result.claims.some((claim) => markOf(month.bill, claim.id) === "needs_confirmation"));
  const firstBad = checked.findIndex((month) => claimed(month.result) > 0);
  const total = checked.reduce((t, month) => t + asked(month), 0);
  const provider = checked.find((month) => month.result.reading.provider)?.result.reading.provider ?? null;
  const hadOffer = checked.some((month) => month.result.hadOffer);
  const callUrl = state.inputs.offer.kind === "call" && state.inputs.offer.call.status === "ready" ? state.inputs.offer.call.url : null;

  if (open !== null) {
    const month = checked.find((m) => m.bill === open);
    const doc = state.inputs.bills[open];
    const selection = state.selections[open];
    if (month && doc?.status === "ready" && selection) {
      return <ResultView result={month.result} bill={open} pages={doc.pages} callUrl={callUrl} selection={selection} dispatch={dispatch} backLabel="Back to the year" onBack={() => setOpen(null)} />;
    }
  }

  const selectedMonths = checked.map((month) => ({ ...month.result, claims: month.result.claims.filter((claim) => markOf(month.bill, claim.id) === "selected") }));
  const message = selectedMonths.some((month) => month.claims.length > 0) ? buildYearMessage(selectedMonths) : null;
  const skipped = [
    leftOut("could_not_check", "couldn't be read", "couldn't be read"),
    leftOut("not_a_bill", "isn't a bill", "aren't bills"),
    duplicates > 0 ? `${duplicates} duplicate ${duplicates === 1 ? "statement" : "statements"}` : null,
    otherAccount > 0 ? `${otherAccount} from another account` : null,
  ].filter(Boolean);
  const largest = Math.max(1, ...checked.map((month) => claimed(month.result)));

  return (
    <section className="mx-auto w-full max-w-[1120px] px-6 pb-24 pt-6">
      <header className="flex flex-wrap items-end justify-between gap-4 pb-8">
        <div>
          {firstBad >= 0 && <p className="text-[40px] font-semibold leading-none tracking-[-0.02em] tabular-nums">{usd(total)}</p>}
          <h1 className={firstBad >= 0 ? "mt-2 max-w-[44rem] text-[17px] text-text-2" : "text-[28px] font-semibold tracking-[-0.02em]"}>
            {firstBad >= 0
              ? `to ask back${provider ? ` from ${provider}` : ""} across ${checked.length} statements${waiting ? ", once you confirm the marked lines" : ""}`
              : hadOffer
                ? `All ${checked.length} statements match the offer`
                : `Read ${checked.length} statements; there was no offer to check them against`}
          </h1>
          {skipped.length > 0 && <p className="mt-1 text-[13px] text-text-2">Not counted: {skipped.join(", ")}</p>}
        </div>
        <button type="button" onClick={() => dispatch({ type: "edit" })} className="h-9 shrink-0 rounded-lg bg-fill px-4 text-[15px] hover:bg-fill-2">
          Check other bills
        </button>
      </header>

      <section className="flex flex-col gap-4">
        <h2 className="text-[17px] font-semibold">{firstBad > 0 ? `Overcharged from ${monthOf(checked[firstBad].result, true)}` : "Overcharge by month"}</h2>
        <ol className="grid grid-cols-6 gap-x-2 gap-y-6 lg:grid-cols-12" aria-label="Overcharge by month">
          {checked.map((month) => {
            const amount = claimed(month.result);
            const unconfirmed = month.result.claims.some((claim) => markOf(month.bill, claim.id) === "needs_confirmation");
            return (
              <li key={month.bill}>
                <button type="button" onClick={() => setOpen(month.bill)} className="group flex w-full flex-col gap-2 rounded-lg text-left" aria-label={`${monthOf(month.result, true)}: ${amount > 0 ? `${usd(amount)} overcharged` : hadOffer ? "matches the offer" : "no offer to compare"}${unconfirmed ? ", to confirm" : ""}`}>
                  <div className="flex h-28 items-end rounded-t-md border-b border-line px-1.5 group-hover:bg-fill">
                    {amount > 0 && <div className="w-full rounded-t-[3px] bg-red" style={{ height: `${Math.max(8, (amount / largest) * 100)}%` }} />}
                  </div>
                  <span className="text-[13px] text-text-2">{monthOf(month.result)}</span>
                  <span className={`text-[13px] tabular-nums ${amount > 0 ? "font-semibold text-red" : "text-text-2"}`}>{amount > 0 ? usd(amount) : "—"}</span>
                  {unconfirmed && <span className="text-[12px] text-text-2">To confirm</span>}
                </button>
              </li>
            );
          })}
        </ol>
        <p className="text-[13px] text-text-2">{waiting ? "Open a month marked “To confirm” and confirm its marked lines to add them to the message." : "Select a month to see its bill and evidence."}</p>
      </section>

      <div className="mt-12 flex max-w-[720px] flex-col gap-10">
        {message && <MessageBox message={message} />}
        <Trace calls={summarize(result.calls)} spentMicros={result.spentMicros} notes={[`${result.months.length} bills read in parallel, ${checked.length} checked against the offer.`]} />
      </div>
    </section>
  );
}
