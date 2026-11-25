import "server-only";
import { z } from "zod";
import { costMicros, type Usage } from "./cost";

const BASE = "https://api.meta.ai/v1";
export const MODEL = "muse-ember-1.0";

export type Effort = "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

export type Part = { type: "text"; text: string } | { type: "image"; dataUrl: string } | { type: "audio"; wav: string };

export type EmberCall<T> = {
  name: string;
  instructions: string;
  parts: Part[];
  schema: z.ZodType<T>;
  effort: Effort;
  maxOutputTokens: number;
};

export type EmberRequest<T> = { call: EmberCall<T>; body: Record<string, unknown> };

export type EmberFailure = "rate_limited" | "upstream" | "truncated" | "refused" | "invalid_output" | "config";

export class EmberError extends Error {
  constructor(
    readonly kind: EmberFailure,
    message: string,
    // What Meta billed for the attempt, when the response reported usage before the failure.
    readonly billedMicros: number | null = null,
    readonly retryAfterSeconds?: number,
  ) {
    super(message);
  }
}

export function buildRequest<T>(call: EmberCall<T>): EmberRequest<T> {
  const content = call.parts.map((part) =>
    part.type === "text"
      ? { type: "input_text", text: part.text }
      : part.type === "image"
        ? { type: "input_image", image_url: part.dataUrl }
        : { type: "input_audio", input_audio: { data: part.wav, format: "wav" } },
  );
  return {
    call,
    body: {
      model: MODEL,
      store: false,
      stream: true,
      instructions: call.instructions,
      input: [{ type: "message", role: "user", content }],
      // The summary is what the person watches while Muse Ember works; the raw reasoning stays private.
      reasoning: { effort: call.effort, summary: "detailed" },
      max_output_tokens: call.maxOutputTokens,
      prompt_cache_key: `billproof-${call.name}`,
      text: { format: { type: "json_schema", name: call.name, schema: z.toJSONSchema(call.schema), strict: false } },
    },
  };
}

function apiKey(): string {
  const key = process.env.MODEL_API_KEY;
  if (!key) throw new EmberError("config", "MODEL_API_KEY is not set on the server");
  return key;
}

async function post(path: string, body: unknown, signal: AbortSignal): Promise<Response> {
  const res = await fetch(`${BASE}${path}`, {
    method: "POST",
    signal,
    headers: { Authorization: `Bearer ${apiKey()}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (res.status === 429) {
    const retryAfter = Number(res.headers.get("retry-after"));
    throw new EmberError("rate_limited", "Muse Ember is rate limited right now", null, Number.isFinite(retryAfter) ? retryAfter : undefined);
  }
  if (!res.ok) {
    const text = await res.text();
    throw new EmberError("upstream", `Meta Model API returned HTTP ${res.status}: ${text.slice(0, 300)}`);
  }
  return res;
}

const countShape = z.object({ input_tokens: z.number().int() });

// Exact input tokens for the rendered request (dev.meta.ai/docs/prompt-caching#token-counting). Does not generate.
export async function countInputTokens(request: EmberRequest<unknown>, signal: AbortSignal): Promise<number> {
  const { model, instructions, input, text } = request.body;
  const res = await post("/responses/input_tokens", { model, instructions, input, text }, signal);
  return countShape.parse(await res.json()).input_tokens;
}

const responseShape = z.object({
  status: z.string(),
  incomplete_details: z.object({ reason: z.string().nullish() }).nullish(),
  output: z.array(
    z.object({
      type: z.string(),
      content: z.array(z.object({ type: z.string(), text: z.string().optional(), refusal: z.string().optional() })).optional(),
    }),
  ),
  usage: z.object({
    input_tokens: z.number(),
    output_tokens: z.number(),
    input_tokens_details: z.object({ cached_tokens: z.number() }).nullish(),
  }),
});

export type EmberResult<T> = { output: T; usage: Usage; costMicros: number };

export type EmberDelta = { kind: "thinking"; text: string } | { kind: "output"; text: string };

const streamEvent = z.object({
  type: z.string(),
  delta: z.string().optional(),
  response: z.unknown().optional(),
});

// Reads the server-sent events of a streamed response, forwarding summary and output deltas, and returns the final
// response object carried by the terminal event.
async function readStream(res: Response, onDelta: (delta: EmberDelta) => void): Promise<unknown> {
  if (!res.body) throw new EmberError("upstream", "Meta Model API sent an empty stream");
  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = "";
  let final: unknown = null;
  let summaryParts = 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += value;
    const events = buffer.split("\n\n");
    buffer = events.pop() ?? "";
    for (const block of events) {
      const data = block
        .split("\n")
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trimStart())
        .join("\n");
      if (!data || data === "[DONE]") continue;
      const event = streamEvent.safeParse(JSON.parse(data));
      if (!event.success) continue;
      const { type, delta, response } = event.data;
      if (type === "response.reasoning_summary_part.added" && summaryParts++ > 0) onDelta({ kind: "thinking", text: "\n\n" });
      else if (type === "response.reasoning_summary_text.delta" && delta) onDelta({ kind: "thinking", text: delta });
      else if (type === "response.output_text.delta" && delta) onDelta({ kind: "output", text: delta });
      else if (type === "response.completed" || type === "response.incomplete" || type === "response.failed") final = response;
    }
  }
  if (final === null) throw new EmberError("upstream", "The stream from Meta Model API ended without a result");
  return final;
}

export async function send<T>(request: EmberRequest<T>, signal: AbortSignal, onDelta: (delta: EmberDelta) => void): Promise<EmberResult<T>> {
  const res = await post("/responses", request.body, signal);
  const parsed = responseShape.safeParse(await readStream(res, onDelta));
  if (!parsed.success) throw new EmberError("upstream", "Meta Model API returned a response in an unexpected shape");
  const usage: Usage = {
    inputTokens: parsed.data.usage.input_tokens,
    cachedTokens: parsed.data.usage.input_tokens_details?.cached_tokens ?? 0,
    outputTokens: parsed.data.usage.output_tokens,
  };
  const billed = costMicros(usage);
  const name = request.call.name;

  if (parsed.data.status === "failed") throw new EmberError("upstream", `${name} failed on Meta's side`, billed);
  if (parsed.data.status !== "completed") {
    throw new EmberError("truncated", `${name} stopped early (${parsed.data.incomplete_details?.reason ?? parsed.data.status})`, billed);
  }
  const content = parsed.data.output.filter((item) => item.type === "message").flatMap((item) => item.content ?? []);
  const refusal = content.find((c) => c.type === "refusal");
  if (refusal) throw new EmberError("refused", `${name} was refused: ${refusal.refusal ?? ""}`.trim(), billed);

  const text = content.filter((c) => c.type === "output_text").map((c) => c.text ?? "").join("");
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new EmberError("invalid_output", `${name} did not return JSON`, billed);
  }
  const checked = request.call.schema.safeParse(json);
  if (!checked.success) throw new EmberError("invalid_output", `${name} returned fields that failed validation`, billed);
  return { output: checked.data, usage, costMicros: billed };
}
