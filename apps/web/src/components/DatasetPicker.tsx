"use client";

import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { REPO_DATASETS, setDatasetId } from "@/lib/realHistory";
import { useDatasetId } from "@/lib/useDataset";

interface Props {
  /** Called after the new selection has been persisted. */
  onPick?: (id: string) => void;
}

/** The repo switcher. Selection persists and is shared across the page. */
export default function DatasetPicker({ onPick }: Props) {
  const dataset = useDatasetId();

  if (dataset === null) {
    return <div aria-hidden className="h-8 w-36 rounded-md bg-deep" />;
  }
  return (
    <Select
      value={dataset}
      onValueChange={(id) => {
        setDatasetId(id);
        onPick?.(id);
      }}
    >
      <SelectTrigger
        size="sm"
        aria-label="repository dataset"
        className="pointer-events-auto w-fit gap-2 border-star/15 bg-void/60 font-mono text-[11px] text-dim backdrop-blur hover:border-star/40 hover:text-star focus-visible:ring-amber/40"
      >
        <SelectValue />
      </SelectTrigger>
      <SelectContent
        position="popper"
        align="start"
        sideOffset={6}
        className="border-star/15 bg-raised"
      >
        {REPO_DATASETS.map((d) => (
          <SelectItem
            key={d.id}
            value={d.id}
            className="font-mono text-xs text-dim focus:bg-amber/15 focus:text-star data-[state=checked]:text-amber"
          >
            {d.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
