import "server-only";
import sharp from "sharp";
import type { PreparedPage } from "@/lib/result";

const LONG_SIDE = 1600;
export const MAX_POST_PICTURES = 6;

// A post's pictures as the check reads them: fetched from Reddit, turned upright, scaled like an upload. A picture
// that is gone or unreadable is skipped; `positions` holds each loaded page's place among the post's pictures, so a
// page number from the check still points at the right picture.
export async function postPages(images: string[]): Promise<{ pages: PreparedPage[]; positions: number[] }> {
  const loaded = await Promise.all(
    images.slice(0, MAX_POST_PICTURES).map(async (url) => {
      try {
        const response = await fetch(url, { headers: { "User-Agent": "billproof/0.1" }, signal: AbortSignal.timeout(30_000) });
        if (!response.ok) return null;
        const jpeg = await sharp(Buffer.from(await response.arrayBuffer()))
          .rotate()
          .resize({ width: LONG_SIDE, height: LONG_SIDE, fit: "inside", withoutEnlargement: true })
          .jpeg({ quality: 85 })
          .toBuffer();
        return { image: `data:image/jpeg;base64,${jpeg.toString("base64")}`, text: null };
      } catch {
        return null;
      }
    }),
  );
  const positions = loaded.flatMap((page, i) => (page ? [i] : []));
  return { pages: positions.map((i) => loaded[i]).filter((page) => page !== null), positions };
}
