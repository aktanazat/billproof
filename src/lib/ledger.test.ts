import { chmodSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, test } from "vitest";
import { CHECK_CAP_MICROS, CHECKS_PER_CLIENT_PER_HOUR, LedgerRefusal, openLedger } from "./ledger";

describe("ledger", () => {
  test("refuses a call whose worst case would pass the per-check cap", () => {
    const ledger = openLedger(":memory:", 1_000_000);
    const check = ledger.admitCheck("a");
    ledger.settle(ledger.reserve(check, CHECK_CAP_MICROS - 1_000, CHECK_CAP_MICROS), CHECK_CAP_MICROS - 1_000);
    expect(() => ledger.reserve(check, 1_001, CHECK_CAP_MICROS)).toThrow(new LedgerRefusal("over_budget", "This check would pass its 3¢ limit. Use fewer pages."));
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

  test("the event cap holds across checks and clients, and a new check is refused once one can't fit", () => {
    const spent = new LedgerRefusal("budget_spent", "This demo has used its budget for live checks. Every saved result is still on the Real bills page.");
    const ledger = openLedger(":memory:", 50_000);
    const a = ledger.admitCheck("a");
    const b = ledger.admitCheck("b");
    ledger.reserve(a, 25_000, CHECK_CAP_MICROS);
    // Admitted while the budget still covered a check, b still can't pass the demo's cap, and the refusal names the
    // demo's cap rather than the check's own limit.
    expect(() => ledger.reserve(b, 26_000, CHECK_CAP_MICROS)).toThrow(spent);
    expect(ledger.reserve(b, 25_000, CHECK_CAP_MICROS)).toEqual(expect.any(String));
    // With less left than one check's own limit, the next check is refused before it starts.
    expect(() => ledger.admitCheck("c")).toThrow(spent);
  });

  test("what's left falls as calls are reserved, and counts an open call at its full reservation", () => {
    const ledger = openLedger(":memory:", 50_000);
    const check = ledger.admitCheck("a");
    expect(ledger.left()).toBe(50_000);
    const open = ledger.reserve(check, 20_000, CHECK_CAP_MICROS);
    expect(ledger.left()).toBe(30_000);
    ledger.settle(open, 700);
    expect(ledger.left()).toBe(49_300);
  });

  test("a client gets a fixed number of checks an hour", () => {
    const ledger = openLedger(":memory:", 1_000_000);
    const start = 1_800_000_000_000;
    for (let i = 0; i < CHECKS_PER_CLIENT_PER_HOUR; i++) {
      const attempt = ledger.reserve(ledger.admitCheck("a", start + i), 1_000, CHECK_CAP_MICROS);
      // A charge, a call still open and a call lost in flight all count.
      if (i % 3 === 0) ledger.settle(attempt, 100);
      if (i % 3 === 1) ledger.lose(attempt);
    }
    expect(() => ledger.admitCheck("a", start + 20 * 60_000)).toThrow(new LedgerRefusal("too_many_checks", `Your network has run ${CHECKS_PER_CLIENT_PER_HOUR} checks in the last hour, the most allowed. Another can start in 40 minutes.`));
    expect(() => ledger.admitCheck("a", start + 3_570_000)).toThrow(new LedgerRefusal("too_many_checks", `Your network has run ${CHECKS_PER_CLIENT_PER_HOUR} checks in the last hour, the most allowed. Another can start in 1 minute.`));
    expect(ledger.admitCheck("b", start + CHECKS_PER_CLIENT_PER_HOUR)).toEqual(expect.any(String));
    expect(ledger.admitCheck("a", start + 3_600_001)).toEqual(expect.any(String));
  });

  // The hourly limit bounds spending. A check that cost nothing, a sample answered from the last 15 minutes' results or
  // one Meta turned away before charging, doesn't use it, so people sharing a network or retrying an outage aren't shut out.
  test("a check that cost nothing doesn't count toward a client's hour", () => {
    const ledger = openLedger(":memory:", 1_000_000);
    const start = 1_800_000_000_000;
    for (let i = 0; i < CHECKS_PER_CLIENT_PER_HOUR; i++) {
      const check = ledger.admitCheck("a", start + i);
      if (i % 2 === 0) ledger.settle(ledger.reserve(check, 1_000, CHECK_CAP_MICROS), 0);
    }
    expect(ledger.admitCheck("a", start + 60_000)).toEqual(expect.any(String));
  });

  // The address is kept only for the hourly limit; the ledger file holds no visitor's address past that hour.
  test("a visitor's address is cleared from checks more than an hour old", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "billproof-ledger-"));
    try {
      const file = path.join(dir, "ledger.db");
      const ledger = openLedger(file, 1_000_000);
      const start = 1_800_000_000_000;
      ledger.admitCheck("203.0.113.7", start);
      ledger.admitCheck("198.51.100.4", start + 30 * 60_000);
      ledger.admitCheck("192.0.2.1", start + 61 * 60_000);
      const stored = new DatabaseSync(file, { readOnly: true }).prepare("SELECT client FROM checks ORDER BY created_at").all();
      expect(stored.map((row) => row.client)).toEqual(["", "198.51.100.4", "192.0.2.1"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // The home and Real bills pages open the ledger to ask whether checks are paused. A restarted server that can't
  // write the file (a full disk) still reads it, and clearing old addresses on open must not take those pages down.
  test("a ledger the server can read but no longer write still opens, with its spending intact", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "billproof-ledger-"));
    const file = path.join(dir, "ledger.db");
    try {
      const before = openLedger(file, 1_000_000);
      const check = before.admitCheck("203.0.113.7", Date.now() - 2 * 60 * 60_000);
      before.settle(before.reserve(check, 20_000, CHECK_CAP_MICROS), 700);
      chmodSync(file, 0o444);
      expect(openLedger(file, 1_000_000).spentTotal()).toBe(700);
    } finally {
      chmodSync(file, 0o644);
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
