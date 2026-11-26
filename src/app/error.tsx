"use client";

import Link from "next/link";
import { useEffect } from "react";
import { SiteHeader } from "./site-header";

// Anything that breaks while a page shows (an unusual bill, a lost connection mid-render) lands here instead of the
// framework's blank "Application error", with a way to try again or start over.
export default function PageError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    console.error(error);
  }, [error]);
  // The page already has a title; a second one would be invalid, so its text is swapped while this shows.
  useEffect(() => {
    const before = document.title;
    document.title = "Something went wrong — Billproof";
    return () => {
      document.title = before;
    };
  }, []);
  return (
    <main className="flex min-h-full flex-col">
      <SiteHeader current={null} />
      <section className="mx-auto flex w-full max-w-[1120px] flex-col items-start gap-3 px-6 pt-16">
        <h1 className="text-[28px] font-semibold tracking-[-0.02em]">Something went wrong showing this page</h1>
        <p className="text-[17px] text-text-2">Try again, or start a new check.</p>
        <div className="mt-2 flex gap-2">
          <button type="button" onClick={reset} className="inline-flex h-9 items-center rounded-lg bg-text px-4 text-[15px] font-medium text-white hover:bg-black">
            Try again
          </button>
          <Link href="/" className="inline-flex h-9 items-center rounded-lg bg-fill px-4 text-[15px] hover:bg-fill-2">
            Check a bill
          </Link>
        </div>
      </section>
    </main>
  );
}
