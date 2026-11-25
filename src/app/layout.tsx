import type { Metadata, Viewport } from "next";
import { Instrument_Serif } from "next/font/google";
import "./globals.css";

const serif = Instrument_Serif({ weight: "400", style: ["normal", "italic"], subsets: ["latin"], variable: "--font-instrument" });

export const metadata: Metadata = {
  title: "Billproof — put your bill on the stand",
  description:
    "Set a phone, internet or utility bill against what you were promised, even a recording of the sales call. Muse Ember marks every charge that breaks it and writes the message that gets the money back.",
};

export const viewport: Viewport = { themeColor: "#ecebe6", colorScheme: "light" };

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className={`h-full ${serif.variable}`}>
      <body className="min-h-full">{children}</body>
    </html>
  );
}
