import { realRun } from "@/data/real-bills";

const MAX_BYTES = 12_000_000;
// Served from Billproof's own address, so only photo formats: an SVG could carry script.
const PHOTO_TYPE = /^image\/(jpeg|png|gif|webp)$/;

// Pictures from the checked public posts, looked up by post and position. The address always comes from the saved
// run, never from the request, so this can't be used to fetch anything else.
export async function GET(_request: Request, { params }: { params: Promise<{ id: string; n: string }> }) {
  const { id, n } = await params;
  const url = realRun.results.find((bill) => bill.id === id)?.images[Number(n)];
  if (!url) return new Response("Not found", { status: 404 });
  const upstream = await fetch(url, { headers: { "User-Agent": "billproof/0.1" }, signal: AbortSignal.timeout(15_000) }).catch(() => null);
  const type = upstream?.headers.get("content-type")?.split(";")[0].trim() ?? "";
  if (!upstream?.ok || !PHOTO_TYPE.test(type)) return new Response("Picture unavailable", { status: 502 });
  // The time limit still runs while the picture arrives, so reading it can fail too.
  const body = await upstream.arrayBuffer().catch(() => null);
  if (!body) return new Response("Picture unavailable", { status: 502 });
  if (body.byteLength > MAX_BYTES) return new Response("Picture too large", { status: 502 });
  return new Response(body, { headers: { "Content-Type": type, "Cache-Control": "public, max-age=86400, immutable" } });
}
