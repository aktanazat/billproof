import { describe, expect, test } from "vitest";
import { initialState, reduce, type CheckAction, type CheckState } from "./check-machine";
import type { CheckResult } from "./result";

const page = { image: "data:image/jpeg;base64,AAAA", text: null };
const notABill: CheckResult = { outcome: "not_a_bill", spentMicros: 120 };

const play = (actions: CheckAction[], from: CheckState = initialState) => actions.reduce(reduce, from);

const readyBill: CheckAction[] = [
  { type: "bill_added", id: "b", name: "bill.pdf" },
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
      { type: "offer_added", id: "o", name: "offer.heic" },
      { type: "doc_failed", id: "o", message: "HEIC photos can't be read here." },
      { type: "start" },
    ]);
    expect(state.s).toBe("composing");
    expect(play([{ type: "doc_removed", id: "o" }, { type: "start" }], state).s).toBe("running");
  });

  test("a file removed while opening does not come back when it finishes", () => {
    const state = play([{ type: "bill_added", id: "b", name: "bill.pdf" }, { type: "doc_removed", id: "b" }, { type: "doc_prepared", id: "b", pages: [page] }]);
    expect(state).toMatchObject({ s: "composing", inputs: { bill: null } });
  });

  test("a claim from a photo cannot be selected until confirmed", () => {
    const done: CheckState = {
      s: "done",
      inputs: initialState.inputs,
      attempts: 1,
      result: notABill,
      selection: { claims: { C1: "needs_confirmation" }, questions: {} },
    };
    expect(play([{ type: "toggle_claim", id: "C1" }], done)).toMatchObject({ selection: { claims: { C1: "needs_confirmation" } } });
    expect(play([{ type: "confirm_claim", id: "C1" }], done)).toMatchObject({ selection: { claims: { C1: "selected" } } });
  });
});
