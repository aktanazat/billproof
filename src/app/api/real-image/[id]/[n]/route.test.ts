import { afterEach, expect, test, vi } from "vitest";
import { GET } from "./route";

afterEach(() => vi.unstubAllGlobals());

const picture = (reply: () => Promise<Response>) => {
  vi.stubGlobal("fetch", vi.fn(reply));
  return GET(new Request("http://localhost/api/real-image/1wen4kx/0"), { params: Promise.resolve({ id: "1wen4kx", n: "0" }) });
};

// The 15-second limit can run out while the picture is still arriving, not only before Reddit answers.
test("a picture cut off while downloading is unavailable, not a server error", async () => {
  const cutOff = new ReadableStream({
    start(controller) {
      controller.enqueue(new Uint8Array([0xff, 0xd8, 0xff]));
      controller.error(new DOMException("The operation timed out.", "TimeoutError"));
    },
  });
  const response = await picture(async () => new Response(cutOff, { headers: { "Content-Type": "image/jpeg" } }));
  expect(response.status).toBe(502);
});

// The route serves what Reddit returns from Billproof's own address; an SVG can carry script, and posts are photos.
test("an SVG from Reddit isn't served", async () => {
  const response = await picture(async () => new Response("<svg xmlns='http://www.w3.org/2000/svg'><script>alert(1)</script></svg>", { headers: { "Content-Type": "image/svg+xml" } }));
  expect(response.status).toBe(502);
});

test("a photo from Reddit is served as it came", async () => {
  const response = await picture(async () => new Response(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]), { headers: { "Content-Type": "image/jpeg" } }));
  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toBe("image/jpeg");
  expect(new Uint8Array(await response.arrayBuffer())).toEqual(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]));
});

// The page tells a picture the poster deleted ("no longer online") from one that failed to arrive ("couldn't be loaded
// just now") by this answer.
test("a picture Reddit says is deleted is not found; one that fails for a moment is unavailable", async () => {
  expect((await picture(async () => new Response("", { status: 404 }))).status).toBe(404);
  expect((await picture(async () => new Response("", { status: 503 }))).status).toBe(502);
});

test("a picture over 12 MB isn't served", async () => {
  const response = await picture(async () => new Response(new Uint8Array(12_000_001), { headers: { "Content-Type": "image/jpeg" } }));
  expect(response.status).toBe(502);
});

test("a post that isn't in the saved run is not found, and nothing is fetched", async () => {
  const fetched = vi.fn();
  vi.stubGlobal("fetch", fetched);
  const response = await GET(new Request("http://localhost/api/real-image/nope/0"), { params: Promise.resolve({ id: "nope", n: "0" }) });
  expect(response.status).toBe(404);
  expect(fetched).not.toHaveBeenCalled();
});
