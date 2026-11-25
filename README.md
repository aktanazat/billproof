# Billproof

Billproof puts a phone, internet or utility bill on the stand against what the company promised, and drafts the message that gets the difference back.

Drop in the bill (PDF or a phone photo) and the promise: the offer email, a screenshot, or a recording of the sales call. Billproof marks each charge that breaks the promise on the bill itself, sets the printed line beside the offer's words (or the moment on the call where they were said), has Muse Ember argue the company's side before anything is claimed, and writes the dispute as a chat message, an email or a call script. Drop up to twelve months of bills and it reads the whole year at once and shows the month the promise broke. Built for the Meta Muse Ember hackathon: every check runs on `muse-ember-1.0` and costs a fraction of a cent.

Live: https://billproof.aktan.us (six samples run from the start screen, including two recorded calls and a year of bills).

## How a check works

1. The browser renders each PDF page to an image and keeps its text layer; photos are scaled to 1600 px; a recorded call is decoded to 16 kHz mono WAV. Nothing is uploaded until you press Check. The server measures the recording from its bytes and refuses anything over four minutes.
2. Muse Ember reads the bill into structured line items (amount, kind, quote, position on the page) at high reasoning effort. Its reasoning summary and each line stream to the screen as they are read, and the lines light up on the bill.
3. If the line items don't add up to the printed current charges, Muse Ember reads the bill once more at xhigh effort. Two readings that still disagree end the check with "could not check" rather than a guess.
4. Muse Ember reads the offer and links each promise to the bill lines it governs. A recording is sent as audio: Muse Ember writes the transcript (speaker, start time, words) and quotes each promise from it with the second it was said.
5. Code, not the model, decides every dollar:
   - a promise counts only if its quote is in the offer (or the transcript) and its amount is in the quote;
   - a bill line counts only if its quote is on the bill's text layer and carries its amount;
   - a promise that ended before the bill period is shown as explained, not claimed;
   - conditions like autopay need proof on the bill; paperless or bundle conditions can't be proven from a bill, so they become questions;
   - an offer from a different company, a promise that starts or ends mid-period, or an amount that looks misread becomes a question;
   - each bill line backs at most one claim;
   - a claim resting on a photo or on a recording waits until the person confirms the marked line, or plays the clip and confirms what was said.
6. Muse Ember then argues the company's side of each claim: it searches the bill and the offer for a credit, an end date or a condition that would defeat it. A claim is dropped only when the rebuttal quotes the bill or offer word for word; a rebuttal that can't be verified leaves the claim standing for the person to confirm.
7. The message is assembled from fixed sentences filled with verified fields, so every number in it traces to a claim you selected. Promises from a call are cited with their time in the recording.

Only three kinds of claim produce dollars: a price above a promised monthly price, a charge for something promised as included, and a promised recurring credit that is missing. Company fees nobody agreed to and charges listed twice are offered as questions to ask, never as overcharges.

With several bills, each is checked on its own, four at a time, and its result streams in as it lands. The year view counts each statement once, only for the account most of them belong to, and adds only the claims you keep selected.

## Spend

Before each model call the server counts the exact input tokens with `POST /v1/responses/input_tokens` and reserves the worst case (all input uncached, every allowed output token) in a SQLite ledger. Reservations are checked against a per-check cap of 3¢ per bill and an event cap, then settled to the billed usage. A call lost mid-flight stays counted at its full reservation. When one bill of a year fails, no other bill starts a new paid call, and the failure is reported only after the calls already running have settled. The cost of each check, and the tokens of each model call, are shown under the result.

## Run it

```bash
pnpm install
MODEL_API_KEY=… pnpm dev
```

| Variable | Default | Meaning |
| --- | --- | --- |
| `MODEL_API_KEY` | required | Meta Model API key |
| `EVENT_BUDGET_MICROS` | `6000000` | Total spend the ledger allows, in millionths of a dollar |
| `LEDGER_PATH` | `data/ledger.db` | SQLite ledger file |

Checks: `pnpm typecheck`, `pnpm lint`, `pnpm test`.

## Evaluation

`pnpm eval` renders every synthetic bill in `scripts/samples/eval-specs.ts` as a PDF and as a phone photo, runs each through the real pipeline and Muse Ember, and scores claims, false claims, questions and explanations against the planted ground truth. The set includes clean lookalikes (promises honored, credits posted), an expired promotion, a promotion ending mid-cycle, an unproven autopay condition, an offer from another company, and an unsupported electricity rate plan. It also runs the same internet bill against two recorded calls (one promising two years, one only the first year) and a year of twelve statements where the price rises in month nine and a gateway fee appears in month eleven.

Run on 2026-11-25 (`eval/run-2026-11-25b.json` holds every event, reading and model call):

| Input | Checks completed | Claims found | False claims | Questions found | Explained |
| --- | --- | --- | --- | --- | --- |
| PDF | 12/12 | 5/5 | 0 | 9/9 | 2/2 |
| Phone photo | 12/12 | 5/5 | 0 | 9/9 | 2/2 |
| Recorded call | 2/2 | 2/2 | 0 | 4/4 | 2/2 |
| Year of 12 bills | 12/12 | 6/6 | 0 | 0/0 | 0/0 |

Median cost per single-bill check: 0.17¢, with the challenge step included. The year of twelve bills cost 2.4¢ and took 32 seconds. All 27 checks together: 69 paid Muse Ember calls (16 more steps reused an identical earlier reading), 209,378 input tokens (147,012 served from Meta's prompt cache), 119,116 output tokens including reasoning, $0.066. The bills and calls are synthetic (the calls are synthesized voices), so these numbers show the pipeline holds its rules; real bills and calls are messier.

`pnpm samples` regenerates the sample bills, the two recorded calls and the year of statements on the start screen.

## Proof of usage

Every check returns its own trace: each Muse Ember step with its reasoning effort, input, cached and output tokens, and cost, shown under "How Muse Ember checked it" on the result screen. The prompts are `READ_BILL_INSTRUCTIONS`, `READ_TERMS_INSTRUCTIONS` and `CHALLENGE_INSTRUCTIONS` in `src/lib/pipeline.ts`; the evaluation trace is `eval/run-2026-11-25b.json`. The server ledger (`data/ledger.db`) records every reservation and settled cost.

## Privacy

Files and recordings go to Meta Model API with `store: false`. The server keeps no files; it holds the extracted readings in memory for 15 minutes so a retried check does not pay twice. A recording plays back from your own browser, never from the server.
