import { expect, test } from "vitest";
import { formatMicros } from "./cost";

test("a cost reads as cents under a cent and as dollars from a cent up, and nothing reads as nothing", () => {
  expect(formatMicros(0)).toBe("0¢");
  expect(formatMicros(5)).toBe("under 0.001¢");
  expect(formatMicros(40)).toBe("0.004¢");
  expect(formatMicros(670)).toBe("0.067¢");
  // A third decimal that is only a trailing zero reads as two, like 0.15¢: "0.090¢" looked like a different figure.
  expect(formatMicros(900)).toBe("0.09¢");
  expect(formatMicros(1_500)).toBe("0.15¢");
  expect(formatMicros(30_000)).toBe("$0.03");
  expect(formatMicros(727_404)).toBe("$0.73");
});
