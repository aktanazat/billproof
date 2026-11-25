import type { ReactNode } from "react";

export type Box = { x0: number; y0: number; x1: number; y1: number };
export type Mark = { id: string; box: Box; tone: "claim" | "ask" | "read"; n?: number };

const TONE_CLASS: Record<Mark["tone"], string> = { claim: "mark", ask: "ask-mark", read: "read-mark" };

// Boxes are on the 0-1000 grid of the full page image; `visibleAspect` (width / height) crops the blank bottom of short bills.
export function BillPage({
  image,
  alt,
  marks = [],
  focus,
  visibleAspect,
  sweeping = false,
  children,
}: {
  image: string;
  alt: string;
  marks?: Mark[];
  focus?: ReadonlySet<string>;
  visibleAspect?: string;
  sweeping?: boolean;
  children?: ReactNode;
}) {
  return (
    <div className="paper relative overflow-hidden rounded-[6px] bg-white" style={visibleAspect ? { aspectRatio: visibleAspect } : undefined}>
      <div className="relative">
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
              className={`absolute transition-opacity duration-200 ${TONE_CLASS[mark.tone]} ${dimmed ? "opacity-25" : ""}`}
              style={{ left: `${left}%`, top: `${top}%`, width: `${width}%`, height: `${height}%` }}
            >
              {mark.n !== undefined && <span className="mark-tab">{mark.n}</span>}
            </div>
          );
        })}
        {sweeping && <div aria-hidden className="sweep" />}
        {children}
      </div>
    </div>
  );
}
