// Runs every eval bill through the real pipeline and Muse Ember, as a PDF and as a phone photo, and scores the
// result against the planted ground truth. Spend goes through the same ledger as the app.
// Usage: MODEL_API_KEY=… pnpm eval [case-id-substring]
//        pnpm eval --replay eval/run-….json   (today's rules on a saved run's readings; no Muse Ember, no spend)
import { readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { formatMicros } from "../src/lib/cost";
import { openLedger } from "../src/lib/ledger";
import { runCheck } from "../src/lib/pipeline";
import type { CheckEvent, CheckResult } from "../src/lib/result";
import { cases, replayed, scoreCase, type Score, type Variant } from "./eval-cases";

const replayFile = process.argv[2] === "--replay" ? process.argv[3] : null;
const saved: { id: string; variant: Variant; events: CheckEvent[] }[] = replayFile ? JSON.parse(readFileSync(replayFile, "utf8")).raw : [];

const filter = replayFile ? "" : (process.argv[2] ?? "");
const ledger = openLedger(path.join(process.cwd(), "data", "ledger.db"), Number(process.env.EVENT_BUDGET_MICROS ?? 6_000_000));
const scores: Score[] = [];
const raw: { id: string; variant: Variant; events: CheckEvent[] }[] = [];

for (const c of cases.filter((c) => c.id.includes(filter))) {
  const events: CheckEvent[] = [];
  const started = performance.now();
  if (replayFile) {
    events.push(...(saved.find((r) => r.id === c.id && r.variant === c.variant)?.events ?? []));
  } else {
    await runCheck(await c.input(), {
      ledger,
      client: `eval:${c.id}:${c.variant}:${Date.now()}`,
      signal: AbortSignal.timeout(240_000),
      emit: (event) => events.push(event),
    });
  }
  const ms = Math.round(performance.now() - started);
  const terminal = events.at(-1);
  const loaded: CheckResult | null = terminal?.type === "result" ? terminal.result : null;
  const result = replayFile ? await replayed(c, loaded) : loaded;
  const error = terminal?.type === "error" ? `${terminal.failure}: ${terminal.message}` : terminal ? null : "not in the saved run";
  const s = scoreCase(c, result, error, ms);
  scores.push(s);
  raw.push({ id: c.id, variant: c.variant, events });
  console.log(
    `${s.id.padEnd(28)} ${c.variant.padEnd(5)} ${s.outcome.padEnd(10)} claims ${s.claimsFound}/${s.claimsExpected}  false ${s.falseClaims.length}  questions ${s.questionsFound}/${s.questionsExpected}  explained ${s.explainedFound}/${s.explainedExpected}  ${formatMicros(s.costMicros).padStart(7)}  ${(s.ms / 1000).toFixed(1)}s${s.falseClaims.length ? `  FALSE: ${s.falseClaims.join("; ")}` : ""}`,
  );
}

const sum = (pick: (s: Score) => number) => scores.reduce((t, s) => t + pick(s), 0);
const costs = scores.map((s) => s.costMicros).sort((a, b) => a - b);
const median = costs.length ? costs[Math.floor(costs.length / 2)] : 0;
for (const variant of ["pdf", "photo", "call", "year"] as const) {
  const of = scores.filter((s) => s.variant === variant);
  if (of.length === 0) continue;
  const total = (pick: (s: Score) => number) => of.reduce((t, s) => t + pick(s), 0);
  console.log(
    `\n${variant}: claims ${total((s) => s.claimsFound)}/${total((s) => s.claimsExpected)}, false claims ${total((s) => s.falseClaims.length)}, questions ${total((s) => s.questionsFound)}/${total((s) => s.questionsExpected)}, explained ${total((s) => s.explainedFound)}/${total((s) => s.explainedExpected)}, completed ${of.filter((s) => s.outcome === "checked").length}/${of.length}`,
  );
}
console.log(`\nruns ${scores.length}, total ${formatMicros(sum((s) => s.costMicros))}, median ${formatMicros(median)} per check, ledger total ${formatMicros(ledger.spentTotal())}`);

if (!replayFile) {
  const outDir = path.join(process.cwd(), "eval", "results");
  await mkdir(outDir, { recursive: true });
  const file = path.join(outDir, `${new Date().toISOString().replaceAll(":", "-")}.json`);
  await writeFile(file, JSON.stringify({ scores, raw }, null, 2));
  console.log(`saved ${file}`);
}
