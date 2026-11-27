import "server-only";
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync, type StatementSync } from "node:sqlite";
import { formatMicros } from "./cost";

export const CHECK_CAP_MICROS = 30_000;
export const BILLS_PER_CLIENT_PER_HOUR = 30;
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
  // `bills` is how many statements the check reads: the hourly limit counts each, as each costs about one check.
  admitCheck(client: string, bills?: number, now?: number): string;
  // A check that ended without costing anything (a sample answered from recent results, a call Meta turned away before
  // charging) gives its place in the hour back.
  release(checkId: string): void;
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
    CREATE TABLE IF NOT EXISTS checks (id TEXT PRIMARY KEY, client TEXT NOT NULL, created_at INTEGER NOT NULL, bills INTEGER NOT NULL DEFAULT 1);
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
  // A check counts toward its client's hour from its admission, so checks sent at the same moment can't all pass; one
  // that ends having cost nothing is released. A ledger written before checks counted their bills gets the column at its
  // first admission, each old check counting as one; opening stays read-only, so a server that can't write the file
  // still shows its pages.
  let checkStatements: { recent: StatementSync; insert: StatementSync; release: StatementSync } | null = null;
  const checkQueries = () => {
    if (checkStatements) return checkStatements;
    if (!db.prepare(`SELECT 1 FROM pragma_table_info('checks') WHERE name = 'bills'`).get()) {
      db.exec(`ALTER TABLE checks ADD COLUMN bills INTEGER NOT NULL DEFAULT 1;
        UPDATE checks SET bills = 0 WHERE NOT EXISTS (SELECT 1 FROM attempts WHERE attempts.check_id = checks.id AND (state != 'settled' OR actual > 0));`);
    }
    checkStatements = {
      recent: db.prepare(`SELECT created_at AS at, bills FROM checks WHERE client = ? AND created_at > ? AND bills > 0 ORDER BY created_at`),
      insert: db.prepare(`INSERT INTO checks (id, client, created_at, bills) VALUES (?, ?, ?, ?)`),
      release: db.prepare(
        `UPDATE checks SET bills = 0 WHERE id = ? AND NOT EXISTS (SELECT 1 FROM attempts WHERE attempts.check_id = checks.id AND (state != 'settled' OR actual > 0))`,
      ),
    };
    return checkStatements;
  };
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
    admitCheck(client: string, bills = 1, now = Date.now()): string {
      // Outside the admission, so a refused check (the budget spent) doesn't roll the clearing back, or the column.
      forgetClients.run(now - HOUR_MS);
      const queries = checkQueries();
      return writeTransaction(() => {
        // The page says checks are paused at this point, so a check started anyway is refused before anything is sent.
        if (eventCapMicros - micros(eventSpent.get()) < CHECK_CAP_MICROS) throw new LedgerRefusal("budget_spent", BUDGET_SPENT);
        const recent = queries.recent.all(client, now - HOUR_MS).map((row) => ({ at: numberColumn(row, "at"), bills: numberColumn(row, "bills") }));
        const counted = recent.reduce((sum, check) => sum + check.bills, 0);
        if (counted + bills > BILLS_PER_CLIENT_PER_HOUR) {
          // The check can start once enough of the hour's bills age out, oldest first.
          let left = counted;
          const freed = recent.find((check) => (left -= check.bills) + bills <= BILLS_PER_CLIENT_PER_HOUR) ?? recent[recent.length - 1];
          const minutes = Math.max(1, Math.ceil((freed.at + HOUR_MS - now) / 60_000));
          const next = bills === 1 ? "Another check" : `A check of ${bills} bills`;
          throw new LedgerRefusal("too_many_checks", `Your network has checked ${counted} ${counted === 1 ? "bill" : "bills"} in the last hour, and the limit is ${BILLS_PER_CLIENT_PER_HOUR}. ${next} can start in ${minutes} ${minutes === 1 ? "minute" : "minutes"}.`);
        }
        const id = randomUUID();
        queries.insert.run(id, client, now, bills);
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
    release(checkId: string) {
      checkQueries().release.run(checkId);
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
