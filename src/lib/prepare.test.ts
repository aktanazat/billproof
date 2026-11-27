import { afterEach, expect, test, vi } from "vitest";
import { isRecording, prepareCall, PrepareError, prepareFile } from "./prepare";

// pdf.js stands in here: each test says how opening the PDF fails, as the real reader reports it.
const pdfjs = vi.hoisted(() => ({ open: (): Promise<unknown> => Promise.reject(new Error("not set")) }));
vi.mock("pdfjs-dist/legacy/build/pdf.mjs", () => ({
  GlobalWorkerOptions: {},
  getDocument: () => ({ promise: pdfjs.open(), destroy: async () => {} }),
}));
const failing = (name: string, message: string) => () => {
  const error = new Error(message);
  error.name = name;
  return Promise.reject(error);
};

const withResolvers = Promise.withResolvers;
afterEach(() => {
  Promise.withResolvers = withResolvers;
  vi.unstubAllGlobals();
});

test("opening a file works in Safari 16.4 to 17.3, which lack Promise.withResolvers", async () => {
  // Those Safari versions (iOS 16 iPhones, and iOS 17 before 17.4) are inside Next's supported browsers.
  Promise.withResolvers = undefined as unknown as typeof Promise.withResolvers;
  // The test runner can't decode an image, so the file ends in the app's own error rather than a crash.
  await expect(prepareFile(new File(["not an image"], "bill.png", { type: "image/png" }), 1)).rejects.toThrow(PrepareError);
});

test("a PDF on a browser too old for pdf.js says to update or use photos, never to unlock the file", async () => {
  Promise.withResolvers = undefined as unknown as typeof Promise.withResolvers;
  const pdf = new File(["%PDF-1.7"], "bill.pdf", { type: "application/pdf" });
  await expect(prepareFile(pdf, 6)).rejects.toThrow(new PrepareError("This browser can't read PDFs. Update Safari, or add photos or screenshots of the bill instead."));
});

test("an iPhone HEIC photo is read where the browser can decode it, and refused with a reason where it can't", async () => {
  const heic = new File(["heic bytes"], "IMG_0412.HEIC", { type: "image/heic" });
  // No decoder, as in Chrome or Firefox: the person is told to export a JPEG.
  await expect(prepareFile(heic, 1)).rejects.toThrow(new PrepareError("HEIC photos can't be read in this browser. Export the photo as JPEG, or open Billproof in Safari."));
  // Safari decodes HEIC itself: the photo becomes a page like any other.
  const canvas = { width: 0, height: 0, getContext: () => ({ fillRect: () => {}, drawImage: () => {} }), toDataURL: () => "data:image/jpeg;base64,AAAA" };
  vi.stubGlobal("createImageBitmap", async () => ({ width: 3024, height: 4032, close: () => {} }));
  vi.stubGlobal("document", { createElement: () => canvas });
  await expect(prepareFile(heic, 1)).resolves.toMatchObject({ pages: [{ image: "data:image/jpeg;base64,AAAA" }], omitted: 0 });
});

// JPEG has no transparency: a transparent picture (a PNG exported from an app) drawn onto a blank canvas comes out with
// a black background, and black text on it unreadable. Safari does this; the canvas here behaves the same.
test("a transparent picture is read on white, as a PDF page is", async () => {
  const { createCanvas, loadImage } = await import("@napi-rs/canvas");
  const source = createCanvas(200, 60);
  const draw = source.getContext("2d");
  draw.fillStyle = "#000";
  draw.fillRect(20, 20, 40, 20);
  const png = new File([new Uint8Array(source.toBuffer("image/png"))], "bill.png", { type: "image/png" });
  vi.stubGlobal("createImageBitmap", async (file: File) => Object.assign(await loadImage(Buffer.from(await file.arrayBuffer())), { close: () => {} }));
  vi.stubGlobal("document", { createElement: () => createCanvas(1, 1) });
  const { pages } = await prepareFile(png, 1);
  const jpeg = await loadImage(Buffer.from(pages[0].image.split(",")[1], "base64"));
  const read = createCanvas(jpeg.width, jpeg.height).getContext("2d");
  read.drawImage(jpeg, 0, 0);
  expect([...read.getImageData(5, 5, 1, 1).data.slice(0, 3)].every((channel) => channel > 240)).toBe(true);
  expect([...read.getImageData(40, 30, 1, 1).data.slice(0, 3)].every((channel) => channel < 15)).toBe(true);
});

// Android phones and call-recorder apps save calls as .3gp, which the system labels video, and a call can be a screen
// recording; browsers take the sound from both. Sent down the document path they were refused as "Add a PDF or a
// photo of the bill."
test("a call saved by an Android phone or as a video is opened as a recording; a PDF or photo is not", () => {
  expect(isRecording(new File([], "Call with Xfinity.3gp", { type: "video/3gpp" }))).toBe(true);
  expect(isRecording(new File([], "ScreenRecording_0412.mp4", { type: "video/mp4" }))).toBe(true);
  expect(isRecording(new File([], "call_20261104.3gp", { type: "" }))).toBe(true);
  expect(isRecording(new File([], "offer.pdf", { type: "application/pdf" }))).toBe(false);
  expect(isRecording(new File([], "IMG_0412.HEIC", { type: "image/heic" }))).toBe(false);
});

// A whole sales or support call often runs past an hour; "120:01 long" reads as neither minutes nor a clock.
test("a recording over the limit is told its length as a clock reads it, hours included", async () => {
  const lasting = (duration: number) => {
    vi.stubGlobal("AudioContext", class { decodeAudioData = async () => ({ duration }); close = async () => {}; });
    return prepareCall(new File(["call"], "call.m4a", { type: "audio/mp4" }), 240);
  };
  await expect(lasting(7200.4)).rejects.toThrow(new PrepareError("This recording is 2:00:01 long. Trim it to the part with the promise, up to 4 minutes."));
  await expect(lasting(259.2)).rejects.toThrow(new PrepareError("This recording is 4:20 long. Trim it to the part with the promise, up to 4 minutes."));
});

// Safari won't decode an hour-long recording at all (measured: a 60-minute WAV failed to decode while a 30-minute one
// took 375 ms), and the person was told to use M4A, MP3 or WAV, for a WAV. The length the file declares says why.
test("a recording too long for the browser to decode is told its length, not that it can't be opened", async () => {
  const refusing = (declared: number | null) => {
    vi.stubGlobal("AudioContext", class { decodeAudioData = async () => { throw new DOMException("Unable to decode.", "EncodingError"); }; close = async () => {}; });
    vi.stubGlobal("URL", { createObjectURL: () => "blob:call", revokeObjectURL: () => {} });
    vi.stubGlobal("Audio", class {
      duration = Number.NaN;
      onloadedmetadata: (() => void) | null = null;
      onerror: (() => void) | null = null;
      preload = "";
      set src(_: string) {
        queueMicrotask(() => (declared === null ? this.onerror?.() : ((this.duration = declared), this.onloadedmetadata?.())));
      }
    });
    return prepareCall(new File(["call"], "call.wav", { type: "audio/wav" }), 240);
  };
  await expect(refusing(3600)).rejects.toThrow(new PrepareError("This recording is 1:00:00 long. Trim it to the part with the promise, up to 4 minutes."));
  await expect(refusing(null)).rejects.toThrow(new PrepareError("This recording could not be opened. Use M4A, MP3 or WAV."));
});

// An iPhone screen recording of a phone call keeps the picture but not the call's sound. Sent on, the silent recording
// would be paid for and could come back with words nobody said; the person is told before the check.
test("a silent recording is refused with what to use instead; a quiet one is read", async () => {
  const recording = (level: number) => {
    const samples = Float32Array.from({ length: 16_000 * 10 }, (_, i) => level * Math.sin((2 * Math.PI * 220 * i) / 16_000));
    vi.stubGlobal("AudioContext", class { decodeAudioData = async () => ({ duration: 10 }); close = async () => {}; });
    vi.stubGlobal("OfflineAudioContext", class {
      destination = {};
      createBufferSource = () => ({ buffer: null, connect: () => {}, start: () => {} });
      startRendering = async () => ({ getChannelData: () => samples });
    });
    vi.stubGlobal("URL", { createObjectURL: () => "blob:call", revokeObjectURL: () => {} });
    return prepareCall(new File(["call"], "call.mov", { type: "video/quicktime" }), 240);
  };
  await expect(recording(0)).rejects.toThrow(new PrepareError("This recording has no sound. A screen recording doesn't capture a phone call's sound: add the call recording itself, or type what they promised."));
  const quiet = await recording(0.02);
  expect(quiet.seconds).toBe(10);
  expect(Math.max(...quiet.peaks)).toBe(1);
});

// pdf.js loads its reader the first time a PDF is added. When that download fails (a phone off its Wi-Fi), the file
// is fine, and the visitor is told so, not to look for a password the PDF doesn't have.
test("a PDF that can't be opened is told why: the reader didn't load, it has a password, or it's damaged", async () => {
  const pdf = () => new File(["%PDF-1.7"], "bill.pdf", { type: "application/pdf" });
  pdfjs.open = failing("Error", "Setting up fake worker failed: \"Failed to fetch dynamically imported module\".");
  await expect(prepareFile(pdf(), 6)).rejects.toThrow(new PrepareError("Billproof couldn't load its PDF reader. Check the connection, then remove the file and add it again."));
  pdfjs.open = failing("PasswordException", "No password given");
  await expect(prepareFile(pdf(), 6)).rejects.toThrow(new PrepareError("This PDF has a password. Save an unlocked copy and add that instead."));
  pdfjs.open = failing("InvalidPDFException", "Invalid PDF structure.");
  await expect(prepareFile(pdf(), 6)).rejects.toThrow(new PrepareError("This PDF could not be opened. Download it again, or add screenshots of the bill instead."));
});
