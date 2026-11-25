// Runs every eval bill through the real pipeline and Muse Ember, as a PDF and as a phone photo, and scores the
// result against the planted ground truth. Spend goes through the same ledger as the app.
// Usage: MODEL_API_KEY=… pnpm eval [case-id-substring]
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { formatMicros } from "../src/lib/cost";
import { openLedger } from "../src/lib/ledger";
import { runCheck } from "../src/lib/pipeline";
import type { CheckEvent, CheckInput, CheckResult } from "../src/lib/result";
import { evalBills } from "./samples/eval-specs";
import { jpegDataUrl, photoOf, rasterize } from "./samples/raster";
import { renderBillPdf } from "./samples/render";
import type { BillSpec } from "./samples/specs";

const LONG_SIDE = 1600;
type Variant = "pdf" | "photo";

async function inputFor(spec: BillSpec, variant: Variant): Promise<CheckInput> {
  const pdf = await renderBillPdf(spec);
  const page =
    variant === "pdf"
      ? await rasterize(pdf, LONG_SIDE).then(async ({ png, text }) => ({ image: await jpegDataUrl(png, LONG_SIDE), text }))
      : { image: await jpegDataUrl(await photoOf((await rasterize(pdf, 2200)).png), LONG_SIDE), text: null };
  return { bill: { pages: [page] }, offer: { kind: "text", text: spec.proof } };
}

type Score = {
  id: string;
  variant: Variant;
  outcome: string;
  claimsExpected: number;
  claimsFound: number;
  falseClaims: string[];
  questionsExpected: number;
  questionsFound: number;
  explainedExpected: number;
  explainedFound: number;
  costMicros: number;
  ms: number;
};

const overlaps = (want: string[], got: string[]) => want.length === 0 || want.some((label) => got.includes(label));

function score(spec: BillSpec, variant: Variant, result: CheckResult | null, error: string | null, ms: number): Score {
  const base = { id: spec.id, variant, ms, claimsExpected: spec.expected.claims.length, questionsExpected: spec.expected.questions.length, explainedExpected: spec.expected.explained.length };
  if (!result || result.outcome !== "checked") {
    return { ...base, outcome: error ?? result?.outcome ?? "error", claimsFound: 0, falseClaims: [], questionsFound: 0, explainedFound: 0, costMicros: result?.spentMicros ?? 0 };
  }
  const label = (id: string) => result.reading.line_items.find((line) => line.id === id)?.label ?? id;
  const unmatched = [...spec.expected.claims];
  const falseClaims: string[] = [];
  let claimsFound = 0;
  for (const claim of result.claims) {
    const labels = claim.lineIds.map(label);
    const i = unmatched.findIndex((want) => want.kind === claim.kind && want.amountCents === claim.amountCents && overlaps(want.labels, labels));
    if (i >= 0) {
      unmatched.splice(i, 1);
      claimsFound += 1;
    } else if (!claim.needsConfirmation || variant === "photo") {
      falseClaims.push(`${claim.kind} ${claim.amountCents}¢ on ${labels.join(" + ")}`);
    }
  }
  const questionsFound = spec.expected.questions.filter((want) => result.questions.some((q) => q.kind === want.kind && overlaps(want.labels, q.lineIds.map(label)))).length;
  const explainedFound = spec.expected.explained.filter((want) => result.explained.some((e) => overlaps(want.labels, e.lineIds.map(label)))).length;
  return { ...base, outcome: "checked", claimsFound, falseClaims, questionsFound, explainedFound, costMicros: result.spentMicros };
}

const filter = process.argv[2] ?? "";
const ledger = openLedger(path.join(process.cwd(), "data", "ledger.db"), Number(process.env.EVENT_BUDGET_MICROS ?? 6_000_000));
const scores: Score[] = [];
const raw: { id: string; variant: Variant; events: CheckEvent[] }[] = [];

for (const spec of evalBills.filter((s) => s.id.includes(filter))) {
  for (const variant of ["pdf", "photo"] as const) {
    const events: CheckEvent[] = [];
    const started = performance.now();
    await runCheck(await inputFor(spec, variant), {
      ledger,
      client: `eval:${spec.id}:${variant}:${Date.now()}`,
      signal: AbortSignal.timeout(120_000),
      emit: (event) => events.push(event),
    });
    const ms = Math.round(performance.now() - started);
    const terminal = events.at(-1);
    const result = terminal?.type === "result" ? terminal.result : null;
    const error = terminal?.type === "error" ? `${terminal.failure}: ${terminal.message}` : null;
    const s = score(spec, variant, result, error, ms);
    scores.push(s);
    raw.push({ id: spec.id, variant, events });
    console.log(
      `${s.id.padEnd(28)} ${variant.padEnd(5)} ${s.outcome.padEnd(10)} claims ${s.claimsFound}/${s.claimsExpected}  false ${s.falseClaims.length}  questions ${s.questionsFound}/${s.questionsExpected}  explained ${s.explainedFound}/${s.explainedExpected}  ${formatMicros(s.costMicros).padStart(7)}  ${(s.ms / 1000).toFixed(1)}s${s.falseClaims.length ? `  FALSE: ${s.falseClaims.join("; ")}` : ""}`,
    );
  }
}

const sum = (pick: (s: Score) => number) => scores.reduce((t, s) => t + pick(s), 0);
const costs = scores.map((s) => s.costMicros).sort((a, b) => a - b);
const median = costs.length ? costs[Math.floor(costs.length / 2)] : 0;
for (const variant of ["pdf", "photo"] as const) {
  const of = scores.filter((s) => s.variant === variant);
  const total = (pick: (s: Score) => number) => of.reduce((t, s) => t + pick(s), 0);
  console.log(
    `\n${variant}: claims ${total((s) => s.claimsFound)}/${total((s) => s.claimsExpected)}, false claims ${total((s) => s.falseClaims.length)}, questions ${total((s) => s.questionsFound)}/${total((s) => s.questionsExpected)}, explained ${total((s) => s.explainedFound)}/${total((s) => s.explainedExpected)}, completed ${of.filter((s) => s.outcome === "checked").length}/${of.length}`,
  );
}
console.log(`\nruns ${scores.length}, total ${formatMicros(sum((s) => s.costMicros))}, median ${formatMicros(median)} per check, ledger total ${formatMicros(ledger.spentTotal())}`);

const outDir = path.join(process.cwd(), "eval", "results");
await mkdir(outDir, { recursive: true });
const file = path.join(outDir, `${new Date().toISOString().replaceAll(":", "-")}.json`);
await writeFile(file, JSON.stringify({ scores, raw }, null, 2));
console.log(`saved ${file}`);
