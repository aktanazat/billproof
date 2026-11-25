import samples from "../../public/samples/index.json";
import { Checker } from "./checker";

export default function Home() {
  return (
    <main className="flex min-h-full flex-col">
      <header className="px-6 pt-5">
        <p className="text-[15px] font-semibold tracking-[-0.01em]">Billproof</p>
      </header>
      <Checker samples={samples} />
    </main>
  );
}
