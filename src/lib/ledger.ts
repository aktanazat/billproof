import "server-only";
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { formatMicros } from "./cost";

export const CHECK_CAP_MICROS = 30_000;
export const CHECKS_PER_CLIENT_PER_HOUR = 30;
const HOUR_MS = 3_600_000;
const BUDGET_SPENT = "This demo has used its budget for live checks. Every saved result is still on the Real bills page.";

export class LedgerRefusal extends Error {
  override readonly name = "LedgerRefusal";
  constructor(readonly kind: "over_budget" | "budget_spent" | "too_many_checks", message: string) {
    super(message);
  }
}

// The site builds this module twice, for its pages and for checks, and the one ledger they share comes from whichever
// loaded first, so a refusal is recognised by its name: `instanceof` fails against the other copy's class.
export function isLedgerRefusal(error: unknown): error is LedgerRefusal {
  return error instanceof Error && error.name === "LedgerRefusal";
}

export type Ledger = {
  admitCheck(client: string, now?: number): string;
  reserve(checkId: string, amount: number, capMicros: number): string;
  settle(attemptId: string, actualMicros: number): void;
  lose(attemptId: string): void;
  spentForCheck(checkId: string): number;
  spentTotal(): number;
  // What the demo's cap still allows, counting open and lost calls at their full reservation.
  left(): number;
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
    PRAGMA busy_timeout = 5000;
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
  // A check counts toward its client's hour once it cost something: a charge, a call still open, or one lost in flight.
  const recentChecks = db.prepare(
    `SELECT COUNT(*) AS n, MIN(created_at) AS oldest FROM checks WHERE client = ? AND created_at > ? AND EXISTS (SELECT 1 FROM attempts WHERE attempts.check_id = checks.id AND (state != 'settled' OR actual > 0))`,
  );
  const insertCheck = db.prepare(`INSERT INTO checks (id, client, created_at) VALUES (?, ?, ?)`);
  // The address is kept only for the hourly limit (owner approval 2026-11-27: "yes"); older checks keep their spend.
  const forgetClients = db.prepare(`UPDATE checks SET client = '' WHERE created_at <= ? AND client != ''`);
  const insertAttempt = db.prepare(`INSERT INTO attempts (id, check_id, reserved, state, created_at) VALUES (?, ?, ?, 'reserved', ?)`);
  const settleAttempt = db.prepare(`UPDATE attempts SET state = 'settled', actual = ? WHERE id = ? AND state = 'reserved'`);
  const loseAttempt = db.prepare(`UPDATE attempts SET state = 'unknown' WHERE id = ? AND state = 'reserved'`);

  const micros = (row: unknown) => numberColumn(row, "micros");

  // BEGIN IMMEDIATE takes the write lock before the reads, so another process sharing the file (the app and
  // `pnpm eval`) cannot pass the same cap check in between.
  function writeTransaction<T>(body: () => T): T {
    db.exec("BEGIN IMMEDIATE");
    try {
      const value = body();
      db.exec("COMMIT");
      return value;
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }

  // On open too, so a restart clears what aged out while no check was admitted. A file that can't be written (a full
  // disk) still opens for the pages that only read; every admission clears again, and fails, until writing works.
  try {
    forgetClients.run(Date.now() - HOUR_MS);
  } catch (error) {
    console.error("ledger: couldn't clear old addresses on open:", error);
  }

  return {
    admitCheck(client: string, now = Date.now()): string {
      // Outside the admission, so a refused check (the budget spent) doesn't roll the clearing back.
      forgetClients.run(now - HOUR_MS);
      return writeTransaction(() => {
        // The page says checks are paused at this point, so a check started anyway is refused before anything is sent.
        if (eventCapMicros - micros(eventSpent.get()) < CHECK_CAP_MICROS) throw new LedgerRefusal("budget_spent", BUDGET_SPENT);
        const recent = recentChecks.get(client, now - HOUR_MS);
        const n = numberColumn(recent, "n");
        if (n >= CHECKS_PER_CLIENT_PER_HOUR) {
          // The next check opens when the oldest one in the hour ages out.
          const minutes = Math.max(1, Math.ceil((numberColumn(recent, "oldest") + HOUR_MS - now) / 60_000));
          throw new LedgerRefusal("too_many_checks", `Your network has run ${n} checks in the last hour, the most allowed. Another can start in ${minutes} ${minutes === 1 ? "minute" : "minutes"}.`);
        }
        const id = randomUUID();
        insertCheck.run(id, client, now);
        return id;
      });
    },
    reserve(checkId: string, amount: number, capMicros: number): string {
      return writeTransaction(() => {
        const forCheck = micros(checkSpent.get(checkId));
        if (forCheck + amount > capMicros) {
          throw new LedgerRefusal("over_budget", `This check would pass its ${formatMicros(capMicros)} limit. Use fewer pages.`);
        }
        if (micros(eventSpent.get()) + amount > eventCapMicros) {
          throw new LedgerRefusal("budget_spent", BUDGET_SPENT);
        }
        const id = randomUUID();
        insertAttempt.run(id, checkId, amount, Date.now());
        return id;
      });
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
    left(): number {
      return eventCapMicros - micros(eventSpent.get());
    },
  };
}
