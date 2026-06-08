import type { Metadata } from "next";
import SketchHost from "@/components/SketchHost";

export const metadata: Metadata = {
  title: "City · Repomentary motion sketch",
};

export default function CitySketchPage() {
  return (
    <main>
      <SketchHost
        kind="city"
        title="CITY"
        hint="hover: inspect · T: labels · click a district: build · space: top out a crane"
      />
    </main>
  );
}
