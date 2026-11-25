import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { photoOf, rasterize } from "./samples/raster";
import { renderBillPdf } from "./samples/render";
import { demoBills } from "./samples/specs";

const OUT = path.join(process.cwd(), "public", "samples");

// What each sample shows, as checked live on muse-ember-1.0 (eval/run-2026-11-25.json).
const COPY: Record<string, { title: string; outcome: string }> = {
  "internet-guaranteed": { title: "Internet, price guaranteed", outcome: "$30.00 to ask back" },
  "internet-expired": { title: "Internet, promo ended", outcome: "No claim: the promo ended Oct 31" },
  "mobile-autopay": { title: "Phone, autopay credit", outcome: "$10.00 credit missing" },
};

await mkdir(OUT, { recursive: true });
for (const spec of demoBills) {
  const pdf = await renderBillPdf(spec);
  const { png } = await rasterize(pdf, 2200);
  await writeFile(path.join(OUT, `${spec.id}.pdf`), pdf);
  await writeFile(path.join(OUT, `${spec.id}.jpg`), await photoOf(png));
  await writeFile(path.join(OUT, `${spec.id}.png`), await sharp(png).resize({ width: 1200 }).png({ palette: true }).toBuffer());
}
await writeFile(
  path.join(OUT, "index.json"),
  JSON.stringify(
    demoBills.map((spec) => ({ id: spec.id, ...COPY[spec.id], bill: `/samples/${spec.id}.pdf`, image: `/samples/${spec.id}.png`, proof: spec.proof })),
    null,
    2,
  ),
);
console.log(`wrote ${demoBills.length} samples to ${OUT}`);
