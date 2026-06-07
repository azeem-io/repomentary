import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import "./globals.css";

export const metadata: Metadata = {
  title: "Repomentary",
  description:
    "Repomentary plays a GitHub repository's history back as a film you can scrub through in the browser. In development.",
};

export const viewport: Viewport = {
  themeColor: "#07091a",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className="dark">
      <body className="min-h-dvh bg-void text-star antialiased">{children}</body>
    </html>
  );
}
