// Runs every eval bill through the real pipeline and Muse Ember, as a PDF and as a phone photo, and scores the
// result against the planted ground truth. Spend goes through the same ledger as the app.
// Usage: MODEL_API_KEY=… pnpm eval [case-id-substring]
//        pnpm eval --replay eval/run-….json   (today's rules on a saved run's readings; no Muse Ember, no spend)
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { formatMicros } from "../src/lib/cost";
import { decide, type Source } from "../src/lib/decide";
import { openLedger } from "../src/lib/ledger";
import { runCheck } from "../src/lib/pipeline";
import type { CheckEvent, CheckInput, CheckResult, Checked } from "../src/lib/result";
import { evalBills } from "./samples/eval-specs";
import { jpegDataUrl, photoOf, rasterize } from "./samples/raster";
import { renderBillPdf } from "./samples/render";
import { internetExpired, internetGuaranteed, yearBills, type BillSpec } from "./samples/specs";

const LONG_SIDE = 1600;
type Variant = "pdf" | "photo" | "call" | "year";

// A recording enters the check the way the browser sends it: 16 kHz mono 16-bit WAV with a plain 44-byte header.
function wavOf(file: string): { wav: string } {
  const out = path.join("/private/var/tmp", `billproof-eval-${path.basename(file)}.wav`);
  execFileSync("ffmpeg", ["-v", "error", "-y", "-i", file, "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", "-bitexact", "-map_metadata", "-1", out]);
  return { wav: readFileSync(out).toString("base64") };
}

async function billPage(spec: BillSpec) {
  const { png, text } = await rasterize(await renderBillPdf(spec), LONG_SIDE);
  return { pages: [{ image: await jpegDataUrl(png, LONG_SIDE), text }] };
}

async function inputFor(spec: BillSpec, variant: "pdf" | "photo"): Promise<CheckInput> {
  if (variant === "pdf") return { bills: [await billPage(spec)], offer: { kind: "text", text: spec.proof } };
  const photo = await photoOf((await rasterize(await renderBillPdf(spec), 2200)).png);
  return { bills: [{ pages: [{ image: await jpegDataUrl(photo, LONG_SIDE), text: null }] }], offer: { kind: "text", text: spec.proof } };
}

// `bills` are the statements the check is given and `offer` the written offer, if any; `specs` hold the expected answers.
type Case = { id: string; variant: Variant; specs: BillSpec[]; bills: BillSpec[]; offer: string | null; input: () => Promise<CheckInput> };

const samples = path.join(process.cwd(), "public", "samples");
const cases: Case[] = [
  ...evalBills.flatMap((spec) => (["pdf", "photo"] as const).map((variant) => ({ id: spec.id, variant, specs: [spec], bills: [spec], offer: spec.proof, input: () => inputFor(spec, variant) }))),
  // The same bill against two recorded calls: one promises two years, the other only the first year.
  { id: "call-two-years", variant: "call", specs: [internetGuaranteed], bills: [internetGuaranteed], offer: null, input: async () => ({ bills: [await billPage(internetGuaranteed)], offer: { kind: "audio", ...wavOf(path.join(samples, "call-two-years.m4a")) } }) },
  { id: "call-first-year", variant: "call", specs: [internetExpired], bills: [internetGuaranteed], offer: null, input: async () => ({ bills: [await billPage(internetGuaranteed)], offer: { kind: "audio", ...wavOf(path.join(samples, "call-first-year.m4a")) } }) },
  { id: "year-12", variant: "year", specs: yearBills, bills: yearBills, offer: internetGuaranteed.proof, input: async () => ({ bills: await Promise.all(yearBills.map(billPage)), offer: { kind: "text", text: internetGuaranteed.proof } }) },
];

// A saved check decided again by today's rules: Muse Ember's readings and promises as saved, the bill's text rendered
// again, and the claims the company-side step struck out last time struck out again (a year has no such step).
async function redecided(saved: Checked, c: Case, bill: BillSpec): Promise<Checked> {
  const source: Source = c.variant === "photo" ? { kind: "image" } : { kind: "text", text: (await rasterize(await renderBillPdf(bill), LONG_SIDE)).text };
  const proof: Source = c.offer === null ? { kind: "heard", text: (saved.transcript ?? []).map((turn) => turn.text).join("\n") } : { kind: "text", text: c.offer };
  const decision = decide(saved.reading, saved.promises, source, proof, saved.offerProvider);
  const key = (claim: { kind: string; lineIds: string[] }) => `${claim.kind}|${[...claim.lineIds].sort().join(",")}`;
  const struck = new Set(saved.dropped.map((d) => key(d.claim)));
  const claims = decision.claims.filter((claim) => !struck.has(key(claim))).map((claim) => ({ ...claim, lookedFor: null }));
  return { ...saved, claims, questions: decision.questions, explained: decision.explained };
}

const replayFile = process.argv[2] === "--replay" ? process.argv[3] : null;
const replayed: { id: string; variant: Variant; events: CheckEvent[] }[] = replayFile ? JSON.parse(readFileSync(replayFile, "utf8")).raw : [];

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
    } else if (!claim.needsConfirmation || variant === "photo" || variant === "call") {
      falseClaims.push(`${claim.kind} ${claim.amountCents}¢ on ${labels.join(" + ")}`);
    }
  }
  const questionsFound = spec.expected.questions.filter((want) => result.questions.some((q) => q.kind === want.kind && overlaps(want.labels, q.lineIds.map(label)))).length;
  const explainedFound = spec.expected.explained.filter((want) => result.explained.some((e) => overlaps(want.labels, e.lineIds.map(label)))).length;
  return { ...base, outcome: "checked", claimsFound, falseClaims, questionsFound, explainedFound, costMicros: result.spentMicros };
}

const filter = replayFile ? "" : (process.argv[2] ?? "");
const ledger = openLedger(path.join(process.cwd(), "data", "ledger.db"), Number(process.env.EVENT_BUDGET_MICROS ?? 6_000_000));
const scores: Score[] = [];
const raw: { id: string; variant: Variant; events: CheckEvent[] }[] = [];

for (const c of cases.filter((c) => c.id.includes(filter))) {
  const events: CheckEvent[] = [];
  const started = performance.now();
  if (replayFile) {
    events.push(...(replayed.find((r) => r.id === c.id && r.variant === c.variant)?.events ?? []));
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
  let result: CheckResult | null = terminal?.type === "result" ? terminal.result : null;
  if (replayFile && result?.outcome === "checked") result = await redecided(result, c, c.bills[0]);
  if (replayFile && result?.outcome === "year") {
    const months = await Promise.all(result.months.map(async (m) => ({ ...m, result: m.result.outcome === "checked" ? await redecided(m.result, c, c.bills[m.bill]) : m.result })));
    result = { ...result, months };
  }
  const error = terminal?.type === "error" ? `${terminal.failure}: ${terminal.message}` : terminal ? null : "not in the saved run";
  let s: Score;
  if (result?.outcome === "year") {
    // A year is scored month by month against each statement's planted truth, then summed.
    const months = result.months.map((m) => score(c.specs[m.bill], c.variant, m.result, null, ms));
    const add = (pick: (m: Score) => number) => months.reduce((t, m) => t + pick(m), 0);
    s = {
      id: c.id,
      variant: c.variant,
      ms,
      outcome: months.every((m) => m.outcome === "checked") ? "checked" : `${months.filter((m) => m.outcome === "checked").length}/12 checked`,
      claimsExpected: add((m) => m.claimsExpected),
      claimsFound: add((m) => m.claimsFound),
      falseClaims: months.flatMap((m, i) => m.falseClaims.map((f) => `month ${i + 1}: ${f}`)),
      questionsExpected: add((m) => m.questionsExpected),
      questionsFound: add((m) => m.questionsFound),
      explainedExpected: add((m) => m.explainedExpected),
      explainedFound: add((m) => m.explainedFound),
      costMicros: result.spentMicros,
    };
  } else {
    s = { ...score(c.specs[0], c.variant, result, error, ms), id: c.id };
  }
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
