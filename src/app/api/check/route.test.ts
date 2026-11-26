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
