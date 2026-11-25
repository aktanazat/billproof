"use client";

import { useEffect, useReducer, useRef, type ChangeEvent, type DragEvent } from "react";
import { checkInput, initialState, reduce, type CheckAction, type Doc } from "@/lib/check-machine";
import { formatMicros } from "@/lib/cost";
import { MAX_BILL_PAGES, MAX_OFFER_PAGES, prepareFile, PrepareError } from "@/lib/prepare";
import type { CheckEvent, CheckInput, Stage } from "@/lib/result";
import { ResultView } from "./result-view";

export type Sample = { id: string; title: string; bill: string; proof: string };

const STAGE_TEXT: Record<Stage, string> = {
  reading_bill: "Reading the bill",
  rereading_bill: "Reading the bill again, more carefully",
  reading_offer: "Reading what you were promised",
  comparing: "Comparing each charge",
};

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
        if (event.type === "stage") dispatch({ type: "stage", attempt, stage: event.stage });
        else if (event.type === "spent") dispatch({ type: "spent", attempt, micros: event.micros });
        else if (event.type === "result") {
          terminal = true;
          dispatch({ type: "finished", attempt, result: event.result });
        } else {
          terminal = true;
          dispatch({ type: "errored", attempt, failure: event.failure, message: event.message, spentMicros: event.spentMicros, retryable: event.retryable });
        }
      }
    }
  } catch {
    if (signal.aborted) return;
  }
  if (!terminal && !signal.aborted) fail("The connection dropped before the check finished.");
}

function DocRow({ doc, onRemove }: { doc: Doc; onRemove: () => void }) {
  const detail = doc.status === "preparing" ? "Opening…" : doc.status === "failed" ? doc.message : doc.pages.length === 1 ? "1 page" : `${doc.pages.length} pages`;
  return (
    <div className="flex items-center gap-3 rounded-[10px] bg-fill px-3 py-2.5">
      <div className="min-w-0 flex-1">
        <div className="truncate text-[15px]">{doc.name}</div>
        <div className={`text-[13px] ${doc.status === "failed" ? "text-danger" : "text-ink-2"}`} role={doc.status === "failed" ? "alert" : undefined}>
          {detail}
        </div>
      </div>
      <button type="button" onClick={onRemove} className="rounded-md px-2 py-1 text-[13px] text-ink-2 hover:bg-fill hover:text-ink">
        Remove
      </button>
    </div>
  );
}

function FilePicker({ label, accept, onFile, children }: { label: string; accept: string; onFile: (file: File) => void; children: React.ReactNode }) {
  const input = useRef<HTMLInputElement>(null);
  const onDrop = (event: DragEvent) => {
    event.preventDefault();
    const file = event.dataTransfer.files[0];
    if (file) onFile(file);
  };
  return (
    <div onDragOver={(event) => event.preventDefault()} onDrop={onDrop}>
      <input
        ref={input}
        type="file"
        accept={accept}
        aria-label={label}
        className="sr-only"
        onChange={(event: ChangeEvent<HTMLInputElement>) => {
          const file = event.target.files?.[0];
          event.target.value = "";
          if (file) onFile(file);
        }}
      />
      <button type="button" onClick={() => input.current?.click()} className="w-full">
        {children}
      </button>
    </div>
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

  const runSample = async (sample: Sample) => {
    if (state.s !== "composing") return;
    if (state.inputs.offerFile) dispatch({ type: "doc_removed", id: state.inputs.offerFile.id });
    dispatch({ type: "offer_text", text: sample.proof });
    const blob = await (await fetch(sample.bill)).blob();
    await addFile("bill", new File([blob], `${sample.title}.pdf`, { type: "application/pdf" }));
    dispatch({ type: "start" });
  };

  if (state.s === "done") {
    return <ResultView state={state} dispatch={dispatch} />;
  }

  if (state.s !== "composing") {
    const bill = state.inputs.bill?.status === "ready" ? state.inputs.bill.pages[0] : null;
    return (
      <section className="mx-auto grid w-full max-w-[880px] gap-8 px-6 py-10 md:grid-cols-[280px_1fr] md:items-center">
        {bill && <img src={bill.image} alt="Your bill, first page" className="w-full rounded-[10px] shadow-[0_1px_3px_rgb(0_0_0/0.12)]" />}
        <div className="space-y-4" aria-live="polite">
          {state.s === "running" && (
            <>
              <p className="text-[22px] font-medium">{state.stage ? STAGE_TEXT[state.stage] : "Sending your files"}</p>
              {state.spentMicros > 0 && <p className="text-[15px] text-ink-2 tabular-nums">{formatMicros(state.spentMicros)} so far</p>}
              <button type="button" onClick={cancel} className="rounded-[10px] bg-fill px-4 py-2 text-[15px] hover:bg-hairline">
                Cancel
              </button>
            </>
          )}
          {state.s === "failed" && (
            <>
              <p className="text-[22px] font-medium" role="alert">
                {state.message}
              </p>
              {state.spentMicros > 0 && <p className="text-[15px] text-ink-2 tabular-nums">{formatMicros(state.spentMicros)} spent</p>}
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
            </>
          )}
          {state.s === "cancelled" && (
            <>
              <p className="text-[22px] font-medium">Check stopped</p>
              <p className="text-[15px] text-ink-2 tabular-nums">At least {formatMicros(state.spentMicros)} spent</p>
              <div className="flex gap-2">
                <button type="button" onClick={() => dispatch({ type: "retry" })} className="rounded-[10px] bg-accent px-4 py-2 text-[15px] font-medium text-accent-ink">
                  Check again
                </button>
                <button type="button" onClick={() => dispatch({ type: "edit" })} className="rounded-[10px] bg-fill px-4 py-2 text-[15px] hover:bg-hairline">
                  Change files
                </button>
              </div>
            </>
          )}
        </div>
      </section>
    );
  }

  const { bill, offerFile, offerText } = state.inputs;
  const ready = checkInput(state.inputs) !== null;
  return (
    <section className="mx-auto w-full max-w-[880px] px-6 py-10">
      <h1 className="text-[28px] font-semibold tracking-[-0.01em] text-balance">Check a bill against what you were promised</h1>

      <div className="mt-8 grid gap-4 md:grid-cols-2">
        <div className="rounded-[14px] bg-surface p-5 shadow-[0_0_0_1px_var(--hairline)]">
          <h2 className="text-[15px] font-medium">Bill</h2>
          <div className="mt-3">
            {bill ? (
              <DocRow doc={bill} onRemove={() => dispatch({ type: "doc_removed", id: bill.id })} />
            ) : (
              <FilePicker label="Choose the bill" accept="application/pdf,image/jpeg,image/png,image/webp" onFile={(file) => void addFile("bill", file)}>
                <span className="flex h-[148px] items-center justify-center rounded-[10px] border border-dashed border-hairline text-[15px] text-ink-2 hover:bg-fill">
                  PDF or photo
                </span>
              </FilePicker>
            )}
          </div>
        </div>

        <div className="rounded-[14px] bg-surface p-5 shadow-[0_0_0_1px_var(--hairline)]">
          <h2 className="text-[15px] font-medium">What you were promised</h2>
          <div className="mt-3">
            {offerFile ? (
              <DocRow doc={offerFile} onRemove={() => dispatch({ type: "doc_removed", id: offerFile.id })} />
            ) : (
              <>
                <textarea
                  value={offerText}
                  onChange={(event) => dispatch({ type: "offer_text", text: event.target.value })}
                  placeholder="Paste the offer email or plan details"
                  aria-label="What you were promised"
                  className="h-[110px] w-full resize-none rounded-[10px] bg-fill px-3 py-2.5 text-[15px] placeholder:text-ink-3 focus:outline-none focus-visible:shadow-[0_0_0_2px_var(--accent)]"
                />
                <FilePicker label="Add the offer as a file" accept="application/pdf,image/jpeg,image/png,image/webp" onFile={(file) => void addFile("offer", file)}>
                  <span className="mt-1 block text-left text-[13px] text-accent hover:underline">Add a screenshot or PDF instead</span>
                </FilePicker>
              </>
            )}
          </div>
        </div>
      </div>

      <div className="mt-6 flex flex-wrap items-center gap-x-4 gap-y-2">
        <button
          type="button"
          disabled={!ready}
          onClick={() => dispatch({ type: "start" })}
          className="rounded-[10px] bg-accent px-5 py-2.5 text-[15px] font-medium text-accent-ink transition-opacity disabled:opacity-40"
        >
          Check bill
        </button>
        <p className="text-[13px] text-ink-2">Files are sent to Meta&apos;s Muse Ember model to be read. Billproof doesn&apos;t keep them.</p>
      </div>

      <div className="mt-12">
        <h2 className="text-[13px] text-ink-2">Samples</h2>
        <div className="mt-2 flex flex-wrap gap-2">
          {samples.map((sample) => (
            <button key={sample.id} type="button" onClick={() => void runSample(sample)} className="rounded-[10px] bg-surface px-3.5 py-2 text-[15px] shadow-[0_0_0_1px_var(--hairline)] hover:bg-fill">
              {sample.title}
            </button>
          ))}
        </div>
      </div>
    </section>
  );
}
