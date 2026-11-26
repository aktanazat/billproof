import { afterEach, expect, test } from "vitest";
import { PrepareError, prepareFile } from "./prepare";

const withResolvers = Promise.withResolvers;
afterEach(() => {
  Promise.withResolvers = withResolvers;
});

test("opening a file works in Safari 16.4 to 17.3, which lack Promise.withResolvers", async () => {
  // Those Safari versions (iOS 16 iPhones, and iOS 17 before 17.4) are inside Next's supported browsers.
  Promise.withResolvers = undefined as unknown as typeof Promise.withResolvers;
  // The test runner can't decode an image, so the file ends in the app's own error rather than a crash.
  await expect(prepareFile(new File(["not an image"], "bill.png", { type: "image/png" }), 1)).rejects.toThrow(PrepareError);
});
