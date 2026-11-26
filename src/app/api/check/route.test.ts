import { expect, test } from "vitest";
import { POST } from "./route";

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
  const fromOrigin = (origin: string | null) =>
    POST(new Request("http://billproof.aktan.us/api/check", { method: "POST", body: "{}", headers: { "Content-Type": "text/plain", Host: "billproof.aktan.us", ...(origin ? { Origin: origin } : {}) } }));
  // Safari before 16.4 (iOS 15 devices) sends Origin on a POST but not Sec-Fetch-Site.
  expect((await fromOrigin("https://billproof.aktan.us")).status).toBe(400);
  expect((await fromOrigin("https://evil.example")).status).toBe(403);
  expect((await fromOrigin(null)).status).toBe(403);
});
