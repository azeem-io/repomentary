import type { Metadata } from "next";
import SketchHost from "@/components/SketchHost";

export const metadata: Metadata = {
  title: "Planet — Repomentary motion sketch",
};

export default function PlanetSketchPage() {
  return (
    <main>
      <SketchHost
        kind="planet"
        title="PLANET"
        hint="hover: inspect · T: labels · click: commits / merge a branch · space: merge"
      />
    </main>
  );
}
