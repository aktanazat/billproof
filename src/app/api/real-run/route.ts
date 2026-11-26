import { realRun } from "@/data/real-bills";
import { postPages } from "@/data/real-pages";
import { runCheck } from "@/lib/pipeline";
import { LIVE_PAUSED, postNotes, unagreedCents, type LiveEvent } from "@/lib/real-bills";
import { clientKey, fromOwnPage, livePaused, serverLedger } from "@/lib/server-ledger";

const BATCH = 24;
const LANES = 8;
const HOUR_MS = 60 * 60_000;
const RUNS_PER_HOUR = 6;

// The real bills with the most to show come first: fees nobody agreed to, then any other bill.
const batch = realRun.results
  .filter((bill) => bill.outcome === "checked")
  .sort((a, b) => unagreedCents(b) - unagreedCents(a))
  .slice(0, BATCH);

// Spend limits for the button: one run at a time, a few runs an hour across the server, one per address an hour.
let running = false;
const startedRuns: number[] = [];
const lastRunByClient = new Map<string, number>();

function refusal(message: string, status: number) {
  const event: LiveEvent = { type: "refused", message };
  return new Response(JSON.stringify(event) + "\n", { status, headers: { "Content-Type": "application/x-ndjson" } });
}

const inMinutes = (ms: number) => {
  const minutes = Math.max(1, Math.ceil(ms / 60_000));
  return `in ${minutes} ${minutes === 1 ? "minute" : "minutes"}`;
};

export async function POST(request: Request) {
  if (!fromOwnPage(request)) return refusal("Start a live run from the Billproof page.", 403);
  if (livePaused()) return refusal(LIVE_PAUSED, 503);
  const now = Date.now();
  const client = clientKey(request);
  while (startedRuns.length > 0 && now - startedRuns[0] > HOUR_MS) startedRuns.shift();
  // A visitor's address is kept only for their hour.
  for (const [key, at] of lastRunByClient) if (now - at >= HOUR_MS) lastRunByClient.delete(key);
  if (running) return refusal("A live run is already going. Try again in a minute.", 503);
  if (startedRuns.length >= RUNS_PER_HOUR) return refusal(`The live run has been used a lot this hour. Try again ${inMinutes(startedRuns[0] + HOUR_MS - now)}.`, 429);
  const last = lastRunByClient.get(client) ?? 0;
  if (now - last < HOUR_MS) return refusal(`You can start one live run an hour. Try again ${inMinutes(last + HOUR_MS - now)}.`, 429);
  running = true;
  startedRuns.push(now);
  lastRunByClient.set(client, now);

  const encoder = new TextEncoder();
  const ledger = serverLedger();
  const started = performance.now();
  let spentMicros = 0;

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      // A closed stream drops lines rather than failing a check that is still spending.
      const send = (event: LiveEvent) => {
        try {
          if (!request.signal.aborted) controller.enqueue(encoder.encode(JSON.stringify(event) + "\n"));
        } catch {
          // The visitor left: no lane takes another bill, and calls cut off mid-way stay counted at what they reserved.
        }
      };
      try {
        send({ type: "batch", posts: batch.map((bill) => ({ id: bill.id, title: bill.title, provider: bill.outcome === "checked" ? bill.provider : null, picture: `/api/real-image/${bill.id}/${bill.outcome === "checked" ? (bill.billPages[0] ?? 0) : 0}` })) });
        let next = 0;
        const lane = async () => {
          while (next < batch.length && !request.signal.aborted) {
            const i = next++;
            const post = batch[i];
            const { pages } = await postPages(post.images);
            if (pages.length === 0) {
              send({ type: "post", i, event: { type: "error", failure: "bad_input", message: "The pictures are no longer online.", spentMicros: 0, retryable: false } });
              continue;
            }
            await runCheck(
              { bills: [{ pages }], offer: { kind: "text", text: postNotes(post) } },
              {
                ledger,
                // Each run is its own ledger client: the limits above bound runs, and a run's 24 checks must not
                // collide with the 30-an-hour cap left over from a run before a restart cleared those limits.
                client: `${client}#live:${now}`,
                signal: request.signal,
                emit: (event) => {
                  // The run's cost is its own checks' final costs, not the whole ledger's movement.
                  if (event.type === "result") spentMicros += event.result.spentMicros;
                  if (event.type === "error") spentMicros += event.spentMicros;
                  send({ type: "post", i, event });
                },
              },
            );
          }
        };
        await Promise.allSettled(Array.from({ length: LANES }, lane));
        send({ type: "done", seconds: (performance.now() - started) / 1000, spentMicros });
      } finally {
        running = false;
        // The hourly limits bound spending, so a run that cost nothing (Meta down or busy) gives its slots back.
        if (spentMicros === 0) {
          const at = startedRuns.indexOf(now);
          if (at >= 0) startedRuns.splice(at, 1);
          if (lastRunByClient.get(client) === now) lastRunByClient.delete(client);
        }
        try {
          controller.close();
        } catch {
          // Already closed by the visitor leaving.
        }
      }
    },
  });
  return new Response(stream, { headers: { "Content-Type": "application/x-ndjson", "Cache-Control": "no-store" } });
}
