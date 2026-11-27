"use client";

import { useState } from "react";
import { offerOmitted, type CheckAction, type CheckState } from "@/lib/check-machine";
import { buildYearMessage, MONTHS, usd } from "@/lib/letter";
import type { CallRecord, Checked, YearResult } from "@/lib/result";
import { inPlainWords } from "./evidence";
import { focusOnShow, MessageBox, ResultView, SHOWN_QUESTIONS, Trace } from "./result-view";

type Done = Extract<CheckState, { s: "done" }>;

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
  // Back from a month, focus returns to that month's button rather than the year's heading, so a keyboard user keeps
  // their place among the twelve.
  const [cameBackFrom, setCameBackFrom] = useState<number | null>(null);
  const read = result.months.flatMap((month) => (month.result.outcome === "checked" ? [{ bill: month.bill, result: month.result }] : [])).sort((a, b) => (dateOf(a.result) ?? "").localeCompare(dateOf(b.result) ?? ""));
  // A bill left out is named by its file, so the person knows which one to replace; a count stands in when a name is missing.
  const leftOut = (outcome: "not_a_bill" | "could_not_check", one: string, many: string) => {
    const months = result.months.filter((month) => month.result.outcome === outcome);
    if (months.length === 0) return null;
    const names = months.map((month) => state.inputs.bills[month.bill]?.name);
    const verb = months.length === 1 ? one : many;
    return names.every(Boolean) ? `${names.join(", ")} ${verb}` : `${months.length} ${months.length === 1 ? "file" : "files"} ${verb}`;
  };

  // Statements are counted once, and only for the account most of them show; on a tie, the one the offer is about (a
  // phone bill dropped beside the internet bill being checked). One whose number couldn't be read is counted with it:
  // only a different number printed on the bill makes it another account's.
  // A statement with no date read can't be shown to repeat another, so it is always counted.
  const dates = ({ result }: (typeof read)[number]) => {
    const { period_start, period_end, statement_date } = result.reading;
    return period_start || period_end || statement_date ? [period_start, period_end, statement_date].join("|") : null;
  };
  const tally = new Map<string, { count: number; offered: boolean }>();
  const tallied = new Set<string>();
  for (const month of read) {
    const number = month.result.reading.account_last4;
    const key = dates(month);
    if (!number || (key !== null && tallied.has(`${number}|${key}`))) continue;
    if (key !== null) tallied.add(`${number}|${key}`);
    const offered = month.result.hadOffer && !month.result.providerMismatch;
    tally.set(number, { count: (tally.get(number)?.count ?? 0) + 1, offered: offered || (tally.get(number)?.offered ?? false) });
  }
  const account = [...tally.entries()].sort(([, a], [, b]) => b.count - a.count || Number(b.offered) - Number(a.offered))[0]?.[0] ?? null;
  const anotherAccount = (month: (typeof read)[number]) => Boolean(account && month.result.reading.account_last4 && month.result.reading.account_last4 !== account);
  const seen = new Set<string>();
  const checked: typeof read = [];
  const skippedMonths = { duplicates: 0, otherAccount: [] as string[] };
  for (const month of read) {
    const key = dates(month);
    if (anotherAccount(month)) skippedMonths.otherAccount.push(state.inputs.bills[month.bill]?.name ?? `Bill ${month.bill + 1}`);
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
  // With nothing owed, the heading says what the offer was compared with, as a single bill's does: an offer from
  // another company, fees worth asking about, one with no price or promise, or promises that fit no line is not a match.
  const otherCompany = checked.find((month) => month.result.providerMismatch)?.result.offerProvider ?? null;
  const compared = (month: (typeof read)[number]) => month.result.matchedPromiseIds.length > 0;
  const asks = (month: (typeof read)[number]) => month.result.questions.some((question) => SHOWN_QUESTIONS.has(question.kind));
  const asking = checked.filter(asks).length;
  // A month whose pictures held an earlier statement can show a rise since it, which its message asks about.
  const rose = (month: (typeof read)[number]) => (month.result.change ? month.result.change.currentCents > month.result.change.earlierCents : false);
  const rising = checked.filter(rose).length;
  const one = checked.length === 1;
  const statements = one ? "1 statement" : `${checked.length} statements`;
  const verdict =
    checked.length === 0
      ? `None of the ${result.months.length} files could be checked`
      : otherCompany
        ? `The offer is from ${otherCompany}, not ${provider ?? "this company"}`
        : asking > 0
          ? `Charges worth asking about on ${asking} of ${statements}`
          : rising > 0
            ? `Higher than the bill before on ${rising} of ${statements}`
          : !hadOffer
            ? `Read ${statements}; there was no offer to check ${one ? "it" : "them"} against`
            : !checked.some((month) => month.result.promises.length > 0)
              ? `No price or promise found to check the ${one ? "statement" : "statements"} against`
              : !checked.some(compared)
                ? `Couldn't match your offer to ${one ? "this statement" : "these statements"}`
                : one
                  ? "The 1 statement matches the offer"
                  : `All ${statements} match the offer`;
  const callUrl = state.inputs.offer.kind === "call" && state.inputs.offer.call.status === "ready" ? state.inputs.offer.call.url : null;

  if (open !== null) {
    const month = checked.find((m) => m.bill === open);
    const doc = state.inputs.bills[open];
    const selection = state.selections[open];
    if (month && doc?.status === "ready" && selection) {
      return <ResultView result={month.result} bill={open} pages={doc.pages} omittedPages={{ bill: doc.omitted, offer: offerOmitted(state.inputs.offer) }} callUrl={callUrl} selection={selection} dispatch={dispatch} backLabel="Back to the year" onBack={() => { setCameBackFrom(open); setOpen(null); }} />;
    }
  }

  // The message carries what each month's page keeps ticked: its claims, and the questions shown there.
  const selectedMonths = checked.map((month) => ({
    ...month.result,
    claims: month.result.claims.filter((claim) => markOf(month.bill, claim.id) === "selected"),
    questions: month.result.questions.filter((question) => SHOWN_QUESTIONS.has(question.kind) && state.selections[month.bill]?.questions[question.id] === true),
  }));
  const message = selectedMonths.some((month) => month.claims.length > 0 || month.questions.length > 0) || rising > 0 ? buildYearMessage(selectedMonths) : null;
  const skipped = [
    leftOut("could_not_check", "couldn't be read", "couldn't be read"),
    leftOut("not_a_bill", "isn't a bill", "aren't bills"),
    duplicates > 0 ? `${duplicates} duplicate ${duplicates === 1 ? "statement" : "statements"}` : null,
    // Named, with what to do: added beside this account's (a phone bill with an internet bill), its finding is unseen.
    otherAccount.length === 1
      ? `${otherAccount[0]} is from another account (check it on its own)`
      : otherAccount.length > 0
        ? `${otherAccount.length === 2 ? otherAccount.join(" and ") : `${otherAccount.length} statements`} are from another account (check them on their own)`
        : null,
  ].filter(Boolean);
  // A month that couldn't be read can't be opened from the year, so its reason is given here, by file, or the person
  // can't tell what to replace it with.
  const unreadable = result.months.flatMap((month) => (month.result.outcome === "could_not_check" ? [{ bill: month.bill, name: state.inputs.bills[month.bill]?.name ?? `Bill ${month.bill + 1}`, reason: month.result.reason }] : []));
  const largest = Math.max(1, ...checked.map((month) => claimed(month.result)));

  return (
    <section className="mx-auto w-full max-w-[1120px] px-6 pb-24 pt-6">
      <header className="flex flex-wrap items-end justify-between gap-4 pb-8">
        <div ref={cameBackFrom === null ? focusOnShow : undefined} tabIndex={-1} className="outline-none">
          <h1 className={firstBad >= 0 ? undefined : "text-[28px] font-semibold leading-[1.2] tracking-[-0.02em]"}>
            {firstBad >= 0 ? (
              <>
                {/* 28 px below 320 px wide (a phone zoomed in): a year's total can't wrap, and at 40 "$1,250.00" is wider than the column. */}
                <span className="block text-[40px] font-semibold leading-none tracking-[-0.02em] tabular-nums max-[320px]:text-[28px]">{usd(total)}</span>{" "}
                <span className="mt-2 block max-w-[44rem] text-[17px] text-text-2">
                  to ask back{provider ? ` from ${provider}` : ""} across {statements}
                  {waiting ? ", once you confirm the marked lines" : ""}
                </span>
              </>
            ) : (
              verdict
            )}
          </h1>
          {skipped.length > 0 && <p className="mt-1 text-[13px] text-text-2 wrap-anywhere">Not counted: {skipped.join(", ")}</p>}
          {unreadable.map(({ bill, name, reason }) => (
            <p key={bill} className="mt-1 text-[13px] text-text-2 wrap-anywhere">
              {name}: {inPlainWords(reason)}
            </p>
          ))}
        </div>
        <button type="button" onClick={() => dispatch({ type: "edit" })} className="h-9 shrink-0 rounded-lg bg-fill px-4 text-[15px] hover:bg-fill-2">
          Check other bills
        </button>
      </header>

      {checked.length > 0 && (
        <section className="flex flex-col gap-4">
          <h2 className="text-[17px] font-semibold">{firstBad > 0 ? `Overcharged from ${monthOf(checked[firstBad].result, true)}` : "Overcharge by month"}</h2>
          {/* Four months a row on a phone, fewer when it's zoomed in, so an amount never runs into the next month's. */}
          <ol className="grid grid-cols-[repeat(auto-fill,minmax(4.5rem,1fr))] gap-x-2 gap-y-6 sm:grid-cols-6 lg:grid-cols-12" aria-label="Overcharge by month">
            {checked.map((month) => {
              const amount = claimed(month.result);
              const unconfirmed = month.result.claims.some((claim) => markOf(month.bill, claim.id) === "needs_confirmation");
              // The spoken name starts with the words shown on the button ("Aug 26 $5.00 to confirm"), so voice control
              // can reach it, then says the month in full and what it found.
              const shown = monthOf(month.result);
              const full = monthOf(month.result, true);
              const visible = [shown, ...(amount > 0 ? [usd(amount)] : []), ...(unconfirmed ? ["To confirm"] : [])].join(" ");
              const status = amount > 0 ? "overcharged" : asks(month) ? "charges worth asking about" : rose(month) ? "higher than the bill before" : !hadOffer ? "no offer to compare" : compared(month) ? "matches the offer" : "not compared with the offer";
              return (
                <li key={month.bill}>
                  <button type="button" ref={month.bill === cameBackFrom ? focusOnShow : undefined} onClick={() => setOpen(month.bill)} className="group flex w-full flex-col gap-2 rounded-lg text-left" aria-label={`${visible}${shown === full ? "" : `, ${full}`}: ${status}`}>
                    <span className="flex h-28 items-end rounded-t-md border-b border-line px-1.5 group-hover:bg-fill">
                      {/* Printed in colour: browsers drop backgrounds on paper, and the bar is the chart. */}
                      {amount > 0 && <span className="w-full rounded-t-[3px] bg-red [print-color-adjust:exact]" style={{ height: `${Math.max(8, (amount / largest) * 100)}%` }} />}
                    </span>
                    {/* The spaces keep the words apart in the button's text; the column layout doesn't show them. */}
                    <span className="text-[13px] text-text-2">{shown}</span>{" "}
                    <span className={`text-[13px] tabular-nums ${amount > 0 ? "font-semibold text-red" : "text-text-2"}`}>{amount > 0 ? usd(amount) : "—"}</span>
                    {unconfirmed && <> <span className="text-[12px] text-text-2">To confirm</span></>}
                  </button>
                </li>
              );
            })}
          </ol>
          <p className="text-[13px] text-text-2">{waiting ? "Open a month marked “To confirm” and confirm its marked lines to add them to the message." : "Select a month to see its bill and evidence."}</p>
        </section>
      )}

      <div className="mt-12 flex max-w-[720px] flex-col gap-10">
        {message && <MessageBox message={message} />}
        <Trace calls={summarize(result.calls)} spentMicros={result.spentMicros} notes={[`${result.months.length} bills read in parallel${hadOffer ? `, ${checked.length} checked against the offer` : ""}.`]} />
      </div>
    </section>
  );
}
