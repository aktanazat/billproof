import { readFileSync } from "node:fs";
import path from "node:path";
import { expect, test } from "vitest";
import type { CheckEvent, CheckResult } from "../src/lib/result";
import { cases, replayed, scoreCase } from "./eval-cases";

// Two eval runs keep every reading Muse Ember made of the synthetic bills. Deciding them again under today's rules is
// how a rule change is checked against real model output without spending: each case must still find every planted
// claim, question and explanation, and make no claim it shouldn't (the README's table).
for (const run of ["run-2026-11-26.json", "run-2026-11-25b.json"]) {
  test(`today's rules score the saved readings of ${run} perfectly`, async () => {
    const saved: { id: string; variant: string; events: CheckEvent[] }[] = JSON.parse(readFileSync(path.join(import.meta.dirname, "..", "eval", run), "utf8")).raw;
    const misses: string[] = [];
    for (const c of cases) {
      const events = saved.find((r) => r.id === c.id && r.variant === c.variant)?.events ?? [];
      const terminal = events.at(-1);
      const result = await replayed(c, terminal?.type === "result" ? (terminal.result as CheckResult) : null);
      const s = scoreCase(c, result, terminal ? null : "not in the saved run", 0);
      const perfect = s.outcome === "checked" && s.claimsFound === s.claimsExpected && s.falseClaims.length === 0 && s.questionsFound === s.questionsExpected && s.explainedFound === s.explainedExpected;
      if (!perfect) misses.push(`${c.id} ${c.variant}: ${s.outcome}, claims ${s.claimsFound}/${s.claimsExpected}, questions ${s.questionsFound}/${s.questionsExpected}, explained ${s.explainedFound}/${s.explainedExpected}${s.falseClaims.length ? `, false: ${s.falseClaims.join("; ")}` : ""}`);
    }
    expect(misses).toEqual([]);
  }, 60_000);
}
