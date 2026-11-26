import Link from "next/link";
import { connection } from "next/server";
import { Suspense } from "react";
import { z } from "zod";
import { realRun } from "@/data/real-bills";
import { usd } from "@/lib/letter";
import { postNotes, unagreedFees, type RealBill } from "@/lib/real-bills";
import { livePaused } from "@/lib/server-ledger";
import data from "../../public/samples/index.json";
import { Checker, type Sample } from "./checker";
import { SiteHeader } from "./site-header";

const samples: Sample[] = z
  .array(
    z.object({
      id: z.string(),
      title: z.string(),
      outcome: z.string(),
      image: z.string(),
      bills: z.array(z.string()).min(1),
      offer: z.discriminatedUnion("kind", [z.object({ kind: z.literal("text"), text: z.string() }), z.object({ kind: z.literal("call"), url: z.string() })]),
    }),
  )
  .parse(data);

function sampleOf(post: RealBill, outcome: string): Sample {
  return {
    id: post.id,
    title: post.title,
    outcome,
    image: `/api/real-image/${post.id}/${post.outcome === "checked" ? (post.billPages[0] ?? 0) : 0}`,
    bills: [],
    pictures: post.images.map((_, n) => `/api/real-image/${post.id}/${n}`),
    offer: { kind: "text", text: postNotes(post) },
  };
}

// A real post opened from the real-bills page: its pictures as one pile, its words as what was promised.
function realSample(id: string | undefined): Sample | null {
  const post = realRun.results.find((bill) => bill.id === id);
  return post ? sampleOf(post, "") : null;
}

// The three real bills with the most in company fees the poster never mentions agreeing to.
const feeCents = (bill: RealBill) => unagreedFees(bill).reduce((t, fee) => t + fee.cents, 0);
const realSamples = [...realRun.results]
  .sort((a, b) => feeCents(b) - feeCents(a))
  .slice(0, 3)
  .filter((bill) => feeCents(bill) > 0)
  .map((bill) => sampleOf(bill, `${usd(feeCents(bill))} in fees nobody agreed to`));

// The post id is request data, so it is read inside a boundary; the plain start screen renders without it.
async function CheckerFor({ searchParams }: { searchParams: PageProps<"/">["searchParams"] }) {
  const { post } = await searchParams;
  return <Checker samples={samples} realSamples={realSamples} startWith={realSample(typeof post === "string" ? post : undefined)} />;
}

// Once the demo's budget can't cover one more check, the page says so before anyone tries; read on every visit.
async function LivePaused() {
  await connection();
  if (!livePaused()) return null;
  return (
    <p role="status" className="mx-auto mt-4 w-full max-w-[1120px] px-6 text-[15px]">
      Live checks are paused: this demo has used its budget. Every saved result is on the{" "}
      <Link href="/real" className="underline">
        Real bills
      </Link>{" "}
      page.
    </p>
  );
}

export default function Home({ searchParams }: PageProps<"/">) {
  return (
    <main className="flex min-h-full flex-col">
      <SiteHeader current="check" />
      <Suspense fallback={null}>
        <LivePaused />
      </Suspense>
      <Suspense fallback={<Checker samples={samples} realSamples={realSamples} startWith={null} />}>
        <CheckerFor searchParams={searchParams} />
      </Suspense>
    </main>
  );
}
