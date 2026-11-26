import { describe, expect, test } from "vitest";
import { initialState, reduce, type CheckAction, type CheckState } from "./check-machine";
import type { CheckResult } from "./result";

const page = { image: "data:image/jpeg;base64,AAAA", text: null, rows: null };
const notABill: CheckResult = { outcome: "not_a_bill", spentMicros: 120 };

const play = (actions: CheckAction[], from: CheckState = initialState) => actions.reduce(reduce, from);

const readyBill: CheckAction[] = [
  { type: "bills_added", docs: [{ id: "b", name: "bill.pdf" }] },
  { type: "doc_prepared", id: "b", pages: [page] },
];

describe("check machine", () => {
  test("a late result from a cancelled attempt does not finish the retried check", () => {
    const state = play([...readyBill, { type: "start" }, { type: "cancel" }, { type: "retry" }, { type: "finished", attempt: 1, result: notABill }]);
    expect(state).toMatchObject({ s: "running", attempt: 2 });
  });

  test("a check cannot start while an offer file failed to open", () => {
    const state = play([
      ...readyBill,
      { type: "offer_file_added", id: "o", name: "offer.heic" },
      { type: "prep_failed", id: "o", message: "HEIC photos can't be read here." },
      { type: "start" },
    ]);
    expect(state.s).toBe("composing");
    expect(play([{ type: "removed", id: "o" }, { type: "start" }], state).s).toBe("running");
  });

  test("a real post whose pictures are gone waits on the start screen with the reason instead of starting", () => {
    const offer = { kind: "text" as const, text: "$55 a month" };
    const gone = play([{ type: "sample_ready", inputs: { bills: [{ id: "p", name: "3 pictures from the post", status: "failed", message: "The pictures from this post are no longer online." }], offer } }]);
    expect(gone).toMatchObject({ s: "composing", inputs: { bills: [{ status: "failed", message: "The pictures from this post are no longer online." }] } });
    expect(play([{ type: "sample_ready", inputs: { bills: [{ id: "p", name: "3 pictures from the post", status: "ready", pages: [page] }], offer } }]).s).toBe("running");
  });

  test("a failure from an attempt already given up on is ignored, and only a retryable failure can be retried", () => {
    const failed = (retryable: boolean): CheckAction => ({ type: "errored", attempt: 2, failure: retryable ? "upstream" : "refused", message: "Muse Ember had a problem on Meta's side. Try again.", spentMicros: 400, retryable });
    const retried = play([...readyBill, { type: "start" }, { type: "cancel" }, { type: "retry" }]);
    expect(play([{ type: "errored", attempt: 1, failure: "upstream", message: "late", spentMicros: 0, retryable: true }], retried)).toMatchObject({ s: "running", attempt: 2 });
    expect(play([failed(true)], retried)).toMatchObject({ s: "failed", message: "Muse Ember had a problem on Meta's side. Try again.", spentMicros: 400 });
    expect(play([failed(true), { type: "retry" }], retried)).toMatchObject({ s: "running", attempt: 3 });
    expect(play([failed(false), { type: "retry" }], retried).s).toBe("failed");
  });

  test("going back from a finished check keeps the files, so the person can change one and check again", () => {
    const back = play([...readyBill, { type: "start" }, { type: "finished", attempt: 1, result: notABill }, { type: "edit" }]);
    expect(back).toMatchObject({ s: "composing", inputs: { bills: [{ id: "b", status: "ready" }] } });
    expect(play([{ type: "start" }], back)).toMatchObject({ s: "running", attempt: 2 });
  });

  test("a month read a second time starts its lines over without touching the other months", () => {
    const seen = (label: string) => ({ label, amount_cents: 1000, kind: "plan", page: 1, box: null });
    const state = play([
      { type: "bills_added", docs: [{ id: "a", name: "jan.pdf" }, { id: "b", name: "feb.pdf" }] },
      { type: "doc_prepared", id: "a", pages: [page] },
      { type: "doc_prepared", id: "b", pages: [page] },
      { type: "start" },
      { type: "line_read", attempt: 1, bill: 0, line: seen("Internet") },
      { type: "line_read", attempt: 1, bill: 1, line: seen("Internet") },
      { type: "line_read", attempt: 1, bill: 1, line: seen("TV") },
      { type: "reread", attempt: 1, bill: 1 },
      { type: "line_read", attempt: 1, bill: 1, line: seen("Internet") },
    ]);
    expect(state).toMatchObject({ s: "running", live: { lines: { 0: [{ label: "Internet" }], 1: [{ label: "Internet" }] } } });
  });

  test("a recording that finishes opening after the person swapped it for a file does not take the file's place", () => {
    const state = play([
      ...readyBill,
      { type: "call_added", id: "c", name: "call.m4a" },
      { type: "offer_file_added", id: "f", name: "offer.png" },
      { type: "call_prepared", id: "c", call: { wav: "UklGRg==", seconds: 30, url: "blob:call", peaks: [] } },
      { type: "prep_failed", id: "c", message: "This recording could not be opened." },
    ]);
    expect(state).toMatchObject({ s: "composing", inputs: { offer: { kind: "file", doc: { id: "f", status: "preparing" } } } });
    expect(play([{ type: "doc_prepared", id: "f", pages: [page] }, { type: "start" }], state).s).toBe("running");
  });

  test("a check waits for every bill of a year to open", () => {
    const state = play([{ type: "bills_added", docs: [{ id: "a", name: "jan.pdf" }, { id: "b", name: "feb.pdf" }] }, { type: "doc_prepared", id: "a", pages: [page] }, { type: "start" }]);
    expect(state.s).toBe("composing");
    expect(play([{ type: "doc_prepared", id: "b", pages: [page] }, { type: "start" }], state).s).toBe("running");
  });

  test("a call still being converted holds the check", () => {
    const state = play([...readyBill, { type: "call_added", id: "c", name: "call.m4a" }, { type: "start" }]);
    expect(state.s).toBe("composing");
    expect(play([{ type: "call_prepared", id: "c", call: { wav: "AAAA", seconds: 12, url: "blob:x", peaks: [] } }, { type: "start" }], state).s).toBe("running");
  });

  test("a file removed while opening does not come back when it finishes", () => {
    const state = play([{ type: "bills_added", docs: [{ id: "b", name: "bill.pdf" }] }, { type: "removed", id: "b" }, { type: "doc_prepared", id: "b", pages: [page] }]);
    expect(state).toMatchObject({ s: "composing", inputs: { bills: [] } });
  });

  test("a claim from a photo cannot be selected until confirmed", () => {
    const done: CheckState = {
      s: "done",
      inputs: initialState.inputs,
      attempts: 1,
      result: notABill,
      selections: [{ claims: { C1: "needs_confirmation" }, questions: {} }],
    };
    expect(play([{ type: "toggle_claim", bill: 0, id: "C1" }], done)).toMatchObject({ selections: [{ claims: { C1: "needs_confirmation" } }] });
    expect(play([{ type: "confirm_claim", bill: 0, id: "C1" }], done)).toMatchObject({ selections: [{ claims: { C1: "selected" } }] });
  });
});
