// Money amounts written with a dollar sign ("$55", "-$5.00", "$1,299.99", "$55.5", "$.99"), with cents ("75.00"), or
// in cents ("99 cents", "75¢"). Bare integers ("Fiber 500") are not money.
// Groups: dollars and cents after "$", cents alone after "$.", dollars and cents written without "$", and a count of
// cents.
const MONEY = /\$\s?(?:(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d{1,2})(?!\d))?|\.(\d{2})(?!\d))|\b(\d{1,3}(?:,\d{3})+|\d+)\.(\d{2})\b|\b(\d+)\s?(?:¢|cents?\b)/g;

export function moneyIn(text: string): number[] {
  const found: number[] = [];
  for (const [, whole, cents, only, bare, bareCents, centCount] of text.matchAll(MONEY)) {
    if (centCount !== undefined) {
      found.push(Number(centCount));
      continue;
    }
    const dollars = Number((whole ?? bare ?? "0").replaceAll(",", ""));
    // One decimal is tenths of a dollar: "$55.5" is $55.50.
    const fraction = only ?? bareCents ?? (cents ?? "00").padEnd(2, "0");
    found.push(dollars * 100 + Number(fraction));
  }
  return found;
}

export function quoteHasAmount(quote: string, cents: number): boolean {
  return moneyIn(quote).includes(Math.abs(cents));
}

export function tokens(text: string): string[] {
  return text
    .toLowerCase()
    .normalize("NFKC")
    // Soft hyphens and zero-width characters don't show, so they don't split a word.
    .replace(/[\u00ad\u200b-\u200d\u2060\ufeff]/g, "")
    .replace(/[\u2010-\u2015\u2212]/g, "-")
    .replace(/[\u2018\u2019\u201c\u201d\u02bc\u2032]/g, "'")
    .split(/[^a-z0-9.$%'-]+/)
    .map((t) => t.replace(/^[.'-]+|[.'-]+$/g, ""))
    .filter(Boolean);
}

// True when some window of the source contains at least `minShare` of the quote's tokens.
// Windows tolerate reordering: a PDF text layer may emit a table row's cells out of visual order.
export function quoteFoundIn(quote: string, source: string, minShare = 0.9): boolean {
  const want = tokens(quote);
  if (want.length === 0) return false;
  const have = tokens(source);
  const needed = Math.ceil(want.length * minShare);
  const span = want.length * 2 + 4;
  const wantCounts = new Map<string, number>();
  for (const t of want) wantCounts.set(t, (wantCounts.get(t) ?? 0) + 1);

  for (let start = 0; start < have.length; start++) {
    if (!wantCounts.has(have[start])) continue;
    const remaining = new Map(wantCounts);
    let matched = 0;
    for (let i = start; i < Math.min(have.length, start + span); i++) {
      const left = remaining.get(have[i]);
      if (left) {
        remaining.set(have[i], left - 1);
        matched += 1;
        if (matched >= needed) return true;
      }
    }
  }
  return false;
}

// True when the source contains the quote's words in the same order with nothing left out.
export function quoteExactIn(quote: string, source: string): boolean {
  const want = tokens(quote).join(" ");
  return want.length > 0 && ` ${tokens(source).join(" ")} `.includes(` ${want} `);
}
