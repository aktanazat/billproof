# Billproof

Billproof puts a phone, internet or utility bill on the stand against what the company promised, and drafts the message that gets the difference back.

Drop in the bill (PDF or a phone photo) and the promise: the offer email, a screenshot, or a recording of the sales call. Billproof marks each charge that breaks the promise on the bill itself, sets the printed line beside the offer's words (or the moment on the call where they were said), has Muse Ember argue the company's side before anything is claimed, and writes the dispute as a chat message, an email or a call script. Drop up to twelve months of bills and it reads the whole year at once and shows the month the promise broke. Built for the Meta Muse Ember hackathon: every check runs on `muse-ember-1.0` and costs a fraction of a cent.

Live: https://billproof.aktan.us (six samples run from the start screen, including two recorded calls and a year of bills).

## How a check works

1. The browser renders each PDF page to an image and keeps its text layer; photos are scaled to 1600 px; a recorded call is decoded to 16 kHz mono WAV. Nothing is uploaded until you press Check. The server measures the recording from its bytes and refuses anything over four minutes.
2. Muse Ember reads the bill into structured line items (amount, kind, quote, position on the page) at high reasoning effort. Its reasoning summary and each line stream to the screen as they are read, and the lines light up on the bill. On a PDF, each mark sits on the printed row that carries the line's label, taken from the text layer, so a box the model places a row off still lands on the right line.
3. If the line items don't add up to the printed current charges, Muse Ember reads the bill once more at xhigh effort. Two readings that still disagree end the check with "could not check" rather than a guess.
4. Muse Ember reads the offer and links each promise to the bill lines it governs. A recording is sent as audio: Muse Ember writes the transcript (speaker, start time, words) and quotes each promise from it with the second it was said.
5. Code, not the model, decides every dollar:
   - a promise counts only if its quote is in the offer (or the transcript) and its amount is in the quote;
   - a bill line counts only if its quote is on the bill's text layer and carries its amount;
   - a promise that ended before the bill period is shown as explained, not claimed;
   - conditions like autopay need proof on the bill; paperless or bundle conditions can't be proven from a bill, so they become questions;
   - an offer from a different company, a promise that starts or ends mid-period, or an amount that looks misread becomes a question;
   - each bill line backs at most one claim;
   - a promise that something is included covers only a charge whose label it names, so a gateway promise linked to the internet plan by mistake claims nothing;
   - a claim resting on a photo or on a recording waits until the person confirms the marked line, or plays the clip and confirms what was said.
6. Muse Ember then argues the company's side of each claim: it searches the bill and the offer for a credit, an end date or a condition that would defeat it. A claim is dropped only when the rebuttal quotes the offer word for word, or quotes a credit on the bill that pays the claim back. The bill's own notices ("your promotional pricing ended") are the company's position, not proof, so they never drop a claim; an offer rebuttal that can't be found word for word leaves the claim standing for the person to confirm.
7. The message is assembled from fixed sentences filled with verified fields, so every number in it traces to a claim you selected. Promises from a call are cited with their time in the recording.

Only three kinds of claim produce dollars: a price above a promised monthly price, a charge for something promised as included, and a promised recurring credit that is missing. Company fees nobody agreed to and charges listed twice are offered as questions to ask, never as overcharges.

With several bills, each is checked on its own, four at a time, and its result streams in as it lands. The year view counts each statement once, only for the account most of them belong to, and adds only the claims you keep selected.

Screenshots dropped together are treated as one pile. Muse Ember first sorts each picture into bill, promise (a chat with the company, an offer, an email) or neither; the bill pages are read as the bill, and the promise pictures join whatever the person wrote as the offer. Promises read off screenshots always wait for the person to confirm.

Every message comes in four forms: a chat message, an email, a call script, and a complaint ready for the FCC (phone, internet, TV) or a state utility commission (electric, gas, water), with a blank for what the company said when asked.

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

## Real bills

The synthetic set proves the rules; the real-bills run shows what happens on the internet's actual mess. `pnpm census <posts.jsonl>` runs Billproof over public Reddit posts about phone, internet and TV bills, eight at a time, each post's pictures as one pile and its words as what the poster says they were promised. The results are on the site at `/real`, where any of them can be checked again live.

Run on 2026-11-25: about 181,000 posts from 32 subreddits (Xfinity, Spectrum, AT&T, Verizon, T-Mobile, Google Fi, Optimum, Cox, Starlink, DirecTV and others, back to 2019) were scanned through the Arctic Shift archive; 1,517 had pictures and talked about a promise, promo, credit or price change; the pictures of 1,251 were still online. Muse Ember sorted those pictures and found the real bills among chats, app screens and ads; the posts it read as bills were then checked again after the fixes below. 138 are real bills (one more, an AT&T sales quote, was counted as a bill until the quote rule below). 41 carry company fees the poster never mentions agreeing to, $527.74 a month in all, led by state "Cost Recovery" charges, "Broadcast TV" and "Regional Sports" fees. 102 of the bills print a total, an amount due or a subtotal for every part, and list their charges. On 93 of them, the charges Muse Ember read add up to them to the cent (73 to the printed current charges, 17 to the amount due once any unpaid balance is counted, 3 to each of their part subtotals); on 7 more, the first charges add up to a subtotal the bill prints before the rest; 2 don't add up, one a screenshot cut off above a line and one a typed summary whose total includes devices it doesn't list. One post has a charge above a promise the poster quoted, and it holds up when read by hand: a Verizon watch line missing its $7.50 discount, which Verizon later paid back. It waits for the poster to confirm the marked line, because a photo can't be checked against a text layer. Before this round's fixes there were eight such posts and only one held up; a second, a Xumo box Spectrum said was included, looked right until the picture showed a $5 discount printed right under it. Every stored reading was then put through the final rules again without new model calls; no claim or question changed. Bills rerun only to check their arithmetic were kept only when their findings came out the same. The first pass took 14 minutes and cost $0.93; the passes after the fixes, 9 minutes and $0.58.

What the real posts taught it, each fix checked against the synthetic set (still 5/5 PDF, 5/5 photo, 2/2 call, 6/6 year, no false claims):

- Many posts show two months side by side. Billproof used to read both as one bill, doubling every fee. Now the sorting step marks earlier statements, the bill is read from the newest one only, and the earlier one is read just to list what moved ("Up $95.12 since the earlier bill: Internet $109.00 → $165.25, Ultimate TV $78.50 → $118.98, …"). Fifteen posts had one.
- Totals are recognized however the bill labels them ("Total monthly charges", "Bill total"), so far more bills can be checked against their own arithmetic: 90 instead of 47. A printed subtotal that the first charges add up to counts as a subtotal match, and charges that, with any unpaid balance, come to the printed amount due count as a match; neither sends the bill to be read a second time.
- A heading read as a charge ("Apple TV $3.00" over the lines that make it up) counted its lines twice. The reading rules now say to skip such headings, and when one slips through, code drops it, but only if that makes the bill add up to its printed total, so a charge that really is billed twice stays.
- A long bill that ran out of room on the first read is read again with twice the room instead of failing.
- A cropped screenshot with no dates no longer turns every promise into a "partial month" question; only promises with dates need the bill's dates.
- A free item can no longer be claimed against the plan's own price, and the company's name no longer counts as naming an item ("Spectrum Modem Included" is not about "Spectrum Internet").
- Read from a poster's own words, complaints, wishes and their own arithmetic are left out of the promises, and so are offers shown by someone shopping for a plan or advertising one.
- "About $20" is not a promise of $20, "for 12 mos." and "for a year" limit a promise in time, and a per-line credit isn't owed on a $0 line.
- A discount printed right under an included item for exactly its amount pays it back, even when it wasn't linked to the promise.
- A sales quote or order summary is not a bill, and a line's label is its name alone, without its rate or quantity.
- On a picture, a line whose quote leaves out its amount still counts by its position on the page; a quote with a different amount still doesn't. Claims from pictures always wait for the person to confirm the marked line.
- Some bills print no overall total, only one per section or per person. Those part totals are now read too, and a bill whose charges split, in order, into runs that match every one of them counts as adding up. Of 36 real bills rerun that had no usable total, 13 then added up and none failed to; the 10 whose findings came out the same are on the site.

The outcome check: the authors' own later comments on every real bill were read for whether the company paid them back. Four said it did for a charge Billproof checks. On the Xfinity bill the company credited, Billproof shows the $95.12 jump line by line; on the Verizon one it claims the missing $7.50 discount, the amount Verizon paid back; on a Spectrum and a Google Fi bill it found nothing, because the bill the poster pictured did not show the problem. The page lists all four.

The reading check by eye: seven real bills, six of them drawn at random, were compared with their pictures after the fixes (AT&T, two DIRECTV, Xfinity, Spectrum side by side with its earlier month, Visible, Verizon). All 45 lines were read with the right label and amount, and from the newest statement. A second random draw of ten more (two Spectrum, Xfinity, Visible, Boost, Starlink, Google Fi, Optimum, AT&T and one with no company name shown) found all 45 of their lines right too; one of the ten was an AT&T sales quote rather than a bill, which led to the quote rule above. A third draw, of ten bills with flagged fees, found all 25 flagged fees to be real company fees at the right amounts, none of them taxes, checked against the picture or, where the bill adds up, its own printed total (7 of the 10 add up to their total and 2 to a printed subtotal). The tenth printed its total only as the heading over its charges, which led to reading such a heading as the total when nothing else is printed: of 12 bills rerun that had no usable total, 4 then added up and none failed to.

The real-bills page also runs live: one button checks 24 of these real bills at once, eight at a time, with every bill's reading, fees and cost streaming into a grid. Only the site's own page can start a run; one run goes at a time, six an hour across the site and one an hour per address.

Only public posts are used. The site shows each post's title and links to it; pictures are fetched from Reddit by post and position, never by an address the visitor supplies.

## Proof of usage

Every check returns its own trace: each Muse Ember step with its reasoning effort, input, cached and output tokens, and cost, shown under "How it was checked" on the result screen. The prompts are `SORT_INSTRUCTIONS`, `READ_BILL_INSTRUCTIONS`, `READ_TERMS_INSTRUCTIONS` and `CHALLENGE_INSTRUCTIONS` in `src/lib/pipeline.ts`; the evaluation trace is `eval/run-2026-11-25b.json` and the real-bills run is `src/data/real-bills.json`. The server ledger (`data/ledger.db`) records every reservation and settled cost.

## Privacy

Files and recordings go to Meta Model API with `store: false`. The server keeps no files; it holds the extracted readings in memory for 15 minutes so a retried check does not pay twice. A recording plays back from your own browser, never from the server.
