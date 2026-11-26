"use client";

import Link from "next/link";
import { useEffect, useReducer, useRef, useState, type ChangeEvent, type DragEvent, type ReactNode } from "react";
import { checkInput, initialState, reduce, type Call, type CheckAction, type CheckState, type Doc, type Inputs } from "@/lib/check-machine";
import { formatMicros } from "@/lib/cost";
import { usd } from "@/lib/letter";
import { isAudio, MAX_BILL_PAGES, MAX_OFFER_PAGES, prepareCall, prepareFile, PrepareError } from "@/lib/prepare";
import { MAX_BILLS, MAX_CALL_SECONDS, type CheckEvent, type CheckInput, type PageKind, type Stage } from "@/lib/result";
import { BillPage, snapBox, Thumbnail, type Mark } from "./bill-page";
import { formatClock, Waveform } from "./evidence";
import { ResultView } from "./result-view";
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

const BILL_ACCEPT = "application/pdf,image/jpeg,image/png,image/webp";
const OFFER_ACCEPT = "application/pdf,image/jpeg,image/png,image/webp,audio/*,.m4a,.mp3,.wav";

function isCheckEvent(value: unknown): value is CheckEvent {
  return typeof value === "object" && value !== null && "type" in value && typeof value.type === "string";
}

async function streamCheck(input: CheckInput, attempt: number, signal: AbortSignal, dispatch: (action: CheckAction) => void) {
  const fail = (message: string) => dispatch({ type: "errored", attempt, failure: "network", message, spentMicros: 0, retryable: true });
  let response: Response;
  try {
    response = await fetch("/api/check", { method: "POST", body: JSON.stringify(input), headers: { "Content-Type": "application/json" }, signal });
  } catch {
    if (!signal.aborted) fail("The connection dropped before the check started.");
    return;
  }
  if (!response.body) return fail("The server sent no response.");
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
            dispatch({ type: "errored", attempt, failure: event.failure, message: event.message, spentMicros: event.spentMicros, retryable: event.retryable });
            break;
        }
      }
    }
  } catch {
    if (signal.aborted) return;
  }
  if (!terminal && !signal.aborted) fail("The connection dropped before the check finished.");
}

function FileTarget({ label, accept, multiple, onFiles, children, className }: { label: string; accept: string; multiple?: boolean; onFiles: (files: File[]) => void; children: ReactNode; className?: string }) {
  const input = useRef<HTMLInputElement>(null);
  const [over, setOver] = useState(false);
  const onDrop = (event: DragEvent) => {
    event.preventDefault();
    setOver(false);
    const files = [...event.dataTransfer.files];
    if (files.length) onFiles(multiple ? files : files.slice(0, 1));
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
      <button type="button" onClick={() => input.current?.click()} className={`${className ?? ""} ${over ? "bg-fill-2" : ""}`}>
        {children}
      </button>
    </div>
  );
}

function RemoveButton({ onRemove }: { onRemove: () => void }) {
  return (
    <button type="button" onClick={onRemove} className="h-8 rounded-lg px-2 text-[13px] text-text-2 hover:bg-fill-2 hover:text-text">
      Remove
    </button>
  );
}

function DocRow({ doc, onRemove }: { doc: Doc; onRemove: () => void }) {
  const detail = doc.status === "preparing" ? "Opening" : doc.status === "failed" ? doc.message : doc.pages.length === 1 ? "1 page" : `${doc.pages.length} pages`;
  return (
    <div className="flex items-center gap-3 py-1.5">
      <div className="h-10 w-8 shrink-0 overflow-hidden rounded-[4px] bg-white shadow-[inset_0_0_0_1px_var(--line)]">{doc.status === "ready" && <Thumbnail src={doc.pages[0].image} />}</div>
      <div className="min-w-0 flex-1">
        <div className="truncate text-[15px]">{doc.name}</div>
        <div className={`text-[13px] ${doc.status === "failed" ? "text-red" : "text-text-2"}`} role={doc.status === "failed" ? "alert" : undefined}>
          {detail}
        </div>
      </div>
      <RemoveButton onRemove={onRemove} />
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
      <RemoveButton onRemove={onRemove} />
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
      {state.spentMicros > 0 && <p className="text-[13px] text-text-2 tabular-nums">{state.s === "cancelled" ? `At least ${formatMicros(state.spentMicros)} spent` : `${formatMicros(state.spentMicros)} spent`}</p>}
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
  const live = state.s === "running" ? state.live : null;
  const bills = state.inputs.bills;
  const done = live ? Object.keys(live.months).length : 0;
  return (
    <section className="mx-auto w-full max-w-[1120px] px-6 pb-20 pt-6">
      <div className="flex items-baseline justify-between gap-6 pb-6">
        <h1 className="text-[28px] font-semibold tracking-[-0.02em]">Reading {bills.length} bills</h1>
        <p className="text-[13px] text-text-2 tabular-nums">
          {done} of {bills.length} done{state.spentMicros > 0 ? `, ${formatMicros(state.spentMicros)}` : ""}
        </p>
      </div>
      <ol className="grid grid-cols-3 gap-4 sm:grid-cols-4 lg:grid-cols-6">
        {bills.map((doc, i) => {
          const month = live?.months[i];
          const lines = live?.lines[i] ?? [];
          const rows = doc.status === "ready" ? doc.pages[0].rows : null;
          const marks: Mark[] = lines.flatMap((line, j) => {
            const box = line.page === 1 ? snapBox(line.box, line.label, rows) : null;
            return box ? [{ id: `R${j}`, box, tone: "read" as const }] : [];
          });
          const over = month?.outcome === "checked" ? month.claims.reduce((t, c) => t + c.amountCents, 0) : 0;
          return (
            <li key={doc.id} className="flex flex-col gap-2">
              {doc.status === "ready" && <BillPage image={doc.pages[0].image} alt={`Bill ${i + 1}`} marks={marks} visibleAspect="1000 / 900" />}
              <p className={`flex items-center gap-2 text-[13px] tabular-nums ${over > 0 ? "font-semibold text-red" : "text-text-2"}`}>
                {!month && state.s === "running" && lines.length > 0 && <Spinner />}
                {month
                  ? month.outcome === "checked"
                    ? over > 0
                      ? `${usd(over)} over`
                      : "Matches"
                    : month.outcome === "not_a_bill"
                      ? "Not a bill"
                      : "Couldn't read"
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
  const latestThought = current ? (live?.thoughts ?? []).filter((t) => current.stages.includes(t.stage)).at(-1)?.text.split("\n\n").at(-1) : undefined;

  return (
    <section className="mx-auto grid w-full max-w-[1120px] gap-10 px-6 pb-20 pt-6 lg:grid-cols-[minmax(0,5fr)_minmax(0,6fr)]">
      <div className="lg:sticky lg:top-6 lg:self-start">{page && <BillPage image={page.image} alt="Your bill, first page" marks={marks} />}</div>

      <div className="flex flex-col gap-6" aria-live="polite">
        <div className="flex items-baseline justify-between gap-4">
          <h1 className="text-[28px] font-semibold tracking-[-0.02em]">{current?.label ?? (running ? "Starting" : "Stopped")}</h1>
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
                        <div className={`h-16 overflow-hidden rounded-[4px] bg-white shadow-[inset_0_0_0_1px_var(--line)] ${kinds[i] === "other" || kinds[i] === "older_bill" ? "opacity-40" : ""}`}>
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
      <div className="h-[72px] w-14 shrink-0 overflow-hidden rounded-[4px] bg-white shadow-[inset_0_0_0_1px_var(--line)]">
        {/* A made-up sample is zoomed onto its header; a real post's picture can be any shape, so it is fitted. */}
        {sample.pictures ? <Thumbnail src={sample.image} /> : <img src={sample.image} alt="" className="w-[230%] max-w-none -translate-x-[9%] -translate-y-[4%]" />}
      </div>
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

export function Checker({ samples, realSamples, startWith }: { samples: Sample[]; realSamples: Sample[]; startWith: Sample | null }) {
  const [state, dispatch] = useReducer(reduce, initialState);
  const controllers = useRef(new Map<number, AbortController>());
  const nextId = useRef(0);
  const id = () => `doc-${++nextId.current}`;

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
      dispatch({ type: "doc_prepared", id: docId, pages: await prepareFile(file, maxPages) });
    } catch (error) {
      dispatch({ type: "prep_failed", id: docId, message: error instanceof PrepareError ? error.message : "This file could not be opened." });
    }
  };

  // Screenshots dropped together are one pile about one bill, sorted by Muse Ember; each PDF is its own bill.
  const addBills = (files: File[]) => {
    const isPdf = (file: File) => file.type === "application/pdf" || file.name.toLowerCase().endsWith(".pdf");
    const pictures = files.filter((file) => !isPdf(file));
    const groups = [...files.filter(isPdf).map((file) => [file]), ...(pictures.length > 1 ? [pictures] : pictures.map((file) => [file]))];
    const room = MAX_BILLS - (state.s === "composing" ? state.inputs.bills.length : 0);
    const docs = groups.slice(0, room).map((group) => ({ id: id(), name: group.length > 1 ? `${group.length} pictures` : group[0].name, group }));
    dispatch({ type: "bills_added", docs: docs.map(({ id: docId, name }) => ({ id: docId, name })) });
    for (const doc of docs) {
      if (doc.group.length === 1) void prepareDoc(doc.id, doc.group[0], MAX_BILL_PAGES);
      else void preparePile(doc.id, doc.group);
    }
  };

  const preparePile = async (docId: string, group: File[]) => {
    // Trimming the pile could drop the screenshot with the offer, so the person picks which to keep.
    if (group.length > MAX_BILL_PAGES) {
      dispatch({ type: "prep_failed", id: docId, message: `${group.length} pictures were added together. Use up to ${MAX_BILL_PAGES}: the ones with the charges and the offer.` });
      return;
    }
    try {
      const pages = (await Promise.all(group.map((file) => prepareFile(file, 1)))).flat();
      dispatch({ type: "doc_prepared", id: docId, pages });
    } catch (error) {
      dispatch({ type: "prep_failed", id: docId, message: error instanceof PrepareError ? error.message : "One of these pictures could not be opened." });
    }
  };

  const addOffer = async (file: File) => {
    const docId = id();
    if (!isAudio(file)) {
      dispatch({ type: "offer_file_added", id: docId, name: file.name });
      return prepareDoc(docId, file, MAX_OFFER_PAGES);
    }
    dispatch({ type: "call_added", id: docId, name: file.name });
    try {
      dispatch({ type: "call_prepared", id: docId, call: await prepareCall(file, MAX_CALL_SECONDS) });
    } catch (error) {
      dispatch({ type: "prep_failed", id: docId, message: error instanceof PrepareError ? error.message : "This recording could not be opened." });
    }
  };

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
          return { id: `sample-${token}-${i}`, name, status: "ready", pages: await prepareFile(await fetchFile(url, name, "application/pdf"), MAX_BILL_PAGES) };
        }),
      );
      // A real post's picture can be gone from Reddit; the check reads the ones still there, as the server does.
      const postPicture = async (url: string, i: number) => {
        const response = await fetch(url);
        if (!response.ok) return [];
        return prepareFile(new File([await response.blob()], `picture-${i + 1}.jpg`, { type: "image/jpeg" }), 1).catch(() => []);
      };
      const pile = async (pictures: string[]): Promise<Doc> => {
        const read = Math.min(pictures.length, MAX_BILL_PAGES);
        const name = read < pictures.length ? `${read} of ${pictures.length} pictures from the post` : `${pictures.length} pictures from the post`;
        const pages = (await Promise.all(pictures.slice(0, MAX_BILL_PAGES).map(postPicture))).flat();
        return pages.length > 0 ? { id: `sample-${token}-pile`, name, status: "ready", pages } : { id: `sample-${token}-pile`, name, status: "failed", message: "The pictures from this post are no longer online." };
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
        callUrl={offer.kind === "call" && offer.call.status === "ready" ? offer.call.url : null}
        selection={state.selections[0]}
        dispatch={dispatch}
        backLabel="Check another bill"
        onBack={() => dispatch({ type: "edit" })}
      />
    );
  }
  if (state.s !== "composing") return <Working state={state} onCancel={cancel} dispatch={dispatch} />;

  const { bills, offer } = state.inputs;
  const ready = checkInput(state.inputs) !== null;

  return (
    <section className="mx-auto w-full max-w-[1120px] px-6 pb-24">
      <div className="max-w-[44rem] pt-12">
        <h1 className="text-[40px] font-semibold leading-[1.1] tracking-[-0.025em]">Check a bill against what you were promised</h1>
        <p className="mt-4 text-[17px] leading-[26px] text-text-2 text-pretty">
          Add a phone, internet or utility bill and the offer: the confirmation email, a screenshot, or a recording of the sales call. Muse Ember finds every charge above the promise and writes the message to get it back.
        </p>
      </div>

      <div className="mt-10 grid gap-3 lg:grid-cols-2">
        <div className="flex min-h-[180px] flex-col rounded-xl bg-fill p-4">
          <p className="text-[15px] font-semibold">Bill</p>
          {bills.length > 0 ? (
            <div className="mt-2 max-h-[200px] overflow-y-auto">
              {bills.map((doc) => (
                <DocRow key={doc.id} doc={doc} onRemove={() => dispatch({ type: "removed", id: doc.id })} />
              ))}
              {bills.length < MAX_BILLS && (
                <FileTarget label="Add more bills" accept={BILL_ACCEPT} multiple onFiles={addBills} className="mt-1 h-8 rounded-lg px-2 text-[13px] text-text-2 hover:bg-fill-2 hover:text-text">
                  Add another month
                </FileTarget>
              )}
            </div>
          ) : (
            <FileTarget label="Choose the bill" accept={BILL_ACCEPT} multiple onFiles={addBills} className="mt-3 flex h-[112px] w-full flex-col items-center justify-center gap-1 rounded-lg border border-dashed border-text-2/40 text-center hover:bg-fill-2">
              <span className="px-2 text-[15px] text-balance">
                <span className="sm:hidden">Choose</span>
                <span className="hidden sm:inline">Drop</span> the bill, or every screenshot you have
              </span>
              <span className="text-[13px] text-text-2">PDFs, photos, chats with the company. Up to 12 months of bills at once.</span>
            </FileTarget>
          )}
        </div>

        <div className="flex min-h-[180px] flex-col rounded-xl bg-fill p-4">
          <p className="text-[15px] font-semibold">What you were promised</p>
          {offer.kind === "file" ? (
            <div className="mt-2">
              <DocRow doc={offer.doc} onRemove={() => dispatch({ type: "removed", id: offer.doc.id })} />
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
                className="mt-2 block min-h-[88px] w-full flex-1 resize-none rounded-lg bg-white p-3 text-[15px] leading-[22px] shadow-[inset_0_0_0_1px_var(--line)] placeholder:text-text-2 focus:outline-none focus-visible:shadow-[inset_0_0_0_2px_var(--text)]"
              />
              <FileTarget label="Add the offer as a file or recording" accept={OFFER_ACCEPT} onFiles={(files) => void addOffer(files[0])} className="mt-2 h-8 rounded-lg px-2 text-[13px] text-text-2 hover:bg-fill-2 hover:text-text">
                Add a screenshot, PDF or call recording instead
              </FileTarget>
            </>
          )}
        </div>
      </div>

      <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
        <p className="text-[13px] text-text-2">Read by Meta&apos;s Muse Ember. Files aren&apos;t stored.</p>
        <button type="button" disabled={!ready} onClick={() => dispatch({ type: "start" })} className="h-11 rounded-lg bg-text px-6 text-[15px] font-medium text-white hover:bg-black disabled:bg-fill-2 disabled:text-text-2">
          {bills.length > 1 ? `Check ${bills.length} bills` : "Check bill"}
        </button>
      </div>

      {realSamples.length > 0 && (
        <section className="mt-16">
          <div className="flex items-baseline justify-between gap-4">
            <h2 className="text-[17px] font-semibold">Real bills people posted</h2>
            <Link href="/real" className="text-[13px] text-text-2 hover:text-text">
              See all of them
            </Link>
          </div>
          <p className="mt-1 text-[13px] text-text-2">Pictures from public Reddit posts, checked live against what the poster wrote.</p>
          <div className="-mx-3 mt-3 grid sm:grid-cols-2 lg:grid-cols-3">
            {realSamples.map((sample) => (
              <SampleButton key={sample.id} sample={sample} busy={loadingSample !== null} loading={loadingSample === sample.id} onRun={() => void runSample(sample)} />
            ))}
          </div>
        </section>
      )}

      <section className="mt-16">
        <h2 className="text-[17px] font-semibold">Samples</h2>
        <p className="mt-1 text-[13px] text-text-2">Made-up bills that show each kind of check. Each one runs live on Muse Ember.</p>
        <div className="-mx-3 mt-3 grid sm:grid-cols-2 lg:grid-cols-3">
          {samples.map((sample) => (
            <SampleButton key={sample.id} sample={sample} busy={loadingSample !== null} loading={loadingSample === sample.id} onRun={() => void runSample(sample)} />
          ))}
        </div>
      </section>
    </section>
  );
}
