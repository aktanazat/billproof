"use client";

import { useEffect, useReducer, useRef, useState, type ChangeEvent, type DragEvent, type ReactNode } from "react";
import { checkInput, initialState, reduce, type Call, type CheckAction, type CheckState, type Doc, type Inputs } from "@/lib/check-machine";
import { formatMicros } from "@/lib/cost";
import { usd } from "@/lib/letter";
import { isAudio, MAX_BILL_PAGES, MAX_OFFER_PAGES, prepareCall, prepareFile, PrepareError } from "@/lib/prepare";
import { MAX_BILLS, MAX_CALL_SECONDS, type CheckEvent, type CheckInput, type Stage } from "@/lib/result";
import { BillPage, type Mark } from "./bill-page";
import { formatClock, Waveform } from "./evidence";
import { ResultView } from "./result-view";
import { YearView } from "./year-view";

export type Sample = {
  id: string;
  title: string;
  outcome: string;
  image: string;
  bills: string[];
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
      <button type="button" onClick={() => input.current?.click()} className={`${className ?? ""} ${over ? "outline-2 outline-vermilion" : ""}`}>
        {children}
      </button>
    </div>
  );
}

function DocChip({ doc, onRemove }: { doc: Doc; onRemove: () => void }) {
  const detail = doc.status === "preparing" ? "Opening…" : doc.status === "failed" ? doc.message : doc.pages.length === 1 ? "1 page" : `${doc.pages.length} pages`;
  return (
    <div className="flex items-center gap-3 py-2">
      <div className="paper h-[52px] w-[40px] shrink-0 overflow-hidden">{doc.status === "ready" && <img src={doc.pages[0].image} alt="" className="h-full w-full object-cover object-top" />}</div>
      <div className="min-w-0 flex-1">
        <div className="truncate text-[14px] font-medium">{doc.name}</div>
        <div className={`text-[12px] ${doc.status === "failed" ? "text-vermilion-ink" : "text-ink-2"}`} role={doc.status === "failed" ? "alert" : undefined}>
          {detail}
        </div>
      </div>
      <button type="button" onClick={onRemove} className="px-2 py-1 text-[12px] text-ink-2 underline-offset-4 hover:text-ink hover:underline">
        Remove
      </button>
    </div>
  );
}

function CallChip({ call, onRemove }: { call: Call; onRemove: () => void }) {
  return (
    <div className="flex items-center gap-4 py-2">
      <div className="min-w-0 flex-1">
        <div className="truncate text-[14px] font-medium">{call.name}</div>
        {call.status === "ready" ? (
          <div className="mt-2 flex items-center gap-3">
            <Waveform peaks={call.peaks} className="h-8 flex-1" />
            <span className="text-[12px] text-ink-2 tabular-nums">{formatClock(call.seconds)}</span>
          </div>
        ) : (
          <div className={`text-[12px] ${call.status === "failed" ? "text-vermilion-ink" : "text-ink-2"}`} role={call.status === "failed" ? "alert" : undefined}>
            {call.status === "failed" ? call.message : "Listening to the file…"}
          </div>
        )}
      </div>
      <button type="button" onClick={onRemove} className="px-2 py-1 text-[12px] text-ink-2 underline-offset-4 hover:text-ink hover:underline">
        Remove
      </button>
    </div>
  );
}

function Spinner() {
  return <span aria-hidden className="inline-block size-[14px] animate-spin rounded-full border-[1.5px] border-rule border-t-vermilion" />;
}

type Step = { key: "bill" | "offer" | "compare" | "challenge"; stages: Stage[] };
const STAGE_ORDER: Stage[] = ["reading_bill", "rereading_bill", "reading_offer", "comparing", "challenging"];

function stepStatus(step: Step, stage: Stage | null, active: boolean): "done" | "now" | "later" {
  if (!stage) return step.key === "bill" && active ? "now" : "later";
  const at = STAGE_ORDER.indexOf(stage);
  const first = Math.min(...step.stages.map((s) => STAGE_ORDER.indexOf(s)));
  const last = Math.max(...step.stages.map((s) => STAGE_ORDER.indexOf(s)));
  if (at > last) return "done";
  if (at >= first) return active ? "now" : "done";
  return "later";
}

function Failure({ state, dispatch }: { state: Extract<CheckState, { s: "failed" } | { s: "cancelled" }>; dispatch: (action: CheckAction) => void }) {
  return (
    <div className="flex flex-col gap-3 border-t border-rule pt-5">
      <p className="display text-[28px] leading-tight" role={state.s === "failed" ? "alert" : undefined}>
        {state.s === "failed" ? state.message : "Check stopped."}
      </p>
      <p className="text-[13px] text-ink-2 tabular-nums">{state.s === "cancelled" ? `At least ${formatMicros(state.spentMicros)} spent` : state.spentMicros > 0 ? `${formatMicros(state.spentMicros)} spent` : ""}</p>
      <div className="flex gap-2">
        {(state.s === "cancelled" || state.retryable) && (
          <button type="button" onClick={() => dispatch({ type: "retry" })} className="h-10 rounded-full bg-ink px-5 text-[14px] font-medium text-paper">
            Check again
          </button>
        )}
        <button type="button" onClick={() => dispatch({ type: "edit" })} className="h-10 rounded-full px-5 text-[14px] shadow-[inset_0_0_0_1px_var(--rule)] hover:bg-fill">
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
    <section className="mx-auto w-full max-w-[1240px] px-6 pb-20 pt-4">
      <div className="flex items-end justify-between gap-6 border-b border-rule pb-5">
        <h1 className="display text-[44px] leading-none sm:text-[56px]">
          Reading {bills.length} bills at once<span className="text-vermilion">.</span>
        </h1>
        <p className="text-[13px] text-ink-2 tabular-nums">
          {done} of {bills.length} read{state.spentMicros > 0 ? `, ${formatMicros(state.spentMicros)}` : ""}
        </p>
      </div>
      <ol className="mt-8 grid grid-cols-3 gap-5 sm:grid-cols-4 lg:grid-cols-6">
        {bills.map((doc, i) => {
          const month = live?.months[i];
          const lines = live?.lines[i] ?? [];
          const marks: Mark[] = lines.flatMap((line, j) => (line.box && line.page === 1 ? [{ id: `R${j}`, box: line.box, tone: "read" as const }] : []));
          const claimed = month?.outcome === "checked" ? month.claims.reduce((t, c) => t + c.amountCents, 0) : 0;
          return (
            <li key={doc.id} className="flex flex-col gap-2">
              {doc.status === "ready" && <BillPage image={doc.pages[0].image} alt={`Bill ${i + 1}`} marks={marks} sweeping={!month && state.s === "running"} visibleAspect="1200 / 1000" />}
              <p className={`text-[13px] tabular-nums ${claimed > 0 ? "font-medium text-vermilion-ink" : "text-ink-2"}`}>
                {month ? (month.outcome === "checked" ? (claimed > 0 ? `+${usd(claimed)}` : "Matches the offer") : "Couldn't read") : lines.length > 0 ? `${lines.length} lines read` : "Waiting"}
              </p>
            </li>
          );
        })}
      </ol>
      <div className="mt-10">{state.s === "running" ? <CancelButton onCancel={onCancel} /> : <Failure state={state} dispatch={dispatch} />}</div>
    </section>
  );
}

function CancelButton({ onCancel }: { onCancel: () => void }) {
  return (
    <button type="button" onClick={onCancel} className="h-10 self-start rounded-full px-5 text-[14px] shadow-[inset_0_0_0_1px_var(--rule)] hover:bg-fill">
      Cancel
    </button>
  );
}

function Working({ state, onCancel, dispatch }: { state: Exclude<CheckState, { s: "composing" } | { s: "done" }>; onCancel: () => void; dispatch: (action: CheckAction) => void }) {
  if (state.inputs.bills.length > 1) return <WorkingYear state={state} onCancel={onCancel} dispatch={dispatch} />;
  const bill = state.inputs.bills[0];
  const page = bill?.status === "ready" ? bill.pages[0] : null;
  const running = state.s === "running";
  const live = running ? state.live : null;
  const stage = state.stage;
  const reading = running && (stage === null || stage === "reading_bill" || stage === "rereading_bill");
  const lines = live?.lines[0] ?? [];
  const marks: Mark[] = lines.flatMap((line, i) => (line.box && line.page === 1 ? [{ id: `R${i}`, box: line.box, tone: "read" as const }] : []));
  const offer = state.inputs.offer;
  const isCall = offer.kind === "call";
  const steps: (Step & { label: string })[] = [
    { key: "bill", stages: ["reading_bill", "rereading_bill"], label: stage === "rereading_bill" ? "Reading the bill again, more carefully" : "Reading the bill" },
    ...(offer.kind === "none" ? [] : [{ key: "offer" as const, stages: ["reading_offer"] as Stage[], label: isCall ? "Listening to the call" : "Reading what you were promised" }]),
    { key: "compare", stages: ["comparing"], label: "Checking every dollar in code" },
    ...(offer.kind === "none" ? [] : [{ key: "challenge" as const, stages: ["challenging"] as Stage[], label: "Arguing the company's side" }]),
  ];
  const thought = (step: Step) => (live?.thoughts ?? []).filter((t) => step.stages.includes(t.stage)).map((t) => t.text).join("\n\n");
  const current = steps.find((step) => stepStatus(step, stage, running) === "now");

  return (
    <section className="mx-auto grid w-full max-w-[1240px] gap-10 px-6 pb-20 pt-4 lg:grid-cols-[minmax(0,0.9fr)_minmax(0,1fr)] lg:gap-16">
      <div className="lg:sticky lg:top-6 lg:self-start">{page && <BillPage image={page.image} alt="Your bill, first page" marks={marks} sweeping={reading} />}</div>

      <div className="flex flex-col gap-8" aria-live="polite">
        <div className="flex items-baseline justify-between border-b border-rule pb-4">
          <p className="text-[13px] text-ink-2">Muse Ember</p>
          <p className="text-[13px] text-ink-2 tabular-nums">{state.spentMicros > 0 ? `${formatMicros(state.spentMicros)} spent` : "Starting"}</p>
        </div>

        {current && thought(current) && <p className="display caret text-[30px] leading-[1.2] text-ink sm:text-[34px]">{thought(current).split("\n\n").at(-1)}</p>}

        <ol className="flex flex-col">
          {steps.map((step, index) => {
            const status = stepStatus(step, stage, running);
            return (
              <li key={step.key} className={`border-t border-rule py-4 transition-opacity duration-300 ${status === "later" ? "opacity-35" : ""}`}>
                <div className="flex items-center gap-3">
                  <span className="w-5 text-[12px] text-ink-3 tabular-nums">{String(index + 1).padStart(2, "0")}</span>
                  <span className="flex-1 text-[16px] font-medium">{step.label}</span>
                  {status === "now" ? <Spinner /> : status === "done" ? <span className="text-[12px] text-ink-2">Done</span> : null}
                </div>

                {step.key === "bill" && lines.length > 0 && (
                  <ul className="ml-8 mt-3">
                    {lines.map((line, i) => (
                      <li key={i} className="appear flex items-baseline justify-between gap-4 border-b border-dotted border-rule py-1.5 text-[14px]">
                        <span className="truncate">{line.label}</span>
                        <span className="tabular-nums text-ink-2">{usd(line.amount_cents)}</span>
                      </li>
                    ))}
                  </ul>
                )}

                {step.key === "offer" && live && live.heard.length > 0 && (
                  <ul className="ml-8 mt-3 flex flex-col gap-2">
                    {live.heard.map((turn, i) => (
                      <li key={i} className="appear grid grid-cols-[4.5rem_1fr] gap-3 text-[14px] leading-snug">
                        <span className="text-ink-3 tabular-nums">
                          {turn.speaker === "company" ? "Company" : turn.speaker === "customer" ? "You" : "Other"} {formatClock(turn.start_seconds)}
                        </span>
                        <span className={turn.speaker === "company" ? "text-ink" : "text-ink-2"}>{turn.text}</span>
                      </li>
                    ))}
                  </ul>
                )}

                {step.key === "offer" && live && live.promises.length > 0 && (
                  <ul className="ml-8 mt-3 flex flex-col gap-1.5">
                    {live.promises.map((promise, i) => (
                      <li key={i} className="appear text-[14px] text-ink">
                        <span className="text-vermilion">→ </span>
                        {promise.description}
                      </li>
                    ))}
                  </ul>
                )}

                {step.key === "challenge" && live && live.challenges.length > 0 && (
                  <ul className="ml-8 mt-3 flex flex-col gap-3">
                    {live.challenges.map((challenge, i) => (
                      <li key={i} className="appear flex items-start justify-between gap-4 text-[14px] leading-snug">
                        <span className="text-ink-2">{challenge.looked_for}</span>
                        <span className={`stamp shrink-0 rounded-[3px] px-2 py-0.5 text-[11px] font-semibold tracking-wide ${challenge.verdict === "stands" ? "text-ink shadow-[inset_0_0_0_1.5px_var(--ink)]" : "text-vermilion-ink shadow-[inset_0_0_0_1.5px_var(--vermilion)]"}`}>
                          {challenge.verdict === "stands" ? "STANDS" : "DROPPED"}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </li>
            );
          })}
        </ol>

        {state.s === "running" ? <CancelButton onCancel={onCancel} /> : <Failure state={state} dispatch={dispatch} />}
      </div>
    </section>
  );
}

function SampleCard({ sample, busy, loading, onRun }: { sample: Sample; busy: boolean; loading: boolean; onRun: () => void }) {
  return (
    <button type="button" disabled={busy} onClick={onRun} className="group flex flex-col gap-3 text-left disabled:cursor-wait">
      <div className="relative transition-transform duration-500 group-hover:-translate-y-1 group-hover:rotate-[-0.6deg]">
        {sample.bills.length > 1 && <div aria-hidden className="paper absolute inset-0 translate-x-2 translate-y-2 rotate-[1.2deg]" />}
        {sample.bills.length > 1 && <div aria-hidden className="paper absolute inset-0 translate-x-1 translate-y-1 rotate-[0.6deg]" />}
        <BillPage image={sample.image} alt="" visibleAspect="1200 / 640" />
        {sample.offer.kind === "call" && (
          <div className="paper absolute -bottom-3 right-3 flex items-center gap-2 px-3 py-2">
            <span className="size-2 rounded-full bg-vermilion" />
            <span className="text-[12px] font-medium">Recorded call</span>
          </div>
        )}
      </div>
      <span className="mt-1">
        <span className="block text-[15px] font-medium">{loading ? "Opening…" : sample.title}</span>
        <span className="block text-[13px] text-ink-2">{sample.outcome}</span>
      </span>
    </button>
  );
}

async function fetchFile(url: string, name: string, type: string): Promise<File> {
  return new File([await (await fetch(url)).blob()], name, { type });
}

export function Checker({ samples }: { samples: Sample[] }) {
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

  const addBills = (files: File[]) => {
    const room = MAX_BILLS - (state.s === "composing" ? state.inputs.bills.length : 0);
    const docs = files.slice(0, room).map((file) => ({ id: id(), name: file.name, file }));
    dispatch({ type: "bills_added", docs: docs.map(({ id: docId, name }) => ({ id: docId, name })) });
    for (const doc of docs) void prepareDoc(doc.id, doc.file, MAX_BILL_PAGES);
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
      const bills = await Promise.all(
        sample.bills.map(async (url, i): Promise<Doc> => {
          const name = sample.bills.length > 1 ? `${sample.title} ${i + 1}.pdf` : `${sample.title}.pdf`;
          return { id: `sample-${token}-${i}`, name, status: "ready", pages: await prepareFile(await fetchFile(url, name, "application/pdf"), MAX_BILL_PAGES) };
        }),
      );
      const offer: Inputs["offer"] =
        sample.offer.kind === "text"
          ? { kind: "text", text: sample.offer.text }
          : { kind: "call", call: { id: `sample-${token}-call`, name: "Sales call.m4a", status: "ready", ...(await prepareCall(await fetchFile(sample.offer.url, "Sales call.m4a", "audio/mp4"), MAX_CALL_SECONDS)) } };
      if (token !== sampleToken.current) return;
      dispatch({ type: "sample_ready", inputs: { bills, offer } });
    } finally {
      if (token === sampleToken.current) setLoadingSample(null);
    }
  };

  if (state.s === "done") {
    if (state.result.outcome === "year") return <YearView state={state} result={state.result} dispatch={dispatch} />;
    const bill = state.inputs.bills[0];
    const { offer } = state.inputs;
    return (
      <ResultView
        result={state.result}
        pages={bill?.status === "ready" ? bill.pages : []}
        offerText={offer.kind === "text" ? offer.text : null}
        callUrl={offer.kind === "call" && offer.call.status === "ready" ? offer.call.url : null}
        bill={0}
        selection={state.selections[0]}
        thoughts={state.thoughts}
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
    <section className="mx-auto w-full max-w-[1240px] px-6 pb-24">
      <div className="pt-10 lg:pt-16">
        <h1 className="display max-w-[14ch] text-[64px] leading-[0.92] tracking-[-0.025em] sm:text-[104px]">
          Put your bill on the stand<span className="text-vermilion">.</span>
        </h1>
        <p className="mt-7 max-w-[40rem] text-[19px] leading-[1.5] text-ink-2 text-pretty">
          Billproof sets a phone, internet or utility bill against what you were promised: the offer email, a screenshot, even a recording of the sales call. Muse Ember marks every charge that breaks it, then argues the company&apos;s side before anything is claimed.
        </p>
      </div>

      <div className="mt-12 grid gap-px overflow-hidden rounded-[4px] bg-rule shadow-[0_0_0_1px_var(--rule)] lg:grid-cols-[1fr_1.15fr_auto]">
        <div className="bg-paper p-5">
          <p className="text-[12px] text-ink-3">The bill</p>
          {bills.length > 0 ? (
            <div className="mt-2 max-h-[220px] overflow-y-auto">
              {bills.map((doc) => (
                <DocChip key={doc.id} doc={doc} onRemove={() => dispatch({ type: "removed", id: doc.id })} />
              ))}
              {bills.length < MAX_BILLS && (
                <FileTarget label="Add more bills" accept={BILL_ACCEPT} multiple onFiles={addBills} className="mt-1 text-[13px] text-ink-2 underline underline-offset-4 hover:text-ink">
                  Add another month
                </FileTarget>
              )}
            </div>
          ) : (
            <FileTarget label="Choose the bill" accept={BILL_ACCEPT} multiple onFiles={addBills} className="mt-3 flex h-[132px] w-full flex-col items-start justify-end text-left">
              <span className="display text-[30px] leading-none">Drop the bill</span>
              <span className="mt-2 text-[13px] text-ink-2">PDF or photo. Drop up to 12 months to read a whole year.</span>
            </FileTarget>
          )}
        </div>

        <div className="bg-paper p-5">
          <p className="text-[12px] text-ink-3">What you were promised</p>
          {offer.kind === "file" ? (
            <DocChip doc={offer.doc} onRemove={() => dispatch({ type: "removed", id: offer.doc.id })} />
          ) : offer.kind === "call" ? (
            <CallChip call={offer.call} onRemove={() => dispatch({ type: "removed", id: offer.call.id })} />
          ) : (
            <>
              <textarea
                value={offer.kind === "text" ? offer.text : ""}
                onChange={(event) => dispatch({ type: "offer_text", text: event.target.value })}
                placeholder="Paste the order confirmation or plan details"
                aria-label="What you were promised"
                className="mt-2 block h-[96px] w-full resize-none bg-transparent text-[15px] leading-6 placeholder:text-ink-3 focus:outline-none"
              />
              <FileTarget label="Add the offer as a file or recording" accept={OFFER_ACCEPT} onFiles={(files) => void addOffer(files[0])} className="text-[13px] text-ink-2 underline underline-offset-4 hover:text-ink">
                Or add a screenshot, PDF, or a recording of the call
              </FileTarget>
            </>
          )}
        </div>

        <div className="flex items-end bg-paper p-5">
          <button
            type="button"
            disabled={!ready}
            onClick={() => dispatch({ type: "start" })}
            className="h-14 w-full rounded-full bg-vermilion px-8 text-[16px] font-semibold text-white transition-[opacity,transform] active:scale-[0.98] disabled:bg-ink disabled:opacity-25 lg:w-auto"
          >
            {bills.length > 1 ? `Check ${bills.length} bills` : "Check bill"}
          </button>
        </div>
      </div>
      <p className="mt-3 text-[12px] text-ink-3">Read by Meta&apos;s Muse Ember. Billproof doesn&apos;t keep your files.</p>

      <div className="mt-24">
        <div className="flex items-baseline justify-between border-b border-rule pb-3">
          <h2 className="display text-[34px] leading-none">Try a sample</h2>
          <p className="text-[13px] text-ink-2">Each runs live on Muse Ember</p>
        </div>
        <div className="mt-8 grid gap-x-6 gap-y-12 sm:grid-cols-2 lg:grid-cols-3">
          {samples.map((sample) => (
            <SampleCard key={sample.id} sample={sample} busy={loadingSample !== null} loading={loadingSample === sample.id} onRun={() => void runSample(sample)} />
          ))}
        </div>
      </div>
    </section>
  );
}
