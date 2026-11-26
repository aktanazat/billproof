import { expect, test } from "vitest";
import { quoteExactIn } from "./evidence";

const notice = "Important information\nThe $15.00 gateway fee was not credited on this statement. Questions? Call 1-866-555-0144.";

test("a rebuttal quote that drops a word from the bill is not the bill's words", () => {
  expect(quoteExactIn("The $15.00 gateway fee was credited on this statement", notice)).toBe(false);
});

test("a rebuttal quote copied from the bill matches across case, quotes and line breaks", () => {
  expect(quoteExactIn("the $15.00 Gateway fee was not credited on this statement.", notice)).toBe(true);
});

// A PDF's text keeps the soft hyphens a word processor put in long words, and pasted marketing emails carry zero-width
// characters; neither shows, so a quote typed from what the page shows has a plain word where the text has a split one.
test("a quote matches a document whose words hold invisible characters or apostrophe look-alikes", () => {
  expect(quoteExactIn("price guarantee through 10/31/2027", "2-year price guar\u00adantee through 10/31/2027")).toBe(true);
  expect(quoteExactIn("price guarantee through 10/31/2027", "2-year price gua\u200brantee through 10/31/2027")).toBe(true);
  expect(quoteExactIn("it's included at no extra cost", "Wi-Fi Gateway: it\u02bcs included at no extra cost")).toBe(true);
  expect(quoteExactIn("it's included at no extra cost", "Wi-Fi Gateway: it\u2032s included at no extra cost")).toBe(true);
});
