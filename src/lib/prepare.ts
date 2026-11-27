import { pageRows, pageText, type TextRow } from "./pdf-text";
import { CALL_SAMPLE_RATE, MAX_PAGE_TEXT, PAGE_LONG_SIDE } from "./limits";
import type { PreparedPage } from "./result";

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

const READER_UNAVAILABLE = "Billproof couldn't load its PDF reader. Check the connection, then remove the file and add it again.";

// A cloud file not on the device, or one moved or changed since it was chosen, can't be read at all; the advice for
// a file in the wrong format would send the person to convert a file that is fine. A decoder's failure doesn't say
// which it was, and a file too large to read whole is still on the device, so one byte decides.
const UNREADABLE = "This file couldn't be read. Save it to this device, then add it again.";
const readable = (file: File) => file.slice(0, 1).arrayBuffer().then(() => true, () => false);

// A long bill keeps its charges at the front, so a PDF past the limit is read from its first pages and the rest are
// counted as left out, rather than refused: few people can cut pages out of a PDF.
async function preparePdf(file: File, maxPages: number): Promise<Prepared> {
  // pdf.js's legacy build still needs Promise.withResolvers (Safari 17.4+); without it every PDF fails, so say what works.
  // The bill and the offer are opened here alike, so the advice names neither.
  if (typeof Promise.withResolvers !== "function") throw new PrepareError("This browser can't read PDFs. Update Safari, or add photos or screenshots of it instead.");
  // pdf.js is browser-only and large; it loads when the first PDF is opened, never during server rendering. pdf.js
  // supports Safari only through its legacy build (Safari 18+, per its FAQ); the standard build targets the latest
  // Firefox and Chrome and calls features older Safari lacks.
  // Fetched when the first PDF is added; on a dropped connection that fails, and the file itself is fine.
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs").catch(() => {
    throw new PrepareError(READER_UNAVAILABLE);
  });
  pdfjs.GlobalWorkerOptions.workerSrc = "/pdfjs/pdf.worker.min.mjs";
  const bytes = await file.arrayBuffer().catch(() => {
    throw new PrepareError(UNREADABLE);
  });
  const task = pdfjs.getDocument({ data: new Uint8Array(bytes), standardFontDataUrl: "/pdfjs/standard_fonts/" });
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
      // A page whose text is past what a check takes (small print, a doubled hidden layer) goes without it, and is read
      // from its picture; sent whole, the server refused the check as files it couldn't prepare.
      const sentText = text.length > 0 && [...text].length <= MAX_PAGE_TEXT ? text : null;
      pages.push({ image: canvasToJpeg(canvas), text: sentText, rows: text.length > 0 ? pageRows(content, base) : null });
    }
    return { pages, omitted: doc.numPages - read };
  } catch (error) {
    if (error instanceof PrepareError) throw error;
    // pdf.js names a password and a damaged file; a worker it couldn't download ends its setup with this message.
    const name = error instanceof Error ? error.name : "";
    if (name === "PasswordException") throw new PrepareError("This PDF has a password. Save an unlocked copy and add that instead.");
    if (error instanceof Error && error.message.startsWith("Setting up fake worker failed")) throw new PrepareError(READER_UNAVAILABLE);
    throw new PrepareError("This PDF could not be opened. Download it again, or add screenshots of it instead.");
  } finally {
    await task.destroy();
  }
}

// An iPhone photo saved as HEIC is tried like any other: Safari decodes it, other browsers can't.
const isHeic = (file: File) => /\.(heic|heif)$/i.test(file.name) || /^image\/hei[cf]/.test(file.type);

// A photo or screenshot this opener takes: any image type, and HEIC by name, which some browsers leave untyped.
export const isPicture = (file: File) => isHeic(file) || file.type.startsWith("image/");

export const isPdf = (file: File) => file.type === "application/pdf" || file.name.toLowerCase().endsWith(".pdf");

async function prepareImage(file: File): Promise<Prepared> {
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
  } catch {
    if (!(await readable(file))) throw new PrepareError(UNREADABLE);
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
  if (!isPdf(file) && !isPicture(file)) {
    // Recordings reach here only from the bill side: the offer side opens them as calls.
    throw new PrepareError(isRecording(file) ? "This is a call recording. Remove it here and add it under What you were promised." : "Add a PDF or a photo of the bill.");
  }

  const work = isPdf(file) ? preparePdf(file, maxPages) : prepareImage(file);
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
// 60 dB under full scale: below a whisper, where speech on a call peaks far above it.
const SILENCE = 0.001;

function peaksOf(samples: Float32Array): number[] {
  const size = Math.max(1, Math.floor(samples.length / PEAKS));
  const peaks: number[] = [];
  for (let i = 0; i < PEAKS; i++) {
    let max = 0;
    for (let j = i * size; j < Math.min(samples.length, (i + 1) * size); j++) max = Math.max(max, Math.abs(samples[j]));
    peaks.push(max);
  }
  return peaks;
}

function tooLong(duration: number, maxSeconds: number): PrepareError {
  // Whole minutes would round 4:20 down to "4 minutes long" beside a 4-minute limit; past an hour it reads 2:00:01.
  const seconds = Math.ceil(duration);
  const two = (n: number) => String(n).padStart(2, "0");
  const hours = Math.floor(seconds / 3600);
  const length = hours > 0 ? `${hours}:${two(Math.floor(seconds / 60) % 60)}:${two(seconds % 60)}` : `${Math.floor(seconds / 60)}:${two(seconds % 60)}`;
  return new PrepareError(`This recording is ${length} long. Trim it to the part with the promise, up to ${maxSeconds / 60} minutes.`);
}

// The length a recording's file declares, read without decoding it, or null when the browser can't say.
function declaredSeconds(file: File): Promise<number | null> {
  return new Promise((resolve) => {
    const audio = new Audio();
    const url = URL.createObjectURL(file);
    const done = (seconds: number | null) => {
      clearTimeout(timer);
      URL.revokeObjectURL(url);
      resolve(seconds);
    };
    const timer = setTimeout(() => done(null), DEADLINE_MS);
    audio.onloadedmetadata = () => done(Number.isFinite(audio.duration) ? audio.duration : null);
    audio.onerror = () => done(null);
    audio.preload = "metadata";
    audio.src = url;
  });
}

export async function prepareCall(file: File, maxSeconds: number): Promise<PreparedCall> {
  const context = new AudioContext();
  let decoded: AudioBuffer;
  try {
    decoded = await context.decodeAudioData(await file.arrayBuffer());
  } catch {
    if (!(await readable(file))) throw new PrepareError(UNREADABLE);
    // Safari won't decode an hour-long call at all; its file still says how long it is.
    const declared = await declaredSeconds(file);
    throw declared !== null && declared > maxSeconds ? tooLong(declared, maxSeconds) : new PrepareError("This recording could not be opened. Use M4A, MP3 or WAV.");
  } finally {
    void context.close();
  }
  if (decoded.duration > maxSeconds) throw tooLong(decoded.duration, maxSeconds);
  const offline = new OfflineAudioContext(1, Math.ceil(decoded.duration * CALL_SAMPLE_RATE), CALL_SAMPLE_RATE);
  const source = offline.createBufferSource();
  source.buffer = decoded;
  source.connect(offline.destination);
  source.start();
  const mono = await offline.startRendering();
  const samples = mono.getChannelData(0);
  const peaks = peaksOf(samples);
  const loudest = Math.max(...peaks);
  // An iPhone screen recording of a call keeps the picture but not the call's sound.
  if (loudest < SILENCE) throw new PrepareError("This recording has no sound. A screen recording doesn't capture a phone call's sound: add the call recording itself, or type what they promised.");
  return { wav: wavBase64(samples, CALL_SAMPLE_RATE), seconds: decoded.duration, url: URL.createObjectURL(file), peaks: peaks.map((p) => Math.round((p / loudest) * 100) / 100) };
}
