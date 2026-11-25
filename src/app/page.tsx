import { z } from "zod";
import data from "../../public/samples/index.json";
import { Checker } from "./checker";

const samples = z
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

export default function Home() {
  return (
    <main className="flex min-h-full flex-col">
      <header className="mx-auto flex w-full max-w-[1240px] items-baseline justify-between px-6 pt-6">
        <p className="display text-[26px] leading-none">
          Billproof<span className="text-vermilion">.</span>
        </p>
        <a href="https://github.com/aktanazat/billproof" className="text-[13px] text-ink-2 underline-offset-4 hover:text-ink hover:underline">
          Source
        </a>
      </header>
      <Checker samples={samples} />
    </main>
  );
}
