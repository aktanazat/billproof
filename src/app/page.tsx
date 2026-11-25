import samples from "../../public/samples/index.json";
import { Checker } from "./checker";

export default function Home() {
  return (
    <main className="flex min-h-full flex-col">
      <header className="mx-auto flex w-full max-w-[1180px] items-center justify-between px-6 pt-6">
        <p className="text-[19px] font-semibold tracking-[-0.02em]">
          Bill<span className="wordmark-mark">proof</span>
        </p>
        <a href="https://github.com/aktanazat/billproof" className="text-[14px] text-ink-2 hover:text-ink">
          Source
        </a>
      </header>
      <Checker samples={samples} />
    </main>
  );
}
