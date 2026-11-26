import { expect, test } from "vitest";
import { formatMicros } from "./cost";

test("a cost reads as cents under a dollar and as dollars from a dollar up, and nothing reads as nothing", () => {
  expect(formatMicros(0)).toBe("0¢");
  expect(formatMicros(5)).toBe("under 0.001¢");
  expect(formatMicros(40)).toBe("0.004¢");
  expect(formatMicros(670)).toBe("0.067¢");
  // A trailing zero isn't shown: "0.090¢" looked like a different figure from 0.09¢.
  expect(formatMicros(900)).toBe("0.09¢");
  expect(formatMicros(1_500)).toBe("0.15¢");
  expect(formatMicros(3_000)).toBe("0.3¢");
  // From a cent to a dollar, where most checks cost, dollars rounded to the cent hid the figure: a step costing 1.13¢
  // beside one costing 0.97¢ read "$0.01".
  expect(formatMicros(11_290)).toBe("1.13¢");
  expect(formatMicros(20_988)).toBe("2.1¢");
  expect(formatMicros(30_000)).toBe("3¢");
  expect(formatMicros(727_404)).toBe("72.74¢");
  expect(formatMicros(1_000_000)).toBe("$1.00");
  expect(formatMicros(16_000_000)).toBe("$16.00");
});
