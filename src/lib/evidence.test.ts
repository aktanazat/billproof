import { expect, test } from "vitest";
import { moneyIn, quoteExactIn } from "./evidence";

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

// "$55.5" read as $55.00 would let a quote of it confirm a $55.00 line and miss a $55.50 one.
test("a dollar amount with one decimal or no leading zero is read at its value", () => {
  expect(moneyIn("Fiber 500 for $55.5 a month")).toEqual([5550]);
  expect(moneyIn("Paper bill fee $.99")).toEqual([99]);
  expect(moneyIn("$55.50, then $1,299.99, then 75.00")).toEqual([5550, 129999, 7500]);
  expect(moneyIn("Fiber 500 through 10/31/2027")).toEqual([]);
});

// People write small amounts in cents ("an iPhone 16 for 99 cents", "75 cents a month"); a promise whose quote shows
// no amount the reader knows is set aside, so these promises were lost.
test("an amount written in cents is read as money, and a percentage is not", () => {
  expect(moneyIn("iPhone 16 with a two-year contract for 99 cents")).toEqual([99]);
  expect(moneyIn("Paperless billing saves 75¢ a month")).toEqual([75]);
  expect(moneyIn("just 1 cent more")).toEqual([1]);
  expect(moneyIn("50 percent off for 12 months")).toEqual([]);
});

// 27 of the 1,517 posts write amounts as "70 dollars" and 6 as "bucks", including what a rep promised ("the phone rep
// said itd be 70 dollars"); a promise whose quote shows no amount the reader knows is set aside.
test("an amount written as dollars or bucks is read as money", () => {
  expect(moneyIn("the phone rep said itd be 70 dollars")).toEqual([7000]);
  expect(moneyIn("they promised 49.99 dollars a month")).toEqual([4999]);
  expect(moneyIn("only 1 dollar more for the second line")).toEqual([100]);
  expect(moneyIn("he said 40 bucks a month, locked in")).toEqual([4000]);
  expect(moneyIn("Fiber 500 for 24 months")).toEqual([]);
});
