import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import sharp from "sharp";
import { photoOf, rasterize } from "./samples/raster";
import { renderBillPdf } from "./samples/render";
import { callFirstYear, callTwoYears, demoBills, internetGuaranteed, yearBills, type CallTurn } from "./samples/specs";

const OUT = path.join(process.cwd(), "public", "samples");
const VOICES = { company: "Flo (English (US))", customer: "Reed (English (US))" } as const;

// What each sample shows, as checked live on muse-ember-1.0.
type SampleOffer = { kind: "text"; text: string } | { kind: "call"; url: string };
type Sample = { id: string; title: string; outcome: string; image: string; bills: string[]; offer: SampleOffer };

async function pageImage(pdf: Buffer, file: string) {
  const { png } = await rasterize(pdf, 2200);
  await writeFile(file, await sharp(png).resize({ width: 1200 }).png({ palette: true }).toBuffer());
  return png;
}

// Speaks each turn with its voice and joins them with a short pause into one AAC file.
async function speak(turns: CallTurn[], out: string) {
  const work = await mkdtemp(path.join(tmpdir(), "billproof-call-"));
  try {
    const parts = turns.map((turn, i) => {
      const file = path.join(work, `${i}.aiff`);
      execFileSync("say", ["-v", VOICES[turn.speaker], "-o", file, turn.text]);
      return file;
    });
    const inputs = parts.flatMap((file) => ["-i", file]);
    const filter = parts.map((_, i) => `[${i}:a]aresample=24000,apad=pad_dur=0.45[a${i}]`).join(";") + ";" + parts.map((_, i) => `[a${i}]`).join("") + `concat=n=${parts.length}:v=0:a=1[out]`;
    execFileSync("ffmpeg", ["-v", "error", "-y", ...inputs, "-filter_complex", filter, "-map", "[out]", "-c:a", "aac", "-b:a", "64k", out]);
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

await mkdir(path.join(OUT, "year"), { recursive: true });
const samples: Sample[] = [];

const titles: Record<string, { title: string; outcome: string }> = {
  "internet-guaranteed": { title: "Internet, price guaranteed", outcome: "$30.00 to ask back" },
  "internet-expired": { title: "Internet, promo ended", outcome: "No claim: the promo ended Oct 31" },
  "mobile-autopay": { title: "Phone, autopay credit", outcome: "$10.00 credit missing" },
};
for (const spec of demoBills) {
  const pdf = await renderBillPdf(spec);
  await writeFile(path.join(OUT, `${spec.id}.pdf`), pdf);
  const png = await pageImage(pdf, path.join(OUT, `${spec.id}.png`));
  await writeFile(path.join(OUT, `${spec.id}.jpg`), await photoOf(png));
  samples.push({ id: spec.id, ...titles[spec.id], image: `/samples/${spec.id}.png`, bills: [`/samples/${spec.id}.pdf`], offer: { kind: "text", text: spec.proof } });
}

await speak(callTwoYears, path.join(OUT, "call-two-years.m4a"));
await speak(callFirstYear, path.join(OUT, "call-first-year.m4a"));
samples.push(
  { id: "call-two-years", title: "Promise made on a call", outcome: "The rep said two years; hear it", image: `/samples/${internetGuaranteed.id}.png`, bills: [`/samples/${internetGuaranteed.id}.pdf`], offer: { kind: "call", url: "/samples/call-two-years.m4a" } },
  { id: "call-first-year", title: "Same bill, different call", outcome: "The rep said one year; no claim", image: `/samples/${internetGuaranteed.id}.png`, bills: [`/samples/${internetGuaranteed.id}.pdf`], offer: { kind: "call", url: "/samples/call-first-year.m4a" } },
);

const yearPaths: string[] = [];
for (const spec of yearBills) {
  const pdf = await renderBillPdf(spec);
  const file = `/samples/year/${spec.id}.pdf`;
  await writeFile(path.join(OUT, "year", `${spec.id}.pdf`), pdf);
  await pageImage(pdf, path.join(OUT, "year", `${spec.id}.png`));
  yearPaths.push(file);
}
samples.push({ id: "year", title: "A year of internet bills", outcome: "12 bills read at once; it went wrong in August", image: "/samples/year/year-12.png", bills: yearPaths, offer: { kind: "text", text: internetGuaranteed.proof } });

await writeFile(path.join(OUT, "index.json"), JSON.stringify(samples, null, 2));
console.log(`wrote ${samples.length} samples to ${OUT}`);
