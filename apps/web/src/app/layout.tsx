import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import "@fontsource-variable/bricolage-grotesque";
import "@fontsource/instrument-serif";
import "@fontsource/instrument-serif/400-italic.css";
import "@fontsource/ibm-plex-mono/400.css";
import "@fontsource/ibm-plex-mono/500.css";
import "@fontsource/ibm-plex-mono/600.css";
import { PageTransitionProvider } from "@/components/PageTransition";
import { TooltipProvider } from "@/components/ui/tooltip";
import "./globals.css";

export const metadata: Metadata = {
  title: "Repomentary",
  description:
    "Repomentary plays a GitHub repository's history back as a film you can scrub through in the browser. In development.",
};

export const viewport: Viewport = {
  themeColor: "#05070e",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className="dark">
      <body className="min-h-dvh bg-void text-star antialiased">
        <TooltipProvider delayDuration={150} skipDelayDuration={300}>
          <PageTransitionProvider>{children}</PageTransitionProvider>
        </TooltipProvider>
      </body>
    </html>
  );
}
