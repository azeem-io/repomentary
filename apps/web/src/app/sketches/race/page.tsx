import type { Metadata } from "next";
import SketchHost from "@/components/SketchHost";

export const metadata: Metadata = {
  title: "Race · Repomentary motion sketch (real data)",
};

export default function RaceSketchPage() {
  return (
    <main>
      <SketchHost
        kind="race"
        title="RACE · REAL DATA"
        hint="hover: details · ⚙ tuning for bars & streamgraph"
      />
    </main>
  );
}
