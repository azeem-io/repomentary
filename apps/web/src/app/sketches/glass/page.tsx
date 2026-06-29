import type { Metadata } from "next";
import SketchHost from "@/components/SketchHost";

export const metadata: Metadata = {
  title: "Stained Glass · Repomentary motion sketch (real data)",
};

export default function GlassSketchPage() {
  return (
    <main>
      <SketchHost
        kind="glass"
        title="STAINED GLASS · REAL DATA"
        hint="space: pause · ↑/↓: speed · scrub the timeline"
      />
    </main>
  );
}
