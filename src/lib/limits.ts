// What a check may take, and the demo's paused notice: plain values both the browser and the server use. They live
// apart from result.ts, whose schemas need zod, so the pages don't ship zod (138 KB) for a few numbers.

export const MAX_BILLS = 12;
export const MAX_BILL_PAGES = 6;
export const MAX_OFFER_PAGES = 4;
// Characters of written offer a check reads; a page past this is held back on the start screen with the reason.
export const MAX_OFFER_TEXT = 20_000;
// Characters of a PDF page's own text a check takes; a page past this is read from its picture, like a photo.
export const MAX_PAGE_TEXT = 60_000;
export const MAX_CALL_SECONDS = 240;
export const CALL_SAMPLE_RATE = 16_000;
// The long side pages are scaled to: by the browser for uploads, and by the server for a real post's pictures.
export const PAGE_LONG_SIDE = 1600;

// Shown on the demo when its budget is used, and sent back to a run asked for from a page loaded before that.
export const LIVE_PAUSED = "Live checks are paused: this demo has used its budget. Every saved result is below.";
