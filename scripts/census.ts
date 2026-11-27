// Runs Billproof over real bills people posted publicly, each against what the poster says they were promised,
// and writes what it found. Spend goes through the same ledger as the app.
// Usage: MODEL_API_KEY=… pnpm census <posts.jsonl> [limit]
//        pnpm census --redecide   (applies today's deciding rules to the saved readings; no model calls)
// Each input line: { id, sub, title, text, images: string[], permalink, created }.
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { postPages } from "../src/data/real-pages";
import { formatMicros } from "../src/lib/cost";
import { openLedger } from "../src/lib/ledger";
import { runCheck } from "../src/lib/pipeline";
import { decide } from "../src/lib/decide";
import { claimedCents, postNotes, type RealBill, type RealRun } from "../src/lib/real-bills";
import { MAX_BILL_PAGES } from "../src/lib/limits";
import type { CheckEvent, CheckInput, CheckResult, Checked } from "../src/lib/result";

type Post = { id: string; sub: string; title: string; text: string; images: string[]; permalink: string; created: number };

const CONCURRENCY = 8;

// Only what a reader of the results page needs: no names, account numbers or addresses.
function summary(post: Post, result: CheckResult | null, error: string | null, ms: number, positions: number[]): RealBill {
  const base = { id: post.id, sub: post.sub, permalink: post.permalink, created: post.created, title: post.title, text: post.text, images: post.images.slice(0, MAX_BILL_PAGES), ms };
  if (!result) return { ...base, outcome: "error", error, spentMicros: 0 };
  if (result.outcome === "year") throw new Error("A post is one bill");
  if (result.outcome !== "checked") return { ...base, outcome: result.outcome, spentMicros: result.spentMicros };
  const line = (id: string) => result.reading.line_items.find((item) => item.id === id);
  const label = (id: string) => line(id)?.label ?? id;
  return {
    ...base,
    outcome: "checked",
    provider: result.reading.provider,
    period: [result.reading.period_start, result.reading.period_end],
    lines: result.reading.line_items.length,
    lineSum: result.totals.lineSum,
    // Page numbers count loaded pictures; the site shows pictures by their place in the post.
    billPages: result.billPages.map((i) => positions[i] ?? i),
    change: result.change && { earlierCents: result.change.earlierCents, currentCents: result.change.currentCents },
    claims: result.claims.map((claim) => ({
      kind: claim.kind,
      amountCents: claim.amountCents,
      actualCents: claim.actualCents,
      expectedCents: claim.expectedCents,
      lines: claim.lineIds.map(label),
      promise: result.promises.find((p) => p.id === claim.promiseId)?.quote ?? null,
      needsConfirmation: claim.needsConfirmation,
    })),
    dropped: result.dropped.map((item) => ({ amountCents: item.claim.amountCents, counterQuote: item.counterQuote })),
    questions: result.questions.map((question) => ({ kind: question.kind, lines: question.lineIds.map(label), cents: question.lineIds.reduce((t, id) => t + (line(id)?.amount_cents ?? 0), 0) })),
    explained: result.explained.length,
    hadOffer: result.hadOffer,
    matchedPromises: result.matchedPromiseIds.length,
    spentMicros: result.spentMicros,
  };
}

const site = path.join(process.cwd(), "src", "data", "real-bills.json");
const rawDir = path.join(process.cwd(), "eval", "census");

// The page shows each bill as the deciding rules judged it when the census ran; after the rules change, a live check
// of the same post answers differently. This judges every bill's saved reading again and replaces only what that
// judgment writes. A bill whose claims would change needs the company's side checked again, which is a model call, so
// it is named and nothing is written.
async function redecide() {
  const run = JSON.parse(await readFile(site, "utf8")) as RealRun;
  const saved = new Map<string, Checked[]>();
  for (const name of (await readdir(rawDir)).filter((f) => f.startsWith("raw-")).sort()) {
    for (const check of JSON.parse(await readFile(path.join(rawDir, name), "utf8")) as { id: string; events: CheckEvent[] }[]) {
      const end = check.events.at(-1);
      if (end?.type === "result" && end.result.outcome === "checked") saved.set(check.id, [...(saved.get(check.id) ?? []), end.result]);
    }
  }
  const claimKeys = (claims: { kind: string; amountCents: number }[]) => JSON.stringify(claims.map((c) => `${c.kind} ${c.amountCents}`).sort());
  const stale: string[] = [];
  let changed = 0;
  const results = run.results.map((bill) => {
    if (bill.outcome !== "checked") return bill;
    // A post read more than once keeps the reading the page shows.
    const result = saved.get(bill.id)?.filter((r) => r.reading.line_items.length === bill.lines && r.reading.provider === bill.provider && r.reading.period_start === bill.period[0] && r.reading.period_end === bill.period[1]).at(-1);
    if (!result) throw new Error(`${bill.id}: no saved reading matches the published one`);
    const decision = decide(result.reading, result.promises, { kind: "image" }, { kind: "text", text: postNotes(bill) }, result.offerProvider);
    if (claimKeys(decision.claims) !== claimKeys([...result.claims, ...result.dropped.map((d) => d.claim)])) stale.push(bill.id);
    const judged = summary(bill, { ...result, ...decision, claims: result.claims, dropped: result.dropped }, null, bill.ms, []);
    if (judged.outcome !== "checked") throw new Error(`${bill.id}: a checked bill stopped being one`);
    const next = { ...bill, questions: judged.questions, explained: judged.explained, matchedPromises: judged.matchedPromises };
    if (JSON.stringify(next) !== JSON.stringify(bill)) changed++;
    return next;
  });
  if (stale.length > 0) throw new Error(`Claims would change on ${stale.join(", ")}: run the census again for these posts`);
  await writeFile(site, JSON.stringify({ ...run, results }, null, 2));
  console.log(`${changed} of ${results.filter((r) => r.outcome === "checked").length} bills changed; saved ${site}`);
}

const [file, limitArg] = process.argv.slice(2);
if (file === "--redecide") {
  await redecide();
  process.exit(0);
}
if (!file) throw new Error("Usage: pnpm census <posts.jsonl> [limit]");
const posts: Post[] = (await readFile(file, "utf8"))
  .split("\n")
  .filter(Boolean)
  .map((line) => JSON.parse(line) as Post)
  .slice(0, limitArg ? Number(limitArg) : undefined);

const ledger = openLedger(path.join(process.cwd(), "data", "ledger.db"), Number(process.env.EVENT_BUDGET_MICROS ?? 6_000_000));
const results: RealBill[] = [];
const raw: { id: string; events: CheckEvent[] }[] = [];
let next = 0;

async function lane() {
  while (next < posts.length) {
    const post = posts[next++];
    const { pages, positions } = await postPages(post.images);
    if (pages.length === 0) {
      results.push(summary(post, null, "images unavailable", 0, positions));
      continue;
    }
    const input: CheckInput = { bills: [{ pages }], offer: { kind: "text", text: postNotes(post) } };
    const events: CheckEvent[] = [];
    const started = performance.now();
    await runCheck(input, { ledger, client: `census:${post.id}:${Date.now()}`, signal: AbortSignal.timeout(240_000), emit: (event) => events.push(event) });
    const ms = Math.round(performance.now() - started);
    const terminal = events.at(-1);
    const result = terminal?.type === "result" ? terminal.result : null;
    const error = terminal?.type === "error" ? `${terminal.failure}: ${terminal.message}` : null;
    const bill = summary(post, result, error, ms, positions);
    results.push(bill);
    raw.push({ id: post.id, events });
    const found = claimedCents(bill);
    console.log(`${post.id.padEnd(8)} ${post.sub.padEnd(16)} ${bill.outcome.padEnd(14)} ${found ? `$${(found / 100).toFixed(2)}` : "-"}  ${formatMicros(bill.spentMicros)}  ${(ms / 1000).toFixed(1)}s  ${post.title.slice(0, 60)}`);
  }
}

const started = performance.now();
await Promise.all(Array.from({ length: CONCURRENCY }, lane));
const seconds = (performance.now() - started) / 1000;

const checked = results.filter((r) => r.outcome === "checked");
const withClaims = checked.filter((r) => claimedCents(r) > 0);
const totalCents = withClaims.reduce((t, r) => t + claimedCents(r), 0);
const spent = results.reduce((t, r) => t + r.spentMicros, 0);
console.log(`\n${posts.length} posts, ${checked.length} read as bills, ${withClaims.length} with a charge above what the poster says was promised, $${(totalCents / 100).toFixed(2)} in total, ${formatMicros(spent)} spent, ${seconds.toFixed(0)}s`);

// The site's real-bills page reads the summary; every event of every check stays local under eval/census.
const run: RealRun = { ranAt: new Date().toISOString(), spentMicros: spent, posts: posts.length, results };
await mkdir(path.dirname(site), { recursive: true });
await mkdir(rawDir, { recursive: true });
await writeFile(site, JSON.stringify(run, null, 2));
await writeFile(path.join(rawDir, `raw-${Date.now()}.json`), JSON.stringify(raw));
console.log(`saved ${site}`);
