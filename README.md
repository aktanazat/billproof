# Billproof

Billproof checks a phone, internet or utility bill against what the company promised, and drafts the message that gets the difference back.

Drop in the bill (PDF or a phone photo) and paste the offer email or plan summary. Billproof highlights each charge that breaks the promise on the bill itself, shows the line from the bill and the line from the offer side by side, and writes the dispute as a chat message, an email or a call script. Built for the Meta Muse Ember hackathon: every check runs on `muse-ember-1.0` and costs a fraction of a cent.

Live: https://billproof.aktan.us (three sample bills run from the start screen).

## How a check works

1. The browser renders each PDF page to an image and keeps its text layer; photos are scaled to 1600 px. Nothing is uploaded until you press Check.
2. Muse Ember reads the bill into structured line items (amount, kind, quote, position on the page) at low reasoning effort.
3. If the line items don't add up to the printed current charges, Muse Ember reads the bill once more at high effort. Two readings that still disagree end the check with "could not check" rather than a guess.
4. Muse Ember reads the offer and links each promise to the bill lines it governs.
5. Code, not the model, decides every dollar:
   - a promise counts only if its quote is in the offer and its amount is in the quote;
   - a bill line counts only if its quote is on the bill's text layer and carries its amount;
   - a promise that ended before the bill period is shown as explained, not claimed;
   - conditions like autopay need proof on the bill; paperless or bundle conditions can't be proven from a bill, so they become questions;
   - an offer from a different company, a promise that starts or ends mid-period, or an amount that looks misread becomes a question;
   - each bill line backs at most one claim.
6. The message is assembled from fixed sentences filled with verified fields, so every number in it traces to a claim you selected.

Only three kinds of claim produce dollars: a price above a promised monthly price, a charge for something promised as included, and a promised recurring credit that is missing. Company fees nobody agreed to and charges listed twice are offered as questions to ask, never as overcharges.

## Spend

Before each model call the server counts the exact input tokens with `POST /v1/responses/input_tokens` and reserves the worst case (all input uncached, every allowed output token) in a SQLite ledger. Reservations are checked against a per-check cap of 3¢ and an event cap, then settled to the billed usage. A call lost mid-flight stays counted at its full reservation. The cost of each check, and the tokens of each model call, are shown under the result.

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

`pnpm eval` renders every synthetic bill in `scripts/samples/eval-specs.ts` as a PDF and as a phone photo, runs each through the real pipeline and Muse Ember, and scores claims, false claims, questions and explanations against the planted ground truth. The set includes clean lookalikes (promises honored, credits posted), an expired promotion, a promotion ending mid-cycle, an unproven autopay condition, an offer from another company, and an unsupported electricity rate plan.

Run on 2026-11-25 (`eval/run-2026-11-25.json` holds every event, reading and model call):

| Input | Checks completed | Claims found | False claims | Questions found | Explained |
| --- | --- | --- | --- | --- | --- |
| PDF | 12/12 | 5/5 | 0 | 9/9 | 2/2 |
| Phone photo | 12/12 | 5/5 | 0 | 9/9 | 2/2 |

Median cost per check: 0.074¢. All 24 checks together: 34 paid Muse Ember calls (14 more steps reused an identical earlier reading), 105,465 input tokens (101,864 served from Meta's prompt cache, because an earlier run had read the same bills), 34,670 output tokens, $0.018. A first run with a cold cache cost $0.023 (median 0.099¢). The same results held on a second full run and on three more runs of the phone bills. The bills are synthetic, so these numbers show the pipeline holds its rules; real bills are messier.

`pnpm samples` regenerates the three sample bills on the start screen.

## Proof of usage

Every check returns its own trace: each Muse Ember step with its reasoning effort, input, cached and output tokens, and cost, shown under "Checked for … with Muse Ember" on the result screen. The prompts are `READ_BILL_INSTRUCTIONS` and `READ_TERMS_INSTRUCTIONS` in `src/lib/pipeline.ts`; the evaluation trace is `eval/run-2026-11-25.json`. The server ledger (`data/ledger.db`) records every reservation and settled cost.

## Privacy

Files go to Meta Model API with `store: false`. The server keeps no files; it holds the extracted readings in memory for 15 minutes so a retried check does not pay twice.
