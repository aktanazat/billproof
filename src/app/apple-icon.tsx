import { ImageResponse } from "next/og";

// The icon an iPhone shows for a home-screen shortcut or bookmark, the tab icon's "B" at Apple's size; iOS rounds
// the corners itself, so the square is left square.
export const size = { width: 180, height: 180 };
export const contentType = "image/png";

export default function AppleIcon() {
  return new ImageResponse(
    (
      <div style={{ width: "100%", height: "100%", display: "flex", alignItems: "center", justifyContent: "center", background: "#1d1d1f", color: "#ffffff", fontSize: 120, fontWeight: 600, fontFamily: "sans-serif" }}>B</div>
    ),
    size,
  );
}
