// Saves each bundled sample's result from a saved eval run, decided again by today's rules, for the start screen to
// show, labelled as saved, when live checks are paused or the visitor's hour is used up. No Muse Ember, no spend.
// Usage: pnpm saved-samples eval/run-….json
import { readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { SAMPLE_CASES, savedSampleResult } from "./eval-cases";

const runFile = process.argv[2];
if (!runFile) throw new Error("Usage: pnpm saved-samples eval/run-….json");
const savedOn = /run-(\d{4}-\d{2}-\d{2})/.exec(runFile)?.[1];
if (!savedOn) throw new Error(`No date in the run's name: ${runFile}`);
const run = JSON.parse(readFileSync(runFile, "utf8"));

const out = path.join(process.cwd(), "public", "samples", "saved");
await mkdir(out, { recursive: true });
for (const sample of Object.keys(SAMPLE_CASES)) {
  const result = await savedSampleResult(sample, run);
  if (!result) throw new Error(`${sample}: no result in ${runFile}`);
  await writeFile(path.join(out, `${sample}.json`), JSON.stringify({ savedOn, result }));
  console.log(`${sample}: ${result.outcome}`);
}
