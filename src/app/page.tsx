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
      <header className="mx-auto flex h-14 w-full max-w-[1120px] items-center justify-between px-6">
        <p className="text-[17px] font-semibold tracking-[-0.01em]">Billproof</p>
        <a href="https://github.com/aktanazat/billproof" className="text-[15px] text-text-2 hover:text-text">
          Source
        </a>
      </header>
      <Checker samples={samples} />
    </main>
  );
}
