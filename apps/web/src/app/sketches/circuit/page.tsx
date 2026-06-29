import type { Metadata } from "next";
import SketchHost from "@/components/SketchHost";

export const metadata: Metadata = {
  title: "Circuit · Repomentary motion sketch (real data)",
};

export default function CircuitSketchPage() {
  return (
    <main>
      <SketchHost
        kind="circuit"
        title="CIRCUIT · REAL DATA"
        hint="space: pause · ↑/↓: speed · T: labels · scrub the timeline"
      />
    </main>
  );
}
