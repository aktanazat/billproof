import type { MetadataRoute } from "next";

// A real post's "Check it live" link starts a paid check as soon as its page runs, and crawlers that run pages would
// spend the demo's budget by following them; the API routes behind the pages aren't for crawling either.
export default function robots(): MetadataRoute.Robots {
  return { rules: { userAgent: "*", allow: "/", disallow: ["/*?post=", "/api/"] } };
}
