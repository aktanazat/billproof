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

const CALL_SAMPLE_RATE = 16_000;

export function isAudio(file: File): boolean {
  return file.type.startsWith("audio/") || /\.(m4a|mp3|wav|aac|caf|ogg|webm)$/i.test(file.name);
}

function wavBase64(samples: Float32Array, sampleRate: number): string {
  const bytes = new Uint8Array(44 + samples.length * 2);
  const view = new DataView(bytes.buffer);
  const ascii = (offset: number, text: string) => [...text].forEach((ch, i) => view.setUint8(offset + i, ch.charCodeAt(0)));
  ascii(0, "RIFF");
  view.setUint32(4, 36 + samples.length * 2, true);
  ascii(8, "WAVEfmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  ascii(36, "data");
  view.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) view.setInt16(44 + i * 2, Math.max(-1, Math.min(1, samples[i])) * 0x7fff, true);
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

// A recorded call becomes 16 kHz mono WAV for Muse Ember; the original file stays playable for the person.
export type PreparedCall = { wav: string; seconds: number; url: string; peaks: number[] };

const PEAKS = 96;

function peaksOf(samples: Float32Array): number[] {
  const size = Math.max(1, Math.floor(samples.length / PEAKS));
  const peaks: number[] = [];
  for (let i = 0; i < PEAKS; i++) {
    let max = 0;
    for (let j = i * size; j < Math.min(samples.length, (i + 1) * size); j++) max = Math.max(max, Math.abs(samples[j]));
    peaks.push(max);
  }
  const top = Math.max(...peaks, 0.0001);
  return peaks.map((p) => Math.round((p / top) * 100) / 100);
}

export async function prepareCall(file: File, maxSeconds: number): Promise<PreparedCall> {
  const context = new AudioContext();
  let decoded: AudioBuffer;
  try {
    decoded = await context.decodeAudioData(await file.arrayBuffer());
  } catch {
    throw new PrepareError("This recording could not be opened. Use M4A, MP3 or WAV.");
  } finally {
    void context.close();
  }
  if (decoded.duration > maxSeconds) throw new PrepareError(`This recording is ${Math.round(decoded.duration / 60)} minutes long. Trim it to the part with the promise, up to ${maxSeconds / 60} minutes.`);
  const offline = new OfflineAudioContext(1, Math.ceil(decoded.duration * CALL_SAMPLE_RATE), CALL_SAMPLE_RATE);
  const source = offline.createBufferSource();
  source.buffer = decoded;
  source.connect(offline.destination);
  source.start();
  const mono = await offline.startRendering();
  const samples = mono.getChannelData(0);
  return { wav: wavBase64(samples, CALL_SAMPLE_RATE), seconds: decoded.duration, url: URL.createObjectURL(file), peaks: peaksOf(samples) };
}
