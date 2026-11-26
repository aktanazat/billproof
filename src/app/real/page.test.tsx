import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, test } from "vitest";
import { realRun } from "@/data/real-bills";
import RealBills from "./page";

// The real-bills page as built from the saved run, reduced to its text.
const text = renderToStaticMarkup(createElement(RealBills))
  .replace(/<[^>]+>/g, "\n")
  .replace(/&amp;/g, "&")
  .replace(/&#x27;/g, "'")
  .split("\n")
  .map((part) => part.trim())
  .filter(Boolean);

test("counts of a thousand or more are written with a comma", () => {
  const unformatted = text.filter((part) => /(^|\s)\d{4,} (posts|bills)\b/.test(part));
  expect(unformatted).toEqual([]);
});

test("no question on a bill names the same line twice in a row", () => {
  const asked = text.filter((part) => part.startsWith("Worth asking about:") || /^[^:]+$/.test(part)).join("\n");
  const repeats = [...asked.matchAll(/(?:^|, )([^,\n]{4,}), \1(?=,|$|\n)/gm)].map((m) => m[1]);
  expect(repeats).toEqual([]);
});

test("one of something is never written with a plural", () => {
  expect(text.filter((part) => /\b1 (bills|charges|posts|times|lines)\b/.test(part))).toEqual([]);
});

test("a missing credit is described as missing, never as a charge above a promise", () => {
  const credits = realRun.results.flatMap((bill) => (bill.outcome === "checked" ? bill.claims.filter((claim) => claim.kind === "credit_missing") : []));
  expect(credits.length).toBeGreaterThan(0);
  for (const claim of credits) expect(text.join(" ")).toContain(`credit missing: credited $${(claim.actualCents / 100).toFixed(2)} on ${claim.lines.join(", ")}`);
  expect(text.filter((part) => /above the promise: billed \$0\.00|1 post had a charge above a promise/.test(part))).toEqual([]);
});

test("every post read is accounted for: real bills, not bills, and bills that couldn't be read", () => {
  const count = (outcome: string) => realRun.results.filter((bill) => bill.outcome === outcome).length;
  const read = count("checked") + count("not_a_bill") + count("could_not_check");
  const page = text.join(" ");
  expect(page).toContain(`Posts read ${read.toLocaleString("en-US")}`);
  expect(page).toContain(`Real bills among them ${count("checked")}`);
  expect(page).toContain(`${count("not_a_bill").toLocaleString("en-US")} posts showed chats, app screens or ads rather than a bill, ${count("could_not_check")} showed a bill whose charges couldn't be read reliably, so they weren't checked, and`);
});