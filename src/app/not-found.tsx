import Link from "next/link";
import { SiteHeader } from "./site-header";

// A mistyped address or an old link lands here, in the site's own look, with the two ways back.
export default function NotFound() {
  return (
    <main className="flex min-h-full flex-col">
      <SiteHeader current={null} />
      <section className="mx-auto flex w-full max-w-[1120px] flex-col items-start gap-3 px-6 pt-16">
        <h1 className="text-[28px] font-semibold tracking-[-0.02em]">This page doesn&apos;t exist</h1>
        <p className="text-[17px] text-text-2">The address may be mistyped, or the page has moved.</p>
        <div className="mt-2 flex gap-2">
          <Link href="/" className="inline-flex h-9 items-center rounded-lg bg-text px-4 text-[15px] font-medium text-white hover:bg-black">
            Check a bill
          </Link>
          <Link href="/real" className="inline-flex h-9 items-center rounded-lg bg-fill px-4 text-[15px] hover:bg-fill-2">
            See the real bills
          </Link>
        </div>
      </section>
    </main>
  );
}
