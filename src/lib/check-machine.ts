import type { CheckFailure, CheckInput, CheckResult, PreparedPage, Stage } from "./result";

export type Doc =
  | { id: string; name: string; status: "preparing" }
  | { id: string; name: string; status: "ready"; pages: PreparedPage[] }
  | { id: string; name: string; status: "failed"; message: string };

export type Inputs = { bill: Doc | null; offerFile: Doc | null; offerText: string };

export type ClaimMark = "selected" | "unselected" | "needs_confirmation";
export type Selection = { claims: Record<string, ClaimMark>; questions: Record<string, boolean> };

export type CheckState =
  | { s: "composing"; inputs: Inputs; attempts: number }
  | { s: "running"; inputs: Inputs; attempts: number; attempt: number; stage: Stage | null; spentMicros: number }
  | { s: "done"; inputs: Inputs; attempts: number; result: CheckResult; selection: Selection }
  | { s: "failed"; inputs: Inputs; attempts: number; stage: Stage | null; failure: CheckFailure; message: string; spentMicros: number; retryable: boolean }
  | { s: "cancelled"; inputs: Inputs; attempts: number; stage: Stage | null; spentMicros: number };

export type CheckAction =
  | { type: "bill_added"; id: string; name: string }
  | { type: "offer_added"; id: string; name: string }
  | { type: "doc_prepared"; id: string; pages: PreparedPage[] }
  | { type: "doc_failed"; id: string; message: string }
  | { type: "doc_removed"; id: string }
  | { type: "offer_text"; text: string }
  | { type: "start" }
  | { type: "sample_ready"; bill: Extract<Doc, { status: "ready" }>; offerText: string }
  | { type: "stage"; attempt: number; stage: Stage }
  | { type: "spent"; attempt: number; micros: number }
  | { type: "finished"; attempt: number; result: CheckResult }
  | { type: "errored"; attempt: number; failure: CheckFailure; message: string; spentMicros: number; retryable: boolean }
  | { type: "cancel" }
  | { type: "retry" }
  | { type: "edit" }
  | { type: "toggle_claim"; id: string }
  | { type: "confirm_claim"; id: string }
  | { type: "toggle_question"; id: string };

export const initialState: CheckState = { s: "composing", inputs: { bill: null, offerFile: null, offerText: "" }, attempts: 0 };

const DEFAULT_QUESTIONS = new Set(["unagreed_fee", "repeated_charge"]);

function initialSelection(result: CheckResult): Selection {
  if (result.outcome !== "checked") return { claims: {}, questions: {} };
  return {
    claims: Object.fromEntries(result.claims.map((claim) => [claim.id, claim.needsConfirmation ? "needs_confirmation" : "selected"])),
    questions: Object.fromEntries(result.questions.map((question) => [question.id, DEFAULT_QUESTIONS.has(question.kind)])),
  };
}

function updateDoc(inputs: Inputs, id: string, update: (doc: Doc) => Doc): Inputs {
  if (inputs.bill?.id === id) return { ...inputs, bill: update(inputs.bill) };
  if (inputs.offerFile?.id === id) return { ...inputs, offerFile: update(inputs.offerFile) };
  return inputs;
}

// The request body for a check, or null when the inputs cannot start one.
export function checkInput(inputs: Inputs): CheckInput | null {
  if (inputs.bill?.status !== "ready") return null;
  if (inputs.offerFile && inputs.offerFile.status !== "ready") return null;
  const offerText = inputs.offerText.trim();
  const offer = inputs.offerFile?.status === "ready" ? { kind: "pages" as const, pages: inputs.offerFile.pages } : offerText ? { kind: "text" as const, text: offerText } : null;
  return { bill: { pages: inputs.bill.pages }, offer };
}

function run(state: CheckState): CheckState {
  const attempt = state.attempts + 1;
  return { s: "running", inputs: state.inputs, attempts: attempt, attempt, stage: null, spentMicros: 0 };
}

export function reduce(state: CheckState, action: CheckAction): CheckState {
  switch (state.s) {
    case "composing": {
      const { inputs } = state;
      switch (action.type) {
        case "bill_added":
          return { ...state, inputs: { ...inputs, bill: { id: action.id, name: action.name, status: "preparing" } } };
        case "offer_added":
          return { ...state, inputs: { ...inputs, offerFile: { id: action.id, name: action.name, status: "preparing" }, offerText: "" } };
        case "doc_prepared":
          return { ...state, inputs: updateDoc(inputs, action.id, (doc) => (doc.status === "preparing" ? { id: doc.id, name: doc.name, status: "ready", pages: action.pages } : doc)) };
        case "doc_failed":
          return { ...state, inputs: updateDoc(inputs, action.id, (doc) => (doc.status === "preparing" ? { id: doc.id, name: doc.name, status: "failed", message: action.message } : doc)) };
        case "doc_removed":
          if (inputs.bill?.id === action.id) return { ...state, inputs: { ...inputs, bill: null } };
          if (inputs.offerFile?.id === action.id) return { ...state, inputs: { ...inputs, offerFile: null } };
          return state;
        case "offer_text":
          return inputs.offerFile ? state : { ...state, inputs: { ...inputs, offerText: action.text } };
        case "sample_ready":
          return run({ ...state, inputs: { bill: action.bill, offerFile: null, offerText: action.offerText } });
        case "start":
          return checkInput(inputs) ? run(state) : state;
        default:
          return state;
      }
    }
    case "running": {
      if ("attempt" in action && action.attempt !== state.attempt) return state;
      switch (action.type) {
        case "stage":
          return { ...state, stage: action.stage };
        case "spent":
          return { ...state, spentMicros: action.micros };
        case "finished":
          return { s: "done", inputs: state.inputs, attempts: state.attempts, result: action.result, selection: initialSelection(action.result) };
        case "errored":
          return { s: "failed", inputs: state.inputs, attempts: state.attempts, stage: state.stage, failure: action.failure, message: action.message, spentMicros: action.spentMicros, retryable: action.retryable };
        case "cancel":
          return { s: "cancelled", inputs: state.inputs, attempts: state.attempts, stage: state.stage, spentMicros: state.spentMicros };
        default:
          return state;
      }
    }
    case "failed":
    case "cancelled":
      if (action.type === "retry" && (state.s === "cancelled" || state.retryable)) return run(state);
      if (action.type === "edit") return { s: "composing", inputs: state.inputs, attempts: state.attempts };
      return state;
    case "done": {
      const { claims, questions } = state.selection;
      switch (action.type) {
        case "edit":
          return { s: "composing", inputs: state.inputs, attempts: state.attempts };
        case "toggle_claim": {
          const mark = claims[action.id];
          if (mark !== "selected" && mark !== "unselected") return state;
          return { ...state, selection: { questions, claims: { ...claims, [action.id]: mark === "selected" ? "unselected" : "selected" } } };
        }
        case "confirm_claim":
          return claims[action.id] === "needs_confirmation" ? { ...state, selection: { questions, claims: { ...claims, [action.id]: "selected" } } } : state;
        case "toggle_question":
          return action.id in questions ? { ...state, selection: { claims, questions: { ...questions, [action.id]: !questions[action.id] } } } : state;
        default:
          return state;
      }
    }
  }
}
