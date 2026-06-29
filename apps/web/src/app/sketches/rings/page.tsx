import type { Metadata } from "next";
import SketchHost from "@/components/SketchHost";

export const metadata: Metadata = {
  title: "Rings · Repomentary motion sketch (real data)",
};

export default function RingsSketchPage() {
  return (
    <main>
      <SketchHost
        kind="rings"
        title="RINGS · REAL DATA"
        hint="space: pause · ↑/↓: speed · scrub the timeline"
      />
    </main>
  );
}
