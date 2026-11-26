import { afterEach, expect, test, vi } from "vitest";
import { PrepareError, prepareFile } from "./prepare";

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
