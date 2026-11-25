import { pageText } from "./pdf-text";
import type { PreparedPage } from "./result";

const LONG_SIDE = 1600;
const JPEG_QUALITY = 0.85;
const DEADLINE_MS = 20_000;
export const MAX_BILL_PAGES = 6;
export const MAX_OFFER_PAGES = 4;

export class PrepareError extends Error {}

function canvasToJpeg(canvas: HTMLCanvasElement): string {
  return canvas.toDataURL("image/jpeg", JPEG_QUALITY);
}

async function preparePdf(file: File, maxPages: number): Promise<PreparedPage[]> {
  // pdf.js is browser-only and large; it loads when the first PDF is opened, never during server rendering.
  const { getDocument, GlobalWorkerOptions } = await import("pdfjs-dist");
  GlobalWorkerOptions.workerSrc = "/pdfjs/pdf.worker.min.mjs";
  const task = getDocument({ data: new Uint8Array(await file.arrayBuffer()), standardFontDataUrl: "/pdfjs/standard_fonts/" });
  try {
    const doc = await task.promise;
    if (doc.numPages > maxPages) throw new PrepareError(`This PDF has ${doc.numPages} pages. Use the pages with the charges, up to ${maxPages}.`);
    const pages: PreparedPage[] = [];
    for (let n = 1; n <= doc.numPages; n++) {
      const page = await doc.getPage(n);
      const base = page.getViewport({ scale: 1 });
      const viewport = page.getViewport({ scale: LONG_SIDE / Math.max(base.width, base.height) });
      const canvas = document.createElement("canvas");
      canvas.width = Math.ceil(viewport.width);
      canvas.height = Math.ceil(viewport.height);
      const context = canvas.getContext("2d");
      if (!context) throw new PrepareError("This browser could not draw the PDF.");
      context.fillStyle = "#ffffff";
      context.fillRect(0, 0, canvas.width, canvas.height);
      await page.render({ canvas, canvasContext: context, viewport }).promise;
      const text = pageText(await page.getTextContent());
      pages.push({ image: canvasToJpeg(canvas), text: text.length > 0 ? text : null });
    }
    return pages;
  } catch (error) {
    if (error instanceof PrepareError) throw error;
    throw new PrepareError("This PDF could not be opened. If it has a password, save an unlocked copy.");
  } finally {
    await task.destroy();
  }
}

async function prepareImage(file: File): Promise<PreparedPage[]> {
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
  } catch {
    throw new PrepareError("This image could not be opened. Use a JPEG, PNG or WebP.");
  }
  const scale = Math.min(1, LONG_SIDE / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  const context = canvas.getContext("2d");
  if (!context) throw new PrepareError("This browser could not draw the image.");
  context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  return [{ image: canvasToJpeg(canvas), text: null }];
}

export async function prepareFile(file: File, maxPages: number): Promise<PreparedPage[]> {
  const isPdf = file.type === "application/pdf" || file.name.toLowerCase().endsWith(".pdf");
  if (!isPdf && /\.(heic|heif)$/i.test(file.name)) throw new PrepareError("HEIC photos can't be read here. Export the photo as JPEG and try again.");
  if (!isPdf && !file.type.startsWith("image/")) throw new PrepareError("Add a PDF or a photo of the bill.");

  const work = isPdf ? preparePdf(file, maxPages) : prepareImage(file);
  const { promise: deadline, reject } = Promise.withResolvers<never>();
  const timer = setTimeout(() => reject(new PrepareError("This file took too long to open.")), DEADLINE_MS);
  try {
    return await Promise.race([work, deadline]);
  } finally {
    clearTimeout(timer);
  }
}
