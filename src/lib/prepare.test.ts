import { afterEach, expect, test, vi } from "vitest";
import { isRecording, PrepareError, prepareFile } from "./prepare";

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
  const canvas = { width: 0, height: 0, getContext: () => ({ drawImage: () => {} }), toDataURL: () => "data:image/jpeg;base64,AAAA" };
  vi.stubGlobal("createImageBitmap", async () => ({ width: 3024, height: 4032, close: () => {} }));
  vi.stubGlobal("document", { createElement: () => canvas });
  await expect(prepareFile(heic, 1)).resolves.toMatchObject({ pages: [{ image: "data:image/jpeg;base64,AAAA" }], omitted: 0 });
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
