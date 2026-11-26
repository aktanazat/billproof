// Runs Billproof over real bills people posted publicly, each against what the poster says they were promised,
// and writes what it found. Spend goes through the same ledger as the app.
// Usage: MODEL_API_KEY=… pnpm census <posts.jsonl> [limit]
// Each input line: { id, sub, title, text, images: string[], permalink, created }.
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { postPages } from "../src/data/real-pages";
import { formatMicros } from "../src/lib/cost";
import { openLedger } from "../src/lib/ledger";
import { runCheck } from "../src/lib/pipeline";
import { claimedCents, postNotes, type RealBill, type RealRun } from "../src/lib/real-bills";
import { MAX_BILL_PAGES, type CheckEvent, type CheckInput, type CheckResult } from "../src/lib/result";

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

const [file, limitArg] = process.argv.slice(2);
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
const run: RealRun = { ranAt: new Date().toISOString(), seconds, spentMicros: spent, posts: posts.length, results };
const site = path.join(process.cwd(), "src", "data", "real-bills.json");
const rawDir = path.join(process.cwd(), "eval", "census");
await mkdir(path.dirname(site), { recursive: true });
await mkdir(rawDir, { recursive: true });
await writeFile(site, JSON.stringify(run, null, 2));
await writeFile(path.join(rawDir, `raw-${Date.now()}.json`), JSON.stringify(raw));
console.log(`saved ${site}`);
