import { expect, test, vi } from "vitest";
import { POST } from "./route";

// The check itself (Muse Ember's calls) is stood in by one that runs until the test lets it finish, so checks can be
// held open; no test here reaches Muse Ember.
const pipeline = vi.hoisted(() => {
  let release = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { held, release: () => release() };
});
vi.mock("@/lib/pipeline", () => ({ runCheck: () => pipeline.held }));

const post = (site: string | null, body: string) =>
  POST(new Request("https://billproof.aktan.us/api/check", { method: "POST", body, headers: { "Content-Type": "text/plain", ...(site ? { "Sec-Fetch-Site": site } : {}) } }));

test("a check can be started only from Billproof's own page, so another site can't spend it from its visitors' browsers", async () => {
  for (const site of ["cross-site", "same-site", "none", null]) {
    const refused = await post(site, "{}");
    expect(refused.status, String(site)).toBe(403);
    expect(await refused.text()).toContain("Start a check from the Billproof page.");
  }
  // From the site's own page the request goes on to be read, and this one is refused only for its empty body.
  expect((await post("same-origin", "{}")).status).toBe(400);
});

test("an older browser that sends no Sec-Fetch-Site is let through only when its Origin is Billproof's own", async () => {
  // Behind the front server the request is addressed to the container; the site's name arrives only in Host.
  const fromOrigin = (origin: string | null) =>
    POST(new Request("http://0.0.0.0:3000/api/check", { method: "POST", body: "{}", headers: { "Content-Type": "text/plain", Host: "billproof.aktan.us", ...(origin ? { Origin: origin } : {}) } }));
  // Safari before 16.4 (iOS 15 devices) sends Origin on a POST but not Sec-Fetch-Site.
  expect((await fromOrigin("https://billproof.aktan.us")).status).toBe(400);
  expect((await fromOrigin("https://evil.example")).status).toBe(403);
  expect((await fromOrigin(null)).status).toBe(403);
});

// A body past the 40 MB a check takes was read and parsed whole, then refused as "The upload was incomplete": a reason
// that sends the person to retry the same files.
test("an upload past the size a check takes is refused as too large, not as broken", async () => {
  const refused = await post("same-origin", "x".repeat(40_000_001));
  expect(refused.status).toBe(413);
  expect(await refused.text()).toContain("These files are too large.");
});

// The server is small and each check holds its files in memory while it's read, so a fifth at once waits its turn.
test("past four checks running at once, another is told Billproof is busy, and taken once one ends", async () => {
  vi.stubEnv("LEDGER_PATH", ":memory:");
  const body = JSON.stringify({ bills: [{ pages: [{ image: "data:image/png;base64,AAAA", text: null }] }], offer: null });
  const running = await Promise.all([1, 2, 3, 4].map(() => post("same-origin", body)));
  expect(running.map((response) => response.status)).toEqual([200, 200, 200, 200]);
  const busy = await post("same-origin", body);
  expect(busy.status).toBe(503);
  expect(await busy.text()).toContain("Billproof is busy with other checks.");
  pipeline.release();
  await Promise.all(running.map((response) => response.text()));
  expect((await post("same-origin", body)).status).toBe(200);
});
