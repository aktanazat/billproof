import type { Metadata, Viewport } from "next";
import "./globals.css";

const description =
  "Check a phone, internet or utility bill against the offer email, a screenshot or a recording of the sales call. Billproof finds charges above the promise and writes the message.";

// A shared link shows a card: the title, description and the generated picture, under the site's own address.
export const metadata: Metadata = {
  metadataBase: new URL("https://billproof.aktan.us"),
  title: "Billproof — check a bill against the offer",
  description,
  openGraph: { siteName: "Billproof", type: "website", title: "Billproof — check a bill against the offer", description },
  twitter: { card: "summary_large_image" },
};

export const viewport: Viewport = { themeColor: "#ffffff", colorScheme: "light" };

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className="h-full">
      <body className="min-h-full">{children}</body>
    </html>
  );
}
