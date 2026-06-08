"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { SimpleTooltip } from "@/components/ui/tooltip";
import { REPO_DATASETS, setDatasetId } from "@/lib/realHistory";
import { useDatasetId } from "@/lib/useDataset";

/** Resolve free text to a bundled dataset id, if it matches one. */
function matchDataset(raw: string): string | null {
  const q = raw
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\/(www\.)?github\.com\//, "");
  if (!q) return null;
  for (const d of REPO_DATASETS) {
    if (q === d.id || q === d.label || q === d.label.split("/")[1]) return d.id;
  }
  return null;
}

/** Hero input + quick-pick chips. Bundled repos only, until ingestion lands. */
export default function HomeHero() {
  const active = useDatasetId();
  const [value, setValue] = useState("");
  const [miss, setMiss] = useState(false);

  const pick = (id: string) => {
    setDatasetId(id);
    setMiss(false);
    document.getElementById("numbers")?.scrollIntoView({ behavior: "smooth" });
  };

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const id = matchDataset(value);
    if (id) pick(id);
    else setMiss(true);
  };

  return (
    <div className="mx-auto w-full max-w-xl">
      <form onSubmit={submit} className="flex w-full">
        <Input
          type="text"
          value={value}
          onChange={(e) => {
            setValue(e.target.value);
            setMiss(false);
          }}
          placeholder="github.com/owner/repo"
          aria-label="repository URL"
          className="h-11 flex-1 rounded-r-none border-r-0 border-star/15 bg-deep px-4 font-mono text-sm text-star placeholder:text-faint focus-visible:border-amber/60 focus-visible:ring-0"
        />
        <Button
          type="submit"
          className="h-11 rounded-l-none px-5 font-mono text-xs font-semibold tracking-[0.18em] uppercase"
        >
          ▶ press play
        </Button>
      </form>

      <div className="mt-4 flex flex-wrap items-center justify-center gap-2">
        <span className="font-mono text-[10px] tracking-[0.2em] text-faint uppercase">try</span>
        {REPO_DATASETS.map((d) => {
          const on = active === d.id;
          return (
            <SimpleTooltip key={d.id} content={d.hint}>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => pick(d.id)}
                className={`h-7 rounded-full border bg-transparent px-3.5 font-mono text-xs shadow-none ${
                  on
                    ? "border-amber/70 text-amber hover:text-amber"
                    : "border-star/15 text-dim hover:border-star/40 hover:bg-transparent hover:text-star"
                }`}
              >
                {d.id}
              </Button>
            </SimpleTooltip>
          );
        })}
      </div>

      {miss && (
        <p className="mt-3 text-center font-mono text-xs text-amber-soft">
          only the bundled repos work right now, ingestion is coming
        </p>
      )}

      <p className="mt-5 text-center font-mono text-[11px] tracking-[0.22em] text-faint uppercase">
        scrub any frame · runs in the browser · free
      </p>
    </div>
  );
}
