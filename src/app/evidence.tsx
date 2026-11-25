"use client";

import { useEffect, useRef, useState } from "react";
import type { Box } from "./bill-page";

export function formatClock(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

// The printed line itself, cut from the bill image: the strongest evidence is the original.
export function LineStrip({ image, box, tone }: { image: string; box: Box; tone: "claim" | "plain" }) {
  const [size, setSize] = useState<{ image: string; w: number; h: number } | null>(null);
  useEffect(() => {
    const probe = new Image();
    probe.src = image;
    void probe.decode().then(() => setSize({ image, w: probe.naturalWidth, h: probe.naturalHeight }));
  }, [image]);
  const x0 = Math.max(0, box.x0 - 10);
  const x1 = Math.min(1000, box.x1 + 10);
  const y0 = Math.max(0, box.y0 - 14);
  const y1 = Math.min(1000, box.y1 + 14);
  const width = (x1 - x0) / 1000;
  const height = (y1 - y0) / 1000;
  return (
    <div className="paper relative overflow-hidden" style={{ aspectRatio: size?.image === image ? `${width * size.w} / ${height * size.h}` : `${width * 1000} / ${height * 1294}` }}>
      <img
        src={image}
        alt=""
        className="absolute max-w-none select-none"
        style={{ width: `${100 / width}%`, left: `${(-x0 / 1000 / width) * 100}%`, top: `${(-y0 / 1000 / height) * 100}%`, height: `${100 / height}%` }}
        draggable={false}
      />
      {tone === "claim" && <div aria-hidden className="mark absolute" style={{ left: `${((box.x0 - x0) / 1000 / width) * 100}%`, right: `${((x1 - box.x1) / 1000 / width) * 100}%`, top: `${((box.y0 - y0) / 1000 / height) * 100}%`, bottom: `${((y1 - box.y1) / 1000 / height) * 100}%` }} />}
    </div>
  );
}

export function Waveform({ peaks, progress, className }: { peaks: number[]; progress?: number; className?: string }) {
  return (
    <svg aria-hidden viewBox={`0 0 ${peaks.length * 4} 40`} preserveAspectRatio="none" className={className}>
      {peaks.map((p, i) => (
        <rect key={i} x={i * 4} y={20 - Math.max(1.5, p * 18)} width={2.2} height={Math.max(3, p * 36)} rx={1} fill={progress !== undefined && i / peaks.length <= progress ? "var(--vermilion)" : "var(--graphite)"} />
      ))}
    </svg>
  );
}

// One audio element per page: playing a quote stops the previous one.
const shared: { audio: HTMLAudioElement | null } = { audio: null };

export function useClip(url: string | null) {
  const [playing, setPlaying] = useState<number | null>(null);
  const stopAt = useRef<number | null>(null);
  useEffect(() => {
    return () => {
      shared.audio?.pause();
    };
  }, []);
  const play = (from: number, to: number | null) => {
    if (!url) return;
    shared.audio?.pause();
    const audio = new Audio(url);
    shared.audio = audio;
    stopAt.current = to;
    audio.currentTime = Math.max(0, from - 0.3);
    audio.ontimeupdate = () => {
      if (stopAt.current !== null && audio.currentTime >= stopAt.current) audio.pause();
    };
    audio.onpause = () => setPlaying(null);
    audio.onended = () => setPlaying(null);
    setPlaying(from);
    void audio.play();
  };
  return { play, playing };
}

export function HeardQuote({ url, from, to, text, who }: { url: string | null; from: number; to: number | null; text: string; who: string }) {
  const { play, playing } = useClip(url);
  const active = playing !== null;
  return (
    <div className="paper flex items-start gap-3 px-4 py-3.5">
      <button
        type="button"
        onClick={() => play(from, to)}
        disabled={!url}
        aria-label={`Play what ${who} said at ${formatClock(from)}`}
        className={`grid size-9 shrink-0 place-items-center rounded-full transition-colors ${active ? "bg-vermilion text-white" : "bg-ink text-paper hover:bg-vermilion"}`}
      >
        <svg aria-hidden width="12" height="12" viewBox="0 0 12 12">
          {active ? <path d="M3 2h2v8H3zM7 2h2v8H7z" fill="currentColor" /> : <path d="M3 1.5v9l7.5-4.5z" fill="currentColor" />}
        </svg>
      </button>
      <div className="min-w-0">
        <p className="text-[12px] text-ink-3 tabular-nums">
          {who}, {formatClock(from)}
        </p>
        <p className="display text-[19px] leading-[1.3]">“{text}”</p>
      </div>
    </div>
  );
}
