import type { Metadata } from "next";
import SketchHost from "@/components/SketchHost";

export const metadata: Metadata = {
  title: "Layout stress test · Repomentary motion sketch",
};

export default function LayoutTestPage() {
  return (
    <main>
      <SketchHost
        kind="layout"
        title="LAYOUT STRESS TEST"
        hint="click: impulse · L: toggle links · ?n=20000"
      />
    </main>
  );
}
