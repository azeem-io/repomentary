import type { Metadata } from "next";
import SketchHost from "@/components/SketchHost";

export const metadata: Metadata = {
  title: "Rain — Repomentary motion sketch",
};

export default function RainSketchPage() {
  return (
    <main>
      <SketchHost
        kind="rain"
        title="RAIN"
        hint="sit back — or click: drop a commit · space: merge splash"
      />
    </main>
  );
}
