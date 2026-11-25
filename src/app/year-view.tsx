"use client";

import { useState, type CSSProperties } from "react";
import type { CheckAction, CheckState } from "@/lib/check-machine";
import { buildYearMessage, usd, type Message } from "@/lib/letter";
import type { CallRecord, Checked, YearResult } from "@/lib/result";
import { BillPage } from "./bill-page";
import { ResultView, Trace } from "./result-view";

type Done = Extract<CheckState, { s: "done" }>;

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const LONG_MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

function monthOf(result: Checked, long = false): string {
  const iso = result.reading.period_start ?? result.reading.statement_date;
  if (!iso) return "Unknown";
  const [y, m] = iso.split("-").map(Number);
  return long ? `${LONG_MONTHS[m - 1]} ${y}` : `${MONTHS[m - 1]} ${String(y).slice(2)}`;
}

// The plan's net monthly price: plan lines with the discounts and credits that come off them.
function netPlan(result: Checked): number {
  return result.reading.line_items.filter((line) => line.kind === "plan" || line.kind === "discount" || line.kind === "credit").reduce((t, line) => t + line.amount_cents, 0);
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

function PriceLine({ values, firstBad }: { values: (number | null)[]; firstBad: number }) {
  const known = values.filter((v): v is number => v !== null);
  if (known.length < 2) return null;
  const max = Math.max(...known);
  const min = Math.min(...known);
  const span = Math.max(1, max - min);
  const w = 100 / values.length;
  const y = (v: number) => 34 - ((v - min) / span) * 26;
  const points = values.map((v, i) => (v === null ? null : { x: i * w + w / 2, y: y(v) }));
  const segments = points.slice(1).map((p, i) => ({ a: points[i], b: p, bad: i + 1 >= firstBad && firstBad >= 0 }));
  return (
    <svg aria-hidden viewBox="0 0 100 40" preserveAspectRatio="none" className="hidden h-16 w-full lg:block">
      {segments.map((s, i) => (s.a && s.b ? <path key={i} d={`M${s.a.x},${s.a.y} H${s.b.x} V${s.b.y}`} fill="none" stroke={s.bad ? "var(--vermilion)" : "var(--ink)"} strokeWidth={s.bad ? 1.4 : 0.8} vectorEffect="non-scaling-stroke" /> : null))}
    </svg>
  );
}

export function YearView({ state, result, dispatch }: { state: Done; result: YearResult; dispatch: (action: CheckAction) => void }) {
  const [open, setOpen] = useState<number | null>(null);
  const read = result.months.flatMap((month) => (month.result.outcome === "checked" ? [{ bill: month.bill, result: month.result }] : [])).sort((a, b) => (a.result.reading.statement_date ?? "").localeCompare(b.result.reading.statement_date ?? ""));
  const unread = result.months.length - read.length;

  // Statements are counted once, and only for the account most of them belong to.
  const accountOf = (month: (typeof read)[number]) => month.result.reading.account_last4 ?? "unknown";
  const tally = new Map<string, number>();
  for (const month of read) tally.set(accountOf(month), (tally.get(accountOf(month)) ?? 0) + 1);
  const account = [...tally.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
  const seen = new Set<string>();
  const checked: typeof read = [];
  const skippedMonths = { duplicates: 0, otherAccount: 0 };
  for (const month of read) {
    const { period_start, period_end, statement_date } = month.result.reading;
    const key = [period_start, period_end, statement_date].join("|");
    if (accountOf(month) !== account) skippedMonths.otherAccount += 1;
    else if (seen.has(key)) skippedMonths.duplicates += 1;
    else {
      seen.add(key);
      checked.push(month);
    }
  }
  const { duplicates, otherAccount } = skippedMonths;

  const markOf = (bill: number, id: string) => state.selections[bill]?.claims[id];
  const asked = (month: (typeof read)[number]) => month.result.claims.reduce((t, claim) => t + (markOf(month.bill, claim.id) === "unselected" ? 0 : claim.amountCents), 0);
  const waiting = checked.some((month) => month.result.claims.some((claim) => markOf(month.bill, claim.id) === "needs_confirmation"));
  const firstBad = checked.findIndex((month) => claimed(month.result) > 0);
  const total = checked.reduce((t, month) => t + asked(month), 0);
  const provider = checked[0]?.result.reading.provider ?? null;
  const offerText = state.inputs.offer.kind === "text" ? state.inputs.offer.text : null;
  const callUrl = state.inputs.offer.kind === "call" && state.inputs.offer.call.status === "ready" ? state.inputs.offer.call.url : null;

  if (open !== null) {
    const month = checked.find((m) => m.bill === open);
    const doc = state.inputs.bills[open];
    const selection = state.selections[open];
    if (month && doc?.status === "ready" && selection) {
      return <ResultView result={month.result} bill={open} pages={doc.pages} offerText={offerText} callUrl={callUrl} selection={selection} thoughts={[]} dispatch={dispatch} backLabel="Back to the year" onBack={() => setOpen(null)} />;
    }
  }

  const selectedMonths = checked.map((month) => ({ ...month.result, claims: month.result.claims.filter((claim) => markOf(month.bill, claim.id) === "selected") }));
  const message = selectedMonths.some((month) => month.claims.length > 0) ? buildYearMessage(selectedMonths) : null;
  const skipped = [
    unread > 0 ? `${unread} ${unread === 1 ? "bill" : "bills"} couldn't be read` : null,
    duplicates > 0 ? `${duplicates} duplicate ${duplicates === 1 ? "statement" : "statements"}` : null,
    otherAccount > 0 ? `${otherAccount} from another account` : null,
  ].filter(Boolean);

  return (
    <section className="mx-auto w-full max-w-[1240px] px-6 pb-24 pt-10">
      <header className="flex flex-wrap items-end justify-between gap-6 border-b border-rule pb-6">
        <div>
          <p className="display text-[96px] leading-[0.85] tracking-[-0.03em] tabular-nums sm:text-[136px]">{usd(total)}</p>
          <h1 className="mt-3 max-w-[48rem] text-[17px] text-ink-2">
            {firstBad >= 0
              ? `to ask back${provider ? ` from ${provider}` : ""} across ${checked.length} statements${waiting ? ", once you confirm the marked lines" : ""}. It started in ${monthOf(checked[firstBad].result, true)}.`
              : `Every one of ${checked.length} statements matches the offer.`}
            {skipped.length > 0 ? ` Not counted: ${skipped.join(", ")}.` : ""}
          </h1>
        </div>
        <button type="button" onClick={() => dispatch({ type: "edit" })} className="h-10 shrink-0 rounded-full px-5 text-[14px] shadow-[inset_0_0_0_1px_var(--rule)] hover:bg-fill">
          Check other bills
        </button>
      </header>

      <div className="mt-12">
        <PriceLine values={checked.map((m) => netPlan(m.result))} firstBad={firstBad} />
        <ol className="grid grid-cols-4 gap-3 sm:grid-cols-6 lg:[grid-template-columns:repeat(var(--months),minmax(0,1fr))]" style={{ "--months": checked.length } as CSSProperties}>
          {checked.map((month, i) => {
            const doc = state.inputs.bills[month.bill];
            const amount = claimed(month.result);
            return (
              <li key={month.bill}>
                <button type="button" onClick={() => setOpen(month.bill)} className={`group flex w-full flex-col gap-2 text-left ${i === firstBad ? "relative" : ""}`}>
                  <div className={`transition-transform duration-300 group-hover:-translate-y-1 ${amount > 0 ? "outline outline-2 outline-offset-2 outline-vermilion" : ""}`}>{doc?.status === "ready" && <BillPage image={doc.pages[0].image} alt="" visibleAspect="1200 / 1100" />}</div>
                  <span className="text-[12px] text-ink-2">{monthOf(month.result)}</span>
                  <span className="text-[13px] tabular-nums">{usd(netPlan(month.result))}</span>
                  <span className={`text-[12px] font-medium tabular-nums ${amount > 0 ? "text-vermilion-ink" : "text-ink-3"}`}>{amount > 0 ? `+${usd(amount)}` : "OK"}</span>
                </button>
              </li>
            );
          })}
        </ol>
        {firstBad > 0 && (
          <p className="display mt-6 text-[24px] leading-snug">
            The promise held for {firstBad} {firstBad === 1 ? "month" : "months"}, then broke in {monthOf(checked[firstBad].result, true)}. Open any month to see its evidence.
          </p>
        )}
      </div>

      {message && <YearMessage text={message} />}

      <div className="mt-12">
        <Trace thoughts={[]} calls={summarize(result.calls)} spentMicros={result.spentMicros} notes={[`${result.months.length} bills read in parallel, ${checked.length} checked against the offer.`]} />
      </div>
    </section>
  );
}

function YearMessage({ text }: { text: Message }) {
  const [format, setFormat] = useState<"chat" | "email" | "call">("email");
  const [copied, setCopied] = useState(false);
  return (
    <section className="paper mt-16 px-6 py-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="display text-[30px] leading-none">The message for the whole year</h2>
        <div className="flex items-center gap-2">
          <div role="tablist" aria-label="Message format" className="inline-flex rounded-full p-0.5 shadow-[inset_0_0_0_1px_var(--rule)]">
            {(["chat", "email", "call"] as const).map((value) => (
              <button key={value} role="tab" type="button" aria-selected={format === value} onClick={() => setFormat(value)} className={`rounded-full px-3 py-1 text-[13px] ${format === value ? "bg-ink text-paper" : "text-ink-2 hover:text-ink"}`}>
                {value === "call" ? "Call script" : value[0].toUpperCase() + value.slice(1)}
              </button>
            ))}
          </div>
          <button
            type="button"
            onClick={() => {
              void navigator.clipboard.writeText(text[format]).then(() => {
                setCopied(true);
                setTimeout(() => setCopied(false), 1600);
              });
            }}
            className="h-8 min-w-[76px] rounded-full bg-vermilion px-4 text-[13px] font-semibold text-white"
          >
            {copied ? "Copied" : "Copy"}
          </button>
        </div>
      </div>
      <textarea readOnly value={text[format]} aria-label="Message to send" className="mt-5 h-[300px] w-full resize-none bg-transparent text-[15px] leading-[1.65] focus:outline-none" />
    </section>
  );
}
