"use client";

import { useEffect, useState } from "react";

export function formatClock(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

// Muse Ember's own words (a thinking summary, why a bill couldn't be read) sometimes name a field of the reading format
// ("applies_from", "line_items"), or the format itself ("the required JSON schema"); the page shows plain words: the two
// date fields by what they mean, a few others by meaning, any other with its underscores as spaces, and the format as
// "the reading format".
const FIELD_WORDS: Record<string, string> = { applies_from: "start date", applies_until: "end date", covers_line_ids: "covered lines", said_at_seconds: "time said", start_seconds: "start time" };
export function inPlainWords(text: string): string {
  return text
    .replace(/ per (?:JSON )?schema\b/gi, ", as the format asks")
    .replace(/\b(?:(?:the|a) )?(?:required )?(?:JSON schema|JSON|schema)(?: (?:fields|structure|output|keys|object))?\b/gi, "the reading format")
    .replace(/\b[a-z]+(?:_[a-z]+)+\b/g, (field) => FIELD_WORDS[field] ?? field.replaceAll("_", " "));
}

export function Waveform({ peaks, className }: { peaks: number[]; className?: string }) {
  return (
    <svg aria-hidden viewBox={`0 0 ${peaks.length * 4} 40`} preserveAspectRatio="none" className={className}>
      {peaks.map((p, i) => (
        <rect key={i} x={i * 4} y={20 - Math.max(1.5, p * 18)} width={2.2} height={Math.max(3, p * 36)} rx={1} fill="var(--text-2)" />
      ))}
    </svg>
  );
}

// One audio element per page: playing a moment stops the previous one.
const shared: { audio: HTMLAudioElement | null } = { audio: null };

export function useClip(url: string | null) {
  const [playing, setPlaying] = useState<number | null>(null);
  useEffect(() => {
    return () => {
      shared.audio?.pause();
    };
  }, []);
  const play = (from: number, to: number | null) => {
    if (!url) return;
    // The button shows a pause icon while its own moment plays; pressing it then stops instead of starting over.
    if (playing === from) {
      shared.audio?.pause();
      return;
    }
    shared.audio?.pause();
    const audio = new Audio(url);
    shared.audio = audio;
    audio.currentTime = Math.max(0, from - 0.3);
    audio.ontimeupdate = () => {
      if (to !== null && audio.currentTime >= to) audio.pause();
    };
    audio.onpause = () => setPlaying(null);
    audio.onended = () => setPlaying(null);
    setPlaying(from);
    audio.play().catch(() => setPlaying(null));
  };
  return { play, playing };
}

export function PlayButton({ url, from, to, label }: { url: string | null; from: number; to: number | null; label: string }) {
  const { play, playing } = useClip(url);
  return (
    // A toggle: pressed while its moment plays, when pressing it stops. The icon alone showed that only to sight.
    <button type="button" onClick={() => play(from, to)} disabled={!url} aria-label={label} aria-pressed={playing !== null} className="inline-flex h-7 shrink-0 items-center gap-1.5 rounded-full bg-fill px-2.5 text-[13px] text-text tabular-nums hover:bg-fill-2 disabled:opacity-40">
      <svg aria-hidden width="10" height="10" viewBox="0 0 12 12">
        {playing !== null ? <path d="M3 2h2v8H3zM7 2h2v8H7z" fill="currentColor" /> : <path d="M3 1.5v9l7.5-4.5z" fill="currentColor" />}
      </svg>
      {formatClock(from)}
    </button>
  );
}
