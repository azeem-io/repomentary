import type { Metadata } from "next";
import SketchHost from "@/components/SketchHost";

export const metadata: Metadata = {
  title: "Tide · Repomentary motion sketch (real data)",
};

export default function TideSketchPage() {
  return (
    <main>
      <SketchHost
        kind="tide"
        title="TIDE · REAL DATA"
        hint="space: pause · ↑/↓: speed · T: labels · scrub the timeline"
      />
    </main>
  );
}
