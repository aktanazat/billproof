import type { PreparedCall, ShownPage } from "./prepare";
import type { TranscriptTurn } from "./schemas";
import { MAX_BILLS, MAX_OFFER_TEXT, MAX_UPLOAD_BYTES } from "./limits";
import type { CheckFailure, CheckInput, CheckResult, PageKind, PreparedPage, SeenChallenge, SeenLine, SeenPromise, SingleResult, Stage } from "./result";

export type Doc =
  | { id: string; name: string; status: "preparing" }
  // `omitted`: pages past the limit that were left out of a long PDF.
  | { id: string; name: string; status: "ready"; pages: ShownPage[]; omitted: number }
  | { id: string; name: string; status: "failed"; message: string };

// A recorded call: the WAV Muse Ember hears, and a playable URL of the original file for the person.
export type Call =
  | { id: string; name: string; status: "preparing" }
  | ({ id: string; name: string; status: "ready" } & PreparedCall)
  | { id: string; name: string; status: "failed"; message: string };

export type Offer = { kind: "none" } | { kind: "text"; text: string } | { kind: "file"; doc: Doc } | { kind: "call"; call: Call };

// Pages of an offer PDF past the limit that weren't read; nothing for any other kind of offer.
export const offerOmitted = (offer: Offer): number => (offer.kind === "file" && offer.doc.status === "ready" ? offer.doc.omitted : 0);

export type Inputs = { bills: Doc[]; offer: Offer };

export type ClaimMark = "selected" | "unselected" | "needs_confirmation";
export type Selection = { claims: Record<string, ClaimMark>; questions: Record<string, boolean> };

export type Thought = { stage: Stage; text: string };
export type Live = {
  thoughts: Thought[];
  lines: Record<number, SeenLine[]>;
  promises: SeenPromise[];
  heard: TranscriptTurn[];
  challenges: SeenChallenge[];
  months: Record<number, SingleResult>;
  sorted: Record<number, PageKind[]>;
};

export type CheckState =
  | { s: "composing"; inputs: Inputs; attempts: number }
  | { s: "running"; inputs: Inputs; attempts: number; attempt: number; stage: Stage | null; spentMicros: number; live: Live }
  // `saved` is set when a sample's live check was refused and its saved result is shown instead: why, and from when.
  | { s: "done"; inputs: Inputs; attempts: number; result: CheckResult; selections: Selection[]; saved: string | null }
  // `spentFinal` is false when the connection dropped mid-check: only the server knows the final cost, so the amount
  // shown is what had been reported so far, a lower bound. A stopped check keeps `live`, so the months a year check
  // finished before it stopped stay on screen.
  // `bill`: in a year check, the statement the failure belongs to and its reason, marked on the progress screen and,
  // back on the start screen, on that file's row.
  | { s: "failed"; inputs: Inputs; attempts: number; stage: Stage | null; failure: CheckFailure; message: string; spentMicros: number; spentFinal: boolean; retryable: boolean; live: Live; bill: { index: number; message: string } | null }
  | { s: "cancelled"; inputs: Inputs; attempts: number; stage: Stage | null; spentMicros: number; live: Live };

export type CheckAction =
  | { type: "bills_added"; docs: { id: string; name: string }[] }
  | { type: "offer_file_added"; id: string; name: string }
  | { type: "call_added"; id: string; name: string }
  | { type: "doc_prepared"; id: string; pages: ShownPage[]; omitted: number }
  | { type: "call_prepared"; id: string; call: PreparedCall }
  | { type: "prep_failed"; id: string; message: string }
  | { type: "removed"; id: string }
  | { type: "offer_text"; text: string }
  | { type: "start" }
  | { type: "sample_ready"; inputs: Inputs }
  | { type: "stage"; attempt: number; stage: Stage }
  | { type: "reread"; attempt: number; bill: number }
  | { type: "spent"; attempt: number; micros: number }
  | { type: "thought"; attempt: number; stage: Stage; text: string }
  | { type: "line_read"; attempt: number; bill: number; line: SeenLine }
  | { type: "promise_read"; attempt: number; promise: SeenPromise }
  | { type: "turn_heard"; attempt: number; turn: TranscriptTurn }
  | { type: "challenged"; attempt: number; challenge: SeenChallenge }
  | { type: "pages_sorted"; attempt: number; bill: number; kinds: PageKind[] }
  | { type: "month_done"; attempt: number; bill: number; result: SingleResult }
  | { type: "finished"; attempt: number; result: CheckResult; saved?: string }
  // `spentMicros` is null when the server's own account of the cost never arrived.
  | { type: "errored"; attempt: number; failure: CheckFailure; message: string; spentMicros: number | null; retryable: boolean; bill?: number }
  | { type: "cancel" }
  | { type: "retry" }
  | { type: "edit" }
  | { type: "toggle_claim"; bill: number; id: string }
  | { type: "confirm_claim"; bill: number; id: string }
  | { type: "toggle_question"; bill: number; id: string };

export const initialState: CheckState = { s: "composing", inputs: { bills: [], offer: { kind: "none" } }, attempts: 0 };

const DEFAULT_QUESTIONS = new Set(["unagreed_fee", "repeated_charge"]);
const EMPTY_LIVE: Live = { thoughts: [], lines: {}, promises: [], heard: [], challenges: [], months: {}, sorted: {} };

function initialSelection(result: SingleResult): Selection {
  if (result.outcome !== "checked") return { claims: {}, questions: {} };
  return {
    claims: Object.fromEntries(result.claims.map((claim) => [claim.id, claim.needsConfirmation ? "needs_confirmation" : "selected"])),
    questions: Object.fromEntries(result.questions.map((question) => [question.id, DEFAULT_QUESTIONS.has(question.kind)])),
  };
}

// One selection per bill, indexed like the bills: a year keeps each month's choices.
function initialSelections(result: CheckResult): Selection[] {
  if (result.outcome !== "year") return [initialSelection(result)];
  const selections: Selection[] = [];
  for (const month of result.months) selections[month.bill] = initialSelection(month.result);
  return selections;
}

function prepared<T extends { id: string; name: string; status: string }>(item: T, id: string, next: (item: T) => T): T {
  return item.id === id && item.status === "preparing" ? next(item) : item;
}

// Characters as the server's limit counts them, and as people see them: an emoji is one, not JavaScript's two units.
const offerLength = (text: string) => [...text.trim()].length;
// A link to the plan page is a likely paste, but a check reads only the words given and can't open it. Each link must
// be set apart by spaces, so the pattern can't backtrack over a long run of joined links.
const onlyLinks = (text: string) => /^\s*(?:https?:\/\/|www\.)\S*(?:\s+(?:https?:\/\/|www\.)\S*)*\s*$/i.test(text);

// The request body for a check, before its size is weighed.
function requestOf(inputs: Inputs): CheckInput | null {
  if (inputs.bills.length === 0 || inputs.bills.some((doc) => doc.status !== "ready")) return null;
  // Printed rows only place marks on screen; the check gets the image and text.
  const sent = (pages: ShownPage[]): PreparedPage[] => pages.map(({ image, text }) => ({ image, text }));
  const bills = inputs.bills.flatMap((doc) => (doc.status === "ready" ? [{ pages: sent(doc.pages) }] : []));
  const { offer } = inputs;
  switch (offer.kind) {
    case "none":
      return { bills, offer: null };
    case "text": {
      const text = offer.text.trim();
      if (offerLength(text) > MAX_OFFER_TEXT || onlyLinks(text)) return null;
      return { bills, offer: text ? { kind: "text", text } : null };
    }
    case "file":
      return offer.doc.status === "ready" ? { bills, offer: { kind: "pages", pages: sent(offer.doc.pages) } } : null;
    case "call":
      return offer.call.status === "ready" ? { bills, offer: { kind: "audio", wav: offer.call.wav } } : null;
  }
}

// The bytes `JSON.stringify(input)` sends, without building it: page pictures and a call's sound are most of it, plain
// ASCII counted by length, and the rest is encoded as sent.
function uploadBytes(input: CheckInput): number {
  let media = 0;
  const rest = JSON.stringify(input, (key, value: unknown) => {
    if ((key === "image" || key === "wav") && typeof value === "string") {
      media += value.length;
      return "";
    }
    return value;
  });
  return media + new TextEncoder().encode(rest).length;
}

// The request body for a check, or null when the inputs cannot start one.
export function checkInput(inputs: Inputs): CheckInput | null {
  const input = requestOf(inputs);
  return input && uploadBytes(input) <= MAX_UPLOAD_BYTES ? input : null;
}

// Why a check can't start, for beside the disabled button. A file that failed (it didn't open, isn't a kind a check
// reads, or is a recording past the length limit) holds it back until removed, and its row says only what went wrong
// with it; so does an offer longer than a check reads, or one that is only links, which the check can't open, and
// files that together are more than a check takes. A file still opening says so on its row, and an empty screen is
// plain.
export function startBlocker(inputs: Inputs): string | null {
  const offerFailed = (inputs.offer.kind === "file" && inputs.offer.doc.status === "failed") || (inputs.offer.kind === "call" && inputs.offer.call.status === "failed");
  if (offerFailed || inputs.bills.some((doc) => doc.status === "failed")) return "Remove the file that can't be checked to continue.";
  const text = inputs.offer.kind === "text" ? inputs.offer.text : "";
  if (onlyLinks(text)) return "Billproof can't open links. Paste the offer's words, or add a screenshot or PDF of the page.";
  const written = offerLength(text);
  if (written > MAX_OFFER_TEXT) return `The offer is ${written.toLocaleString("en-US")} characters; a check reads up to ${MAX_OFFER_TEXT.toLocaleString("en-US")}. Keep the part with the prices and what's included.`;
  const input = requestOf(inputs);
  const bytes = input ? uploadBytes(input) : 0;
  return bytes > MAX_UPLOAD_BYTES ? `These files add up to ${Math.ceil(bytes / 1e6)} MB; a check takes up to ${MAX_UPLOAD_BYTES / 1e6} MB. Check fewer months at once, or fewer pictures of each bill.` : null;
}

function run(state: CheckState): CheckState {
  const attempt = state.attempts + 1;
  return { s: "running", inputs: state.inputs, attempts: attempt, attempt, stage: null, spentMicros: 0, live: EMPTY_LIVE };
}

function compose(state: Extract<CheckState, { s: "composing" }>, action: CheckAction): CheckState {
  const { inputs } = state;
  const withInputs = (next: Inputs): CheckState => ({ ...state, inputs: next });
  switch (action.type) {
    case "bills_added":
      // The screen trims a drop to the room it saw, which two quick drops can both see; the list never passes a check's limit.
      return withInputs({ ...inputs, bills: [...inputs.bills, ...action.docs.map((doc): Doc => ({ ...doc, status: "preparing" }))].slice(0, MAX_BILLS) });
    case "offer_file_added":
      return withInputs({ ...inputs, offer: { kind: "file", doc: { id: action.id, name: action.name, status: "preparing" } } });
    case "call_added":
      return withInputs({ ...inputs, offer: { kind: "call", call: { id: action.id, name: action.name, status: "preparing" } } });
    case "doc_prepared": {
      const ready = (doc: Doc): Doc => prepared(doc, action.id, (d) => ({ id: d.id, name: d.name, status: "ready", pages: action.pages, omitted: action.omitted }));
      const offer = inputs.offer.kind === "file" ? { kind: "file" as const, doc: ready(inputs.offer.doc) } : inputs.offer;
      return withInputs({ bills: inputs.bills.map(ready), offer });
    }
    case "call_prepared":
      if (inputs.offer.kind !== "call") return state;
      return withInputs({ ...inputs, offer: { kind: "call", call: prepared(inputs.offer.call, action.id, (c) => ({ id: c.id, name: c.name, status: "ready", ...action.call })) } });
    case "prep_failed": {
      const fail = <T extends Doc | Call>(item: T): T => prepared(item, action.id, (d) => ({ id: d.id, name: d.name, status: "failed", message: action.message }) as T);
      const offer: Offer = inputs.offer.kind === "file" ? { kind: "file", doc: fail(inputs.offer.doc) } : inputs.offer.kind === "call" ? { kind: "call", call: fail(inputs.offer.call) } : inputs.offer;
      return withInputs({ bills: inputs.bills.map(fail), offer });
    }
    case "removed": {
      const offerGone = (inputs.offer.kind === "file" && inputs.offer.doc.id === action.id) || (inputs.offer.kind === "call" && inputs.offer.call.id === action.id);
      return withInputs({ bills: inputs.bills.filter((doc) => doc.id !== action.id), offer: offerGone ? { kind: "none" } : inputs.offer });
    }
    case "offer_text":
      if (inputs.offer.kind === "file" || inputs.offer.kind === "call") return state;
      return withInputs({ ...inputs, offer: action.text ? { kind: "text", text: action.text } : { kind: "none" } });
    case "sample_ready":
      // A sample whose pictures didn't load stays on the start screen, with the reason on its row.
      return checkInput(action.inputs) ? run({ ...state, inputs: action.inputs }) : withInputs(action.inputs);
    case "start":
      return checkInput(inputs) ? run(state) : state;
    default:
      return state;
  }
}

function running(state: Extract<CheckState, { s: "running" }>, action: CheckAction): CheckState {
  if ("attempt" in action && action.attempt !== state.attempt) return state;
  const live = state.live;
  switch (action.type) {
    case "stage":
      return { ...state, stage: action.stage };
    case "reread":
      return { ...state, live: { ...live, lines: { ...live.lines, [action.bill]: [] } } };
    case "spent":
      return { ...state, spentMicros: action.micros };
    case "thought": {
      const last = live.thoughts.at(-1);
      const thoughts = last?.stage === action.stage ? [...live.thoughts.slice(0, -1), { stage: last.stage, text: last.text + action.text }] : [...live.thoughts, { stage: action.stage, text: action.text }];
      return { ...state, live: { ...live, thoughts } };
    }
    case "line_read":
      return { ...state, live: { ...live, lines: { ...live.lines, [action.bill]: [...(live.lines[action.bill] ?? []), action.line] } } };
    case "promise_read":
      return { ...state, live: { ...live, promises: [...live.promises, action.promise] } };
    case "turn_heard":
      return { ...state, live: { ...live, heard: [...live.heard, action.turn] } };
    case "challenged":
      return { ...state, live: { ...live, challenges: [...live.challenges, action.challenge] } };
    case "pages_sorted":
      return { ...state, live: { ...live, sorted: { ...live.sorted, [action.bill]: action.kinds } } };
    case "month_done":
      return { ...state, live: { ...live, months: { ...live.months, [action.bill]: action.result } } };
    case "finished":
      return { s: "done", inputs: state.inputs, attempts: state.attempts, result: action.result, selections: initialSelections(action.result), saved: action.saved ?? null };
    case "errored": {
      // A failure that belongs to one bill of a year is told by that bill's file, which the person can find and fix.
      const named = action.bill === undefined ? undefined : state.inputs.bills[action.bill]?.name;
      return { s: "failed", inputs: state.inputs, attempts: state.attempts, stage: state.stage, failure: action.failure, message: named ? `${named}: ${action.message}` : action.message, spentMicros: action.spentMicros ?? state.spentMicros, spentFinal: action.spentMicros !== null, retryable: action.retryable, live: state.live, bill: action.bill === undefined ? null : { index: action.bill, message: action.message } };
    }
    case "cancel":
      return { s: "cancelled", inputs: state.inputs, attempts: state.attempts, stage: state.stage, spentMicros: state.spentMicros, live: state.live };
    default:
      return state;
  }
}

export function reduce(state: CheckState, action: CheckAction): CheckState {
  switch (state.s) {
    case "composing":
      return compose(state, action);
    case "running":
      return running(state, action);
    case "failed":
    case "cancelled":
      if (action.type === "retry" && (state.s === "cancelled" || state.retryable)) return run(state);
      if (action.type === "edit") {
        const failed = state.s === "failed" ? state.bill : null;
        const bills = failed ? state.inputs.bills.map((doc, i): Doc => (i === failed.index ? { id: doc.id, name: doc.name, status: "failed", message: failed.message } : doc)) : state.inputs.bills;
        return { s: "composing", inputs: { ...state.inputs, bills }, attempts: state.attempts };
      }
      return state;
    case "done": {
      // A checked bill or year is done with its files, and keeping them would fold the next bill in with them as one
      // year; a file that wasn't a bill, or couldn't be checked, stays for the person to swap.
      if (action.type === "edit") return { s: "composing", inputs: state.result.outcome === "checked" || state.result.outcome === "year" ? initialState.inputs : state.inputs, attempts: state.attempts };
      if (action.type !== "toggle_claim" && action.type !== "confirm_claim" && action.type !== "toggle_question") return state;
      const selection = state.selections[action.bill];
      if (!selection) return state;
      const next = (changed: Selection): CheckState => ({ ...state, selections: state.selections.map((s, i) => (i === action.bill ? changed : s)) });
      const { claims, questions } = selection;
      switch (action.type) {
        case "toggle_claim": {
          const mark = claims[action.id];
          if (mark !== "selected" && mark !== "unselected") return state;
          return next({ questions, claims: { ...claims, [action.id]: mark === "selected" ? "unselected" : "selected" } });
        }
        case "confirm_claim":
          return claims[action.id] === "needs_confirmation" ? next({ questions, claims: { ...claims, [action.id]: "selected" } }) : state;
        case "toggle_question":
          return action.id in questions ? next({ claims, questions: { ...questions, [action.id]: !questions[action.id] } }) : state;
      }
    }
  }
}
