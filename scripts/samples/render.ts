import PDFDocument from "pdfkit";
import type { BillSpec, Line, Section } from "./specs";

const SECTION_TITLES: Record<Section, string> = {
  service: "Service charges",
  equipment: "Equipment",
  fees: "Other charges",
  credits: "Credits and discounts",
  taxes: "Taxes, surcharges and fees",
};
const SECTION_ORDER: Section[] = ["service", "equipment", "fees", "credits", "taxes"];

const usd = (cents: number) => {
  const sign = cents < 0 ? "-" : "";
  return `${sign}$${(Math.abs(cents) / 100).toFixed(2)}`;
};

const shortDate = (iso: string) => {
  const [y, m, d] = iso.split("-");
  return `${m}/${d}/${y}`;
};

export function currentCharges(spec: BillSpec): number {
  return spec.lines.reduce((sum, line) => sum + line.cents, 0);
}

export function renderBillPdf(spec: BillSpec): Promise<Buffer> {
  const doc = new PDFDocument({ size: "LETTER", margin: 54, info: { Title: `${spec.provider.name} statement` } });
  const chunks: Buffer[] = [];
  doc.on("data", (chunk: Buffer) => chunks.push(chunk));
  const { promise: done, resolve } = Promise.withResolvers<Buffer>();
  doc.on("end", () => resolve(Buffer.concat(chunks)));

  const left = 54;
  const right = 558;
  const ink = "#1d1d1f";
  const muted = "#5f6368";

  doc.fillColor(ink).font("Helvetica-Bold").fontSize(20).text(spec.provider.name, left, 54);
  doc.font("Helvetica").fontSize(9).fillColor(muted).text(spec.provider.address, left, 80);
  doc.text(`${spec.provider.phone}  |  ${spec.provider.web}`, left, 92);

  doc.fillColor(ink).font("Helvetica-Bold").fontSize(11).text("Monthly statement", 360, 54, { width: right - 360, align: "right" });
  doc.font("Helvetica").fontSize(9);
  const meta: [string, string][] = [
    ["Account number", spec.account],
    ["Statement date", shortDate(spec.statementDate)],
    ["Service period", `${shortDate(spec.period.start)} - ${shortDate(spec.period.end)}`],
    ["Payment due", shortDate(spec.dueDate)],
  ];
  meta.forEach(([k, v], i) => {
    doc.fillColor(muted).text(k, 360, 72 + i * 13, { width: 100 });
    doc.fillColor(ink).text(v, 440, 72 + i * 13, { width: right - 440, align: "right" });
  });

  doc.fillColor(ink).font("Helvetica-Bold").fontSize(10).text(spec.customer.name, left, 140);
  doc.font("Helvetica").fontSize(9).text(spec.customer.address, left, 154);

  const current = currentCharges(spec);
  const totalDue = spec.previousBalanceCents - spec.paymentCents + current;
  let y = 190;
  doc.rect(left, y, right - left, 92).fill("#f3f4f6");
  doc.fillColor(ink).font("Helvetica-Bold").fontSize(11).text("Account summary", left + 14, y + 12);
  const summary: [string, number][] = [
    ["Previous balance", spec.previousBalanceCents],
    ["Payment received - thank you", -spec.paymentCents],
    ["Current charges", current],
  ];
  doc.font("Helvetica").fontSize(9.5);
  summary.forEach(([k, v], i) => {
    doc.fillColor(ink).text(k, left + 14, y + 32 + i * 14);
    doc.text(usd(v), 200, y + 32 + i * 14, { width: 90, align: "right" });
  });
  doc.font("Helvetica-Bold").fontSize(11).text("Total amount due", 330, y + 32);
  doc.fontSize(18).text(usd(totalDue), 330, y + 48, { width: right - 344, align: "right" });
  doc.font("Helvetica").fontSize(9).fillColor(muted).text(`Due by ${shortDate(spec.dueDate)}`, 330, y + 72, {
    width: right - 344,
    align: "right",
  });

  y += 116;
  doc.fillColor(ink).font("Helvetica-Bold").fontSize(12).text("Current charges detail", left, y);
  y += 22;

  const bySection = new Map<Section, Line[]>();
  for (const line of spec.lines) bySection.set(line.section, [...(bySection.get(line.section) ?? []), line]);

  for (const section of SECTION_ORDER) {
    const lines = bySection.get(section);
    if (!lines) continue;
    doc.fillColor(muted).font("Helvetica-Bold").fontSize(9).text(SECTION_TITLES[section], left, y);
    y += 15;
    doc.font("Helvetica").fontSize(9.5).fillColor(ink);
    for (const line of lines) {
      doc.text(line.label, left + 10, y, { width: 300 });
      if (line.detail) doc.fillColor(muted).text(line.detail, 330, y, { width: 120 }).fillColor(ink);
      doc.text(usd(line.cents), right - 100, y, { width: 100, align: "right" });
      y += 15;
    }
    y += 8;
  }

  doc.moveTo(left, y).lineTo(right, y).lineWidth(0.5).strokeColor("#c7c7cc").stroke();
  y += 8;
  doc.font("Helvetica-Bold").fontSize(10).text("Total current charges", left, y);
  doc.text(usd(current), right - 100, y, { width: 100, align: "right" });
  y += 30;

  if (spec.notices.length > 0) {
    doc.fillColor(ink).font("Helvetica-Bold").fontSize(10).text("Important information", left, y);
    y += 15;
    doc.font("Helvetica").fontSize(9).fillColor(ink);
    for (const notice of spec.notices) {
      doc.text(notice, left, y, { width: right - left });
      y = doc.y + 6;
    }
  }

  doc.end();
  return done;
}
