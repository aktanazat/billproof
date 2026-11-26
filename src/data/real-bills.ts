import "server-only";
import { realRunSchema } from "@/lib/real-bills";
import data from "./real-bills.json";

// Written by `pnpm census`; parsed once so a malformed run fails the build instead of a page.
export const realRun = realRunSchema.parse(data);
