"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import type { TextRow } from "@/lib/pdf-text";

export type Box = { x0: number; y0: number; x1: number; y1: number };
export type Mark = { id: string; box: Box; tone: "claim" | "ask" | "read"; n?: number };

// A bill picture in a small box: a page or a phone screenshot shows its top, where the company and the total are; a
// wide strip (a cropped screenshot of a few lines) is shown whole, since its top corner alone is blank.
export function Thumbnail({ src, lazy = false }: { src: string; lazy?: boolean }) {
  const ref = useRef<HTMLImageElement>(null);
  const [wide, setWide] = useState(false);
  const measure = (img: HTMLImageElement) => setWide(img.naturalWidth > img.naturalHeight * 1.5);
  // A picture the server page already loaded before this code ran gets no load event, so it is measured here once.
  useEffect(() => {
    if (ref.current?.complete && ref.current.naturalWidth > 0) measure(ref.current);
  }, []);
  return <img ref={ref} src={src} alt="" loading={lazy ? "lazy" : undefined} onLoad={(event) => measure(event.currentTarget)} className={`h-full w-full ${wide ? "object-contain" : "object-cover object-top"}`} />;
}

const norm = (text: string) => text.toLowerCase().replace(/\s+/g, " ").trim();

// On a PDF, a charge is marked on the printed row that carries its label, nearest where Muse Ember placed it;
// the model's own box can be a row off. Photos have no rows and keep the model's box.
export function snapBox(box: Box | null, label: string, rows: TextRow[] | null): Box | null {
  if (!rows) return box;
  const want = norm(label);
  const hits = rows.filter((row) => norm(row.text).includes(want));
  if (hits.length === 0 || (!box && hits.length > 1)) return box;
  if (!box) return hits[0].box;
  const middle = (b: Box) => (b.y0 + b.y1) / 2;
  return hits.reduce((best, row) => (Math.abs(middle(row.box) - middle(box)) < Math.abs(middle(best.box) - middle(box)) ? row : best)).box;
}

const TONE_CLASS: Record<Mark["tone"], string> = { claim: "mark-claim", ask: "mark-ask", read: "mark-read" };

// Boxes are on the 0-1000 grid of the full page image; `visibleAspect` (width / height) crops the blank bottom of short bills.
export function BillPage({ image, alt, marks = [], focus, visibleAspect, children }: { image: string; alt: string; marks?: Mark[]; focus?: ReadonlySet<string>; visibleAspect?: string; children?: ReactNode }) {
  return (
    <div className="relative overflow-hidden rounded-lg bg-white shadow-[inset_0_0_0_1px_var(--line)]" style={visibleAspect ? { aspectRatio: visibleAspect } : undefined}>
      <img src={image} alt={alt} className="block w-full select-none" draggable={false} />
      {marks.map((mark) => {
        const dimmed = focus && focus.size > 0 && !focus.has(mark.id);
        const left = Math.max(0, mark.box.x0 - 8) / 10;
        const top = Math.max(0, mark.box.y0 - 5) / 10;
        const width = (Math.min(1000, mark.box.x1 + 8) - Math.max(0, mark.box.x0 - 8)) / 10;
        const height = (Math.min(1000, mark.box.y1 + 5) - Math.max(0, mark.box.y0 - 5)) / 10;
        return (
          <div
            key={mark.id}
            aria-hidden
            className={`absolute transition-opacity duration-150 ${TONE_CLASS[mark.tone]} ${dimmed ? "opacity-30" : ""}`}
            style={{ left: `${left}%`, top: `${top}%`, width: `${width}%`, height: `${height}%` }}
          >
            {mark.n !== undefined && <span className="absolute top-1/2 right-[calc(100%+4px)] grid size-[18px] -translate-y-1/2 place-items-center rounded-full bg-red text-[11px] font-semibold text-white tabular-nums">{mark.n}</span>}
          </div>
        );
      })}
      {children}
    </div>
  );
}
