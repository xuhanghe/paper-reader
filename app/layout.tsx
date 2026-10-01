import type { Metadata } from "next";
import { Geist, Geist_Mono, Lora } from "next/font/google";
import "highlight.js/styles/github-dark.css";
import "katex/dist/katex.min.css";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

const lora = Lora({
  variable: "--font-lora",
  subsets: ["latin"],
  style: ["normal", "italic"],
});

export const metadata: Metadata = {
  title: "Paper Reader",
  description: "Sensemaking assistant for academic papers",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    // Browser extensions stamp attributes on <html> before React hydrates —
    // the Zotero Connector adds data-zotero-connector-injected — and React
    // would report the page as mismatched for it. The attributes on this one
    // element are left unchecked; everything inside is still verified.
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} ${lora.variable} h-full antialiased`}
      suppressHydrationWarning
    >
      <body className="h-full flex flex-col overflow-hidden">{children}</body>
    </html>
  );
}
