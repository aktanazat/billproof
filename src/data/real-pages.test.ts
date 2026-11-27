import sharp from "sharp";
import { afterEach, expect, test, vi } from "vitest";
import { postPages } from "./real-pages";

afterEach(() => vi.unstubAllGlobals());

// 34 of the posts' PNG and GIF pictures still online have transparent areas. JPEG has none, and saving one as JPEG
// without a background turned those areas black, with any dark text on them unreadable.
test("a transparent picture from a post reaches the check on white", async () => {
  const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="200" height="60"><rect x="20" y="20" width="40" height="20" fill="#000"/></svg>');
  const png = await sharp(svg).png().toBuffer();
  vi.stubGlobal("fetch", vi.fn(async () => new Response(new Uint8Array(png), { headers: { "Content-Type": "image/png" } })));
  const { pages } = await postPages(["https://i.redd.it/transparent.png"]);
  const jpeg = Buffer.from(pages[0].image.split(",")[1], "base64");
  const { data, info } = await sharp(jpeg).raw().toBuffer({ resolveWithObject: true });
  const at = (x: number, y: number) => [...data.subarray((y * info.width + x) * info.channels, (y * info.width + x) * info.channels + 3)];
  expect(at(5, 5).every((channel) => channel > 240)).toBe(true);
  expect(at(40, 30).every((channel) => channel < 15)).toBe(true);
});

// Reddit answers a deleted picture with 403, 404 or 410; anything else (a timeout, a 5xx) is a passing failure, and the
// live run says to try again rather than that the post's pictures are gone.
test("pictures Reddit says are gone are told apart from pictures that failed to load just now", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => new Response("down", { status: 503 })));
  expect(await postPages(["https://i.redd.it/a.png", "https://i.redd.it/b.png"])).toMatchObject({ pages: [], unavailable: 2 });
  vi.stubGlobal("fetch", vi.fn(async () => new Response("gone", { status: 404 })));
  expect(await postPages(["https://i.redd.it/a.png", "https://i.redd.it/b.png"])).toMatchObject({ pages: [], unavailable: 0 });
});
