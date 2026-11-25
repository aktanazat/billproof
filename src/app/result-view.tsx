"use client";

import { useState, type Dispatch } from "react";
import type { CheckAction, CheckState } from "@/lib/check-machine";
import { formatMicros } from "@/lib/cost";
import type { Claim, Question, UnusedReason } from "@/lib/decide";
import { buildMessage, shortDate, usd } from "@/lib/letter";
import type { CheckResult } from "@/lib/result";
import type { LineItem, PromiseTerm } from "@/lib/schemas";
import { BillPage, type Mark } from "./bill-page";

type Done = Extract<CheckState, { s: "done" }>;
type Checked = Extract<CheckResult, { outcome: "checked" }>;

// A provider mismatch is said once, in the heading.
const SHOWN_QUESTIONS = new Set<Question["kind"]>(["unagreed_fee", "repeated_charge", "partial_period", "conditions_unproven", "price_gap", "end_date_unread"]);
const CALL_NAMES: Record<string, string> = { read_bill: "Read bill", reread_bill: "Reread bill", read_terms: "Read offer" };
// Promises that simply have nothing on this bill are not worth a line.
const UNUSED_TEXT: Record<UnusedReason, string | null> = {
  kind_not_checked: "this kind of promise isn't checked yet",
  quote_not_in_offer: "its wording isn't in the offer",
  amount_not_in_quote: "its amount isn't in the quoted text",
  no_matching_charge: null,
  line_not_on_bill: "a matching line couldn't be found on the bill as quoted",
  starts_later: null,
  no_price: "it names no price for a plan on this bill",
  no_credit_amount: "it names no credit amount",
};

function listNames(lines: LineItem[]): string {
  const labels = [...new Set(lines.map((line) => line.label))];
  return labels.length <= 1 ? (labels[0] ?? "A charge") : `${labels.slice(0, -1).join(", ")} and ${labels.at(-1)}`;
}

function claimTitle(claim: Claim, lines: LineItem[]): string {
  switch (claim.kind) {
    case "price_above_promise":
      return `${listNames(lines.filter((line) => line.amount_cents > 0))} is billed above your promised price`;
    case "included_charged":
      return `${listNames(lines.filter((line) => line.amount_cents > 0))} was supposed to be included`;
    case "credit_missing":
      return claim.actualCents === 0 ? "Your promised credit is missing" : "Your promised credit is short";
  }
}

const CONDITION_NAMES: Record<string, string> = { autopay: "autopay", paperless: "paperless billing", bundle: "a bundle", contract: "a contract", other: "a condition" };

function questionTitle(question: Question, lines: LineItem[], result: Checked): string {
  const promise = result.promises.find((p) => p.id === question.promiseId);
  switch (question.kind) {
    case "unagreed_fee":
      return `${listNames(lines)} isn't in your offer`;
    case "repeated_charge":
      return `${listNames(lines)} is charged ${lines.length} times`;
    case "partial_period":
      return "Your offer starts or ends during this bill";
    case "conditions_unproven":
      return `The bill doesn't show ${(promise?.conditions ?? ["other"]).map((c) => CONDITION_NAMES[c]).join(" or ")}, which your price depends on`;
    case "price_gap":
      return `${listNames(lines)} is too far from the promised amount to claim; check the offer`;
    case "provider_mismatch":
      return `The offer is from ${result.offerProvider ?? "another company"}, not ${result.reading.provider ?? "this company"}`;
    case "end_date_unread":
      return `Your offer for ${listNames(lines.filter((line) => line.amount_cents > 0))} has an end date that couldn't be read; check whether it has ended`;
    case "overlapping_claim":
      return "";
  }
}

function BillPages({ result, pages, focus }: { result: Checked; pages: { image: string }[]; focus: ReadonlySet<string> }) {
  const asked = new Set(result.questions.filter((q) => SHOWN_QUESTIONS.has(q.kind)).flatMap((q) => q.lineIds));
  const lines = new Map(result.reading.line_items.map((line) => [line.id, line]));
  const marks: (Mark & { page: number })[] = [];
  result.claims.forEach((claim, i) => {
    // The number tab sits on the claim's charged line; its discounts are marked without a tab.
    const tabbed = claim.lineIds.find((id) => (lines.get(id)?.amount_cents ?? 0) > 0) ?? claim.lineIds[0];
    for (const id of claim.lineIds) {
      const line = lines.get(id);
      if (line?.box) marks.push({ id, box: line.box, tone: "claim", n: id === tabbed ? i + 1 : undefined, page: line.page });
    }
  });
  for (const id of asked) {
    const line = lines.get(id);
    if (line?.box && !marks.some((m) => m.id === id)) marks.push({ id, box: line.box, tone: "ask", page: line.page });
  }
  return (
    <div className="space-y-5">
      {pages.map((page, index) => (
        <BillPage key={index} image={page.image} alt={`Bill page ${index + 1}`} marks={marks.filter((m) => m.page === index + 1)} focus={focus} />
      ))}
    </div>
  );
}

function Toggle({ checked, onChange, label }: { checked: boolean; onChange: () => void; label: string }) {
  return (
    <label className="inline-flex cursor-pointer items-center gap-2 text-[13px] text-ink-2 select-none">
      <input type="checkbox" checked={checked} onChange={onChange} className="size-4 accent-[var(--accent)]" />
      {label}
    </label>
  );
}

function Evidence({ rows }: { rows: { source: string; text: string }[] }) {
  return (
    <dl className="grid grid-cols-[3.25rem_1fr] gap-x-3 gap-y-1.5 rounded-[12px] bg-fill px-3.5 py-3 text-[13px] leading-5">
      {rows.map((row, i) => (
        <div key={i} className="contents">
          <dt className="text-ink-3">{row.source}</dt>
          <dd className="text-ink">{row.text}</dd>
        </div>
      ))}
    </dl>
  );
}

function MessageBox({ result, done }: { result: Checked; done: Done }) {
  const [format, setFormat] = useState<"chat" | "email" | "call">("chat");
  const [copied, setCopied] = useState(false);
  const selected = new Set(Object.entries(done.selection.claims).filter(([, mark]) => mark === "selected").map(([id]) => id));
  const included = new Set(Object.entries(done.selection.questions).filter(([, on]) => on).map(([id]) => id));
  if (selected.size === 0 && included.size === 0) return null;
  const text = buildMessage(result, selected, included)[format];
  const formats = [
    ["chat", "Chat"],
    ["email", "Email"],
    ["call", "Call"],
  ] as const;
  return (
    <div className="rounded-[20px] bg-surface p-5 shadow-[0_0_0_1px_var(--hairline)]">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-[17px] font-semibold tracking-[-0.01em]">Message to send</h2>
        <div className="flex items-center gap-2">
          <div role="tablist" aria-label="Message format" className="inline-flex rounded-[10px] bg-fill p-0.5">
            {formats.map(([value, label]) => (
              <button
                key={value}
                role="tab"
                type="button"
                aria-selected={format === value}
                onClick={() => setFormat(value)}
                className={`rounded-[8px] px-3 py-1 text-[13px] transition-colors ${format === value ? "bg-surface font-medium shadow-[0_1px_2px_rgb(0_0_0/0.12)]" : "text-ink-2 hover:text-ink"}`}
              >
                {label}
              </button>
            ))}
          </div>
          <button
            type="button"
            onClick={() => {
              void navigator.clipboard.writeText(text).then(() => {
                setCopied(true);
                setTimeout(() => setCopied(false), 1600);
              });
            }}
            className="h-8 min-w-[72px] rounded-[10px] bg-accent px-3.5 text-[13px] font-semibold text-accent-ink active:scale-[0.98]"
          >
            {copied ? "Copied" : "Copy"}
          </button>
        </div>
      </div>
      <textarea readOnly value={text} aria-label="Message to send" className="mt-4 h-[300px] w-full resize-none bg-transparent text-[15px] leading-[1.6] focus:outline-none" />
    </div>
  );
}

export function ResultView({ state, dispatch }: { state: Done; dispatch: Dispatch<CheckAction> }) {
  const [focus, setFocus] = useState<ReadonlySet<string>>(new Set());
  const { result } = state;
  const pages = state.inputs.bill?.status === "ready" ? state.inputs.bill.pages : [];
  const again = (
    <button type="button" onClick={() => dispatch({ type: "edit" })} className="h-9 shrink-0 rounded-[10px] bg-fill px-3.5 text-[14px] hover:bg-hairline">
      Check another bill
    </button>
  );

  if (result.outcome !== "checked") {
    return (
      <section className="mx-auto flex w-full max-w-[720px] flex-col items-start gap-4 px-6 pt-16">
        <h1 className="text-[34px] font-semibold tracking-[-0.025em]">{result.outcome === "not_a_bill" ? "This doesn't look like a bill" : "Couldn't check this bill"}</h1>
        {result.outcome === "could_not_check" && <p className="text-[17px] text-ink-2">{result.reason}</p>}
        <p className="text-[13px] text-ink-2 tabular-nums">Checked for {formatMicros(result.spentMicros)}</p>
        {again}
      </section>
    );
  }

  const lines = new Map(result.reading.line_items.map((line) => [line.id, line]));
  const promises = new Map<string, PromiseTerm>(result.promises.map((promise) => [promise.id, promise]));
  const linesOf = (ids: string[]) => ids.flatMap((id) => lines.get(id) ?? []);
  const questions = result.questions.filter((q) => SHOWN_QUESTIONS.has(q.kind));
  const selectedTotal = result.claims.reduce((total, claim) => total + (state.selection.claims[claim.id] === "selected" ? claim.amountCents : 0), 0);
  const provider = result.reading.provider;
  const { totals } = result;
  const printed = result.reading.printed.current_charges;
  const focusOn = (ids: string[]) => ({ onMouseEnter: () => setFocus(new Set(ids)), onMouseLeave: () => setFocus(new Set()), onFocus: () => setFocus(new Set(ids)), onBlur: () => setFocus(new Set()) });

  const heading =
    result.claims.length > 0
      ? null
      : !result.hadOffer
        ? questions.length > 0
          ? "Charges worth asking about"
          : "Nothing to flag on this bill"
        : result.providerMismatch
          ? `The offer is from ${result.offerProvider}, not ${provider ?? "this company"}`
          : result.matchedPromiseIds.length === 0
            ? "Couldn't match your offer to this bill"
            : "Nothing is billed above your offer";

  return (
    <section className="mx-auto grid w-full max-w-[1180px] gap-10 px-6 pb-20 pt-6 lg:grid-cols-[minmax(0,0.95fr)_minmax(0,1fr)] lg:gap-14">
      <div className="lg:sticky lg:top-8 lg:self-start">
        <BillPages result={result} pages={pages} focus={focus} />
      </div>

      <div className="flex flex-col gap-10">
        <header className="flex items-start justify-between gap-6">
          {heading ? (
            <h1 className="text-[34px] font-semibold leading-[1.1] tracking-[-0.025em] text-balance">{heading}</h1>
          ) : (
            <div>
              <p className="text-[64px] font-semibold leading-none tracking-[-0.04em] tabular-nums">{usd(selectedTotal)}</p>
              <h1 className="mt-2 text-[17px] text-ink-2">to ask back{provider ? ` from ${provider}` : ""}</h1>
            </div>
          )}
          {again}
        </header>

        {result.claims.length > 0 && (
          <ol className="flex flex-col gap-4">
            {result.claims.map((claim, i) => {
              const claimLines = linesOf(claim.lineIds);
              const promise = promises.get(claim.promiseId);
              const mark = state.selection.claims[claim.id];
              return (
                <li key={claim.id} tabIndex={0} {...focusOn(claim.lineIds)} className="flex flex-col gap-3.5 rounded-[20px] bg-surface p-5 shadow-[0_0_0_1px_var(--hairline)] outline-none focus-visible:shadow-[0_0_0_2px_var(--accent)]">
                  <div className="flex items-start gap-3">
                    <span className="mt-0.5 grid size-6 shrink-0 place-items-center rounded-full bg-ink text-[12px] font-semibold text-ground">{i + 1}</span>
                    <p className="flex-1 text-[17px] font-medium leading-snug">{claimTitle(claim, claimLines)}</p>
                    <p className="text-[17px] font-semibold tabular-nums">{usd(claim.amountCents)}</p>
                  </div>
                  <Evidence rows={[...claimLines.map((line) => ({ source: "Bill", text: line.quote })), ...(promise ? [{ source: "Offer", text: promise.quote }] : [])]} />
                  <div className="pl-9">
                    {mark === "needs_confirmation" ? (
                      <button type="button" onClick={() => dispatch({ type: "confirm_claim", id: claim.id })} className="rounded-[10px] bg-fill px-3 py-1.5 text-[13px] hover:bg-hairline">
                        The highlighted line matches my bill
                      </button>
                    ) : (
                      <Toggle checked={mark === "selected"} onChange={() => dispatch({ type: "toggle_claim", id: claim.id })} label="Include in message" />
                    )}
                  </div>
                </li>
              );
            })}
          </ol>
        )}

        {questions.length > 0 && (
          <div>
            <h2 className="text-[17px] font-semibold tracking-[-0.01em]">Worth asking about</h2>
            <ul className="mt-3 divide-y divide-hairline rounded-[20px] bg-surface px-5 shadow-[0_0_0_1px_var(--hairline)]">
              {questions.map((question) => {
                const questionLines = linesOf(question.lineIds);
                const canInclude = question.kind === "unagreed_fee" || question.kind === "repeated_charge";
                return (
                  <li key={question.id} tabIndex={0} {...focusOn(question.lineIds)} className="flex flex-col gap-2 py-4 outline-none">
                    <div className="flex items-baseline justify-between gap-4">
                      <p className="text-[15px] leading-snug">{questionTitle(question, questionLines, result)}</p>
                      {questionLines[0] && <p className="text-[15px] text-ink-2 tabular-nums">{usd(questionLines.reduce((t, l) => t + l.amount_cents, 0))}</p>}
                    </div>
                    {canInclude && <Toggle checked={state.selection.questions[question.id] === true} onChange={() => dispatch({ type: "toggle_question", id: question.id })} label="Ask in message" />}
                  </li>
                );
              })}
            </ul>
          </div>
        )}

        {result.explained.length > 0 && (
          <div>
            <h2 className="text-[17px] font-semibold tracking-[-0.01em]">Explained by your offer</h2>
            <ul className="mt-3 flex flex-col gap-3">
              {result.explained.map((item) => {
                const promise = promises.get(item.promiseId);
                return (
                  <li key={item.id} className="flex flex-col gap-2.5 rounded-[20px] bg-surface p-5 shadow-[0_0_0_1px_var(--hairline)]">
                    <p className="text-[15px] leading-snug">
                      {listNames(linesOf(item.lineIds).filter((line) => line.amount_cents > 0))}: the offer ended {shortDate(item.endedOn)}, before this bill
                    </p>
                    {promise && <Evidence rows={[{ source: "Offer", text: promise.quote }]} />}
                  </li>
                );
              })}
            </ul>
          </div>
        )}

        <MessageBox result={result} done={state} />

        <details className="group rounded-[20px] bg-surface p-5 shadow-[0_0_0_1px_var(--hairline)]">
          <summary className="flex cursor-pointer list-none items-center justify-between text-[15px] font-medium">
            How Muse Ember checked it
            <span className="text-[13px] font-normal text-ink-2 tabular-nums">{formatMicros(result.spentMicros)}</span>
          </summary>
          <div className="mt-4 flex flex-col gap-4 text-[14px] leading-6 text-ink-2">
            {state.thoughts.map((thought, i) => (
              <p key={i} className="whitespace-pre-line">
                {thought.text}
              </p>
            ))}
            <ul className="flex flex-col gap-1 text-[13px]">
              {printed && totals.lineSum === "ok" && <li className="tabular-nums">The charges add up to the {usd(printed.cents)} printed on the bill.</li>}
              {printed && totals.lineSum === "mismatch" && (
                <li className="tabular-nums text-ink">
                  The charges add up to {usd(totals.lineSumCents)}, but the bill prints {usd(printed.cents)}.
                </li>
              )}
              {totals.balance === "mismatch" && <li className="text-ink">The previous balance, payments and new charges don&apos;t add up to the amount due.</li>}
              {result.hadOffer && (
                <li>
                  Compared {result.reading.line_items.length} charges with {result.matchedPromiseIds.length} {result.matchedPromiseIds.length === 1 ? "promise" : "promises"} from your offer.
                </li>
              )}
              {result.unused.flatMap((item) => {
                const why = UNUSED_TEXT[item.reason];
                return why ? [<li key={item.promiseId}>{`Not used: ${promises.get(item.promiseId)?.description ?? "a promise"} (${why}).`}</li>] : [];
              })}
            </ul>
            <table className="w-full text-left text-[13px] tabular-nums">
              <thead className="text-ink-3">
                <tr>
                  <th className="py-1.5 font-normal">Step</th>
                  <th className="py-1.5 font-normal">Effort</th>
                  <th className="py-1.5 text-right font-normal">Tokens in</th>
                  <th className="py-1.5 text-right font-normal">Tokens out</th>
                  <th className="py-1.5 text-right font-normal">Cost</th>
                </tr>
              </thead>
              <tbody>
                {result.calls.map((call, i) => (
                  <tr key={i} className="border-t border-hairline">
                    <td className="py-1.5 text-ink">{CALL_NAMES[call.name] ?? call.name}</td>
                    <td className="py-1.5">{call.effort}</td>
                    <td className="py-1.5 text-right">{call.reused ? "reused" : call.inputTokens.toLocaleString("en-US")}</td>
                    <td className="py-1.5 text-right">{call.reused ? "" : call.outputTokens.toLocaleString("en-US")}</td>
                    <td className="py-1.5 text-right">{formatMicros(call.costMicros)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </details>
      </div>
    </section>
  );
}
