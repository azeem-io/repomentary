import type { Metadata } from "next";
import SketchHost from "@/components/SketchHost";

export const metadata: Metadata = {
  title: "Civilization — Repomentary motion sketch (real data)",
};

export default function CivilizationSketchPage() {
  return (
    <main>
      <SketchHost
        kind="civilization"
        title="CIVILIZATION · REAL DATA"
        hint="hover: inspect · click a city: build · ⚙ tuning"
      />
    </main>
  );
}
