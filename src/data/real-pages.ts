import "server-only";
import sharp from "sharp";
import { MAX_BILL_PAGES, PAGE_LONG_SIDE } from "@/lib/limits";
import type { PreparedPage } from "@/lib/result";

// How Reddit answers for a picture the poster deleted. Any other failure (a timeout, a 5xx) passes, so it's retried.
export const GONE_STATUSES = new Set([403, 404, 410]);

// A post's pictures as the check reads them: fetched from Reddit, turned upright, scaled like an upload. A picture
// that is gone or unreadable is skipped; `positions` holds each loaded page's place among the post's pictures, so a
// page number from the check still points at the right picture. `unavailable` counts pictures that failed to arrive
// for any reason but being gone, so a post isn't called deleted when Reddit was only slow.
export async function postPages(images: string[]): Promise<{ pages: PreparedPage[]; positions: number[]; unavailable: number }> {
  let unavailable = 0;
  const loaded = await Promise.all(
    images.slice(0, MAX_BILL_PAGES).map(async (url) => {
      let bytes: Buffer;
      try {
        const response = await fetch(url, { headers: { "User-Agent": "billproof/0.1" }, signal: AbortSignal.timeout(30_000) });
        if (!response.ok) {
          if (!GONE_STATUSES.has(response.status)) unavailable += 1;
          return null;
        }
        bytes = Buffer.from(await response.arrayBuffer());
      } catch {
        unavailable += 1;
        return null;
      }
      try {
        const jpeg = await sharp(bytes)
          .rotate()
          .resize({ width: PAGE_LONG_SIDE, height: PAGE_LONG_SIDE, fit: "inside", withoutEnlargement: true })
          // JPEG has no transparency; without a background, transparent areas come out black.
          .flatten({ background: "#ffffff" })
          .jpeg({ quality: 85 })
          .toBuffer();
        return { image: `data:image/jpeg;base64,${jpeg.toString("base64")}`, text: null };
      } catch {
        return null;
      }
    }),
  );
  const positions = loaded.flatMap((page, i) => (page ? [i] : []));
  return { pages: positions.map((i) => loaded[i]).filter((page) => page !== null), positions, unavailable };
}
