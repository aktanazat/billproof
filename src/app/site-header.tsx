import Link from "next/link";

export function SiteHeader({ current }: { current: "check" | "real" | null }) {
  // 44 px tall within the 56 px header, so a thumb finds them; the text doesn't move.
  const link = (active: boolean) => `inline-flex h-11 items-center whitespace-nowrap text-[15px] ${active ? "text-text" : "text-text-2 hover:text-text"}`;
  return (
    // The links drop below the name when there's no room beside it (a phone zoomed in), rather than run into it.
    <header className="mx-auto flex min-h-14 w-full max-w-[1120px] flex-wrap items-center justify-between gap-x-6 px-6">
      <Link href="/" className="text-[17px] font-semibold tracking-[-0.01em]">
        Billproof
      </Link>
      <nav className="flex items-center gap-6">
        <Link href="/real" className={link(current === "real")} aria-current={current === "real" ? "page" : undefined}>
          Real bills
        </Link>
        <a href="https://github.com/aktanazat/billproof" className={link(false)}>
          Source
        </a>
      </nav>
    </header>
  );
}
