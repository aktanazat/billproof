"use client";

import { useState } from "react";
import type { CheckAction, Selection, Thought } from "@/lib/check-machine";
import { formatMicros } from "@/lib/cost";
import type { Claim, Question, UnusedReason } from "@/lib/decide";
import { buildMessage, shortDate, usd, type Message } from "@/lib/letter";
import type { CallRecord, Checked, PreparedPage, SingleResult, TestedClaim } from "@/lib/result";
import type { LineItem, PromiseTerm, TranscriptTurn } from "@/lib/schemas";
import { BillPage, type Mark } from "./bill-page";
import { formatClock, HeardQuote, LineStrip, useClip } from "./evidence";

// A provider mismatch is said once, in the heading.
const SHOWN_QUESTIONS = new Set<Question["kind"]>(["unagreed_fee", "repeated_charge", "partial_period", "conditions_unproven", "price_gap", "end_date_unread"]);
const CALL_NAMES: Record<string, string> = { read_bill: "Read bill", reread_bill: "Reread bill", read_terms: "Read offer", read_call: "Listen to call", challenge: "Argue the company's side" };
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

export function listNames(lines: LineItem[]): string {
  const labels = [...new Set(lines.map((line) => line.label))];
  return labels.length <= 1 ? (labels[0] ?? "A charge") : `${labels.slice(0, -1).join(", ")} and ${labels.at(-1)}`;
}

const charged = (lines: LineItem[]) => lines.filter((line) => line.amount_cents > 0);

export function claimTitle(claim: Claim, lines: LineItem[]): string {
  switch (claim.kind) {
    case "price_above_promise":
      return `${listNames(charged(lines))} is billed above the promised price`;
    case "included_charged":
      return `${listNames(charged(lines))} was supposed to be included`;
    case "credit_missing":
      return claim.actualCents === 0 ? "The promised credit is missing" : "The promised credit is short";
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
      return `Your offer for ${listNames(charged(lines))} has an end date that couldn't be read; check whether it has ended`;
    case "overlapping_claim":
      return "";
  }
}

function Stamp({ children, tone }: { children: string; tone: "ink" | "vermilion" }) {
  return (
    <span className={`stamp inline-block rounded-[3px] px-2 py-0.5 text-[11px] font-semibold tracking-[0.06em] ${tone === "ink" ? "text-ink shadow-[inset_0_0_0_1.5px_var(--ink)]" : "text-vermilion-ink shadow-[inset_0_0_0_1.5px_var(--vermilion)]"}`}>
      {children}
    </span>
  );
}

function billMarks(result: Checked): (Mark & { page: number })[] {
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
  return marks;
}

// The offer as its own paper: a written offer with its promises underlined, or the call as a script.
function OfferPaper({ result, offerText, callUrl, focusPromise }: { result: Checked; offerText: string | null; callUrl: string | null; focusPromise: string | null }) {
  const { play, playing } = useClip(callUrl);
  if (result.transcript) {
    const promiseTurns = new Set(result.promises.flatMap((p) => (p.said_at_seconds === null ? [] : [p.said_at_seconds])));
    return (
      <div className="paper px-6 py-6">
        <p className="text-[12px] text-ink-3">The call, as Muse Ember heard it</p>
        <ol className="mt-4 flex flex-col gap-3">
          {result.transcript.map((turn, i) => {
            const next = result.transcript?.[i + 1]?.start_seconds ?? null;
            const promised = [...promiseTurns].some((s) => s >= turn.start_seconds && (next === null || s < next));
            return (
              <li key={i} className="grid grid-cols-[3.25rem_1fr] gap-3">
                <button type="button" onClick={() => play(turn.start_seconds, next)} className={`h-6 text-left text-[12px] tabular-nums ${playing === turn.start_seconds ? "text-vermilion-ink" : "text-ink-3 hover:text-ink"}`}>
                  ▸ {formatClock(turn.start_seconds)}
                </button>
                <p className={`text-[15px] leading-[1.5] ${turn.speaker === "company" ? "text-ink" : "text-ink-2"} ${promised ? "underline decoration-vermilion decoration-2 underline-offset-[5px]" : ""}`}>
                  <span className="mr-2 text-[12px] text-ink-3">{turn.speaker === "company" ? (result.offerProvider ?? "Company") : turn.speaker === "customer" ? "You" : "Other"}</span>
                  {turn.text}
                </p>
              </li>
            );
          })}
        </ol>
      </div>
    );
  }
  if (offerText) {
    const quotes = result.promises.filter((p) => offerText.includes(p.quote.trim()));
    let parts: { text: string; promiseId: string | null }[] = [{ text: offerText, promiseId: null }];
    for (const p of quotes) {
      parts = parts.flatMap((part) => {
        if (part.promiseId) return [part];
        const at = part.text.indexOf(p.quote.trim());
        if (at < 0) return [part];
        return [
          { text: part.text.slice(0, at), promiseId: null },
          { text: p.quote.trim(), promiseId: p.id },
          { text: part.text.slice(at + p.quote.trim().length), promiseId: null },
        ];
      });
    }
    return (
      <div className="paper px-6 py-6">
        <p className="text-[12px] text-ink-3">What you were promised</p>
        <p className="mt-4 whitespace-pre-wrap text-[14px] leading-[1.6] text-ink-2">
          {parts.map((part, i) =>
            part.promiseId ? (
              <mark key={i} className={`bg-transparent text-ink underline decoration-2 underline-offset-[5px] transition-colors ${focusPromise === part.promiseId ? "decoration-vermilion bg-[var(--vermilion-wash)]" : "decoration-vermilion/60"}`}>
                {part.text}
              </mark>
            ) : (
              <span key={i}>{part.text}</span>
            ),
          )}
        </p>
      </div>
    );
  }
  return null;
}

function turnEnd(transcript: TranscriptTurn[] | null, at: number): number | null {
  const next = transcript?.find((turn) => turn.start_seconds > at + 0.5);
  return next?.start_seconds ?? null;
}

function Exhibit({ claim, index, result, page, callUrl, mark, onToggle, onConfirm, onFocus }: { claim: TestedClaim; index: number; result: Checked; page: PreparedPage | null; callUrl: string | null; mark: string | undefined; onToggle: () => void; onConfirm: () => void; onFocus: (ids: string[] | null) => void }) {
  const lines = claim.lineIds.flatMap((id) => result.reading.line_items.find((line) => line.id === id) ?? []);
  const promise = result.promises.find((p) => p.id === claim.promiseId);
  const strips = charged(lines).filter((line) => line.box && line.page === 1);
  const provider = result.reading.provider ?? "the company";
  return (
    <article tabIndex={0} onMouseEnter={() => onFocus([...claim.lineIds, `promise:${claim.promiseId}`])} onMouseLeave={() => onFocus(null)} onFocus={() => onFocus([...claim.lineIds, `promise:${claim.promiseId}`])} onBlur={() => onFocus(null)} className="border-t border-rule pt-6 outline-none">
      <header className="flex items-start gap-4">
        <span className="mt-1.5 grid size-6 shrink-0 place-items-center rounded-full bg-vermilion text-[12px] font-semibold text-white">{index + 1}</span>
        <h3 className="display flex-1 text-[28px] leading-[1.1]">{claimTitle(claim, lines)}</h3>
      </header>

      <div className="mt-5 grid items-center gap-4 md:grid-cols-[minmax(0,1fr)_7.5rem_minmax(0,1fr)]">
        <div className="slide-from-left flex flex-col gap-2">
          <p className="text-[12px] text-ink-3">On the bill</p>
          {page && strips.length > 0 ? strips.map((line) => <LineStrip key={line.id} image={page.image} box={line.box!} tone="claim" />) : lines.map((line) => <p key={line.id} className="paper px-4 py-3 text-[14px]">{line.quote}</p>)}
        </div>
        <div className="stamp text-center">
          <p className="display text-[40px] leading-none text-vermilion-ink tabular-nums">+{usd(claim.amountCents)}</p>
          <p className="mt-1 text-[11px] text-ink-3 tabular-nums">
            {usd(claim.actualCents)} vs {usd(claim.expectedCents)}
          </p>
        </div>
        <div className="slide-from-right flex flex-col gap-2">
          <p className="text-[12px] text-ink-3">{result.transcript ? "Said on the call" : "In the offer"}</p>
          {promise && promise.said_at_seconds !== null && result.transcript ? (
            <HeardQuote url={callUrl} from={promise.said_at_seconds} to={turnEnd(result.transcript, promise.said_at_seconds)} text={promise.quote} who={result.offerProvider ?? "The company"} />
          ) : (
            <p className="paper display px-4 py-3.5 text-[19px] leading-[1.3]">“{promise?.quote}”</p>
          )}
        </div>
      </div>

      <footer className="mt-5 flex flex-wrap items-center justify-between gap-3 pl-10">
        <p className="max-w-[46rem] text-[13px] leading-5 text-ink-2">
          {claim.lookedFor ? (
            <>
              Arguing {provider}&apos;s side, Muse Ember {claim.lookedFor.replace(/^I /, "").replace(/\.$/, "")}. It found nothing. <Stamp tone="ink">STANDS</Stamp>
            </>
          ) : null}
        </p>
        {mark === "needs_confirmation" ? (
          <button type="button" onClick={onConfirm} className="h-9 rounded-full bg-ink px-4 text-[13px] font-medium text-paper">
            {result.transcript ? "I heard it, use this" : "The highlighted line matches my bill"}
          </button>
        ) : (
          <label className="inline-flex cursor-pointer items-center gap-2 text-[13px] text-ink-2 select-none">
            <input type="checkbox" checked={mark === "selected"} onChange={onToggle} className="size-4 accent-[var(--vermilion)]" />
            Include in message
          </label>
        )}
      </footer>
    </article>
  );
}

function MessageBox({ message }: { message: Message | null }) {
  const [format, setFormat] = useState<"chat" | "email" | "call">("chat");
  const [copied, setCopied] = useState(false);
  if (!message) return null;
  const text = message[format];
  const formats = [
    ["chat", "Chat"],
    ["email", "Email"],
    ["call", "Call script"],
  ] as const;
  return (
    <section className="paper px-6 py-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="display text-[30px] leading-none">The message</h2>
        <div className="flex items-center gap-2">
          <div role="tablist" aria-label="Message format" className="inline-flex rounded-full p-0.5 shadow-[inset_0_0_0_1px_var(--rule)]">
            {formats.map(([value, label]) => (
              <button key={value} role="tab" type="button" aria-selected={format === value} onClick={() => setFormat(value)} className={`rounded-full px-3 py-1 text-[13px] transition-colors ${format === value ? "bg-ink text-paper" : "text-ink-2 hover:text-ink"}`}>
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
            className="h-8 min-w-[76px] rounded-full bg-vermilion px-4 text-[13px] font-semibold text-white active:scale-[0.98]"
          >
            {copied ? "Copied" : "Copy"}
          </button>
        </div>
      </div>
      <textarea readOnly value={text} aria-label="Message to send" className="mt-5 h-[300px] w-full resize-none bg-transparent text-[15px] leading-[1.65] focus:outline-none" />
    </section>
  );
}

export function Trace({ thoughts, calls, spentMicros, notes }: { thoughts: Thought[]; calls: CallRecord[]; spentMicros: number; notes: string[] }) {
  return (
    <details className="group border-t border-rule pt-5">
      <summary className="flex cursor-pointer list-none items-baseline justify-between">
        <span className="display text-[26px]">How Muse Ember checked it</span>
        <span className="text-[13px] text-ink-2 tabular-nums">{formatMicros(spentMicros)}</span>
      </summary>
      <div className="mt-4 flex flex-col gap-4 text-[14px] leading-6 text-ink-2">
        {thoughts.map((thought, i) => (
          <p key={i} className="display whitespace-pre-line text-[19px] leading-[1.35] text-ink">
            {thought.text}
          </p>
        ))}
        <ul className="flex flex-col gap-1 text-[13px]">
          {notes.map((note, i) => (
            <li key={i}>{note}</li>
          ))}
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
            {calls.map((call, i) => (
              <tr key={i} className="border-t border-rule">
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
  );
}

export function ResultView({
  result,
  bill,
  pages,
  offerText,
  callUrl,
  selection,
  thoughts,
  dispatch,
  backLabel,
  onBack,
}: {
  result: SingleResult;
  bill: number;
  pages: PreparedPage[];
  offerText: string | null;
  callUrl: string | null;
  selection: Selection;
  thoughts: Thought[];
  dispatch: (action: CheckAction) => void;
  backLabel: string;
  onBack: () => void;
}) {
  const [focus, setFocus] = useState<string[] | null>(null);
  const back = (
    <button type="button" onClick={onBack} className="h-10 shrink-0 rounded-full px-5 text-[14px] shadow-[inset_0_0_0_1px_var(--rule)] hover:bg-fill">
      {backLabel}
    </button>
  );

  if (result.outcome !== "checked") {
    return (
      <section className="mx-auto flex w-full max-w-[1240px] flex-col items-start gap-5 px-6 pt-10">
        <h1 className="display text-[64px] leading-none">{result.outcome === "not_a_bill" ? "This isn't a bill." : "Couldn't check this bill."}</h1>
        {result.outcome === "could_not_check" && <p className="text-[17px] text-ink-2">{result.reason}</p>}
        <p className="text-[13px] text-ink-2 tabular-nums">Checked for {formatMicros(result.spentMicros)}</p>
        {back}
      </section>
    );
  }

  const linesOf = (ids: string[]) => ids.flatMap((id) => result.reading.line_items.find((line) => line.id === id) ?? []);
  const promises = new Map<string, PromiseTerm>(result.promises.map((promise) => [promise.id, promise]));
  const questions = result.questions.filter((q) => SHOWN_QUESTIONS.has(q.kind));
  // A claim waiting for the person to confirm what they heard still counts toward what can be asked back.
  const askTotal = result.claims.reduce((total, claim) => total + (selection.claims[claim.id] === "unselected" ? 0 : claim.amountCents), 0);
  const waiting = result.claims.some((claim) => selection.claims[claim.id] === "needs_confirmation");
  const provider = result.reading.provider;
  const printed = result.reading.printed.current_charges;
  const marks = billMarks(result);
  const focusLines = new Set(focus?.filter((id) => !id.startsWith("promise:")) ?? []);
  const focusPromise = focus?.find((id) => id.startsWith("promise:"))?.slice(8) ?? null;

  const selectedIds = new Set(Object.entries(selection.claims).filter(([, mark]) => mark === "selected").map(([id]) => id));
  const includedIds = new Set(Object.entries(selection.questions).filter(([, on]) => on).map(([id]) => id));
  const message = selectedIds.size + includedIds.size > 0 ? buildMessage(result, selectedIds, includedIds) : null;

  const verdict =
    result.claims.length > 0
      ? null
      : !result.hadOffer
        ? questions.length > 0
          ? "Charges worth asking about."
          : "Nothing to flag on this bill."
        : result.providerMismatch
          ? `The offer is from ${result.offerProvider}, not ${provider ?? "this company"}.`
          : result.matchedPromiseIds.length === 0
            ? "Couldn't match your offer to this bill."
            : "Nothing is billed above your offer.";

  const notes = [
    ...(printed && result.totals.lineSum === "ok" ? [`The charges add up to the ${usd(printed.cents)} printed on the bill.`] : []),
    ...(printed && result.totals.lineSum === "mismatch" ? [`The charges add up to ${usd(result.totals.lineSumCents)}, but the bill prints ${usd(printed.cents)}.`] : []),
    ...(result.totals.balance === "mismatch" ? ["The previous balance, payments and new charges don't add up to the amount due."] : []),
    ...(result.hadOffer ? [`Compared ${result.reading.line_items.length} charges with ${result.matchedPromiseIds.length} ${result.matchedPromiseIds.length === 1 ? "promise" : "promises"}.`] : []),
    ...result.unused.flatMap((item) => {
      const why = UNUSED_TEXT[item.reason];
      return why ? [`Not used: ${promises.get(item.promiseId)?.description ?? "a promise"} (${why}).`] : [];
    }),
  ];

  return (
    <section className="mx-auto w-full max-w-[1240px] px-6 pb-24 pt-10">
      <header className="flex flex-wrap items-end justify-between gap-6 border-b border-rule pb-6">
        {verdict ? (
          <h1 className="display max-w-[18ch] text-[52px] leading-[1] sm:text-[72px]">{verdict}</h1>
        ) : (
          <div>
            <p className="display text-[96px] leading-[0.85] tracking-[-0.03em] tabular-nums sm:text-[136px]">{usd(askTotal)}</p>
            <h1 className="mt-3 text-[17px] text-ink-2">
              to ask back{provider ? ` from ${provider}` : ""}{waiting ? (result.transcript ? ", once you confirm what you heard on the call" : ", once you confirm the marked lines") : ""}. Every dollar below has a source on both sides.
            </h1>
          </div>
        )}
        {back}
      </header>

      <div className="mt-10 grid gap-8 lg:grid-cols-2">
        <div>
          <p className="mb-3 text-[12px] text-ink-3">The bill</p>
          <div className="space-y-5">
            {pages.map((page, index) => (
              <BillPage key={index} image={page.image} alt={`Bill page ${index + 1}`} marks={marks.filter((m) => m.page === index + 1)} focus={focusLines} />
            ))}
          </div>
        </div>
        <div className="flex flex-col">
          <p className="mb-3 text-[12px] text-ink-3">The promise</p>
          <OfferPaper result={result} offerText={offerText} callUrl={callUrl} focusPromise={focusPromise} />
        </div>
      </div>

      {result.claims.length > 0 && (
        <section className="mt-16">
          <h2 className="display text-[44px] leading-none">The evidence</h2>
          <div className="mt-6 flex flex-col gap-10">
            {result.claims.map((claim, i) => (
              <Exhibit
                key={claim.id}
                claim={claim}
                index={i}
                result={result}
                page={pages[0] ?? null}
                callUrl={callUrl}
                mark={selection.claims[claim.id]}
                onToggle={() => dispatch({ type: "toggle_claim", bill, id: claim.id })}
                onConfirm={() => dispatch({ type: "confirm_claim", bill, id: claim.id })}
                onFocus={setFocus}
              />
            ))}
          </div>
        </section>
      )}

      {result.dropped.length > 0 && (
        <section className="mt-14">
          <h2 className="display text-[32px] leading-none">Dropped under cross-examination</h2>
          <ul className="mt-5 flex flex-col gap-4">
            {result.dropped.map((item) => (
              <li key={item.claim.id} className="border-t border-rule pt-4">
                <div className="flex items-baseline justify-between gap-4">
                  <p className="text-[15px]">
                    {claimTitle(item.claim, linesOf(item.claim.lineIds))} <span className="text-ink-3 line-through tabular-nums">{usd(item.claim.amountCents)}</span>
                  </p>
                  <Stamp tone="vermilion">DROPPED</Stamp>
                </div>
                <p className="mt-2 text-[13px] text-ink-2">
                  {item.source === "bill" ? "The bill says" : "The offer says"}: <span className="text-ink">“{item.counterQuote}”</span>
                </p>
              </li>
            ))}
          </ul>
        </section>
      )}

      {(questions.length > 0 || result.explained.length > 0) && (
        <div className="mt-14 grid gap-10 lg:grid-cols-2">
          {questions.length > 0 && (
            <section>
              <h2 className="display text-[32px] leading-none">Worth asking about</h2>
              <ul className="mt-5">
                {questions.map((question) => {
                  const questionLines = linesOf(question.lineIds);
                  const canInclude = question.kind === "unagreed_fee" || question.kind === "repeated_charge";
                  return (
                    <li key={question.id} tabIndex={0} onMouseEnter={() => setFocus(question.lineIds)} onMouseLeave={() => setFocus(null)} onFocus={() => setFocus(question.lineIds)} onBlur={() => setFocus(null)} className="flex flex-col gap-2 border-t border-rule py-4 outline-none">
                      <div className="flex items-baseline justify-between gap-4">
                        <p className="text-[15px] leading-snug">{questionTitle(question, questionLines, result)}</p>
                        {questionLines[0] && <p className="text-[15px] text-ink-2 tabular-nums">{usd(questionLines.reduce((t, l) => t + l.amount_cents, 0))}</p>}
                      </div>
                      {canInclude && (
                        <label className="inline-flex cursor-pointer items-center gap-2 text-[13px] text-ink-2 select-none">
                          <input type="checkbox" checked={selection.questions[question.id] === true} onChange={() => dispatch({ type: "toggle_question", bill, id: question.id })} className="size-4 accent-[var(--vermilion)]" />
                          Ask in the message
                        </label>
                      )}
                    </li>
                  );
                })}
              </ul>
            </section>
          )}
          {result.explained.length > 0 && (
            <section>
              <h2 className="display text-[32px] leading-none">Explained by your offer</h2>
              <ul className="mt-5">
                {result.explained.map((item) => {
                  const promise = promises.get(item.promiseId);
                  return (
                    <li key={item.id} className="flex flex-col gap-2 border-t border-rule py-4">
                      <p className="text-[15px] leading-snug">
                        {listNames(charged(linesOf(item.lineIds)))}: the promise ended {shortDate(item.endedOn)}, before this bill.
                      </p>
                      {promise && <p className="display text-[18px] leading-snug text-ink-2">“{promise.quote}”</p>}
                    </li>
                  );
                })}
              </ul>
            </section>
          )}
        </div>
      )}

      <div className="mt-16 flex flex-col gap-10">
        <MessageBox message={message} />
        <Trace thoughts={thoughts} calls={result.calls} spentMicros={result.spentMicros} notes={notes} />
      </div>
    </section>
  );
}
