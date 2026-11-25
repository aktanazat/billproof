// Money amounts written with a dollar sign ("$55", "-$5.00", "$1,299.99") or with cents ("75.00").
// Bare integers ("Fiber 500") are not money.
const MONEY = /(-)?\$\s?(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d{2}))?|(-)?\b(\d{1,3}(?:,\d{3})+|\d+)\.(\d{2})\b/g;

export function moneyIn(text: string): number[] {
  const found: number[] = [];
  for (const m of text.matchAll(MONEY)) {
    const whole = (m[2] ?? m[5]).replaceAll(",", "");
    const frac = m[3] ?? m[6] ?? "00";
    found.push(Number(whole) * 100 + Number(frac));
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
    .replace(/[\u2010-\u2015\u2212]/g, "-")
    .replace(/[\u2018\u2019\u201c\u201d]/g, "'")
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
