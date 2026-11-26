import { runCheck } from "@/lib/pipeline";
import { checkInputSchema, MAX_UPLOAD_BYTES, type CheckEvent, type CheckFailure } from "@/lib/result";
import { clientKey, serverLedger } from "@/lib/server-ledger";

function refuse(status: number, message: string, failure: CheckFailure = "bad_input", retryable = false) {
  const event: CheckEvent = { type: "error", failure, message, spentMicros: 0, retryable };
  return new Response(JSON.stringify(event) + "\n", { status, headers: { "Content-Type": "application/x-ndjson" } });
}

// Uploads are buffered and parsed before the per-address limit can apply, so the number in progress is capped first.
const MAX_IN_FLIGHT = 4;
let inFlight = 0;

export async function POST(request: Request) {
  if (inFlight >= MAX_IN_FLIGHT) return refuse(503, "Billproof is busy with other checks. Try again in a minute.", "rate_limited", true);
  inFlight += 1;
  let streaming = false;
  try {
    const declared = Number(request.headers.get("content-length") ?? "0");
    if (declared > MAX_UPLOAD_BYTES) return refuse(413, "These files are too large. Try fewer pages or a smaller photo.");

    const raw = await request.text();
    if (raw.length > MAX_UPLOAD_BYTES) return refuse(413, "These files are too large. Try fewer pages or a smaller photo.");
    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch {
      return refuse(400, "The upload was incomplete. Try again.");
    }
    const input = checkInputSchema.safeParse(json);
    if (!input.success) return refuse(400, "The files could not be prepared for reading.");

    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        try {
          await runCheck(input.data, {
            ledger: serverLedger(),
            client: clientKey(request),
            signal: request.signal,
            emit: (event) => {
              if (!request.signal.aborted) controller.enqueue(encoder.encode(JSON.stringify(event) + "\n"));
            },
          });
        } finally {
          inFlight -= 1;
        }
        if (!request.signal.aborted) controller.close();
      },
    });
    streaming = true;
    return new Response(stream, { headers: { "Content-Type": "application/x-ndjson", "Cache-Control": "no-store" } });
  } finally {
    if (!streaming) inFlight -= 1;
  }
}
