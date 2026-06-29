import type { Metadata } from "next";
import SketchHost from "@/components/SketchHost";

export const metadata: Metadata = {
  title: "Language Tide · Repomentary motion sketch (real data)",
};

export default function TideSketchPage() {
  return (
    <main>
      <SketchHost
        kind="tide"
        title="LANGUAGE TIDE · REAL DATA"
        hint="space: pause · ↑/↓: speed · T: labels · scrub the timeline"
      />
    </main>
  );
}
