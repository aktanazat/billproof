"use client";

import { useEffect, useReducer, useRef, useState, type ChangeEvent, type DragEvent, type ReactNode } from "react";
import { checkInput, initialState, reduce, type CheckAction, type CheckState, type Doc } from "@/lib/check-machine";
import { formatMicros } from "@/lib/cost";
import { usd } from "@/lib/letter";
import { MAX_BILL_PAGES, MAX_OFFER_PAGES, prepareFile, PrepareError } from "@/lib/prepare";
import type { CheckEvent, CheckInput, Stage } from "@/lib/result";
import { BillPage, type Mark } from "./bill-page";
import { ResultView } from "./result-view";

export type Sample = { id: string; title: string; outcome: string; bill: string; image: string; proof: string };

const ACCEPT = "application/pdf,image/jpeg,image/png,image/webp";

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
          case "spent":
            dispatch({ type: "spent", attempt, micros: event.micros });
            break;
          case "thinking":
            dispatch({ type: "thought", attempt, stage: event.stage, text: event.text });
            break;
          case "line":
            dispatch({ type: "line_read", attempt, line: event.line });
            break;
          case "promise":
            dispatch({ type: "promise_read", attempt, promise: event.promise });
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

function FileTarget({ label, onFile, children, className }: { label: string; onFile: (file: File) => void; children: ReactNode; className?: string }) {
  const input = useRef<HTMLInputElement>(null);
  const [over, setOver] = useState(false);
  const onDrop = (event: DragEvent) => {
    event.preventDefault();
    setOver(false);
    const file = event.dataTransfer.files[0];
    if (file) onFile(file);
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
        accept={ACCEPT}
        aria-label={label}
        tabIndex={-1}
        className="sr-only"
        onChange={(event: ChangeEvent<HTMLInputElement>) => {
          const file = event.target.files?.[0];
          event.target.value = "";
          if (file) onFile(file);
        }}
      />
      <button type="button" onClick={() => input.current?.click()} className={`${className ?? ""} ${over ? "shadow-[0_0_0_2px_var(--accent)]" : ""}`}>
        {children}
      </button>
    </div>
  );
}

function DocIcon() {
  return (
    <svg aria-hidden width="28" height="34" viewBox="0 0 28 34" fill="none" className="text-ink-3">
      <path d="M4 1.5h13.5L26.5 10.5V30a2.5 2.5 0 0 1-2.5 2.5H4A2.5 2.5 0 0 1 1.5 30V4A2.5 2.5 0 0 1 4 1.5Z" stroke="currentColor" strokeWidth="1.5" />
      <path d="M17.5 1.5V8a2.5 2.5 0 0 0 2.5 2.5h6.5" stroke="currentColor" strokeWidth="1.5" />
      <path d="M7 17h14M7 21.5h14M7 26h9" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

function DocChip({ doc, onRemove }: { doc: Doc; onRemove: () => void }) {
  const detail = doc.status === "preparing" ? "Opening…" : doc.status === "failed" ? doc.message : doc.pages.length === 1 ? "1 page" : `${doc.pages.length} pages`;
  const thumb = doc.status === "ready" ? doc.pages[0].image : null;
  return (
    <div className="flex items-center gap-4 rounded-[14px] bg-fill p-3">
      <div className="grid h-[64px] w-[50px] shrink-0 place-items-center overflow-hidden rounded-[6px] bg-surface shadow-[0_0_0_1px_var(--hairline)]">
        {thumb ? <img src={thumb} alt="" className="h-full w-full object-cover object-top" /> : <DocIcon />}
      </div>
      <div className="min-w-0 flex-1">
        <div className="truncate text-[15px] font-medium">{doc.name}</div>
        <div className={`text-[13px] ${doc.status === "failed" ? "text-danger" : "text-ink-2"}`} role={doc.status === "failed" ? "alert" : undefined}>
          {detail}
        </div>
      </div>
      <button type="button" onClick={onRemove} className="rounded-[8px] px-2.5 py-1.5 text-[13px] text-ink-2 hover:bg-hairline hover:text-ink">
        Remove
      </button>
    </div>
  );
}

// The sample bill as Muse Ember marked it on a live run (eval/run-2026-11-25.json): what a result looks like.
const HERO_MARKS: Mark[] = [
  { id: "L1", box: { x0: 100, y0: 427, x1: 912, y1: 447 }, tone: "claim", n: 1 },
  { id: "L4", box: { x0: 100, y0: 576, x1: 912, y1: 596 }, tone: "claim" },
  { id: "L2", box: { x0: 100, y0: 478, x1: 912, y1: 498 }, tone: "claim", n: 2 },
  { id: "L3", box: { x0: 100, y0: 527, x1: 912, y1: 547 }, tone: "ask" },
  { id: "L6", box: { x0: 100, y0: 644, x1: 912, y1: 662 }, tone: "ask" },
];

function Hero({ sample, onRun, busy }: { sample: Sample; onRun: () => void; busy: boolean }) {
  return (
    <button type="button" onClick={onRun} disabled={busy} className="group block w-full text-left disabled:cursor-wait">
      <div className="rounded-[24px] bg-surface p-5 shadow-[0_0_0_1px_var(--hairline),0_24px_48px_-28px_rgb(0_0_0/0.25)] transition-transform duration-300 group-hover:-translate-y-0.5 sm:p-7">
        <BillPage image={sample.image} alt="A sample internet bill with two overcharges marked" marks={HERO_MARKS} visibleAspect="1200 / 1090" />
        <dl className="mt-5 grid gap-2.5 text-[14px]">
          <div className="flex items-baseline gap-3">
            <dt className="grid size-5 shrink-0 place-items-center rounded-full bg-ink text-[11px] font-semibold text-ground">1</dt>
            <dd className="flex-1">Internet billed above the promised $55</dd>
            <dd className="font-medium tabular-nums">$15.00</dd>
          </div>
          <div className="flex items-baseline gap-3">
            <dt className="grid size-5 shrink-0 place-items-center rounded-full bg-ink text-[11px] font-semibold text-ground">2</dt>
            <dd className="flex-1">Gateway charged, promised included</dd>
            <dd className="font-medium tabular-nums">$15.00</dd>
          </div>
        </dl>
        <p className="mt-4 text-[13px] text-ink-2">{busy ? "Opening the sample…" : "Run this sample live"}</p>
      </div>
    </button>
  );
}

function Spinner() {
  return <span aria-hidden className="inline-block size-[14px] animate-spin rounded-full border-[1.5px] border-hairline border-t-ink" />;
}

function Check() {
  return (
    <svg aria-hidden width="14" height="14" viewBox="0 0 14 14" fill="none">
      <path d="M2.5 7.5 5.5 10.5 11.5 3.5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

type Step = { key: "bill" | "offer" | "compare"; label: string; stages: Stage[] };
const STEPS: Step[] = [
  { key: "bill", label: "Reading the bill", stages: ["reading_bill", "rereading_bill"] },
  { key: "offer", label: "Reading what you were promised", stages: ["reading_offer"] },
  { key: "compare", label: "Comparing each charge", stages: ["comparing"] },
];
const STAGE_ORDER: Stage[] = ["reading_bill", "rereading_bill", "reading_offer", "comparing"];

function stepState(step: Step, stage: Stage | null, active: boolean): "done" | "now" | "later" {
  if (!stage) return step.key === "bill" && active ? "now" : "later";
  const at = STAGE_ORDER.indexOf(stage);
  const last = Math.max(...step.stages.map((s) => STAGE_ORDER.indexOf(s)));
  const first = Math.min(...step.stages.map((s) => STAGE_ORDER.indexOf(s)));
  if (at > last) return "done";
  if (at >= first) return active ? "now" : "later";
  return "later";
}

function Working({ state, onCancel, dispatch }: { state: Exclude<CheckState, { s: "composing" } | { s: "done" }>; onCancel: () => void; dispatch: (action: CheckAction) => void }) {
  const page = state.inputs.bill?.status === "ready" ? state.inputs.bill.pages[0] : null;
  const running = state.s === "running";
  const live = running ? state.live : null;
  const stage = state.stage;
  const reading = running && (stage === null || stage === "reading_bill" || stage === "rereading_bill");
  const marks: Mark[] = (live?.lines ?? []).flatMap((line, i) => (line.box && line.page === 1 ? [{ id: `R${i}`, box: line.box, tone: "read" as const }] : []));
  const hasOffer = state.inputs.offerFile !== null || state.inputs.offerText.trim().length > 0;
  const steps = STEPS.filter((step) => step.key !== "offer" || hasOffer);
  const thoughtsByStep = (step: Step) => (live?.thoughts ?? []).filter((t) => step.stages.includes(t.stage)).map((t) => t.text).join("\n\n");

  return (
    <section className="mx-auto grid w-full max-w-[1180px] gap-10 px-6 pb-16 pt-6 lg:grid-cols-[minmax(0,0.95fr)_minmax(0,1fr)] lg:gap-14">
      <div className="lg:sticky lg:top-8 lg:self-start">{page && <BillPage image={page.image} alt="Your bill, first page" marks={marks} sweeping={reading} />}</div>

      <div className="flex flex-col gap-6" aria-live="polite">
        <div className="flex items-center justify-between">
          <p className="text-[13px] font-medium text-ink-2">Muse Ember</p>
          <p className="text-[13px] text-ink-2 tabular-nums">{state.spentMicros > 0 ? `${formatMicros(state.spentMicros)} spent` : "Starting"}</p>
        </div>

        <ol className="flex flex-col gap-5">
          {steps.map((step) => {
            const status = stepState(step, stage, running);
            const thought = thoughtsByStep(step);
            return (
              <li key={step.key} className={`transition-opacity duration-300 ${status === "later" ? "opacity-40" : ""}`}>
                <div className="flex items-center gap-3">
                  <span className={`grid size-6 place-items-center rounded-full ${status === "done" ? "bg-ink text-ground" : "bg-fill text-ink"}`}>{status === "now" ? <Spinner /> : status === "done" ? <Check /> : null}</span>
                  <span className="text-[17px] font-medium">{step.key === "bill" && stage === "rereading_bill" ? "Reading the bill again, more carefully" : step.label}</span>
                </div>
                {thought && <p className="ml-9 mt-2 whitespace-pre-line text-[14px] leading-6 text-ink-2">{thought}</p>}
                {step.key === "bill" && live && live.lines.length > 0 && (
                  <ul className="ml-9 mt-3 divide-y divide-hairline rounded-[12px] bg-surface px-3 shadow-[0_0_0_1px_var(--hairline)]">
                    {live.lines.map((line, i) => (
                      <li key={i} className="appear flex items-baseline justify-between gap-4 py-2 text-[14px]">
                        <span className="truncate">{line.label}</span>
                        <span className="tabular-nums text-ink-2">{usd(line.amount_cents)}</span>
                      </li>
                    ))}
                  </ul>
                )}
                {step.key === "offer" && live && live.promises.length > 0 && (
                  <ul className="ml-9 mt-3 flex flex-col gap-2">
                    {live.promises.map((promise, i) => (
                      <li key={i} className="appear rounded-[12px] bg-surface px-3 py-2 text-[14px] shadow-[0_0_0_1px_var(--hairline)]">
                        {promise.description}
                      </li>
                    ))}
                  </ul>
                )}
              </li>
            );
          })}
        </ol>

        {state.s === "running" && (
          <div>
            <button type="button" onClick={onCancel} className="rounded-[10px] bg-fill px-4 py-2 text-[15px] hover:bg-hairline">
              Cancel
            </button>
          </div>
        )}
        {state.s === "failed" && (
          <div className="flex flex-col gap-3 rounded-[16px] bg-surface p-5 shadow-[0_0_0_1px_var(--hairline)]">
            <p className="text-[17px] font-medium" role="alert">
              {state.message}
            </p>
            {state.spentMicros > 0 && <p className="text-[13px] text-ink-2 tabular-nums">{formatMicros(state.spentMicros)} spent</p>}
            <div className="flex gap-2">
              {state.retryable && (
                <button type="button" onClick={() => dispatch({ type: "retry" })} className="rounded-[10px] bg-accent px-4 py-2 text-[15px] font-medium text-accent-ink">
                  Try again
                </button>
              )}
              <button type="button" onClick={() => dispatch({ type: "edit" })} className="rounded-[10px] bg-fill px-4 py-2 text-[15px] hover:bg-hairline">
                Change files
              </button>
            </div>
          </div>
        )}
        {state.s === "cancelled" && (
          <div className="flex flex-col gap-3 rounded-[16px] bg-surface p-5 shadow-[0_0_0_1px_var(--hairline)]">
            <p className="text-[17px] font-medium">Check stopped</p>
            <p className="text-[13px] text-ink-2 tabular-nums">At least {formatMicros(state.spentMicros)} spent</p>
            <div className="flex gap-2">
              <button type="button" onClick={() => dispatch({ type: "retry" })} className="rounded-[10px] bg-accent px-4 py-2 text-[15px] font-medium text-accent-ink">
                Check again
              </button>
              <button type="button" onClick={() => dispatch({ type: "edit" })} className="rounded-[10px] bg-fill px-4 py-2 text-[15px] hover:bg-hairline">
                Change files
              </button>
            </div>
          </div>
        )}
      </div>
    </section>
  );
}

export function Checker({ samples }: { samples: Sample[] }) {
  const [state, dispatch] = useReducer(reduce, initialState);
  const controllers = useRef(new Map<number, AbortController>());
  const nextId = useRef(0);

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

  const addFile = async (role: "bill" | "offer", file: File) => {
    const id = `doc-${++nextId.current}`;
    dispatch({ type: role === "bill" ? "bill_added" : "offer_added", id, name: file.name });
    try {
      const pages = await prepareFile(file, role === "bill" ? MAX_BILL_PAGES : MAX_OFFER_PAGES);
      dispatch({ type: "doc_prepared", id, pages });
    } catch (error) {
      dispatch({ type: "doc_failed", id, message: error instanceof PrepareError ? error.message : "This file could not be opened." });
    }
  };

  // A sample's bill and offer enter the check together; a later sample click wins over one still loading.
  const sampleToken = useRef(0);
  const [loadingSample, setLoadingSample] = useState<string | null>(null);
  const runSample = async (sample: Sample) => {
    const token = ++sampleToken.current;
    setLoadingSample(sample.id);
    try {
      const blob = await (await fetch(sample.bill)).blob();
      const pages = await prepareFile(new File([blob], `${sample.title}.pdf`, { type: "application/pdf" }), MAX_BILL_PAGES);
      if (token !== sampleToken.current) return;
      dispatch({ type: "sample_ready", bill: { id: `sample-${token}`, name: `${sample.title}.pdf`, status: "ready", pages }, offerText: sample.proof });
    } finally {
      if (token === sampleToken.current) setLoadingSample(null);
    }
  };

  if (state.s === "done") return <ResultView state={state} dispatch={dispatch} />;
  if (state.s !== "composing") return <Working state={state} onCancel={cancel} dispatch={dispatch} />;

  const { bill, offerFile, offerText } = state.inputs;
  const ready = checkInput(state.inputs) !== null;
  const hero = samples[0];

  return (
    <section className="mx-auto w-full max-w-[1180px] px-6 pb-20">
      <div className="grid items-start gap-12 pt-10 lg:grid-cols-[minmax(0,1fr)_minmax(0,0.92fr)] lg:gap-16 lg:pt-16">
        <div>
          <h1 className="text-[40px] font-semibold leading-[1.04] tracking-[-0.03em] text-balance sm:text-[56px]">Find what your bill owes you</h1>
          <p className="mt-5 max-w-[34rem] text-[19px] leading-[1.5] text-ink-2 text-pretty">
            Add a phone, internet or utility bill and the offer you signed up for. Billproof marks each charge that breaks it and writes the message that gets the money back.
          </p>

          <div className="mt-10 rounded-[24px] bg-surface p-3 shadow-[0_0_0_1px_var(--hairline),0_24px_48px_-28px_rgb(0_0_0/0.25)]">
            <div className="p-3">
              <p className="mb-2 text-[13px] font-medium text-ink-2">Bill</p>
              {bill ? (
                <DocChip doc={bill} onRemove={() => dispatch({ type: "doc_removed", id: bill.id })} />
              ) : (
                <FileTarget label="Choose the bill" onFile={(file) => void addFile("bill", file)} className="flex w-full items-center gap-4 rounded-[14px] bg-fill p-4 text-left transition-colors hover:bg-hairline">
                  <DocIcon />
                  <span>
                    <span className="block text-[15px] font-medium">Drop the bill here, or choose a file</span>
                    <span className="block text-[13px] text-ink-2">PDF or photo, up to 6 pages</span>
                  </span>
                </FileTarget>
              )}
            </div>

            <div className="p-3 pt-1">
              <p className="mb-2 text-[13px] font-medium text-ink-2">What you were promised</p>
              {offerFile ? (
                <DocChip doc={offerFile} onRemove={() => dispatch({ type: "doc_removed", id: offerFile.id })} />
              ) : (
                <div className="rounded-[14px] bg-fill focus-within:shadow-[0_0_0_2px_var(--accent)]">
                  <textarea
                    value={offerText}
                    onChange={(event) => dispatch({ type: "offer_text", text: event.target.value })}
                    placeholder="Paste the order confirmation or plan details"
                    aria-label="What you were promised"
                    className="block h-[120px] w-full resize-none bg-transparent px-4 pt-3.5 text-[15px] leading-6 placeholder:text-ink-3 focus:outline-none"
                  />
                  <div className="flex justify-end px-3 pb-2.5">
                    <FileTarget label="Add the offer as a file" onFile={(file) => void addFile("offer", file)} className="rounded-[8px] px-2 py-1 text-[13px] text-ink-2 hover:bg-hairline hover:text-ink">
                      Add a screenshot or PDF
                    </FileTarget>
                  </div>
                </div>
              )}
            </div>

            <div className="flex flex-wrap items-center justify-between gap-3 p-3 pt-2">
              <p className="text-[13px] text-ink-2">Read by Meta&apos;s Muse Ember. Billproof doesn&apos;t keep your files.</p>
              <button
                type="button"
                disabled={!ready}
                onClick={() => dispatch({ type: "start" })}
                className="h-11 rounded-[12px] bg-accent px-6 text-[15px] font-semibold text-accent-ink transition-[opacity,transform] active:scale-[0.98] disabled:opacity-35"
              >
                Check bill
              </button>
            </div>
          </div>
        </div>

        {hero && <Hero sample={hero} onRun={() => void runSample(hero)} busy={loadingSample !== null} />}
      </div>

      <div className="mt-20">
        <h2 className="text-[22px] font-semibold tracking-[-0.015em]">Try a sample bill</h2>
        <div className="mt-5 grid gap-4 sm:grid-cols-3">
          {samples.map((sample) => (
            <button
              key={sample.id}
              type="button"
              disabled={loadingSample !== null}
              onClick={() => void runSample(sample)}
              className="group flex flex-col gap-4 rounded-[20px] bg-surface p-4 text-left shadow-[0_0_0_1px_var(--hairline)] transition-[transform,box-shadow] duration-300 hover:-translate-y-0.5 hover:shadow-[0_0_0_1px_var(--hairline),0_18px_36px_-24px_rgb(0_0_0/0.3)] disabled:cursor-wait"
            >
              <BillPage image={sample.image} alt="" visibleAspect="1200 / 560" />
              <span>
                <span className="block text-[15px] font-medium">{loadingSample === sample.id ? "Opening…" : sample.title}</span>
                <span className="block text-[13px] text-ink-2">{sample.outcome}</span>
              </span>
            </button>
          ))}
        </div>
      </div>
    </section>
  );
}
