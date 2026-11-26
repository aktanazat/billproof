"use client";

import { useEffect, useRef, useState } from "react";
import { formatMicros } from "@/lib/cost";
import { usd } from "@/lib/letter";
import type { LiveEvent } from "@/lib/real-bills";
import type { SingleResult, Stage } from "@/lib/result";
import { Thumbnail } from "../bill-page";

type Tile = { id: string; title: string; provider: string | null; picture: string; stage: Stage | "waiting" | "done" | "failed" | "stopped"; lines: number; spent: number; feeCents: number; claimCents: number; note: string };

const STAGE_TEXT: Record<Stage, string> = { sorting: "Sorting pictures", reading_bill: "Reading", rereading_bill: "Reading again", reading_offer: "Reading the post", comparing: "Comparing", challenging: "Checking the company's side" };

function finish(tile: Tile, result: SingleResult): Tile {
  if (result.outcome !== "checked") return { ...tile, stage: "done", note: result.outcome === "not_a_bill" ? "Not a bill" : "Couldn't read" };
  const line = (id: string) => result.reading.line_items.find((item) => item.id === id)?.amount_cents ?? 0;
  const feeCents = result.questions.filter((q) => q.kind === "unagreed_fee").reduce((t, q) => t + q.lineIds.reduce((s, id) => s + line(id), 0), 0);
  const claimCents = result.claims.reduce((t, claim) => t + claim.amountCents, 0);
  const claimNote = result.claims.every((claim) => claim.kind === "credit_missing") ? "credit missing" : "above the promise";
  return { ...tile, stage: "done", provider: result.reading.provider ?? tile.provider, feeCents, claimCents, note: claimCents > 0 ? `${usd(claimCents)} ${claimNote}` : feeCents > 0 ? `${usd(feeCents)} in fees` : "No fees or claims" };
}

export function LiveRun({ paused }: { paused: boolean }) {
  const [tiles, setTiles] = useState<Tile[]>([]);
  const [state, setState] = useState<"idle" | "running" | "done" | "refused">("idle");
  const [message, setMessage] = useState("");
  const [elapsed, setElapsed] = useState(0);
  const [total, setTotal] = useState<{ seconds: number; spentMicros: number } | null>(null);
  const started = useRef(0);

  useEffect(() => {
    if (state !== "running") return;
    const timer = setInterval(() => setElapsed((performance.now() - started.current) / 1000), 100);
    return () => clearInterval(timer);
  }, [state]);

  const run = async () => {
    setState("running");
    setTiles([]);
    setTotal(null);
    started.current = performance.now();
    const response = await fetch("/api/real-run", { method: "POST" }).catch(() => null);
    if (!response?.body) {
      setState("refused");
      setMessage("The connection dropped. Try again.");
      return;
    }
    const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
    let buffer = "";
    let ended = false;
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += value;
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const text of lines) {
          if (!text.trim()) continue;
          const event = JSON.parse(text) as LiveEvent;
          if (event.type === "refused") {
            ended = true;
            setState("refused");
            setMessage(event.message);
          } else if (event.type === "batch") {
            setTiles(event.posts.map((post) => ({ ...post, stage: "waiting", lines: 0, spent: 0, feeCents: 0, claimCents: 0, note: "" })));
          } else if (event.type === "done") {
            ended = true;
            setTotal({ seconds: event.seconds, spentMicros: event.spentMicros });
            setState("done");
          } else {
            const inner = event.event;
            setTiles((all) =>
              all.map((tile, i) => {
                if (i !== event.i) return tile;
                switch (inner.type) {
                  case "stage":
                    return { ...tile, stage: inner.stage };
                  case "line":
                    return { ...tile, lines: tile.lines + 1 };
                  case "reread":
                    return { ...tile, lines: 0 };
                  case "spent":
                    return { ...tile, spent: inner.micros };
                  case "result":
                    return inner.result.outcome === "year" ? tile : { ...finish(tile, inner.result), spent: inner.result.spentMicros };
                  case "error":
                    // A tile can't be retried on its own, so only a reason about the post itself is shown; the check screen's "try again" advice is not.
                    return { ...tile, stage: "failed", note: inner.failure === "bad_input" ? inner.message : inner.failure === "budget_spent" ? "Demo budget used up" : "Couldn't finish", spent: inner.spentMicros };
                  default:
                    return tile;
                }
              }),
            );
          }
        }
      }
    } catch {
      // A dropped connection or a cut-off line ends the run below.
    } finally {
      if (!ended) {
        setState("refused");
        setMessage("The run stopped early. Try again later.");
        // Nothing more will arrive, so a tile still reading or waiting would claim work that is no longer happening.
        setTiles((all) => all.map((tile) => (tile.stage === "done" || tile.stage === "failed" ? tile : { ...tile, stage: "stopped", note: "Stopped" })));
      }
    }
  };

  const finished = tiles.filter((tile) => tile.stage === "done" || tile.stage === "failed").length;
  const fees = tiles.reduce((t, tile) => t + tile.feeCents, 0);
  const claims = tiles.reduce((t, tile) => t + tile.claimCents, 0);
  const spent = total?.spentMicros ?? tiles.reduce((t, tile) => t + tile.spent, 0);
  const seconds = total?.seconds ?? elapsed;

  return (
    <section className="mt-14">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h2 className="text-[17px] font-semibold">Watch it check 24 real bills at once</h2>
          <p className="mt-1 text-[13px] text-text-2">Each one is read live by Muse Ember, eight at a time, while you watch.</p>
        </div>
        <button type="button" onClick={() => void run()} disabled={paused || state === "running"} className="h-9 rounded-lg bg-text px-4 text-[15px] font-medium text-white hover:bg-black disabled:bg-fill-2 disabled:text-text-2">
          {state === "running" ? "Running" : state === "done" ? "Run again" : "Run it live"}
        </button>
      </div>
      {paused && <p className="mt-3 text-[13px] text-text-2">Live checks are paused: this demo has used its budget. Every saved result is below.</p>}
      {state === "refused" && (
        <p className="mt-3 text-[13px] text-red" role="alert">
          {message}
        </p>
      )}

      {tiles.length > 0 && (
        <>
          <dl className="mt-5 grid grid-cols-2 rounded-xl bg-fill sm:grid-cols-5 sm:divide-x sm:divide-line">
            {[
              ["Bills done", `${finished} of ${tiles.length}`],
              ["Fees found, per month", usd(fees)],
              ["To ask back", usd(claims)],
              ["Seconds", seconds.toFixed(1)],
              ["Spent", formatMicros(spent)],
            ].map(([label, value]) => (
              <div key={label} className="flex flex-col gap-1 p-4">
                <dt className="text-[13px] text-text-2">{label}</dt>
                <dd className="text-[24px] font-semibold tracking-[-0.01em] tabular-nums">{value}</dd>
              </div>
            ))}
          </dl>
          <ol className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-6">
            {tiles.map((tile) => {
              const live = tile.stage === "waiting" || tile.stage === "done" || tile.stage === "failed" || tile.stage === "stopped" ? null : tile.stage;
              const found = tile.feeCents + tile.claimCents > 0;
              return (
                <li key={tile.id} className={`flex flex-col gap-2 rounded-xl p-2 transition-colors ${live ? "bg-fill" : ""}`}>
                  <div className={`h-28 overflow-hidden rounded-[4px] bg-white shadow-[inset_0_0_0_1px_var(--line)] ${found ? "shadow-[inset_0_0_0_2px_var(--red)]" : ""} ${tile.stage === "waiting" ? "opacity-40" : ""}`}>
                    <Thumbnail src={tile.picture} />
                  </div>
                  <p className="truncate text-[12px] text-text-2">{tile.provider ?? "Bill"}</p>
                  <p className={`text-[13px] leading-[17px] tabular-nums ${found ? "font-semibold text-red" : live ? "text-text" : "text-text-2"}`}>
                    {tile.stage === "waiting" ? "Waiting" : live ? `${STAGE_TEXT[live]}${tile.lines > 0 ? `, ${tile.lines} ${tile.lines === 1 ? "line" : "lines"}` : ""}` : tile.note}
                  </p>
                </li>
              );
            })}
          </ol>
        </>
      )}
    </section>
  );
}
