import { expect, test } from "vitest";
import { quoteExactIn } from "./evidence";

const notice = "Important information\nThe $15.00 gateway fee was not credited on this statement. Questions? Call 1-866-555-0144.";

test("a rebuttal quote that drops a word from the bill is not the bill's words", () => {
  expect(quoteExactIn("The $15.00 gateway fee was credited on this statement", notice)).toBe(false);
});

test("a rebuttal quote copied from the bill matches across case, quotes and line breaks", () => {
  expect(quoteExactIn("the $15.00 Gateway fee was not credited on this statement.", notice)).toBe(true);
});
