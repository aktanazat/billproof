import type { Metadata, Viewport } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Billproof — check a bill against the offer",
  description:
    "Check a phone, internet or utility bill against the offer email, a screenshot or a recording of the sales call. Billproof finds charges above the promise and writes the message.",
};

export const viewport: Viewport = { themeColor: "#ffffff", colorScheme: "light" };

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className="h-full">
      <body className="min-h-full">{children}</body>
    </html>
  );
}
