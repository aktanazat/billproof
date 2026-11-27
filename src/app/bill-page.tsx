"use client";

import Image from "next/image";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { quoteExactIn } from "@/lib/evidence";
import type { TextRow } from "@/lib/pdf-text";

export type Box = { x0: number; y0: number; x1: number; y1: number };
export type Mark = { id: string; box: Box; tone: "claim" | "ask" | "read"; n?: number };

// A bill picture in a small box: a page or a phone screenshot shows its top, where the company and the total are; a
// wide strip (a cropped screenshot of a few lines) is shown whole, since its top corner alone is blank. Pictures served
// by the site (the real posts') are resized on the server for the box, since a full Reddit picture can weigh 1.8 MB;
// the person's own uploads are already in the browser and are shown as they are.
// A real post's picture can be gone from Reddit by the time it's shown; its box is left empty rather than showing the
// browser's broken-picture icon, and the words beside it say why.
export function Thumbnail({ src, lazy = false }: { src: string; lazy?: boolean }) {
  const ref = useRef<HTMLImageElement>(null);
  const [wide, setWide] = useState(false);
  const [broken, setBroken] = useState(false);
  const measure = (img: HTMLImageElement) => setWide(img.naturalWidth > img.naturalHeight * 1.5);
  // A picture the server page loaded, or failed to load, before this code ran gets no event, so it's checked here once.
  useEffect(() => {
    if (!ref.current?.complete) return;
    if (ref.current.naturalWidth > 0) measure(ref.current);
    else setBroken(true);
  }, []);
  if (broken) return null;
  return (
    <Image
      ref={ref}
      src={src}
      alt=""
      width={256}
      height={256}
      sizes="112px"
      unoptimized={!src.startsWith("/")}
      loading={lazy ? "lazy" : "eager"}
      onLoad={(event) => measure(event.currentTarget)}
      onError={() => setBroken(true)}
      className={`h-full w-full ${wide ? "object-contain" : "object-cover object-top"}`}
    />
  );
}

// On a PDF, a charge is marked on the printed row that carries its label as whole words, read past look-alike
// characters as quotes are, nearest where Muse Ember placed it; the model's own box can be a row off. Photos have no
// rows and keep the model's box.
export function snapBox(box: Box | null, label: string, rows: TextRow[] | null): Box | null {
  if (!rows) return box;
  const hits = rows.filter((row) => quoteExactIn(label, row.text));
  if (hits.length === 0 || (!box && hits.length > 1)) return box;
  if (!box) return hits[0].box;
  const middle = (b: Box) => (b.y0 + b.y1) / 2;
  return hits.reduce((best, row) => (Math.abs(middle(row.box) - middle(box)) < Math.abs(middle(best.box) - middle(box)) ? row : best)).box;
}

const TONE_CLASS: Record<Mark["tone"], string> = { claim: "mark-claim", ask: "mark-ask", read: "mark-read" };

// Boxes are on the 0-1000 grid of the full page image; `visibleAspect` (width / height) crops the blank bottom of short bills.
export function BillPage({ image, alt, marks = [], focus, visibleAspect, children }: { image: string; alt: string; marks?: Mark[]; focus?: ReadonlySet<string>; visibleAspect?: string; children?: ReactNode }) {
  return (
    // The edge is an outline: it is drawn over the picture, where an inset shadow is hidden beneath it.
    // A size container: a mark's number is placed against the picture's width (cqw) so it never falls off its edge.
    <div className="@container relative overflow-hidden rounded-lg bg-white outline-1 -outline-offset-1 outline-line" style={visibleAspect ? { aspectRatio: visibleAspect } : undefined}>
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
            {/* Beside the line, or as far left as the picture allows: a line near the edge (a phone screenshot, a small
                picture) would otherwise leave its number cut off. 22px is the number's 18 plus a 4px gap. */}
            {mark.n !== undefined && <span className="absolute top-1/2 grid size-[18px] -translate-y-1/2 place-items-center rounded-full bg-red text-[11px] font-semibold text-white tabular-nums [print-color-adjust:exact]" style={{ left: `max(-22px, -${left}cqw)` }}>{mark.n}</span>}
          </div>
        );
      })}
      {children}
    </div>
  );
}
