// The eval's cases and its scoring against their planted ground truth, shared by `pnpm eval` and the replay test.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { decide, type Source } from "../src/lib/decide";
import type { CheckEvent, CheckInput, CheckResult, Checked } from "../src/lib/result";
import { evalBills } from "./samples/eval-specs";
import { jpegDataUrl, photoOf, rasterize } from "./samples/raster";
import { renderBillPdf } from "./samples/render";
import { internetExpired, internetGuaranteed, yearBills, type BillSpec } from "./samples/specs";

const LONG_SIDE = 1600;
export type Variant = "pdf" | "photo" | "call" | "year";

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
export type Case = { id: string; variant: Variant; specs: BillSpec[]; bills: BillSpec[]; offer: string | null; input: () => Promise<CheckInput> };

const samples = path.join(process.cwd(), "public", "samples");
export const cases: Case[] = [
  ...evalBills.flatMap((spec) => (["pdf", "photo"] as const).map((variant) => ({ id: spec.id, variant, specs: [spec], bills: [spec], offer: spec.proof, input: () => inputFor(spec, variant) }))),
  // The same bill against two recorded calls: one promises two years, the other only the first year.
  { id: "call-two-years", variant: "call", specs: [internetGuaranteed], bills: [internetGuaranteed], offer: null, input: async () => ({ bills: [await billPage(internetGuaranteed)], offer: { kind: "audio", ...wavOf(path.join(samples, "call-two-years.m4a")) } }) },
  { id: "call-first-year", variant: "call", specs: [internetExpired], bills: [internetGuaranteed], offer: null, input: async () => ({ bills: [await billPage(internetGuaranteed)], offer: { kind: "audio", ...wavOf(path.join(samples, "call-first-year.m4a")) } }) },
  { id: "year-12", variant: "year", specs: yearBills, bills: yearBills, offer: internetGuaranteed.proof, input: async () => ({ bills: await Promise.all(yearBills.map(billPage)), offer: { kind: "text", text: internetGuaranteed.proof } }) },
];

// Each sample on the start screen, by its id in public/samples/index.json, and the eval case that checked it. Their
// saved checks (public/samples/saved) stand in when a live one is refused.
export const SAMPLE_CASES: Record<string, { id: string; variant: Variant }> = {
  "internet-guaranteed": { id: "internet-guaranteed", variant: "pdf" },
  "internet-expired": { id: "internet-expired", variant: "pdf" },
  "mobile-autopay": { id: "mobile-autopay", variant: "pdf" },
  "call-two-years": { id: "call-two-years", variant: "call" },
  "call-first-year": { id: "call-first-year", variant: "call" },
  year: { id: "year-12", variant: "year" },
};

// A sample's saved check: the eval run's result for its case, decided again by today's rules.
export async function savedSampleResult(sample: string, run: { raw: { id: string; variant: Variant; events: CheckEvent[] }[] }): Promise<CheckResult | null> {
  const target = SAMPLE_CASES[sample];
  const c = target && cases.find((each) => each.id === target.id && each.variant === target.variant);
  const terminal = target && run.raw.find((each) => each.id === target.id && each.variant === target.variant)?.events.at(-1);
  return c && terminal?.type === "result" ? replayed(c, terminal.result) : null;
}

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

// A saved result, every statement in it decided again by today's rules.
export async function replayed(c: Case, result: CheckResult | null): Promise<CheckResult | null> {
  if (result?.outcome === "checked") return redecided(result, c, c.bills[0]);
  if (result?.outcome !== "year") return result;
  const months = await Promise.all(result.months.map(async (m) => ({ ...m, result: m.result.outcome === "checked" ? await redecided(m.result, c, c.bills[m.bill]) : m.result })));
  return { ...result, months };
}

export type Score = {
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

// A case's score; a year is scored month by month against each statement's planted truth, then summed.
export function scoreCase(c: Case, result: CheckResult | null, error: string | null, ms: number): Score {
  if (result?.outcome !== "year") return { ...score(c.specs[0], c.variant, result, error, ms), id: c.id };
  const months = result.months.map((m) => score(c.specs[m.bill], c.variant, m.result, null, ms));
  const add = (pick: (m: Score) => number) => months.reduce((t, m) => t + pick(m), 0);
  return {
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
}
