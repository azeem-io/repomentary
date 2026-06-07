"use client";

import { useEffect, useState } from "react";
import { getDatasetId, REPO_DATASETS, setDatasetId } from "@/lib/realHistory";

interface Props {
  /** Called after the new selection has been persisted. */
  onPick?: (id: string) => void;
}

/**
 * The repo switcher, the same control on the homepage and on every sketch
 * page. Selection persists in localStorage so it follows you across pages.
 */
export default function DatasetPicker({ onPick }: Props) {
  // Read localStorage only after mount, the server must not guess.
  const [dataset, setDataset] = useState<string | null>(null);
  useEffect(() => {
    setDataset(getDatasetId());
  }, []);

  if (dataset === null) {
    return <div aria-hidden className="h-[26px] w-36 rounded-md bg-black/20" />;
  }
  return (
    <select
      value={dataset}
      onChange={(e) => {
        const id = e.target.value;
        setDatasetId(id);
        setDataset(id);
        onPick?.(id);
      }}
      title={REPO_DATASETS.find((d) => d.id === dataset)?.hint}
      aria-label="repository dataset"
      className="pointer-events-auto cursor-pointer rounded-md border-0 bg-black/30 px-2.5 py-1.5 font-mono text-xs text-star/80 backdrop-blur transition-colors [color-scheme:dark] hover:text-star focus:outline-none"
    >
      {REPO_DATASETS.map((d) => (
        <option key={d.id} value={d.id} className="bg-deep text-star">
          {d.label}
        </option>
      ))}
    </select>
  );
}
