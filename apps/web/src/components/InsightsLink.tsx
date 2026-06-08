"use client";

import { TransitionLink } from "@/components/PageTransition";
import { useDatasetId } from "@/lib/useDataset";

/** Homepage link into the full per-repo insights page. */
export default function InsightsLink() {
  const id = useDatasetId() ?? "vite";
  return (
    <div className="mt-8 flex justify-center">
      <TransitionLink
        href={`/insights/${id}`}
        direction="forward"
        className="rounded-md border border-star/15 px-4 py-2 font-mono text-[11px] tracking-[0.16em] text-dim uppercase transition-colors hover:border-amber/50 hover:text-amber"
      >
        full insights →
      </TransitionLink>
    </div>
  );
}
