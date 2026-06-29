import type { Metadata } from "next";
import SketchHost from "@/components/SketchHost";

export const metadata: Metadata = {
  title: "Flow · Repomentary motion sketch (real data)",
};

export default function FlowSketchPage() {
  return (
    <main>
      <SketchHost
        kind="flow"
        title="FLOW · REAL DATA"
        hint="space: pause · ↑/↓: speed · scrub the timeline"
      />
    </main>
  );
}
