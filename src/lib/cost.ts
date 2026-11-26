// muse-ember-1.0 Standard mode prices in micro-dollars per token (dev.meta.ai/docs/pricing-rate-limits).
// A request over 200K input tokens is billed entirely at the long-context rates.
const TIERS = {
  standard: { input: 0.1, cached: 0.004, output: 0.5 },
  long: { input: 0.3, cached: 0.012, output: 1.5 },
};
export const LONG_CONTEXT_THRESHOLD = 200_000;

export type Usage = {
  inputTokens: number;
  cachedTokens: number;
  outputTokens: number;
};

export function costMicros(usage: Usage): number {
  const rate = usage.inputTokens > LONG_CONTEXT_THRESHOLD ? TIERS.long : TIERS.standard;
  const uncached = usage.inputTokens - usage.cachedTokens;
  return Math.ceil(uncached * rate.input + usage.cachedTokens * rate.cached + usage.outputTokens * rate.output);
}

// Most a call can cost once its exact input size is known: no cache hits, every output token used.
export function ceilingMicros(inputTokens: number, maxOutputTokens: number): number {
  return costMicros({ inputTokens, cachedTokens: 0, outputTokens: maxOutputTokens });
}

export function formatMicros(micros: number): string {
  const cents = micros / 10_000;
  // A reused reading costs nothing; a cost too small for three decimals still isn't nothing.
  if (micros === 0) return "0¢";
  if (cents < 0.001) return "under 0.001¢";
  // Under a dollar, where checks cost, cents keep the figure: 1.13¢, not "$0.01". No trailing zeros: 0.09¢, 3¢.
  const shown = cents.toFixed(cents >= 0.1 ? 2 : 3);
  if (Number(shown) >= 100) return `$${(cents / 100).toFixed(2)}`;
  return `${shown.replace(/\.?0+$/, "")}¢`;
}
