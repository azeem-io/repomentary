import type { Metadata } from "next";
import SketchHost from "@/components/SketchHost";

export const metadata: Metadata = {
  title: "Pulse · Repomentary motion sketch (real data)",
};

export default function PulseSketchPage() {
  return (
    <main>
      <SketchHost
        kind="pulse"
        title="PULSE · REAL DATA"
        hint="space: pause · ↑/↓: speed · T: labels · scrub the timeline"
      />
    </main>
  );
}
