"use client";

import { useState, type Dispatch } from "react";
import type { CheckAction, CheckState } from "@/lib/check-machine";
import { formatMicros } from "@/lib/cost";
import type { Claim, Question, UnusedReason } from "@/lib/decide";
import { buildMessage, shortDate, usd } from "@/lib/letter";
import type { CheckResult } from "@/lib/result";
import type { LineItem, PromiseTerm } from "@/lib/schemas";

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

function Quote({ source, text }: { source: string; text: string }) {
  return (
    <p className="text-[13px] leading-5 text-ink-2">
      <span className="text-ink-3">{source} </span>
      <q className="text-ink">{text}</q>
    </p>
  );
}

function BillPages({ result, pages, focus }: { result: Checked; pages: { image: string }[]; focus: ReadonlySet<string> }) {
  const claimNumber = new Map<string, number>();
  result.claims.forEach((claim, i) => claim.lineIds.forEach((id) => claimNumber.set(id, i + 1)));
  const asked = new Set(result.questions.filter((q) => SHOWN_QUESTIONS.has(q.kind)).flatMap((q) => q.lineIds));
  return (
    <div className="space-y-4">
      {pages.map((page, index) => (
        <div key={index} className="relative overflow-hidden rounded-[10px] bg-white shadow-[0_1px_3px_rgb(0_0_0/0.12)]">
          <img src={page.image} alt={`Bill page ${index + 1}`} className="block w-full" />
          {result.reading.line_items
            .filter((line) => line.page === index + 1 && line.box && (claimNumber.has(line.id) || asked.has(line.id)))
            .map((line) => {
              const box = line.box!;
              const isClaim = claimNumber.has(line.id);
              return (
                <div
                  key={line.id}
                  aria-hidden
                  className={`absolute rounded-[3px] transition-opacity ${isClaim ? "mark" : "ask-mark"} ${focus.size > 0 && !focus.has(line.id) ? "opacity-30" : ""}`}
                  style={{
                    left: `${Math.max(0, box.x0 - 6) / 10}%`,
                    top: `${Math.max(0, box.y0 - 4) / 10}%`,
                    width: `${(Math.min(1000, box.x1 + 6) - Math.max(0, box.x0 - 6)) / 10}%`,
                    height: `${(Math.min(1000, box.y1 + 4) - Math.max(0, box.y0 - 4)) / 10}%`,
                  }}
                />
              );
            })}
        </div>
      ))}
    </div>
  );
}

function Checkbox({ checked, onChange, label }: { checked: boolean; onChange: () => void; label: string }) {
  return <input type="checkbox" checked={checked} onChange={onChange} aria-label={label} className="mt-1 size-[18px] shrink-0 accent-[var(--accent)]" />;
}

function MessageBox({ result, done }: { result: Checked; done: Done }) {
  const [format, setFormat] = useState<"chat" | "email" | "call">("chat");
  const [copied, setCopied] = useState(false);
  const selected = new Set(Object.entries(done.selection.claims).filter(([, mark]) => mark === "selected").map(([id]) => id));
  const included = new Set(Object.entries(done.selection.questions).filter(([, on]) => on).map(([id]) => id));
  const message = buildMessage(result, selected, included);
  if (selected.size === 0 && included.size === 0) return null;
  const text = message[format];
  const formats = [
    ["chat", "Chat"],
    ["email", "Email"],
    ["call", "Call"],
  ] as const;
  return (
    <div className="rounded-[14px] bg-surface p-4 shadow-[0_0_0_1px_var(--hairline)]">
      <div className="flex items-center justify-between gap-3">
        <div role="tablist" aria-label="Message format" className="inline-flex rounded-[9px] bg-fill p-0.5">
          {formats.map(([value, label]) => (
            <button
              key={value}
              role="tab"
              type="button"
              aria-selected={format === value}
              onClick={() => setFormat(value)}
              className={`rounded-[7px] px-3 py-1 text-[13px] ${format === value ? "bg-surface font-medium shadow-[0_1px_2px_rgb(0_0_0/0.1)]" : "text-ink-2"}`}
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
          className="rounded-[9px] bg-accent px-3.5 py-1.5 text-[13px] font-medium text-accent-ink"
        >
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
      <textarea readOnly value={text} aria-label="Message to send" className="mt-3 h-[260px] w-full resize-none bg-transparent text-[14px] leading-6 focus:outline-none" />
    </div>
  );
}

export function ResultView({ state, dispatch }: { state: Done; dispatch: Dispatch<CheckAction> }) {
  const [focus, setFocus] = useState<ReadonlySet<string>>(new Set());
  const { result } = state;
  const pages = state.inputs.bill?.status === "ready" ? state.inputs.bill.pages : [];
  const changeFiles = (
    <button type="button" onClick={() => dispatch({ type: "edit" })} className="rounded-[10px] bg-fill px-4 py-2 text-[15px] hover:bg-hairline">
      Check another bill
    </button>
  );

  if (result.outcome !== "checked") {
    return (
      <section className="mx-auto w-full max-w-[880px] space-y-4 px-6 py-10">
        <p className="text-[22px] font-medium">{result.outcome === "not_a_bill" ? "This doesn't look like a bill" : result.reason}</p>
        <p className="text-[13px] text-ink-2 tabular-nums">Checked for {formatMicros(result.spentMicros)}</p>
        {changeFiles}
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
    <section className="mx-auto grid w-full max-w-[1180px] gap-8 px-6 py-10 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
      <div className="lg:sticky lg:top-8 lg:self-start">
        <BillPages result={result} pages={pages} focus={focus} />
      </div>

      <div className="space-y-8">
        <header>
          {heading ? (
            <h1 className="text-[28px] font-semibold tracking-[-0.01em]">{heading}</h1>
          ) : (
            <>
              <p className="text-[40px] font-semibold tracking-[-0.02em] tabular-nums">{usd(selectedTotal)}</p>
              <h1 className="text-[17px] text-ink-2">to ask back{provider ? ` from ${provider}` : ""}</h1>
            </>
          )}
        </header>

        {result.claims.length > 0 && (
          <ul className="space-y-3">
            {result.claims.map((claim, i) => {
              const claimLines = linesOf(claim.lineIds);
              const promise = promises.get(claim.promiseId);
              const mark = state.selection.claims[claim.id];
              return (
                <li
                  key={claim.id}
                  onMouseEnter={() => setFocus(new Set(claim.lineIds))}
                  onMouseLeave={() => setFocus(new Set())}
                  className="flex gap-3 rounded-[14px] bg-surface p-4 shadow-[0_0_0_1px_var(--hairline)]"
                >
                  {mark !== "needs_confirmation" && <Checkbox checked={mark === "selected"} onChange={() => dispatch({ type: "toggle_claim", id: claim.id })} label={`Include claim ${i + 1}`} />}
                  <div className="min-w-0 flex-1 space-y-2">
                    <div className="flex items-baseline justify-between gap-3">
                      <p className="text-[15px] font-medium">{claimTitle(claim, claimLines)}</p>
                      <p className="text-[15px] font-medium tabular-nums">{usd(claim.amountCents)}</p>
                    </div>
                    {claimLines.map((line) => (
                      <Quote key={line.id} source="Bill" text={line.quote} />
                    ))}
                    {promise && <Quote source="Offer" text={promise.quote} />}
                    {mark === "needs_confirmation" && (
                      <button type="button" onClick={() => dispatch({ type: "confirm_claim", id: claim.id })} className="rounded-[9px] bg-fill px-3 py-1.5 text-[13px] hover:bg-hairline">
                        The highlighted line matches my bill
                      </button>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        )}

        {questions.length > 0 && (
          <div>
            <h2 className="text-[15px] font-medium">Worth asking about</h2>
            <ul className="mt-3 space-y-2">
              {questions.map((question) => {
                const questionLines = linesOf(question.lineIds);
                const canInclude = question.kind === "unagreed_fee" || question.kind === "repeated_charge";
                return (
                  <li
                    key={question.id}
                    onMouseEnter={() => setFocus(new Set(question.lineIds))}
                    onMouseLeave={() => setFocus(new Set())}
                    className="flex gap-3 rounded-[12px] px-1 py-1.5"
                  >
                    {canInclude && <Checkbox checked={state.selection.questions[question.id] === true} onChange={() => dispatch({ type: "toggle_question", id: question.id })} label="Include in message" />}
                    <div className="min-w-0 flex-1">
                      <div className="flex items-baseline justify-between gap-3">
                        <p className="text-[15px]">{questionTitle(question, questionLines, result)}</p>
                        {questionLines[0] && <p className="text-[15px] text-ink-2 tabular-nums">{usd(questionLines.reduce((t, l) => t + l.amount_cents, 0))}</p>}
                      </div>
                    </div>
                  </li>
                );
              })}
            </ul>
          </div>
        )}

        {result.explained.length > 0 && (
          <div>
            <h2 className="text-[15px] font-medium">Explained by your offer</h2>
            <ul className="mt-3 space-y-2">
              {result.explained.map((item) => {
                const promise = promises.get(item.promiseId);
                return (
                  <li key={item.id} className="space-y-1 px-1">
                    <p className="text-[15px]">
                      {listNames(linesOf(item.lineIds))}: the offer ended {shortDate(item.endedOn)}, before this bill
                    </p>
                    {promise && <Quote source="Offer" text={promise.quote} />}
                  </li>
                );
              })}
            </ul>
          </div>
        )}

        <MessageBox result={result} done={state} />

        <div className="space-y-1 text-[13px] text-ink-2">
          {printed && totals.lineSum === "ok" && <p className="tabular-nums">The charges add up to the {usd(printed.cents)} printed on the bill.</p>}
          {printed && totals.lineSum === "mismatch" && (
            <p className="tabular-nums text-ink">
              The charges add up to {usd(totals.lineSumCents)}, but the bill prints {usd(printed.cents)}.
            </p>
          )}
          {totals.balance === "mismatch" && <p className="text-ink">The previous balance, payments and new charges don&apos;t add up to the amount due.</p>}
          {result.hadOffer && (
            <p>
              Compared {result.reading.line_items.length} charges with {result.matchedPromiseIds.length} {result.matchedPromiseIds.length === 1 ? "promise" : "promises"} from your offer.
            </p>
          )}
          {result.unused.flatMap((item) => {
            const why = UNUSED_TEXT[item.reason];
            return why ? [<p key={item.promiseId}>{`Not used: ${promises.get(item.promiseId)?.description ?? "a promise"} (${why}).`}</p>] : [];
          })}
          <details className="group">
            <summary className="cursor-pointer list-none tabular-nums hover:text-ink">Checked for {formatMicros(result.spentMicros)} with Muse Ember</summary>
            <table className="mt-2 w-full text-left tabular-nums">
              <thead className="text-ink-3">
                <tr>
                  <th className="py-1 font-normal">Step</th>
                  <th className="py-1 font-normal">Effort</th>
                  <th className="py-1 text-right font-normal">Tokens in</th>
                  <th className="py-1 text-right font-normal">Tokens out</th>
                  <th className="py-1 text-right font-normal">Cost</th>
                </tr>
              </thead>
              <tbody>
                {result.calls.map((call, i) => (
                  <tr key={i} className="border-t border-hairline">
                    <td className="py-1">{CALL_NAMES[call.name] ?? call.name}</td>
                    <td className="py-1">{call.effort}</td>
                    <td className="py-1 text-right">{call.reused ? "reused" : call.inputTokens.toLocaleString("en-US")}</td>
                    <td className="py-1 text-right">{call.reused ? "" : call.outputTokens.toLocaleString("en-US")}</td>
                    <td className="py-1 text-right">{formatMicros(call.costMicros)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </details>
        </div>

        {changeFiles}
      </div>
    </section>
  );
}
