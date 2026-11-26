import { ImageResponse } from "next/og";

// The tab icon: a "B" in the site's own dark button colour, in place of the template's Next.js logo.
export const size = { width: 64, height: 64 };
export const contentType = "image/png";

export default function Icon() {
  return new ImageResponse(
    (
      <div style={{ width: "100%", height: "100%", display: "flex", alignItems: "center", justifyContent: "center", background: "#1d1d1f", borderRadius: 14, color: "#ffffff", fontSize: 44, fontWeight: 600, fontFamily: "sans-serif" }}>B</div>
    ),
    size,
  );
}
