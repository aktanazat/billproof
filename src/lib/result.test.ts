import { describe, expect, test } from "vitest";
import { checkInputSchema } from "./result";

function wav(seconds: number, sampleRate = 16_000, channels = 1): string {
  const dataBytes = Math.round(seconds * sampleRate) * channels * 2;
  const bytes = new Uint8Array(44 + dataBytes);
  const view = new DataView(bytes.buffer);
  const ascii = (offset: number, text: string) => [...text].forEach((ch, i) => view.setUint8(offset + i, ch.charCodeAt(0)));
  ascii(0, "RIFF");
  view.setUint32(4, 36 + dataBytes, true);
  ascii(8, "WAVEfmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, channels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * channels * 2, true);
  view.setUint16(32, channels * 2, true);
  view.setUint16(34, 16, true);
  ascii(36, "data");
  view.setUint32(40, dataBytes, true);
  return Buffer.from(bytes).toString("base64");
}

const withCall = (audio: string) => ({ bills: [{ pages: [{ image: "data:image/jpeg;base64,AAAA", text: null }] }], offer: { kind: "audio", wav: audio } });

describe("a recorded call at the upload boundary", () => {
  test("accepts a 16 kHz mono recording within four minutes", () => {
    expect(checkInputSchema.safeParse(withCall(wav(12))).success).toBe(true);
  });

  test("rejects a recording longer than four minutes, whatever the client says", () => {
    expect(checkInputSchema.safeParse(withCall(wav(241))).success).toBe(false);
  });

  test("rejects audio at another sample rate, which would hide its true length", () => {
    expect(checkInputSchema.safeParse(withCall(wav(12, 8_000))).success).toBe(false);
  });

  test("rejects a header that claims less audio than the upload carries", () => {
    const real = Uint8Array.from(Buffer.from(wav(12), "base64"));
    new DataView(real.buffer).setUint32(40, 32_000, true);
    expect(checkInputSchema.safeParse(withCall(Buffer.from(real).toString("base64"))).success).toBe(false);
  });
});
