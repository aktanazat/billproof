import "server-only";
import path from "node:path";
import { CHECK_CAP_MICROS, openLedger, type Ledger } from "./ledger";

const globalLedger = globalThis as typeof globalThis & { billproofLedger?: Ledger };

// One ledger per server process, shared by every route that spends.
export function serverLedger(): Ledger {
  globalLedger.billproofLedger ??= openLedger(
    process.env.LEDGER_PATH ?? path.join(process.cwd(), "data", "ledger.db"),
    Number(process.env.EVENT_BUDGET_MICROS ?? 6_000_000),
  );
  return globalLedger.billproofLedger;
}

// Live checks pause once the demo's cap can't cover one more check at its worst case.
export function livePaused(): boolean {
  return serverLedger().left() < CHECK_CAP_MICROS;
}

export function clientKey(request: Request): string {
  return request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || request.headers.get("x-real-ip") || "local";
}

// Only Billproof's own page may start paid work, so another site can't spend it from its visitors' browsers. Browsers
// mark such a request same-origin; older ones (Safari before 16.4, on iOS 15 devices) send only its Origin, compared
// with the Host the front server passes along (the server's own URL names the container's address, not the site's).
export function fromOwnPage(request: Request): boolean {
  const site = request.headers.get("sec-fetch-site");
  if (site !== null) return site === "same-origin";
  const origin = request.headers.get("origin");
  const host = request.headers.get("host");
  if (!origin || !host) return false;
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}
