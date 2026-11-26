"use client";

import Image from "next/image";
import Link from "next/link";
import { useEffect, useLayoutEffect, useReducer, useRef, useState, type ChangeEvent, type DragEvent, type ReactNode } from "react";
import { checkInput, initialState, offerOmitted, reduce, startBlocker, type Call, type CheckAction, type CheckState, type Doc, type Inputs } from "@/lib/check-machine";
import { formatMicros } from "@/lib/cost";
import { usd } from "@/lib/letter";
import { isPicture, isRecording, MAX_BILL_PAGES, MAX_OFFER_PAGES, prepareCall, prepareFile, PrepareError } from "@/lib/prepare";
import { MAX_BILLS, MAX_CALL_SECONDS, type CheckEvent, type CheckInput, type PageKind, type Stage } from "@/lib/result";
import { BillPage, snapBox, Thumbnail, type Mark } from "./bill-page";
import { formatClock, inPlainWords, Waveform } from "./evidence";
import { focusOnShow, ResultView } from "./result-view";
import { YearView } from "./year-view";

export type Sample = {
  id: string;
  title: string;
  outcome: string;
  image: string;
  bills: string[];
  // Pictures from one real post: loaded as a single pile that Muse Ember sorts into bill and promise.
  pictures?: string[];
  offer: { kind: "text"; text: string } | { kind: "call"; url: string };
};

const BILL_ACCEPT = "application/pdf,image/jpeg,image/png,image/webp,image/heic,image/heif,.heic,.heif";
const OFFER_ACCEPT = "application/pdf,image/jpeg,image/png,image/webp,image/heic,image/heif,.heic,.heif,audio/*,video/*,.m4a,.mp3,.wav,.3gp";
const isPdf = (file: File) => file.type === "application/pdf" || file.name.toLowerCase().endsWith(".pdf");
const LEAVE_QUESTION = "Leave this page? The files you added, and any check or result, will be lost.";

function isCheckEvent(value: unknown): value is CheckEvent {
  return typeof value === "object" && value !== null && "type" in value && typeof value.type === "string";
}

async function streamCheck(input: CheckInput, attempt: number, signal: AbortSignal, dispatch: (action: CheckAction) => void) {
  const fail = (message: string, spentMicros: number | null) => dispatch({ type: "errored", attempt, failure: "network", message, spentMicros, retryable: true });
  let response: Response;
  try {
    response = await fetch("/api/check", { method: "POST", body: JSON.stringify(input), headers: { "Content-Type": "application/json" }, signal });
  } catch {
    if (!signal.aborted) fail("The connection dropped before the check started.", 0);
    return;
  }
  // Every reply from the check is a stream of events; anything else came from the proxy in front of it (an upload over
  // its size limit, or the app restarting during a deploy), before any reading started, so nothing was spent.
  if (!response.headers.get("Content-Type")?.startsWith("application/x-ndjson")) {
    const tooLarge = response.status === 413;
    dispatch({ type: "errored", attempt, failure: tooLarge ? "bad_input" : "network", message: tooLarge ? "These files are too large. Try fewer pages or a smaller photo." : "Billproof couldn't be reached. Try again in a minute.", spentMicros: 0, retryable: !tooLarge });
    return;
  }
  if (!response.body) return fail("The server sent no response.", 0);
  const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = "";
  let terminal = false;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += value;
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.trim()) continue;
        const event: unknown = JSON.parse(line);
        if (!isCheckEvent(event)) continue;
        switch (event.type) {
          case "stage":
            dispatch({ type: "stage", attempt, stage: event.stage });
            break;
          case "reread":
            dispatch({ type: "reread", attempt, bill: event.bill });
            break;
          case "spent":
            dispatch({ type: "spent", attempt, micros: event.micros });
            break;
          case "thinking":
            dispatch({ type: "thought", attempt, stage: event.stage, text: event.text });
            break;
          case "line":
            dispatch({ type: "line_read", attempt, bill: event.bill, line: event.line });
            break;
          case "promise":
            dispatch({ type: "promise_read", attempt, promise: event.promise });
            break;
          case "heard":
            dispatch({ type: "turn_heard", attempt, turn: event.turn });
            break;
          case "challenge":
            dispatch({ type: "challenged", attempt, challenge: event.challenge });
            break;
          case "sorted":
            dispatch({ type: "pages_sorted", attempt, bill: event.bill, kinds: event.kinds });
            break;
          case "month":
            dispatch({ type: "month_done", attempt, bill: event.bill, result: event.result });
            break;
          case "result":
            terminal = true;
            dispatch({ type: "finished", attempt, result: event.result });
            break;
          case "error":
            terminal = true;
            dispatch({ type: "errored", attempt, failure: event.failure, message: event.message, spentMicros: event.spentMicros, retryable: event.retryable, bill: event.bill });
            break;
        }
      }
    }
  } catch {
    if (signal.aborted) return;
  }
  if (!terminal && !signal.aborted) fail("The connection dropped before the check finished.", null);
}

function FileTarget({ label, accept, multiple, onFiles, children, className }: { label: string; accept: string; multiple?: boolean; onFiles: (files: File[]) => void; children: ReactNode; className?: string }) {
  const input = useRef<HTMLInputElement>(null);
  const [over, setOver] = useState(false);
  const onDrop = (event: DragEvent) => {
    event.preventDefault();
    setOver(false);
    const files = [...event.dataTransfer.files];
    // Every dropped file goes on; a target that takes one says what happened to the rest.
    if (files.length) onFiles(files);
  };
  return (
    <div
      onDragOver={(event) => {
        event.preventDefault();
        setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={onDrop}
    >
      <input
        ref={input}
        type="file"
        accept={accept}
        multiple={multiple}
        aria-label={label}
        tabIndex={-1}
        className="sr-only"
        onChange={(event: ChangeEvent<HTMLInputElement>) => {
          const files = [...(event.target.files ?? [])];
          event.target.value = "";
          if (files.length) onFiles(files);
        }}
      />
      {/* A file held over the target styles it as hovering does; browsers apply no hover during a drag. */}
      <button type="button" onClick={() => input.current?.click()} data-over={over || undefined} className={className}>
        {children}
      </button>
    </div>
  );
}

// The spoken name starts with the word shown, so voice control finds it, then names the file, so a list of twelve
// statements doesn't read as twelve identical "Remove" buttons.
function RemoveButton({ name, onRemove }: { name: string; onRemove: () => void }) {
  return (
    <button type="button" onClick={onRemove} aria-label={`Remove ${name}`} className="h-8 rounded-lg px-2 text-[13px] text-text-2 hover:bg-fill-2 hover:text-text">
      Remove
    </button>
  );
}

function DocRow({ doc, onRemove }: { doc: Doc; onRemove: () => void }) {
  const pagesText = (doc: Extract<Doc, { status: "ready" }>) => (doc.omitted > 0 ? `First ${doc.pages.length} of ${doc.pages.length + doc.omitted} pages` : doc.pages.length === 1 ? "1 page" : `${doc.pages.length} pages`);
  const detail = doc.status === "preparing" ? "Opening" : doc.status === "failed" ? doc.message : pagesText(doc);
  return (
    <div className="flex items-center gap-3 py-1.5">
      <div className="h-10 w-8 shrink-0 overflow-hidden rounded-[4px] bg-white outline-1 -outline-offset-1 outline-line">{doc.status === "ready" && <Thumbnail src={doc.pages[0].image} />}</div>
      <div className="min-w-0 flex-1">
        <div className="truncate text-[15px]">{doc.name}</div>
        <div className={`text-[13px] ${doc.status === "failed" ? "text-red" : "text-text-2"}`} role={doc.status === "failed" ? "alert" : undefined}>
          {detail}
        </div>
      </div>
      <RemoveButton name={doc.name} onRemove={onRemove} />
    </div>
  );
}

function CallRow({ call, onRemove }: { call: Call; onRemove: () => void }) {
  return (
    <div className="flex items-center gap-3 py-1.5">
      <div className="min-w-0 flex-1">
        <div className="truncate text-[15px]">{call.name}</div>
        {call.status === "ready" ? (
          <div className="mt-1 flex items-center gap-3">
            <Waveform peaks={call.peaks} className="h-6 flex-1" />
            <span className="text-[13px] text-text-2 tabular-nums">{formatClock(call.seconds)}</span>
          </div>
        ) : (
          <div className={`text-[13px] ${call.status === "failed" ? "text-red" : "text-text-2"}`} role={call.status === "failed" ? "alert" : undefined}>
            {call.status === "failed" ? call.message : "Opening"}
          </div>
        )}
      </div>
      <RemoveButton name={call.name} onRemove={onRemove} />
    </div>
  );
}

function Spinner() {
  return <span aria-hidden className="inline-block size-4 animate-spin rounded-full border-2 border-fill-2 border-t-text" />;
}

function Check() {
  return (
    <svg aria-hidden width="16" height="16" viewBox="0 0 16 16" className="text-text">
      <path d="M3.5 8.5l3 3 6-7" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

type Step = { key: "sort" | "bill" | "offer" | "compare" | "challenge"; stages: Stage[]; label: string };
const STAGE_ORDER: Stage[] = ["sorting", "reading_bill", "rereading_bill", "reading_offer", "comparing", "challenging"];
const KIND_NAMES: Record<PageKind, string> = { bill: "Bill", older_bill: "Earlier bill", promise: "Promise", other: "Not used" };

function stepStatus(step: Step, stage: Stage | null, active: boolean): "done" | "now" | "later" {
  if (!stage) return step.key === "bill" && active ? "now" : "later";
  const at = STAGE_ORDER.indexOf(stage);
  const first = Math.min(...step.stages.map((s) => STAGE_ORDER.indexOf(s)));
  const last = Math.max(...step.stages.map((s) => STAGE_ORDER.indexOf(s)));
  if (at > last) return "done";
  if (at >= first) return active ? "now" : "done";
  return "later";
}

const secondary = "h-9 rounded-lg bg-fill px-4 text-[15px] hover:bg-fill-2";
const primary = "h-9 rounded-lg bg-text px-4 text-[15px] font-medium text-white hover:bg-black";

function Footer({ state, onCancel, dispatch }: { state: Exclude<CheckState, { s: "composing" } | { s: "done" }>; onCancel: () => void; dispatch: (action: CheckAction) => void }) {
  if (state.s === "running") {
    return (
      <button type="button" onClick={onCancel} className={`${secondary} self-start`}>
        Cancel
      </button>
    );
  }
  return (
    <div className="flex flex-col gap-3">
      <p className="text-[15px]" role={state.s === "failed" ? "alert" : undefined}>
        {state.s === "failed" ? state.message : "Check stopped."}
      </p>
      {state.spentMicros > 0 && <p className="text-[13px] text-text-2 tabular-nums">{state.s === "cancelled" || !state.spentFinal ? `At least ${formatMicros(state.spentMicros)} spent` : `${formatMicros(state.spentMicros)} spent`}</p>}
      <div className="flex gap-2">
        {(state.s === "cancelled" || state.retryable) && (
          <button type="button" onClick={() => dispatch({ type: "retry" })} className={primary}>
            Check again
          </button>
        )}
        <button type="button" onClick={() => dispatch({ type: "edit" })} className={secondary}>
          Change files
        </button>
      </div>
    </div>
  );
}

function WorkingYear({ state, onCancel, dispatch }: { state: Exclude<CheckState, { s: "composing" } | { s: "done" }>; onCancel: () => void; dispatch: (action: CheckAction) => void }) {
  const live = state.live;
  const bills = state.inputs.bills;
  const done = Object.keys(live.months).length;
  return (
    <section className="mx-auto w-full max-w-[1120px] px-6 pb-20 pt-6">
      <div className="flex items-baseline justify-between gap-6 pb-6">
        {/* Keyed to the attempt and its state, so focus lands here when a check starts and again when it stops: the
            button pressed to start or retry is gone by then, and focus would otherwise drop to the top of the page. */}
        <h1 key={`${state.attempts}-${state.s}`} ref={focusOnShow} tabIndex={-1} className="text-[28px] font-semibold leading-[1.2] tracking-[-0.02em] outline-none">
          {state.s === "running" ? `Reading ${bills.length} bills` : "Stopped"}
        </h1>
        <p className="text-[13px] text-text-2 tabular-nums">
          {/* Read whole ("8 of 12 done"); otherwise only the changed number is spoken. */}
          <span aria-live="polite" aria-atomic>
            {done} of {bills.length} done
          </span>
          {state.spentMicros > 0 ? `, ${formatMicros(state.spentMicros)}` : ""}
        </p>
      </div>
      <ol className="grid grid-cols-3 gap-4 sm:grid-cols-4 lg:grid-cols-6">
        {bills.map((doc, i) => {
          const month = live.months[i];
          const lines = live.lines[i] ?? [];
          const rows = doc.status === "ready" ? doc.pages[0].rows : null;
          const marks: Mark[] = lines.flatMap((line, j) => {
            const box = line.page === 1 ? snapBox(line.box, line.label, rows) : null;
            return box ? [{ id: `R${j}`, box, tone: "read" as const }] : [];
          });
          const over = month?.outcome === "checked" ? month.claims.reduce((t, c) => t + c.amountCents, 0) : 0;
          // The bill a stopped year stopped on is marked, so the person sees which statement to fix.
          const stoppedHere = state.s === "failed" && state.bill === i;
          return (
            <li key={doc.id} className="flex flex-col gap-2">
              {doc.status === "ready" && <BillPage image={doc.pages[0].image} alt={`Bill ${i + 1}`} marks={marks} visibleAspect="1000 / 900" />}
              <p className={`flex items-center gap-2 text-[13px] tabular-nums ${over > 0 || stoppedHere ? "font-semibold text-red" : "text-text-2"}`}>
                {!month && state.s === "running" && lines.length > 0 && <Spinner />}
                {month
                  ? month.outcome === "checked"
                    ? over > 0
                      ? `${usd(over)} over`
                      : "Matches"
                    : month.outcome === "not_a_bill"
                      ? "Not a bill"
                      : "Couldn't read"
                  : stoppedHere
                    ? "Couldn't read"
                    : lines.length > 0
                    ? `${lines.length} ${lines.length === 1 ? "line" : "lines"}`
                    : state.s === "running"
                      ? "Waiting"
                      : "Stopped"}
              </p>
            </li>
          );
        })}
      </ol>
      <div className="mt-8">
        <Footer state={state} onCancel={onCancel} dispatch={dispatch} />
      </div>
    </section>
  );
}

function Working({ state, onCancel, dispatch }: { state: Exclude<CheckState, { s: "composing" } | { s: "done" }>; onCancel: () => void; dispatch: (action: CheckAction) => void }) {
  if (state.inputs.bills.length > 1) return <WorkingYear state={state} onCancel={onCancel} dispatch={dispatch} />;
  const bill = state.inputs.bills[0];
  const kinds = state.s === "running" ? state.live.sorted[0] : undefined;
  const pages = bill?.status === "ready" ? bill.pages : [];
  const page = pages[Math.max(0, kinds?.indexOf("bill") ?? 0)] ?? null;
  const running = state.s === "running";
  const live = running ? state.live : null;
  const stage = state.stage;
  const lines = live?.lines[0] ?? [];
  const marks: Mark[] = lines.flatMap((line, i) => {
    const box = line.page === 1 ? snapBox(line.box, line.label, page?.rows ?? null) : null;
    return box ? [{ id: `R${i}`, box, tone: "read" as const }] : [];
  });
  const offer = state.inputs.offer;
  const isCall = offer.kind === "call";
  // Offer pictures found among the bill's screenshots are read as the offer, as one the person added would be.
  const promised = offer.kind !== "none" || (kinds?.includes("promise") ?? false);
  const steps: Step[] = [
    ...(kinds || stage === "sorting" ? [{ key: "sort" as const, stages: ["sorting"] as Stage[], label: "Sorting your pictures" }] : []),
    { key: "bill", stages: ["reading_bill", "rereading_bill"], label: stage === "rereading_bill" ? "Reading the bill again" : "Reading the bill" },
    ...(promised ? [{ key: "offer" as const, stages: ["reading_offer"] as Stage[], label: isCall ? "Listening to the call" : "Reading the offer" }] : []),
    { key: "compare", stages: ["comparing"], label: promised ? "Comparing charges with the promise" : "Checking the charges" },
    ...(promised ? [{ key: "challenge" as const, stages: ["challenging"] as Stage[], label: "Checking the company's side" }] : []),
  ];
  const current = steps.find((step) => stepStatus(step, stage, running) === "now");
  const latest = current ? (live?.thoughts ?? []).filter((t) => current.stages.includes(t.stage)).at(-1)?.text.split("\n\n").at(-1) : undefined;
  const latestThought = latest && inPlainWords(latest);

  return (
    <section className="mx-auto grid w-full max-w-[1120px] gap-10 px-6 pb-20 pt-6 lg:grid-cols-[minmax(0,5fr)_minmax(0,6fr)]">
      <div className="lg:sticky lg:top-6 lg:self-start">{page && <BillPage image={page.image} alt="Your bill, first page" marks={marks} />}</div>

      <div className="flex flex-col gap-6">
        <div className="flex items-baseline justify-between gap-4">
          {/* Only the step is announced: the thinking text and the spend change many times a second. */}
          {/* Keyed to the attempt and its state, so focus lands here when a check starts and again when it stops. */}
          <h1 key={`${state.attempts}-${state.s}`} ref={focusOnShow} tabIndex={-1} aria-live="polite" className="text-[28px] font-semibold leading-[1.2] tracking-[-0.02em] outline-none">
            {current?.label ?? (running ? "Starting" : "Stopped")}
          </h1>
          {state.spentMicros > 0 && <p className="text-[13px] text-text-2 tabular-nums">{formatMicros(state.spentMicros)}</p>}
        </div>
        <p className="min-h-[44px] text-[15px] leading-[22px] text-text-2">{latestThought ?? (running ? "Muse Ember is starting on the bill." : "")}</p>

        <ol className="flex flex-col border-t border-line">
          {steps.map((step) => {
            const status = stepStatus(step, stage, running);
            return (
              <li key={step.key} className="border-b border-line py-3">
                <div className={`flex items-center gap-3 ${status === "later" ? "text-text-2" : ""}`}>
                  <span className="grid size-4 place-items-center">{status === "now" ? <Spinner /> : status === "done" ? <Check /> : <span className="size-2 rounded-full bg-fill-2" />}</span>
                  <span className="text-[15px]">{step.label}</span>
                </div>

                {step.key === "sort" && kinds && (
                  <ul className="ml-7 mt-2 grid grid-cols-4 gap-2 sm:grid-cols-6">
                    {pages.map((shown, i) => (
                      <li key={i} className="appear flex flex-col gap-1">
                        <div className={`h-16 overflow-hidden rounded-[4px] bg-white outline-1 -outline-offset-1 outline-line ${kinds[i] === "other" || kinds[i] === "older_bill" ? "opacity-40" : ""}`}>
                          <Thumbnail src={shown.image} />
                        </div>
                        <span className="text-[12px] text-text-2">{KIND_NAMES[kinds[i] ?? "bill"]}</span>
                      </li>
                    ))}
                  </ul>
                )}

                {step.key === "bill" && lines.length > 0 && (
                  <ul className="ml-7 mt-2">
                    {lines.map((line, i) => (
                      <li key={i} className="appear flex items-baseline justify-between gap-4 py-0.5 text-[13px]">
                        <span className="truncate">{line.label}</span>
                        <span className="text-text-2 tabular-nums">{usd(line.amount_cents)}</span>
                      </li>
                    ))}
                  </ul>
                )}

                {step.key === "offer" && live && live.heard.length > 0 && (
                  <ul className="ml-7 mt-2 flex flex-col gap-1">
                    {live.heard.map((turn, i) => (
                      <li key={i} className="appear grid grid-cols-[2.5rem_1fr] gap-2 text-[13px] leading-[18px]">
                        <span className="text-text-2 tabular-nums">{formatClock(turn.start_seconds)}</span>
                        <span>
                          <span className="text-text-2">{turn.speaker === "company" ? "Company" : turn.speaker === "customer" ? "You" : "Other"}: </span>
                          {turn.text}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}

                {step.key === "offer" && live && live.promises.length > 0 && (
                  <ul className="ml-7 mt-2 flex flex-col gap-0.5">
                    {live.promises.map((promise, i) => (
                      <li key={i} className="appear text-[13px] leading-[18px]">
                        {promise.description}
                      </li>
                    ))}
                  </ul>
                )}

                {step.key === "challenge" && live && live.challenges.length > 0 && (
                  <ul className="ml-7 mt-2 flex flex-col gap-1">
                    {live.challenges.map((challenge, i) => (
                      <li key={i} className="appear text-[13px] leading-[18px] text-text-2">
                        {challenge.looked_for}
                      </li>
                    ))}
                  </ul>
                )}
              </li>
            );
          })}
        </ol>

        <Footer state={state} onCancel={onCancel} dispatch={dispatch} />
      </div>
    </section>
  );
}

function SampleButton({ sample, busy, loading, onRun }: { sample: Sample; busy: boolean; loading: boolean; onRun: () => void }) {
  return (
    <button type="button" disabled={busy} onClick={onRun} className="flex items-center gap-4 rounded-xl p-3 text-left hover:bg-fill disabled:cursor-wait">
      <span className="block h-[72px] w-14 shrink-0 overflow-hidden rounded-[4px] bg-white outline-1 -outline-offset-1 outline-line">
        {/* A made-up sample is zoomed onto its header; a real post's picture can be any shape, so it is fitted. */}
        {/* The previews sit below a phone's first screen, so they load as they scroll into view, at their shown size. */}
        {sample.pictures ? <Thumbnail src={sample.image} lazy /> : <Image src={sample.image} alt="" width={1200} height={1553} sizes="129px" className="h-auto w-[230%] max-w-none -translate-x-[9%] -translate-y-[4%]" />}
      </span>
      <span className="min-w-0">
        <span className="block text-[15px] font-medium">{loading ? "Opening" : sample.title}</span>
        <span className="block text-[13px] text-text-2">{sample.outcome}</span>
      </span>
    </button>
  );
}

async function fetchFile(url: string, name: string, type: string): Promise<File> {
  const response = await fetch(url).catch(() => null);
  if (!response?.ok) throw new PrepareError("This sample couldn't be downloaded. Check the connection and try again.");
  return new File([await response.blob()], name, { type });
}

// File names as a sentence lists them: "a", "a and b", "a, b and c".
const listed = (names: string[]) => (names.length === 1 ? names[0] : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`);

export function Checker({ samples, realSamples, startWith }: { samples: Sample[]; realSamples: Sample[]; startWith: Sample | null }) {
  const [state, dispatch] = useReducer(reduce, initialState);
  // The state as last shown, for work that resumes after an await (a pasted screenshot's bill is read again first).
  const shown = useRef(state);
  useLayoutEffect(() => {
    shown.current = state;
  });
  // Files dropped past the 12-bill limit, named, so the person knows which months are missing: PDFs are placed before
  // pictures, so the ones left out aren't simply the last chosen.
  const [leftOut, setLeftOut] = useState<string[]>([]);
  // The same statement added twice (a download kept under a second name) would be read, and paid for, twice; files are
  // told apart by their contents, and a repeat is named instead of added.
  const [alreadyAdded, setAlreadyAdded] = useState<string[]>([]);
  const billHashes = useRef(new Map<string, string[]>());
  // Each bill's own files, so a pasted screenshot can join the bill as if it had been dropped with them.
  const billFiles = useRef(new Map<string, File[]>());
  const pastedCount = useRef(0);
  const pasteQueue = useRef(Promise.resolve());
  const [pasteNote, setPasteNote] = useState<string | null>(null);
  // The offer takes one file; a drop of several keeps the first and says where the rest belong.
  const [offerExtra, setOfferExtra] = useState(0);
  const controllers = useRef(new Map<number, AbortController>());
  const nextId = useRef(0);
  const id = () => `doc-${++nextId.current}`;

  // A file dropped just outside a drop area would otherwise be opened by the browser, leaving the page and losing every
  // file already added. Text drags (into the offer box) are left alone.
  useEffect(() => {
    const keep = (event: globalThis.DragEvent) => {
      if (event.dataTransfer?.types.includes("Files")) event.preventDefault();
    };
    window.addEventListener("dragover", keep);
    window.addEventListener("drop", keep);
    return () => {
      window.removeEventListener("dragover", keep);
      window.removeEventListener("drop", keep);
    };
  }, []);

  // Closing or reloading the tab loses everything here: added files, a check already being paid for, a drafted message.
  // While there's any of that, the browser asks before leaving; a page with nothing added leaves freely. A link to
  // another Billproof page moves without a reload, which the browser doesn't ask about, so the page asks itself.
  const hasWork = state.s !== "composing" || state.inputs.bills.length > 0 || state.inputs.offer.kind !== "none";
  const leaving = useRef(false);
  useEffect(() => {
    if (!hasWork) return;
    // A Back the visitor already agreed to doesn't ask a second time.
    const ask = (event: BeforeUnloadEvent) => {
      if (!leaving.current) event.preventDefault();
    };
    const leave = (event: MouseEvent) => {
      // A click that opens a new tab or window keeps this page, and so its work.
      if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      const anchor = event.target instanceof Element ? event.target.closest("a[href]") : null;
      if (!(anchor instanceof HTMLAnchorElement) || anchor.target === "_blank") return;
      const url = new URL(anchor.href, location.href);
      if (url.origin !== location.origin || url.pathname + url.search === location.pathname + location.search) return;
      if (!window.confirm(LEAVE_QUESTION)) event.preventDefault();
    };
    window.addEventListener("beforeunload", ask);
    document.addEventListener("click", leave, true);
    return () => {
      window.removeEventListener("beforeunload", ask);
      document.removeEventListener("click", leave, true);
    };
  }, [hasWork]);

  // Back within the site (to the real-bills page a post was opened from) doesn't unload the page, and iPhone Safari
  // never shows the browser's prompt; so while there's work, a history entry for this same address takes the first
  // Back, and the page asks there. An entry still waiting once the work is gone is passed straight through. The router
  // keeps a page it navigated away from and shows it again later (Forward, or another post opened from the real-bills
  // page), so the guard is set up afresh each time the page shows, for the address it shows.
  const work = useRef(hasWork);
  const guardedHref = useRef<string | null>(null);
  useEffect(() => {
    work.current = hasWork;
    if (!hasWork) return;
    if (!history.state?.billproofGuard) {
      // With no earlier page (a tab opened straight onto Billproof), Back has nowhere to go and "Leave" couldn't leave;
      // closing the tab is still asked about. The history count includes pages ahead, so the browser's own answer
      // comes first where it has one.
      const navigation = (window as Window & { navigation?: { canGoBack: boolean } }).navigation;
      if (!(navigation ? navigation.canGoBack : history.length > 1)) return;
      history.pushState({ ...history.state, billproofGuard: true }, "");
    }
    guardedHref.current = location.href;
  }, [hasWork]);
  useEffect(() => {
    leaving.current = false;
    const back = () => {
      if (leaving.current) return;
      // Forward onto the guard entry: it guards again.
      if (history.state?.billproofGuard) {
        guardedHref.current = location.href;
        return;
      }
      // Only a Back from the guard to its own address is this page's to answer.
      if (guardedHref.current !== location.href) return;
      guardedHref.current = null;
      if (work.current && !window.confirm(LEAVE_QUESTION)) {
        history.pushState({ ...history.state, billproofGuard: true }, "");
        guardedHref.current = location.href;
        return;
      }
      leaving.current = true;
      history.back();
    };
    window.addEventListener("popstate", back);
    return () => window.removeEventListener("popstate", back);
  }, []);

  // A check can take a minute, often in a background tab; its title says whether it's still going, done or stopped,
  // and the start screen's own title comes back after.
  const phase = state.s === "running" ? "Checking" : state.s === "done" ? "Checked" : state.s === "failed" || state.s === "cancelled" ? "Stopped" : null;
  useEffect(() => {
    if (!phase) return;
    const before = document.title;
    document.title = `${phase} — Billproof`;
    return () => {
      document.title = before;
    };
  }, [phase]);

  const runningAttempt = state.s === "running" ? state.attempt : null;
  useEffect(() => {
    if (runningAttempt === null || controllers.current.has(runningAttempt)) return;
    const input = checkInput(state.inputs);
    if (!input) return;
    const controller = new AbortController();
    controllers.current.set(runningAttempt, controller);
    void streamCheck(input, runningAttempt, controller.signal, dispatch);
  }, [runningAttempt, state.inputs]);

  const cancel = () => {
    if (state.s !== "running") return;
    controllers.current.get(state.attempt)?.abort();
    dispatch({ type: "cancel" });
  };

  const prepareDoc = async (docId: string, file: File, maxPages: number) => {
    try {
      dispatch({ type: "doc_prepared", id: docId, ...(await prepareFile(file, maxPages)) });
    } catch (error) {
      dispatch({ type: "prep_failed", id: docId, message: error instanceof PrepareError ? error.message : "This file could not be opened." });
    }
  };

  // Screenshots dropped together are one pile about one bill, sorted by Muse Ember; each PDF is its own bill. One PDF
  // dropped with screenshots (a chat, the offer) is one bill with them, so the screenshots are sorted with the statement
  // and their promises apply to it, rather than becoming a second "month" that holds no bill.
  // `replacing` names a bill these files rebuild (a pasted screenshot joining it): it is left out of the room and the
  // repeats, since its own files come back in the drop, and is removed only once they have been read again; if they
  // can't be (the file changed on disk since), it stays as it was.
  const addBills = async (dropped: File[], replacing?: string) => {
    const digest = async (file: File) => Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", await file.arrayBuffer())), (byte) => byte.toString(16).padStart(2, "0")).join("");
    let digests: Map<File, string>;
    try {
      digests = new Map(await Promise.all(dropped.map(async (file) => [file, await digest(file)] as const)));
    } catch (error) {
      if (!replacing) throw error;
      setPasteNote("The pasted screenshot wasn't added: the bill's own files can no longer be read. Add the screenshot and the bill's files again together.");
      return;
    }
    if (replacing) dispatch({ type: "removed", id: replacing });
    const current = shown.current;
    const existing = (current.s === "composing" ? current.inputs.bills : []).filter((doc) => doc.id !== replacing);
    const seen = new Set(existing.flatMap((doc) => billHashes.current.get(doc.id) ?? []));
    // A statement added on its own and dropped again with new screenshots, as the offer box advises, means them to go
    // with it: its bill is replaced by one holding both, rather than the screenshots becoming a bill of their own.
    const droppedPdfs = dropped.filter(isPdf);
    const newPictures = dropped.filter((file) => isPicture(file) && !seen.has(digests.get(file) ?? ""));
    const statementHash = droppedPdfs.length === 1 && newPictures.length > 0 ? digests.get(droppedPdfs[0]) : undefined;
    const joined = statementHash === undefined ? undefined : existing.find((doc) => billHashes.current.get(doc.id)?.join() === statementHash);
    if (joined && statementHash) {
      seen.delete(statementHash);
      billHashes.current.delete(joined.id);
      dispatch({ type: "removed", id: joined.id });
    }
    const hashes = new Map<File, string>();
    const repeated: string[] = [];
    for (const file of dropped) {
      const hash = digests.get(file) ?? "";
      if (seen.has(hash)) repeated.push(file.name);
      else {
        seen.add(hash);
        hashes.set(file, hash);
      }
    }
    setAlreadyAdded(repeated);
    const files = dropped.filter((file) => hashes.has(file));
    const pdfs = files.filter(isPdf);
    const pictures = files.filter(isPicture);
    // A file that is neither (a Word document, a spreadsheet) stays on its own row, where it is refused alone instead of
    // failing the pile, and the statement in it, with it.
    const others = files.filter((file) => !isPdf(file) && !isPicture(file)).map((file) => [file]);
    const groups = [...(pdfs.length === 1 && pictures.length > 0 ? [[pdfs[0], ...pictures]] : [...pdfs.map((file) => [file]), ...(pictures.length > 1 ? [pictures] : pictures.map((file) => [file]))]), ...others];
    const room = MAX_BILLS - existing.length + (joined ? 1 : 0);
    const nameOf = (group: File[]) => (group.length === 1 ? group[0].name : isPdf(group[0]) ? `${group[0].name} and ${group.length - 1} ${group.length === 2 ? "picture" : "pictures"}` : `${group.length} pictures`);
    const named = groups.map((group) => ({ name: nameOf(group), group }));
    const docs = named.slice(0, room).map(({ name, group }) => ({ id: id(), name, group }));
    setLeftOut(named.slice(room).map(({ name }) => name));
    for (const doc of docs) {
      billHashes.current.set(doc.id, doc.group.map((file) => hashes.get(file) ?? ""));
      billFiles.current.set(doc.id, doc.group);
    }
    dispatch({ type: "bills_added", docs: docs.map(({ id: docId, name }) => ({ id: docId, name })) });
    for (const doc of docs) {
      if (doc.group.length === 1) void prepareDoc(doc.id, doc.group[0], MAX_BILL_PAGES);
      else void preparePile(doc.id, doc.group);
    }
  };

  // Screenshots are pasted one at a time, and each is a page of the same bill: a pasted picture joins the bill added
  // last, read again with its files as one bill (the owner's request, 2026-11-27). Pastes are taken in turn, each from
  // the bills as shown once the one before it is on the page. A bill without its files at hand (a sample's), or one
  // that failed, is left as it is and the picture starts a bill of its own; a full one keeps its pictures.
  const pasteBills = async (pictures: File[]) => {
    await new Promise((resolve) => requestAnimationFrame(resolve));
    const current = shown.current;
    if (current.s !== "composing") return;
    const last = current.inputs.bills.at(-1);
    const files = last ? billFiles.current.get(last.id) : undefined;
    if (!last || !files || last.status === "failed" || files.some((file) => !isPdf(file) && !isPicture(file))) return addBills(pictures);
    if (files.length + pictures.length > MAX_BILL_PAGES) {
      setPasteNote(`The pasted screenshot wasn't added: a bill takes up to ${MAX_BILL_PAGES} pictures, and this one is full. For another month, use “Add another month”.`);
      return;
    }
    setPasteNote(null);
    return addBills([...files, ...pictures], last.id);
  };

  const preparePile = async (docId: string, group: File[]) => {
    const pdf = group.find(isPdf);
    const pictures = group.filter((file) => file !== pdf);
    // Trimming the pile could drop the screenshot with the offer, so the person picks which to keep. Pictures added
    // together are one bill, so someone adding a picture per month is told to add each month on its own. A statement
    // keeps at least its first page beside them.
    const room = MAX_BILL_PAGES - (pdf ? 1 : 0);
    if (pictures.length > room) {
      const message = pdf
        ? `${pictures.length} pictures added with ${pdf.name} are read as one bill with it, which takes up to ${room} besides its first page: keep the ones with the offer or the charges.`
        : `${pictures.length} pictures added together are read as one bill, which takes up to ${MAX_BILL_PAGES}: keep the ones with the charges and the offer. For more than one month, add each month's pictures separately.`;
      dispatch({ type: "prep_failed", id: docId, message });
      return;
    }
    try {
      const [statement, shots] = await Promise.all([pdf ? prepareFile(pdf, MAX_BILL_PAGES - pictures.length) : null, Promise.all(pictures.map((file) => prepareFile(file, 1)))]);
      dispatch({ type: "doc_prepared", id: docId, pages: [...(statement?.pages ?? []), ...shots.flatMap((prepared) => prepared.pages)], omitted: statement?.omitted ?? 0 });
    } catch (error) {
      dispatch({ type: "prep_failed", id: docId, message: error instanceof PrepareError ? error.message : "One of these files could not be opened." });
    }
  };

  const addOffer = async (files: File[]) => {
    const file = files[0];
    setOfferExtra(files.length - 1);
    const docId = id();
    if (!isRecording(file)) {
      dispatch({ type: "offer_file_added", id: docId, name: file.name });
      // The file opener's refusal is worded for a bill; an offer it can't read (a Word file, a text file) can be pasted.
      if (!isPdf(file) && !isPicture(file)) return dispatch({ type: "prep_failed", id: docId, message: "This file can't be read. Remove it and paste the offer's words instead, or add it as a PDF, a screenshot or a call recording." });
      return prepareDoc(docId, file, MAX_OFFER_PAGES);
    }
    dispatch({ type: "call_added", id: docId, name: file.name });
    try {
      dispatch({ type: "call_prepared", id: docId, call: await prepareCall(file, MAX_CALL_SECONDS) });
    } catch (error) {
      dispatch({ type: "prep_failed", id: docId, message: error instanceof PrepareError ? error.message : "This recording could not be opened." });
    }
  };

  // A screenshot pasted (Cmd+V, or Paste on a phone) is added like a chosen file: into the offer box when the cursor is
  // there and it's empty, otherwise to the bill. Pasted words are left to the page: a picture pasted into an offer
  // already written is ignored, and so is one that comes with words (a document's copy can carry a picture of itself).
  useEffect(() => {
    if (state.s !== "composing") return;
    const offerEmpty = state.inputs.offer.kind === "none";
    const paste = (event: ClipboardEvent) => {
      const files = [...(event.clipboardData?.files ?? [])].filter(isPicture);
      if (files.length === 0) return;
      const inOffer = event.target instanceof HTMLTextAreaElement && event.target.getAttribute("aria-label") === "What you were promised";
      if (inOffer && (!offerEmpty || event.clipboardData?.getData("text/plain").trim())) return;
      event.preventDefault();
      // An untyped picture is known by its name (an iPhone's .heic), so the new name keeps its extension.
      const pictures = files.map((file) => new File([file], `Pasted screenshot ${++pastedCount.current}.${file.type ? file.type.split("/")[1] : file.name.split(".").pop()}`, { type: file.type }));
      if (inOffer) void addOffer(pictures);
      else pasteQueue.current = pasteQueue.current.then(() => pasteBills(pictures)).catch(() => setPasteNote("The pasted screenshot couldn't be added. Try adding it as a file."));
    };
    document.addEventListener("paste", paste);
    return () => document.removeEventListener("paste", paste);
  });

  // A sample's bills and offer enter the check together; a later sample click wins over one still loading.
  const sampleToken = useRef(0);
  const [loadingSample, setLoadingSample] = useState<string | null>(null);
  const runSample = async (sample: Sample) => {
    const token = ++sampleToken.current;
    setLoadingSample(sample.id);
    try {
      const pdfs = await Promise.all(
        sample.bills.map(async (url, i): Promise<Doc> => {
          const name = sample.bills.length > 1 ? `${sample.title} ${i + 1}.pdf` : `${sample.title}.pdf`;
          return { id: `sample-${token}-${i}`, name, status: "ready", ...(await prepareFile(await fetchFile(url, name, "application/pdf"), MAX_BILL_PAGES)) };
        }),
      );
      // A real post's picture can be gone from Reddit; the check reads the ones still there, as the server does.
      const postPicture = async (url: string, i: number) => {
        const response = await fetch(url);
        if (!response.ok) return [];
        return prepareFile(new File([await response.blob()], `picture-${i + 1}.jpg`, { type: "image/jpeg" }), 1).then((prepared) => prepared.pages, () => []);
      };
      const pile = async (pictures: string[]): Promise<Doc> => {
        // Named by the pictures read: past the page limit, or with some gone from Reddit, it says how many of the post's.
        const pages = (await Promise.all(pictures.slice(0, MAX_BILL_PAGES).map(postPicture))).flat();
        const name = pages.length > 0 && pages.length < pictures.length ? `${pages.length} of ${pictures.length} pictures from the post` : pictures.length === 1 ? "The picture from the post" : `${pictures.length} pictures from the post`;
        const gone = pictures.length === 1 ? "The picture from this post is no longer online." : "The pictures from this post are no longer online.";
        return pages.length > 0 ? { id: `sample-${token}-pile`, name, status: "ready", pages, omitted: 0 } : { id: `sample-${token}-pile`, name, status: "failed", message: gone };
      };
      const bills: Doc[] = [...pdfs, ...(sample.pictures ? [await pile(sample.pictures)] : [])];
      const offer: Inputs["offer"] =
        sample.offer.kind === "text"
          ? { kind: "text", text: sample.offer.text }
          : { kind: "call", call: { id: `sample-${token}-call`, name: "Sales call.m4a", status: "ready", ...(await prepareCall(await fetchFile(sample.offer.url, "Sales call.m4a", "audio/mp4"), MAX_CALL_SECONDS)) } };
      if (token !== sampleToken.current) return;
      dispatch({ type: "sample_ready", inputs: { bills, offer } });
    } catch (error) {
      // A failed download or a file that won't open stays on the start screen with the reason on its row.
      if (token !== sampleToken.current) return;
      const message = error instanceof PrepareError ? error.message : "This sample couldn't be opened. Try again.";
      dispatch({ type: "sample_ready", inputs: { bills: [{ id: `sample-${token}-failed`, name: sample.title, status: "failed", message }], offer: { kind: "none" } } });
    } finally {
      if (token === sampleToken.current) setLoadingSample(null);
    }
  };

  // A sample replaces whatever was added and starts at once, so files and an offer the person added are asked about first.
  const trySample = (sample: Sample) => {
    if (hasWork && !window.confirm("Replace the files you added with this sample? It will be checked right away.")) return;
    void runSample(sample);
  };

  // Opened from the real-bills page: that post's check starts as soon as its pictures load.
  const started = useRef(false);
  useEffect(() => {
    if (!startWith || started.current) return;
    started.current = true;
    void runSample(startWith);
  });

  if (state.s === "done") {
    if (state.result.outcome === "year") return <YearView state={state} result={state.result} dispatch={dispatch} />;
    const bill = state.inputs.bills[0];
    const { offer } = state.inputs;
    return (
      <ResultView
        result={state.result}
        bill={0}
        pages={bill?.status === "ready" ? bill.pages : []}
        omittedPages={{ bill: bill?.status === "ready" ? bill.omitted : 0, offer: offerOmitted(offer) }}
        callUrl={offer.kind === "call" && offer.call.status === "ready" ? offer.call.url : null}
        selection={state.selections[0]}
        dispatch={dispatch}
        backLabel={state.result.outcome === "checked" ? "Check another bill" : "Change files"}
        onBack={() => dispatch({ type: "edit" })}
      />
    );
  }
  if (state.s !== "composing") return <Working state={state} onCancel={cancel} dispatch={dispatch} />;

  const { bills, offer } = state.inputs;
  const ready = checkInput(state.inputs) !== null;
  const blocker = startBlocker(state.inputs);

  return (
    <section className="mx-auto w-full max-w-[1120px] px-6 pb-24">
      <div className="max-w-[44rem] pt-12">
        {/* Back from a check, the button pressed is gone with its screen, so the heading takes focus; a first visit keeps
            the browser's own starting point. */}
        <h1 ref={state.attempts > 0 ? focusOnShow : undefined} tabIndex={state.attempts > 0 ? -1 : undefined} className="text-[40px] font-semibold leading-[1.1] tracking-[-0.025em] outline-none">
          Check a bill against what you were promised
        </h1>
        <p className="mt-4 text-[17px] leading-[26px] text-text-2 text-pretty">
          Add a phone, internet or utility bill and the offer: the confirmation email, a screenshot, or a recording of the sales call. Muse Ember finds every charge above the promise and writes the message to get it back.
        </p>
      </div>

      {/* One column on a phone may not grow to a long file name, or the page scrolls sideways instead of the name truncating. */}
      <div className="mt-10 grid grid-cols-[minmax(0,1fr)] gap-3 lg:grid-cols-2">
        <div className="flex min-h-[180px] flex-col rounded-xl bg-fill p-4">
          <p className="text-[15px] font-semibold">Bill</p>
          {bills.length > 0 ? (
            // The padding, taken back by the margins, keeps the focus ring of a button at the list's edge inside the
            // scrolling box, which would cut it off.
            <div className="-mx-1 -mb-1 mt-1 max-h-[208px] overflow-y-auto p-1">
              {bills.map((doc) => (
                <DocRow
                  key={doc.id}
                  doc={doc}
                  onRemove={() => {
                    billFiles.current.delete(doc.id);
                    billHashes.current.delete(doc.id);
                    dispatch({ type: "removed", id: doc.id });
                  }}
                />
              ))}
              {bills.length < MAX_BILLS && (
                <FileTarget label="Add more bills" accept={BILL_ACCEPT} multiple onFiles={addBills} className="mt-1 h-8 rounded-lg px-2 text-[13px] text-text-2 hover:bg-fill-2 hover:text-text data-[over]:bg-fill-2 data-[over]:text-text">
                  Add another month
                </FileTarget>
              )}
              {leftOut.length > 0 && (
                <p role="status" className="mt-2 px-2 text-[13px] text-text-2 break-words">
                  Left out, as a check reads up to {MAX_BILLS} bills: {listed(leftOut)}.
                </p>
              )}
              {alreadyAdded.length > 0 && (
                <p role="status" className="mt-2 px-2 text-[13px] text-text-2 break-words">
                  Already added, so not added again: {listed(alreadyAdded)}.
                </p>
              )}
              {pasteNote && (
                <p role="status" className="mt-2 px-2 text-[13px] text-text-2 break-words">
                  {pasteNote}
                </p>
              )}
            </div>
          ) : (
            <FileTarget label="Choose the bill" accept={BILL_ACCEPT} multiple onFiles={addBills} className="mt-3 flex h-[112px] w-full flex-col items-center justify-center gap-1 rounded-lg border border-dashed border-text-2/40 text-center hover:bg-white data-[over]:bg-white">
              <span className="px-2 text-[15px] text-balance">
                <span className="sm:hidden">Choose</span>
                <span className="hidden sm:inline">Drop</span> the bill, or every screenshot you have
              </span>
              <span className="text-[13px] text-text-2">PDFs, photos, chats with the company, or paste a screenshot. Up to 12 months of bills at once.</span>
            </FileTarget>
          )}
        </div>

        <div className="flex min-h-[180px] flex-col rounded-xl bg-fill p-4">
          <p className="text-[15px] font-semibold">What you were promised</p>
          {offer.kind === "file" ? (
            <div className="mt-2">
              <DocRow doc={offer.doc} onRemove={() => dispatch({ type: "removed", id: offer.doc.id })} />
              {offerExtra > 0 && (
                <p role="status" className="mt-1 text-[13px] text-text-2">
                  Only the first file was added. To include several screenshots of the offer, drop them in the bill box with the bill, and Billproof sorts them.
                </p>
              )}
            </div>
          ) : offer.kind === "call" ? (
            <div className="mt-2">
              <CallRow call={offer.call} onRemove={() => dispatch({ type: "removed", id: offer.call.id })} />
            </div>
          ) : (
            <>
              <textarea
                value={offer.kind === "text" ? offer.text : ""}
                onChange={(event) => dispatch({ type: "offer_text", text: event.target.value })}
                placeholder="Paste the order confirmation or plan details"
                aria-label="What you were promised"
                // 16 px on a phone: iPhone Safari zooms the page into a box with smaller text when it's tapped.
                className="mt-2 block min-h-[88px] w-full flex-1 resize-none rounded-lg bg-white p-3 text-[16px] leading-[22px] shadow-[inset_0_0_0_1px_var(--line)] placeholder:text-text-2 focus:outline-none focus-visible:shadow-[inset_0_0_0_2px_var(--text)] sm:text-[15px]"
              />
              <FileTarget label="Add the offer as a file or recording" accept={OFFER_ACCEPT} onFiles={(files) => void addOffer(files)} className="mt-2 h-8 rounded-lg px-2 text-[13px] text-text-2 hover:bg-fill-2 hover:text-text data-[over]:bg-fill-2 data-[over]:text-text">
                Add a screenshot, PDF or call recording instead
              </FileTarget>
            </>
          )}
        </div>
      </div>

      <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
        <p className="text-[13px] text-text-2">Read by Meta&apos;s Muse Ember. Files aren&apos;t stored.</p>
        <div className="flex flex-wrap items-center gap-3">
          {/* Kept on the page so a reason that appears is announced; while empty it takes no slot, or the row's gap
              would push the button in from the edge where it wraps on a phone. */}
          <p role="status" className="text-[13px] text-text-2 empty:absolute">
            {blocker}
          </p>
          <button type="button" disabled={!ready} onClick={() => dispatch({ type: "start" })} className="h-11 rounded-lg bg-text px-6 text-[15px] font-medium text-white hover:bg-black disabled:bg-fill-2 disabled:text-text-2">
            {bills.length > 1 ? `Check ${bills.length} bills` : "Check bill"}
          </button>
        </div>
      </div>

      {realSamples.length > 0 && (
        <section className="mt-16">
          <div className="flex items-baseline justify-between gap-4">
            <h2 className="text-[17px] font-semibold">Real bills people posted</h2>
            <Link href="/real" className="inline-flex min-h-6 items-center text-[13px] text-text-2 hover:text-text">
              See all of them
            </Link>
          </div>
          <p className="mt-1 text-[13px] text-text-2">Pictures from public Reddit posts, checked live against what the poster wrote.</p>
          <div className="-mx-3 mt-3 grid sm:grid-cols-2 lg:grid-cols-3">
            {realSamples.map((sample) => (
              <SampleButton key={sample.id} sample={sample} busy={loadingSample !== null} loading={loadingSample === sample.id} onRun={() => trySample(sample)} />
            ))}
          </div>
        </section>
      )}

      <section className="mt-16">
        <h2 className="text-[17px] font-semibold">Samples</h2>
        <p className="mt-1 text-[13px] text-text-2">Made-up bills that show each kind of check. Each one runs live on Muse Ember.</p>
        <div className="-mx-3 mt-3 grid sm:grid-cols-2 lg:grid-cols-3">
          {samples.map((sample) => (
            <SampleButton key={sample.id} sample={sample} busy={loadingSample !== null} loading={loadingSample === sample.id} onRun={() => trySample(sample)} />
          ))}
        </div>
      </section>
    </section>
  );
}
