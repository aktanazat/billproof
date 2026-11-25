import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { photoOf, rasterize } from "./samples/raster";
import { renderBillPdf } from "./samples/render";
import { demoBills } from "./samples/specs";

const OUT = path.join(process.cwd(), "public", "samples");

const TITLES: Record<string, string> = {
  "internet-guaranteed": "Internet, price guaranteed",
  "internet-expired": "Internet, promo ended",
  "mobile-autopay": "Phone, autopay credit",
};

await mkdir(OUT, { recursive: true });
for (const spec of demoBills) {
  const pdf = await renderBillPdf(spec);
  await writeFile(path.join(OUT, `${spec.id}.pdf`), pdf);
  await writeFile(path.join(OUT, `${spec.id}.jpg`), await photoOf((await rasterize(pdf, 2200)).png));
}
await writeFile(
  path.join(OUT, "index.json"),
  JSON.stringify(
    demoBills.map((spec) => ({ id: spec.id, title: TITLES[spec.id], bill: `/samples/${spec.id}.pdf`, proof: spec.proof })),
    null,
    2,
  ),
);
console.log(`wrote ${demoBills.length} samples to ${OUT}`);
