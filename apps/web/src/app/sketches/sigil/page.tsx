import type { Metadata } from "next";
import SketchHost from "@/components/SketchHost";

export const metadata: Metadata = {
  title: "Sigil · Repomentary motion sketch (real data)",
};

export default function SigilSketchPage() {
  return (
    <main>
      <SketchHost
        kind="sigil"
        title="SIGIL · REAL DATA"
        hint="space: pause · ↑/↓: speed · scrub the timeline"
      />
    </main>
  );
}
