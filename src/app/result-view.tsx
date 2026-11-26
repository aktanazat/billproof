"use client";

import { useRef, useState, type ReactNode } from "react";
import type { CheckAction, Selection } from "@/lib/check-machine";
import { formatMicros } from "@/lib/cost";
import type { Claim, Question, TestedClaim, UnusedReason } from "@/lib/decide";
import { buildMessage, increaseSentence, shortDate, usd, type Message } from "@/lib/letter";
import { MAX_OFFER_PAGES, type ShownPage } from "@/lib/prepare";
import type { CallRecord, Checked, SingleResult } from "@/lib/result";
import type { LineItem, PromiseTerm, TranscriptTurn } from "@/lib/schemas";
import { BillPage, snapBox, type Mark } from "./bill-page";
import { formatClock, PlayButton } from "./evidence";

// A provider mismatch is said once, in the heading.
export const SHOWN_QUESTIONS = new Set<Question["kind"]>(["unagreed_fee", "repeated_charge", "partial_period", "conditions_unproven", "price_gap", "end_date_unread"]);
const CALL_NAMES: Record<string, string> = { sort_pages: "Sort pictures", read_bill: "Read bill", reread_bill: "Reread bill", read_terms: "Read offer", read_call: "Listen to call", challenge: "Argue the company's side" };
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
  item_not_named: "the charge linked to it isn't the item it names",
  amount_approximate: "its amount is only approximate",
  device_or_cart_total: "it's a device payment or order total, not a plan price",
};

function listNames(lines: LineItem[]): string {
  const labels = [...new Set(lines.map((line) => line.label))];
  return labels.length <= 1 ? (labels[0] ?? "A charge") : `${labels.slice(0, -1).join(", ")} and ${labels.at(-1)}`;
}

const charged = (lines: LineItem[]) => lines.filter((line) => line.amount_cents > 0);

// A title's verb agrees with the names it lists: one charge "is", several "are".
const several = (lines: LineItem[]) => new Set(lines.map((line) => line.label)).size > 1;

function claimTitle(claim: Claim, lines: LineItem[]): string {
  switch (claim.kind) {
    case "price_above_promise":
      return `${listNames(charged(lines))} ${several(charged(lines)) ? "are" : "is"} billed above the promised price`;
    case "included_charged":
      return `${listNames(charged(lines))} ${several(charged(lines)) ? "were" : "was"} supposed to be included`;
    case "credit_missing":
      return claim.actualCents === 0 ? "The promised credit is missing" : "The promised credit is short";
  }
}

const CONDITION_NAMES: Record<string, string> = { autopay: "autopay", paperless: "paperless billing", bundle: "a bundle", contract: "a contract" };

function questionTitle(question: Question, lines: LineItem[], result: Checked): string {
  const promise = result.promises.find((p) => p.id === question.promiseId);
  switch (question.kind) {
    case "unagreed_fee": {
      // Only this company's own offer can show a fee is missing from it; otherwise the fee is just one it added.
      const said = result.hadOffer && !result.providerMismatch ? "isn't in your offer" : "is a fee the company added";
      return `${listNames(lines)} ${said}${lines.length > 1 ? `, charged ${lines.length} times` : ""}`;
    }
    case "repeated_charge":
      return `${listNames(lines)} is charged ${lines.length} times`;
    case "partial_period":
      return "Your offer starts or ends during this bill";
    case "conditions_unproven": {
      const named = (promise?.conditions ?? []).filter((c) => c !== "other").map((c) => CONDITION_NAMES[c]);
      return named.length > 0 ? `The bill doesn't show ${named.join(" or ")}, which your price depends on` : "The bill doesn't show that you meet your offer's conditions";
    }
    case "price_gap":
      return `${listNames(lines)} ${several(lines) ? "are" : "is"} too far from the promised amount to claim`;
    case "provider_mismatch":
      return `The offer is from ${result.offerProvider ?? "another company"}, not ${result.reading.provider ?? "this company"}`;
    case "end_date_unread":
      return `The end date of your offer for ${listNames(charged(lines).length > 0 ? charged(lines) : lines)} couldn't be read`;
    case "overlapping_claim":
      return "";
  }
}

function billMarks(result: Checked, pages: ShownPage[]): (Mark & { page: number })[] {
  const boxOf = (line: LineItem) => snapBox(line.box, line.label, pages[line.page - 1]?.rows ?? null);
  const asked = new Set(result.questions.filter((q) => SHOWN_QUESTIONS.has(q.kind)).flatMap((q) => q.lineIds));
  const lines = new Map(result.reading.line_items.map((line) => [line.id, line]));
  const marks: (Mark & { page: number })[] = [];
  result.claims.forEach((claim, i) => {
    // The number sits on the claim's charged line; its discounts are marked without one.
    const numbered = claim.lineIds.find((id) => (lines.get(id)?.amount_cents ?? 0) > 0) ?? claim.lineIds[0];
    for (const id of claim.lineIds) {
      const line = lines.get(id);
      const box = line && boxOf(line);
      if (line && box) marks.push({ id, box, tone: "claim", n: id === numbered ? i + 1 : undefined, page: line.page });
    }
  });
  for (const id of asked) {
    const line = lines.get(id);
    const box = line && boxOf(line);
    if (line && box && !marks.some((m) => m.id === id)) marks.push({ id, box, tone: "ask", page: line.page });
  }
  return marks;
}

function turnEnd(transcript: TranscriptTurn[] | null, at: number): number | null {
  return transcript?.find((turn) => turn.start_seconds > at + 0.5)?.start_seconds ?? null;
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="flex flex-col">
      <h2 className="border-b border-line pb-2 text-[13px] font-semibold text-text-2">{title}</h2>
      {children}
    </section>
  );
}

// Bill against promise, as two lines with their amounts: what was charged, what was promised, and the source of each.
function ClaimRow({ claim, index, result, callUrl, mark, onToggle, onConfirm, onFocus }: { claim: TestedClaim; index: number; result: Checked; callUrl: string | null; mark: string | undefined; onToggle: () => void; onConfirm: () => void; onFocus: (ids: string[] | null) => void }) {
  const lines = claim.lineIds.flatMap((id) => result.reading.line_items.find((line) => line.id === id) ?? []);
  const promise = result.promises.find((p) => p.id === claim.promiseId);
  const heardAt = result.transcript && promise?.said_at_seconds !== null && promise?.said_at_seconds !== undefined ? promise.said_at_seconds : null;
  const focusIds = [...claim.lineIds];
  return (
    <li tabIndex={0} onMouseEnter={() => onFocus(focusIds)} onMouseLeave={() => onFocus(null)} onFocus={() => onFocus(focusIds)} onBlur={() => onFocus(null)} className="flex flex-col gap-3 border-b border-line py-4 outline-none focus-visible:bg-fill">
      <div className="flex items-start gap-3">
        <span className="mt-0.5 grid size-[18px] shrink-0 place-items-center rounded-full bg-red text-[11px] font-semibold text-white tabular-nums">{index + 1}</span>
        <h3 className="flex-1 text-[15px] font-semibold leading-snug">{claimTitle(claim, lines)}</h3>
        <p className="text-[15px] font-semibold text-red tabular-nums">{usd(claim.amountCents)}</p>
      </div>

      <dl className="grid grid-cols-[4.5rem_minmax(0,1fr)] gap-x-3 gap-y-1.5 text-[13px] leading-[18px] sm:ml-[30px] sm:grid-cols-[4.5rem_4.5rem_minmax(0,1fr)] sm:gap-y-2">
        <dt className="text-text-2">{claim.kind === "credit_missing" ? "Credited" : "Billed"}</dt>
        <dd className="tabular-nums sm:text-right">{usd(claim.actualCents)}</dd>
        <dd className="col-span-2 mb-1.5 flex flex-col gap-0.5 text-text-2 sm:col-span-1 sm:mb-0">
          {lines.map((line) => (
            <span key={line.id} className="flex justify-between gap-3">
              <span>{line.label}</span>
              <span className="tabular-nums">{usd(line.amount_cents)}</span>
            </span>
          ))}
        </dd>
        <dt className="text-text-2">Promised</dt>
        <dd className="tabular-nums sm:text-right">{usd(claim.expectedCents)}</dd>
        <dd className="col-span-2 flex items-start gap-2 text-text-2 sm:col-span-1">
          {heardAt !== null && <PlayButton url={callUrl} from={heardAt} to={turnEnd(result.transcript, heardAt)} label={`Play what was said at ${formatClock(heardAt)}`} />}
          <span className={heardAt !== null ? "pt-[5px]" : ""}>“{promise?.quote}”</span>
        </dd>
      </dl>

      <div className="flex flex-wrap items-center justify-between gap-3 sm:ml-[30px]">
        <p className="max-w-[34rem] text-[13px] leading-[18px] text-text-2">{claim.lookedFor ? "Checked against the company's side before claiming." : ""}</p>
        {mark === "needs_confirmation" ? (
          <button type="button" onClick={onConfirm} className="h-8 rounded-lg bg-text px-3 text-[13px] font-medium text-white hover:bg-black">
            {result.transcript ? "I heard it, use this" : "The marked line matches my bill"}
          </button>
        ) : (
          <label className="inline-flex cursor-pointer items-center gap-2 text-[13px] text-text-2 select-none">
            <input type="checkbox" checked={mark === "selected"} onChange={onToggle} className="size-4 accent-[var(--text)]" />
            In message
          </label>
        )}
      </div>
    </li>
  );
}

function Transcript({ transcript, provider, callUrl }: { transcript: TranscriptTurn[]; provider: string | null; callUrl: string | null }) {
  return (
    <details className="group border-b border-line">
      <summary className="flex h-11 cursor-pointer list-none items-center justify-between text-[15px]">
        <span>Call transcript</span>
        <span className="text-[13px] text-text-2 tabular-nums">{transcript.length === 1 ? "1 line" : `${transcript.length} lines`}</span>
      </summary>
      <ol className="flex flex-col gap-2 pb-4">
        {transcript.map((turn, i) => (
          <li key={i} className="grid grid-cols-[4.5rem_minmax(0,1fr)] items-start gap-3 text-[13px] leading-[18px]">
            <PlayButton url={callUrl} from={turn.start_seconds} to={transcript[i + 1]?.start_seconds ?? null} label={`Play from ${formatClock(turn.start_seconds)}`} />
            <p className="pt-[5px]">
              <span className="text-text-2">{turn.speaker === "company" ? (provider ?? "Company") : turn.speaker === "customer" ? "You" : "Other"}: </span>
              {turn.text}
            </p>
          </li>
        ))}
      </ol>
    </details>
  );
}

export function MessageBox({ message }: { message: Message }) {
  const [format, setFormat] = useState<"chat" | "email" | "call" | "complaint">("chat");
  const [copied, setCopied] = useState<"no" | "yes" | "failed">("no");
  const box = useRef<HTMLTextAreaElement>(null);
  const text = message[format];
  const formats = [
    ["chat", "Chat"],
    ["email", "Email"],
    ["call", "Call script"],
    ["complaint", "FCC complaint"],
  ] as const;
  return (
    <section className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-[17px] font-semibold">Message</h2>
        <div className="flex flex-wrap items-center gap-2">
          <div role="tablist" aria-label="Message format" className="inline-flex rounded-lg bg-fill p-0.5">
            {formats.map(([value, label]) => (
              <button key={value} role="tab" type="button" aria-selected={format === value} onClick={() => { setFormat(value); setCopied("no"); }} className={`h-7 whitespace-nowrap rounded-md px-2.5 text-[13px] sm:px-3 ${format === value ? "bg-white font-medium shadow-[0_1px_2px_rgb(0_0_0/0.12)]" : "text-text-2 hover:text-text"}`}>
                {label}
              </button>
            ))}
          </div>
          <button
            type="button"
            onClick={() => {
              navigator.clipboard.writeText(text).then(
                () => {
                  setCopied("yes");
                  setTimeout(() => setCopied("no"), 1600);
                },
                // A browser that blocks the clipboard (an embedded page, a denied permission) gets the text selected to copy by hand.
                () => {
                  box.current?.select();
                  setCopied("failed");
                },
              );
            }}
            className="h-8 min-w-[72px] rounded-lg bg-text px-3 text-[13px] font-medium text-white hover:bg-black"
          >
            {copied === "yes" ? "Copied" : copied === "failed" ? "Selected, copy it yourself" : "Copy"}
          </button>
        </div>
      </div>
      <textarea ref={box} readOnly value={text} aria-label="Message to send" className="h-[280px] w-full resize-none rounded-xl bg-fill p-4 text-[15px] leading-[22px] focus:outline-none focus-visible:shadow-[inset_0_0_0_2px_var(--text)]" />
    </section>
  );
}

export function Trace({ calls, spentMicros, notes }: { calls: CallRecord[]; spentMicros: number; notes: string[] }) {
  return (
    <details className="border-t border-line">
      <summary className="flex h-11 cursor-pointer list-none items-center justify-between text-[15px]">
        <span>How it was checked</span>
        <span className="text-[13px] text-text-2 tabular-nums">{formatMicros(spentMicros)}</span>
      </summary>
      <div className="flex flex-col gap-3 pb-4 text-[13px] leading-[18px] text-text-2">
        {notes.map((note, i) => (
          <p key={i}>{note}</p>
        ))}
        <table className="w-full text-left tabular-nums">
          <thead>
            <tr>
              <th className="py-1.5 font-normal">Muse Ember step</th>
              <th className="py-1.5 font-normal">Effort</th>
              <th className="py-1.5 text-right font-normal">Tokens in</th>
              <th className="py-1.5 text-right font-normal">Tokens out</th>
              <th className="py-1.5 text-right font-normal">Cost</th>
            </tr>
          </thead>
          <tbody>
            {calls.map((call, i) => (
              <tr key={i} className="border-t border-line">
                <td className="py-1.5 text-text">{CALL_NAMES[call.name] ?? call.name}</td>
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
  omittedPages,
  callUrl,
  selection,
  dispatch,
  backLabel,
  onBack,
}: {
  result: SingleResult;
  bill: number;
  pages: ShownPage[];
  // Pages of a long PDF past the limit that weren't read, of the bill and of the offer.
  omittedPages: { bill: number; offer: number };
  callUrl: string | null;
  selection: Selection;
  dispatch: (action: CheckAction) => void;
  backLabel: string;
  onBack: () => void;
}) {
  const [focus, setFocus] = useState<string[] | null>(null);
  const back = (
    <button type="button" onClick={onBack} className="h-9 shrink-0 rounded-lg bg-fill px-4 text-[15px] hover:bg-fill-2">
      {backLabel}
    </button>
  );

  if (result.outcome !== "checked") {
    return (
      <section className="mx-auto flex w-full max-w-[1120px] flex-col items-start gap-3 px-6 pt-10">
        <h1 className="text-[28px] font-semibold tracking-[-0.02em]">{result.outcome === "not_a_bill" ? "This isn't a bill" : "Couldn't check this bill"}</h1>
        {result.outcome === "could_not_check" && <p className="text-[17px] text-text-2">{result.reason}</p>}
        <p className="max-w-[40rem] text-[15px]">
          {result.outcome === "not_a_bill"
            ? "Add the statement itself: the PDF, or screenshots of the page that shows the billing period and each charge."
            : omittedPages.bill > 0
              ? `Only the first ${pages.length} of ${pages.length + omittedPages.bill} pages were read. Add the pages with the charges as their own PDF, or as screenshots.`
              : "Try the PDF from the company's website, or screenshots that show every charge and the total, uncropped."}
        </p>
        <p className="text-[13px] text-text-2 tabular-nums">Checked for {formatMicros(result.spentMicros)}</p>
        {back}
      </section>
    );
  }

  const linesOf = (ids: string[]) => ids.flatMap((id) => result.reading.line_items.find((line) => line.id === id) ?? []);
  const promises = new Map<string, PromiseTerm>(result.promises.map((promise) => [promise.id, promise]));
  const questions = result.questions.filter((q) => SHOWN_QUESTIONS.has(q.kind));
  // A claim waiting for the person to confirm still counts toward what can be asked back.
  const askTotal = result.claims.reduce((total, claim) => total + (selection.claims[claim.id] === "unselected" ? 0 : claim.amountCents), 0);
  const unconfirmed = result.claims.filter((claim) => selection.claims[claim.id] === "needs_confirmation");
  const waiting = unconfirmed.length > 0;
  const markedLines = new Set(unconfirmed.flatMap((claim) => claim.lineIds)).size;
  const provider = result.reading.provider;
  const printed = result.reading.printed.current_charges;
  // Pictures sorted out as chats or offers aren't bill pages; line items count pages within the bill.
  const billPages = result.billPages.flatMap((i) => pages[i] ?? []);
  const marks = billMarks(result, billPages);
  const focusLines = new Set(focus ?? []);

  const selectedIds = new Set(Object.entries(selection.claims).filter(([, mark]) => mark === "selected").map(([id]) => id));
  const includedIds = new Set(Object.entries(selection.questions).filter(([, on]) => on).map(([id]) => id));
  const message = selectedIds.size + includedIds.size > 0 || increaseSentence(result.change) ? buildMessage(result, selectedIds, includedIds) : null;
  const read = result.reading.line_items.length;
  const chargesThat = read === 1 ? "1 charge that" : `${read} charges that`;
  const addUp = read === 1 ? "adds up" : "add up";

  const verdict =
    result.claims.length > 0
      ? null
      : result.providerMismatch
        ? `The offer is from ${result.offerProvider}, not ${provider ?? "this company"}`
        : questions.length > 0
          ? `${questions.length} ${questions.length === 1 ? "charge" : "charges"} worth asking about`
          : !result.hadOffer
            ? "Nothing to flag on this bill"
            : result.promises.length === 0
              ? "No price or promise found to check the bill against"
              : result.matchedPromiseIds.length === 0
                ? "Couldn't match your offer to this bill"
                : "Nothing is billed above your offer";

  const notes = [
    // Pictures in a pile that weren't the bill were read as the offer, as an earlier bill, or set aside; say so rather than drop them silently.
    ...(pages.length > billPages.length && billPages.length > 0 ? [`Read ${billPages.length} of the ${pages.length} pictures as this bill; the other ${pages.length - billPages.length === 1 ? "one was" : `${pages.length - billPages.length} were`} read as the offer or an earlier bill, or set aside.`] : []),
    ...(omittedPages.bill > 0 ? [`Read the first ${pages.length} of ${pages.length + omittedPages.bill} pages of this PDF; charges on the rest aren't included.`] : []),
    ...(omittedPages.offer > 0 ? [`Read the first ${MAX_OFFER_PAGES} of ${MAX_OFFER_PAGES + omittedPages.offer} pages of the offer; promises on the rest aren't included.`] : []),
    ...(printed && result.totals.lineSum === "mismatch" ? [`The charges add up to ${usd(result.totals.lineSumCents)}, but the bill prints ${usd(printed.cents)}.`] : []),
    ...(result.totals.balance === "mismatch" ? ["The previous balance, payments and new charges don't add up to the amount due."] : []),
    ...(result.hadOffer ? [`Compared ${read} ${read === 1 ? "charge" : "charges"} with ${result.matchedPromiseIds.length} ${result.matchedPromiseIds.length === 1 ? "promise" : "promises"}.`] : []),
    ...result.unused.flatMap((item) => {
      const why = UNUSED_TEXT[item.reason];
      // The reading writes some descriptions as sentences; the reason follows in brackets, so their own period goes.
      const description = promises.get(item.promiseId)?.description.replace(/[.\s]+$/, "") || "a promise";
      return why ? [`Not used: ${description} (${why}).`] : [];
    }),
  ];

  return (
    <section className="mx-auto w-full max-w-[1120px] px-6 pb-24 pt-6">
      <header className="flex flex-wrap items-end justify-between gap-4 pb-6">
        <div>
          {verdict ? (
            <h1 className="text-[28px] font-semibold tracking-[-0.02em]">{verdict}</h1>
          ) : (
            <>
              <p className="text-[40px] font-semibold leading-none tracking-[-0.02em] tabular-nums">{usd(askTotal)}</p>
              <h1 className="mt-2 text-[17px] text-text-2">
                to ask back{provider ? ` from ${provider}` : ""}
                {waiting ? (result.transcript ? ", once you confirm what you heard" : `, once you confirm the marked ${markedLines === 1 ? "line" : "lines"}`) : ""}
              </h1>
            </>
          )}
          {printed && result.totals.lineSum === "ok" && (
            <p className="mt-2 text-[13px] text-text-2">
              Read {chargesThat} {addUp} to the {usd(printed.cents)} printed on the bill.
            </p>
          )}
          {printed && result.totals.lineSum === "subtotal" && result.totals.subtotalLines !== null && (
            <p className="mt-2 text-[13px] text-text-2">
              The first {result.totals.subtotalLines} of {result.reading.line_items.length} charges {result.totals.subtotalLines === 1 ? "adds" : "add"} up to the {usd(printed.cents)} subtotal printed on the bill.
            </p>
          )}
          {result.totals.lineSum === "due" && result.reading.printed.total_due && (
            <p className="mt-2 text-[13px] text-text-2">
              Read {chargesThat}{result.totals.carriedCents !== 0 ? `, with the ${usd(result.totals.carriedCents)} carried over,` : ""} {addUp} to the {usd(result.reading.printed.total_due.cents)} due on the bill.
            </p>
          )}
          {result.totals.lineSum === "sections" && (
            <p className="mt-2 text-[13px] text-text-2">
              Read {chargesThat} {addUp} to the subtotals printed on the bill.
            </p>
          )}
        </div>
        {back}
      </header>

      <div className="grid gap-10 lg:grid-cols-[minmax(0,5fr)_minmax(0,6fr)]">
        <div className="flex flex-col gap-4 lg:sticky lg:top-6 lg:self-start">
          {billPages.map((page, index) => (
            <BillPage key={index} image={page.image} alt={`Bill page ${index + 1}`} marks={marks.filter((m) => m.page === index + 1)} focus={focusLines} />
          ))}
        </div>

        <div className="flex flex-col gap-10">
          {result.claims.length > 0 && (
            <Section title={result.claims.every((claim) => claim.kind === "credit_missing") ? "Missing from the bill" : result.claims.some((claim) => claim.kind === "credit_missing") ? "Not billed as promised" : "Charged above the promise"}>
              <ol>
                {result.claims.map((claim, i) => (
                  <ClaimRow
                    key={claim.id}
                    claim={claim}
                    index={i}
                    result={result}
                    callUrl={callUrl}
                    mark={selection.claims[claim.id]}
                    onToggle={() => dispatch({ type: "toggle_claim", bill, id: claim.id })}
                    onConfirm={() => dispatch({ type: "confirm_claim", bill, id: claim.id })}
                    onFocus={setFocus}
                  />
                ))}
              </ol>
              {result.transcript && <Transcript transcript={result.transcript} provider={result.offerProvider ?? provider} callUrl={callUrl} />}
            </Section>
          )}

          {result.dropped.length > 0 && (
            <Section title="Dropped after checking the company's side">
              <ul>
                {result.dropped.map((item) => (
                  <li key={item.claim.id} className="flex flex-col gap-1 border-b border-line py-3">
                    <div className="flex items-baseline justify-between gap-4 text-[15px]">
                      <p>{claimTitle(item.claim, linesOf(item.claim.lineIds))}</p>
                      <p className="text-text-2 line-through tabular-nums">{usd(item.claim.amountCents)}</p>
                    </div>
                    <p className="text-[13px] leading-[18px] text-text-2">
                      {item.source === "bill" ? "The bill says" : "The offer says"} “{item.counterQuote}”
                    </p>
                  </li>
                ))}
              </ul>
            </Section>
          )}

          {questions.length > 0 && (
            <Section title="Worth asking about">
              <ul>
                {questions.map((question) => {
                  const questionLines = linesOf(question.lineIds);
                  const canInclude = question.kind === "unagreed_fee" || question.kind === "repeated_charge";
                  return (
                    <li key={question.id} tabIndex={0} onMouseEnter={() => setFocus(question.lineIds)} onMouseLeave={() => setFocus(null)} onFocus={() => setFocus(question.lineIds)} onBlur={() => setFocus(null)} className="flex flex-col gap-2 border-b border-line py-3 outline-none focus-visible:bg-fill">
                      <div className="flex items-baseline justify-between gap-4 text-[15px]">
                        <p>{questionTitle(question, questionLines, result)}</p>
                        {questionLines[0] && (
                          <p className="text-text-2 tabular-nums">
                            {/* A repeat puts one copy at stake, not their sum. */}
                            {question.kind === "repeated_charge" && questionLines.every((l) => l.amount_cents === questionLines[0].amount_cents)
                              ? `${usd(questionLines[0].amount_cents)} each`
                              : usd(questionLines.reduce((t, l) => t + l.amount_cents, 0))}
                          </p>
                        )}
                      </div>
                      {canInclude && (
                        <label className="inline-flex cursor-pointer items-center gap-2 text-[13px] text-text-2 select-none">
                          <input type="checkbox" checked={selection.questions[question.id] === true} onChange={() => dispatch({ type: "toggle_question", bill, id: question.id })} className="size-4 accent-[var(--text)]" />
                          Ask in message
                        </label>
                      )}
                    </li>
                  );
                })}
              </ul>
            </Section>
          )}

          {result.change && result.change.lines.length > 0 && (
            <Section title={`${result.change.currentCents >= result.change.earlierCents ? "Up" : "Down"} ${usd(Math.abs(result.change.currentCents - result.change.earlierCents))} since the earlier bill`}>
              <ul>
                {result.change.lines.map((line) => (
                  <li key={line.label} className="flex items-baseline justify-between gap-4 border-b border-line py-3 text-[15px]">
                    <p>{line.label}</p>
                    <p className="shrink-0 tabular-nums text-text-2">
                      {line.beforeCents === null ? "new" : usd(line.beforeCents)} → <span className="text-text">{line.afterCents === null ? "gone" : usd(line.afterCents)}</span>
                    </p>
                  </li>
                ))}
              </ul>
            </Section>
          )}

          {result.explained.length > 0 && (
            <Section title="Explained by your offer">
              <ul>
                {result.explained.map((item) => {
                  const promise = promises.get(item.promiseId);
                  return (
                    <li key={item.id} className="flex flex-col gap-1 border-b border-line py-3">
                      <p className="text-[15px]">
                        {listNames(charged(linesOf(item.lineIds)))}: the promise ended {shortDate(item.endedOn)}, before this bill
                      </p>
                      {promise && <p className="text-[13px] leading-[18px] text-text-2">“{promise.quote}”</p>}
                    </li>
                  );
                })}
              </ul>
              {result.transcript && <Transcript transcript={result.transcript} provider={result.offerProvider ?? provider} callUrl={callUrl} />}
            </Section>
          )}

          {message && <MessageBox message={message} />}
          <Trace calls={result.calls} spentMicros={result.spentMicros} notes={notes} />
        </div>
      </div>
    </section>
  );
}
