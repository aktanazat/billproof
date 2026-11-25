import "server-only";
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

// One Node process owns this file. node:sqlite is synchronous, so each function below runs to completion
// before any other request's JavaScript can observe the ledger: reservation checks and inserts are atomic.

export const CHECK_CAP_MICROS = 30_000;
const CHECKS_PER_CLIENT_PER_HOUR = 12;
const HOUR_MS = 3_600_000;

export class LedgerRefusal extends Error {
  constructor(readonly kind: "over_budget" | "too_many_checks", message: string) {
    super(message);
  }
}

export type Ledger = {
  admitCheck(client: string, now?: number): string;
  reserve(checkId: string, amount: number): string;
  settle(attemptId: string, actualMicros: number): void;
  lose(attemptId: string): void;
  spentForCheck(checkId: string): number;
  spentTotal(): number;
};

function numberColumn(row: unknown, column: string): number {
  if (row && typeof row === "object" && column in row) {
    const value: unknown = Reflect.get(row, column);
    if (typeof value === "number") return value;
  }
  throw new Error(`ledger query returned no numeric ${column}`);
}

export function openLedger(file: string, eventCapMicros: number): Ledger {
  if (file !== ":memory:") mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS checks (id TEXT PRIMARY KEY, client TEXT NOT NULL, created_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS attempts (
      id TEXT PRIMARY KEY,
      check_id TEXT NOT NULL REFERENCES checks(id),
      reserved INTEGER NOT NULL,
      actual INTEGER,
      state TEXT NOT NULL CHECK (state IN ('reserved', 'settled', 'unknown')),
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS attempts_check ON attempts(check_id);
    CREATE INDEX IF NOT EXISTS checks_client ON checks(client, created_at);
  `);

  // Settled attempts count what Meta billed; open and unknown attempts count their full reservation.
  const committed = `COALESCE(SUM(CASE state WHEN 'settled' THEN actual ELSE reserved END), 0)`;
  const eventSpent = db.prepare(`SELECT ${committed} AS micros FROM attempts`);
  const checkSpent = db.prepare(`SELECT ${committed} AS micros FROM attempts WHERE check_id = ?`);
  const recentChecks = db.prepare(`SELECT COUNT(*) AS n FROM checks WHERE client = ? AND created_at > ?`);
  const insertCheck = db.prepare(`INSERT INTO checks (id, client, created_at) VALUES (?, ?, ?)`);
  const insertAttempt = db.prepare(`INSERT INTO attempts (id, check_id, reserved, state, created_at) VALUES (?, ?, ?, 'reserved', ?)`);
  const settleAttempt = db.prepare(`UPDATE attempts SET state = 'settled', actual = ? WHERE id = ? AND state = 'reserved'`);
  const loseAttempt = db.prepare(`UPDATE attempts SET state = 'unknown' WHERE id = ? AND state = 'reserved'`);

  const micros = (row: unknown) => numberColumn(row, "micros");

  return {
    admitCheck(client: string, now = Date.now()): string {
      const n = numberColumn(recentChecks.get(client, now - HOUR_MS), "n");
      if (n >= CHECKS_PER_CLIENT_PER_HOUR) {
        throw new LedgerRefusal("too_many_checks", `This address has run ${n} checks in the last hour`);
      }
      const id = randomUUID();
      insertCheck.run(id, client, now);
      return id;
    },
    reserve(checkId: string, amount: number): string {
      const forCheck = micros(checkSpent.get(checkId));
      if (forCheck + amount > CHECK_CAP_MICROS) {
        throw new LedgerRefusal("over_budget", `This step could cost up to ${amount} µ$, past this check's ${CHECK_CAP_MICROS} µ$ limit`);
      }
      if (micros(eventSpent.get()) + amount > eventCapMicros) {
        throw new LedgerRefusal("over_budget", "The demo's model budget is used up");
      }
      const id = randomUUID();
      insertAttempt.run(id, checkId, amount, Date.now());
      return id;
    },
    settle(attemptId: string, actualMicros: number) {
      settleAttempt.run(actualMicros, attemptId);
    },
    lose(attemptId: string) {
      loseAttempt.run(attemptId);
    },
    spentForCheck(checkId: string): number {
      return micros(checkSpent.get(checkId));
    },
    spentTotal(): number {
      return micros(eventSpent.get());
    },
  };
}
