// pdf.js runs its parser in a worker and loads the 14 standard PDF fonts on demand; both are served from /pdfjs.
import { cpSync, mkdirSync } from "node:fs";
import path from "node:path";

const from = path.join(process.cwd(), "node_modules", "pdfjs-dist");
const to = path.join(process.cwd(), "public", "pdfjs");
mkdirSync(to, { recursive: true });
cpSync(path.join(from, "build", "pdf.worker.min.mjs"), path.join(to, "pdf.worker.min.mjs"));
cpSync(path.join(from, "standard_fonts"), path.join(to, "standard_fonts"), { recursive: true });
