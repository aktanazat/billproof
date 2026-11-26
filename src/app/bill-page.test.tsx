import { expect, test } from "vitest";
import { snapBox } from "./bill-page";

const box = (y: number) => ({ x0: 80, y0: y, x1: 920, y1: y + 18 });

// A PDF prints "Wi‑Fi" with a non-breaking hyphen, or carries invisible characters in a word; the charge's name, typed
// plainly, wasn't found in its row, and the mark stayed on the model's box a row off.
test("a charge is marked on its printed row even when the row writes its name with look-alike characters", () => {
  const rows = [
    { text: "Fiber 500 Internet $70.00", box: box(400) },
    { text: "Wi\u2011Fi Gateway Rental $15.00", box: box(440) },
    { text: "Network Enhance\u00adment Fee $3.99", box: box(480) },
  ];
  expect(snapBox(box(400), "Wi-Fi Gateway Rental", rows)).toEqual(box(440));
  expect(snapBox(box(440), "Network Enhancement Fee", rows)).toEqual(box(480));
});

// A short name is a whole word of its row, not part of another word: "TV" is not in "ATV Rental".
test("a short charge name is matched as whole words", () => {
  const rows = [{ text: "ATV Rental $40.00", box: box(400) }, { text: "TV Box $10.00", box: box(500) }];
  expect(snapBox(box(400), "TV Box", rows)).toEqual(box(500));
  expect(snapBox(null, "TV", rows)).toEqual(box(500));
});
