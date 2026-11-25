import { describe, expect, test } from "vitest";
import { CHECK_CAP_MICROS, CHECKS_PER_CLIENT_PER_HOUR, LedgerRefusal, openLedger } from "./ledger";

describe("ledger", () => {
  test("refuses a call whose worst case would pass the per-check cap", () => {
    const ledger = openLedger(":memory:", 1_000_000);
    const check = ledger.admitCheck("a");
    ledger.settle(ledger.reserve(check, CHECK_CAP_MICROS - 1_000, CHECK_CAP_MICROS), CHECK_CAP_MICROS - 1_000);
    expect(() => ledger.reserve(check, 1_001, CHECK_CAP_MICROS)).toThrow(LedgerRefusal);
    expect(ledger.reserve(check, 1_000, CHECK_CAP_MICROS)).toEqual(expect.any(String));
  });

  test("settling releases the unused part of a reservation", () => {
    const ledger = openLedger(":memory:", 1_000_000);
    const check = ledger.admitCheck("a");
    ledger.settle(ledger.reserve(check, 20_000, CHECK_CAP_MICROS), 700);
    expect(ledger.spentForCheck(check)).toBe(700);
  });

  test("a call lost in flight stays counted at its full reservation", () => {
    const ledger = openLedger(":memory:", 1_000_000);
    const check = ledger.admitCheck("a");
    const attempt = ledger.reserve(check, 20_000, CHECK_CAP_MICROS);
    ledger.lose(attempt);
    ledger.settle(attempt, 10);
    expect(ledger.spentTotal()).toBe(20_000);
  });

  test("the event cap holds across checks and clients", () => {
    const ledger = openLedger(":memory:", 25_000);
    ledger.reserve(ledger.admitCheck("a"), 20_000, CHECK_CAP_MICROS);
    expect(() => ledger.reserve(ledger.admitCheck("b"), 6_000, CHECK_CAP_MICROS)).toThrow("The demo's model budget is used up");
  });

  test("a client gets a fixed number of checks an hour", () => {
    const ledger = openLedger(":memory:", 1_000_000);
    const start = 1_800_000_000_000;
    for (let i = 0; i < CHECKS_PER_CLIENT_PER_HOUR; i++) ledger.admitCheck("a", start + i);
    expect(() => ledger.admitCheck("a", start + CHECKS_PER_CLIENT_PER_HOUR)).toThrow(LedgerRefusal);
    expect(ledger.admitCheck("b", start + CHECKS_PER_CLIENT_PER_HOUR)).toEqual(expect.any(String));
    expect(ledger.admitCheck("a", start + 3_600_001)).toEqual(expect.any(String));
  });
});
