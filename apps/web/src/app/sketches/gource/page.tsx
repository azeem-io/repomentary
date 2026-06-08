import type { Metadata } from "next";
import SketchHost from "@/components/SketchHost";

export const metadata: Metadata = {
  title: "Gource · Repomentary motion sketch (real data)",
};

export default function GourceSketchPage() {
  return (
    <main>
      <SketchHost
        kind="gource"
        title="GOURCE · REAL DATA"
        hint="space: pause · ↑/↓: speed · T: labels · hover: inspect"
      />
    </main>
  );
}
