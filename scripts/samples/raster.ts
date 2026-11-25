import path from "node:path";
import { createCanvas } from "@napi-rs/canvas";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import sharp from "sharp";
import { pageText } from "../../src/lib/pdf-text";

const standardFontDataUrl = path.join(process.cwd(), "node_modules", "pdfjs-dist", "standard_fonts") + path.sep;

// Page 1 drawn the way the browser prepares it (src/lib/prepare.ts): long side `longSide` px, white ground,
// plus the text layer joined by the same pageText.
export async function rasterize(pdf: Buffer, longSide: number): Promise<{ png: Buffer; text: string }> {
  const task = getDocument({ data: new Uint8Array(pdf), standardFontDataUrl });
  try {
    const doc = await task.promise;
    const page = await doc.getPage(1);
    const base = page.getViewport({ scale: 1 });
    const viewport = page.getViewport({ scale: longSide / Math.max(base.width, base.height) });
    const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
    const context = canvas.getContext("2d");
    context.fillStyle = "#ffffff";
    context.fillRect(0, 0, canvas.width, canvas.height);
    // @napi-rs/canvas implements the 2D context pdf.js draws with; the DOM types differ only nominally.
    const domCanvas = canvas as unknown as HTMLCanvasElement;
    const domContext = context as unknown as CanvasRenderingContext2D;
    await page.render({ canvas: domCanvas, canvasContext: domContext, viewport }).promise;
    return { png: canvas.toBuffer("image/png"), text: pageText(await page.getTextContent()) };
  } finally {
    await task.destroy();
  }
}

// A phone photo of a printed bill: slight rotation, warm uneven light, sensor noise, mild blur.
export async function photoOf(png: Buffer): Promise<Buffer> {
  const { data: lit, info } = await sharp(png)
    .rotate(-2.2, { background: "#d9d4c8" })
    .modulate({ brightness: 0.93, saturation: 0.9 })
    .tint("#fff4e0")
    .png()
    .toBuffer({ resolveWithObject: true });
  const { width, height } = info;
  const noise = Buffer.alloc(width * height);
  let seed = 7;
  for (let i = 0; i < noise.length; i++) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    noise[i] = 128 + ((seed >> 16) % 23) - 11;
  }
  const noiseLayer = await sharp(noise, { raw: { width, height, channels: 1 } }).png().toBuffer();
  // sharp runs resize before composite within one pipeline, so the noise is applied at full size first.
  const noisy = await sharp(lit).composite([{ input: noiseLayer, blend: "overlay" }]).png().toBuffer();
  return sharp(noisy).blur(0.6).resize({ width: 1400 }).jpeg({ quality: 72 }).toBuffer();
}

export async function jpegDataUrl(image: Buffer, longSide: number): Promise<string> {
  const jpeg = await sharp(image).resize({ width: longSide, height: longSide, fit: "inside", withoutEnlargement: true }).jpeg({ quality: 85 }).toBuffer();
  return `data:image/jpeg;base64,${jpeg.toString("base64")}`;
}
