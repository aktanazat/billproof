import { pageRows, pageText, type TextRow } from "./pdf-text";
import { CALL_SAMPLE_RATE, PAGE_LONG_SIDE, type PreparedPage } from "./result";

// A page as the browser keeps it: what is sent to the check, plus the printed rows used to place marks exactly.
export type ShownPage = PreparedPage & { rows: TextRow[] | null };

const JPEG_QUALITY = 0.85;
const DEADLINE_MS = 20_000;

export class PrepareError extends Error {}

function canvasToJpeg(canvas: HTMLCanvasElement): string {
  return canvas.toDataURL("image/jpeg", JPEG_QUALITY);
}

// A file ready to read: its pages, and how many pages past the limit were left out.
export type Prepared = { pages: ShownPage[]; omitted: number };

// A long bill keeps its charges at the front, so a PDF past the limit is read from its first pages and the rest are
// counted as left out, rather than refused: few people can cut pages out of a PDF.
async function preparePdf(file: File, maxPages: number): Promise<Prepared> {
  // pdf.js's legacy build still needs Promise.withResolvers (Safari 17.4+); without it every PDF fails, so say what works.
  if (typeof Promise.withResolvers !== "function") throw new PrepareError("This browser can't read PDFs. Update Safari, or add photos or screenshots of the bill instead.");
  // pdf.js is browser-only and large; it loads when the first PDF is opened, never during server rendering. pdf.js
  // supports Safari only through its legacy build (Safari 18+, per its FAQ); the standard build targets the latest
  // Firefox and Chrome and calls features older Safari lacks.
  const { getDocument, GlobalWorkerOptions } = await import("pdfjs-dist/legacy/build/pdf.mjs");
  GlobalWorkerOptions.workerSrc = "/pdfjs/pdf.worker.min.mjs";
  const task = getDocument({ data: new Uint8Array(await file.arrayBuffer()), standardFontDataUrl: "/pdfjs/standard_fonts/" });
  try {
    const doc = await task.promise;
    const read = Math.min(doc.numPages, maxPages);
    const pages: ShownPage[] = [];
    for (let n = 1; n <= read; n++) {
      const page = await doc.getPage(n);
      const base = page.getViewport({ scale: 1 });
      const viewport = page.getViewport({ scale: PAGE_LONG_SIDE / Math.max(base.width, base.height) });
      const canvas = document.createElement("canvas");
      canvas.width = Math.ceil(viewport.width);
      canvas.height = Math.ceil(viewport.height);
      const context = canvas.getContext("2d");
      if (!context) throw new PrepareError("This browser could not draw the PDF.");
      context.fillStyle = "#ffffff";
      context.fillRect(0, 0, canvas.width, canvas.height);
      await page.render({ canvas, canvasContext: context, viewport }).promise;
      const content = await page.getTextContent();
      const text = pageText(content);
      pages.push({ image: canvasToJpeg(canvas), text: text.length > 0 ? text : null, rows: text.length > 0 ? pageRows(content, base) : null });
    }
    return { pages, omitted: doc.numPages - read };
  } catch (error) {
    if (error instanceof PrepareError) throw error;
    throw new PrepareError("This PDF could not be opened. If it has a password, save an unlocked copy.");
  } finally {
    await task.destroy();
  }
}

// An iPhone photo saved as HEIC is tried like any other: Safari decodes it, other browsers can't.
const isHeic = (file: File) => /\.(heic|heif)$/i.test(file.name) || /^image\/hei[cf]/.test(file.type);

// A photo or screenshot this opener takes: any image type, and HEIC by name, which some browsers leave untyped.
export const isPicture = (file: File) => isHeic(file) || file.type.startsWith("image/");

async function prepareImage(file: File): Promise<Prepared> {
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
  } catch {
    throw new PrepareError(isHeic(file) ? "HEIC photos can't be read in this browser. Export the photo as JPEG, or open Billproof in Safari." : "This image could not be opened. Use a JPEG, PNG or WebP.");
  }
  const scale = Math.min(1, PAGE_LONG_SIDE / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  const context = canvas.getContext("2d");
  if (!context) throw new PrepareError("This browser could not draw the image.");
  // JPEG has no transparency: a transparent picture would come out on black, as a PDF page would without its white.
  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  return { pages: [{ image: canvasToJpeg(canvas), text: null, rows: null }], omitted: 0 };
}

export async function prepareFile(file: File, maxPages: number): Promise<Prepared> {
  const isPdf = file.type === "application/pdf" || file.name.toLowerCase().endsWith(".pdf");
  if (!isPdf && !isPicture(file)) throw new PrepareError("Add a PDF or a photo of the bill.");

  const work = isPdf ? preparePdf(file, maxPages) : prepareImage(file);
  // A plain promise rather than Promise.withResolvers, which Safari lacks before 17.4.
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new PrepareError("This file took too long to open.")), DEADLINE_MS);
  });
  try {
    return await Promise.race([work, deadline]);
  } finally {
    clearTimeout(timer);
  }
}

// A call can arrive as a video too: Android saves calls as .3gp, labelled video, and a call can be screen recorded.
// The browser takes the sound from either, or the recording says it couldn't be opened.
export function isRecording(file: File): boolean {
  return /^(audio|video)\//.test(file.type) || /\.(m4a|mp3|wav|aac|caf|ogg|opus|oga|flac|amr|webm|3gp|3ga|mp4|mov)$/i.test(file.name);
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
  if (decoded.duration > maxSeconds) {
    // Whole minutes would round 4:20 down to "4 minutes long" beside a 4-minute limit; past an hour it reads 2:00:01.
    const seconds = Math.ceil(decoded.duration);
    const two = (n: number) => String(n).padStart(2, "0");
    const hours = Math.floor(seconds / 3600);
    const length = hours > 0 ? `${hours}:${two(Math.floor(seconds / 60) % 60)}:${two(seconds % 60)}` : `${Math.floor(seconds / 60)}:${two(seconds % 60)}`;
    throw new PrepareError(`This recording is ${length} long. Trim it to the part with the promise, up to ${maxSeconds / 60} minutes.`);
  }
  const offline = new OfflineAudioContext(1, Math.ceil(decoded.duration * CALL_SAMPLE_RATE), CALL_SAMPLE_RATE);
  const source = offline.createBufferSource();
  source.buffer = decoded;
  source.connect(offline.destination);
  source.start();
  const mono = await offline.startRendering();
  const samples = mono.getChannelData(0);
  return { wav: wavBase64(samples, CALL_SAMPLE_RATE), seconds: decoded.duration, url: URL.createObjectURL(file), peaks: peaksOf(samples) };
}
