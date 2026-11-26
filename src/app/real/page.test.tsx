import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, test } from "vitest";
import { realRun } from "@/data/real-bills";
import { formatMicros } from "@/lib/cost";
import { unagreedFees } from "@/lib/real-bills";
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

test("the company table adds up to every real bill, every bill with fees and the page's fee total", () => {
  const html = renderToStaticMarkup(createElement(RealBills));
  const table = html.slice(html.indexOf(">By company<"), html.indexOf(">Every bill<"));
  const rows = [...table.matchAll(/<tr[^>]*>((?:<td[^>]*>.*?<\/td>){4})<\/tr>/g)].map((row) => [...row[1].matchAll(/<td[^>]*>(.*?)<\/td>/g)].map((cell) => cell[1].replace(/<!-- -->/g, "")));
  const cents = (cell: string) => (cell === "—" ? 0 : Math.round(Number(cell.replace(/[$,]/g, "")) * 100));
  const bills = realRun.results.filter((bill) => bill.outcome === "checked");
  const fees = bills.map((bill) => unagreedFees(bill).reduce((t, fee) => t + fee.cents, 0));
  expect(rows.length).toBeGreaterThan(1);
  expect(rows.reduce((t, row) => t + Number(row[1]), 0)).toBe(bills.length);
  expect(rows.reduce((t, row) => t + Number(row[2]), 0)).toBe(fees.filter((c) => c > 0).length);
  expect(rows.reduce((t, row) => t + cents(row[3]), 0)).toBe(fees.reduce((t, c) => t + c, 0));
});

test("the most common fees count bills, so a fee printed once per phone line counts its bill once", () => {
  const list = text.slice(text.indexOf("Fees that showed up most") + 2, text.indexOf("By company"));
  const key = (label: string) =>
    label.toLowerCase().replace(/\bcalifornia\b/, "ca").replace(/[^a-z ]/g, "").replace(/\s+/g, " ").trim().replace(/ (fee|charge|surcharge)$/, "");
  const billsWith = (label: string) => realRun.results.filter((bill) => bill.outcome === "checked" && unagreedFees(bill).some((fee) => fee.lines.some((line) => key(line) === key(label)))).length;
  const rows = list.flatMap((part, i) => (/^\d+ bills?$/.test(part) ? [{ label: list[i - 1], count: Number.parseInt(part, 10) }] : []));
  expect(rows.length).toBeGreaterThan(0);
  for (const row of rows) expect(row, row.label).toEqual({ label: row.label, count: billsWith(row.label) });
});

// Bills print the same fee different ways ("California Cost Recovery Charge" beside "CA Cost Recovery Charge",
// "Broadcast TV Surcharge" beside "Broadcast TV Fee"); each is one fee on the list, counted on every bill that has it.
test("a fee printed two ways is one fee on the most-common list", () => {
  const list = text.slice(text.indexOf("Fees that showed up most") + 2, text.indexOf("By company"));
  const count = (label: string) => list[list.indexOf(label) + 1];
  expect(count("CA Cost Recovery Charge")).toBe("7 bills");
  expect(count("Broadcast TV Fee")).toBe("6 bills");
  expect(count("Regulatory Cost Recovery")).toBe("5 bills");
  expect(list).not.toContain("California Cost Recovery Charge");
});

// The run's total kept adding the partial re-runs made while the checks improved ($1.56 against $0.93 across the
// posts' own costs), so "the whole run cost $1.56" and a cost per post divided from it overstated what checking costs.
test("the cost per post is what the posts' checks cost, and the census total is said to include its re-reads", () => {
  const read = realRun.results.filter((bill) => !(bill.outcome === "error" && bill.error === "images unavailable"));
  const perPost = read.reduce((t, bill) => t + bill.spentMicros, 0) / read.length;
  expect(text[text.indexOf("Cost per post") + 1]).toBe(formatMicros(perPost));
  const intro = text.find((part) => part.includes("public Reddit posts about"))!;
  expect(intro).toContain(formatMicros(realRun.spentMicros));
  expect(intro).toMatch(/re-read/);
  expect(intro).not.toContain("The whole run");
});