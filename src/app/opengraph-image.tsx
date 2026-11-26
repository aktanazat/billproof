import { ImageResponse } from "next/og";
import { realRun } from "@/data/real-bills";
import { usd } from "@/lib/letter";
import { unagreedFees } from "@/lib/real-bills";

// The picture a shared link shows, with the real-bills figures read from the saved run so they can't drift.
export const alt = "Billproof: check a bill against what you were promised";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

export default function OpenGraphImage() {
  const bills = realRun.results.filter((bill) => bill.outcome === "checked");
  const feeCents = bills.flatMap(unagreedFees).reduce((t, fee) => t + fee.cents, 0);
  return new ImageResponse(
    (
      <div style={{ width: "100%", height: "100%", display: "flex", flexDirection: "column", justifyContent: "space-between", padding: 72, background: "#ffffff", color: "#1d1d1f", fontFamily: "sans-serif" }}>
        <div style={{ fontSize: 36, fontWeight: 600 }}>Billproof</div>
        <div style={{ display: "flex", flexDirection: "column", gap: 24 }}>
          <div style={{ fontSize: 76, fontWeight: 700, lineHeight: 1.05, letterSpacing: -2 }}>Check a bill against what you were promised</div>
          <div style={{ fontSize: 32, color: "#6e6e73" }}>
            {`${bills.length} real bills checked · ${usd(feeCents)} a month in fees nobody agreed to · read by Meta's Muse Ember`}
          </div>
        </div>
      </div>
    ),
    size,
  );
}
