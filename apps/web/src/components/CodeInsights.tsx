"use client";

import { useEffect, useState } from "react";
import { SimpleTooltip } from "@/components/ui/tooltip";
import type { RealHistory } from "@/lib/realHistory";
import { getDatasetId, loadSharedRealHistory } from "@/lib/realHistory";
import { useDatasetId } from "@/lib/useDataset";

interface FileHot {
  path: string;
  short: string;
  changes: number;
}

interface Owned {
  module: string;
  owner: string;
  share: number;
  changes: number;
}

interface CodeMap {
  hotspots: FileHot[];
  hotMax: number;
  ownership: Owned[];
}

/** Group a file path into a module: two segments deep for monorepos, one
 *  otherwise. "packages/react-dom/src/x.js" -> "packages/react-dom". */
function moduleOf(path: string): string {
  const seg = path.split("/");
  if (seg.length >= 3) return `${seg[0]}/${seg[1]}`;
  if (seg.length === 2) return seg[0] as string;
  return "(root)";
}

function shortenPath(path: string): string {
  const seg = path.split("/");
  return seg.length <= 2 ? path : `…/${seg.slice(-2).join("/")}`;
}

function compute(real: RealHistory): CodeMap {
  const fileChurn = new Map<number, number>();
  const modTotal = new Map<string, number>();
  const modAuthor = new Map<string, Map<number, number>>();

  for (const c of real.commits) {
    for (const [, pathIdx] of c.changes) {
      fileChurn.set(pathIdx, (fileChurn.get(pathIdx) ?? 0) + 1);
      const path = real.paths[pathIdx];
      if (!path) continue;
      const mod = moduleOf(path);
      modTotal.set(mod, (modTotal.get(mod) ?? 0) + 1);
      let am = modAuthor.get(mod);
      if (!am) {
        am = new Map();
        modAuthor.set(mod, am);
      }
      am.set(c.author, (am.get(c.author) ?? 0) + 1);
    }
  }

  const hotspots: FileHot[] = [...fileChurn.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 6)
    .map(([idx, changes]) => {
      const path = real.paths[idx] ?? "";
      return { path, short: shortenPath(path), changes };
    });
  const hotMax = hotspots[0]?.changes ?? 1;

  const ownership: Owned[] = [...modTotal.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 6)
    .map(([module, total]) => {
      const top = [...(modAuthor.get(module)?.entries() ?? [])].sort((a, b) => b[1] - a[1])[0] ?? [
        0, 0,
      ];
      return {
        module,
        owner: real.authors[top[0]] ?? "·",
        share: total ? top[1] / total : 0,
        changes: total,
      };
    });

  return { hotspots, hotMax, ownership };
}

const boxClass = "rounded-xl border border-star/10 bg-deep/40 p-5";
const boxLabel = "font-mono text-[10px] tracking-[0.16em] text-faint uppercase";

export default function CodeInsights({ datasetId }: { datasetId?: string }) {
  const ctxId = useDatasetId();
  const id = datasetId ?? ctxId;
  const [map, setMap] = useState<CodeMap | null>(null);

  useEffect(() => {
    let cancelled = false;
    setMap(null);
    loadSharedRealHistory(id ?? getDatasetId())
      .then((real) => {
        if (!cancelled) setMap(compute(real));
      })
      .catch(() => {
        if (!cancelled) setMap(null);
      });
    return () => {
      cancelled = true;
    };
  }, [id]);

  return (
    <section className="border-t border-star/10 py-14">
      <h2 className={boxLabel}>the code map</h2>

      <div className="mt-8 grid gap-4 lg:grid-cols-2">
        <div className={boxClass}>
          <p className={boxLabel}>hotspots · most-changed files</p>
          <ol className="mt-3 space-y-2.5">
            {(map?.hotspots ?? []).map((f) => (
              <li key={f.path} className="flex items-center gap-3">
                <SimpleTooltip content={f.path}>
                  <span className="min-w-0 flex-1 truncate font-mono text-xs text-star">
                    {f.short}
                  </span>
                </SimpleTooltip>
                <span className="hidden h-1.5 w-24 overflow-hidden rounded-full bg-star/10 sm:block">
                  <span
                    className="block h-full rounded-full bg-amber/70"
                    style={{ width: `${Math.round((f.changes / map!.hotMax) * 100)}%` }}
                  />
                </span>
                <span className="w-12 shrink-0 text-right font-mono text-[11px] text-dim">
                  {f.changes.toLocaleString()}
                </span>
              </li>
            ))}
            {!map && <li className="font-mono text-xs text-faint">reading file history…</li>}
          </ol>
        </div>

        <div className={boxClass}>
          <p className={boxLabel}>knowledge map · who owns what</p>
          <ol className="mt-3 space-y-2.5">
            {(map?.ownership ?? []).map((m) => (
              <li key={m.module} className="flex items-center gap-3">
                <SimpleTooltip content={m.module}>
                  <span className="w-32 shrink-0 truncate font-mono text-xs text-star">
                    {m.module}
                  </span>
                </SimpleTooltip>
                <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-dim">
                  {m.owner}
                </span>
                <SimpleTooltip
                  content={m.share >= 0.6 ? "concentrated, bus-factor risk" : "shared evenly"}
                >
                  <span
                    className={`shrink-0 rounded px-1.5 py-0.5 font-mono text-[10px] ${
                      m.share >= 0.6 ? "bg-amber/20 text-amber" : "bg-star/10 text-dim"
                    }`}
                  >
                    {Math.round(m.share * 100)}%
                  </span>
                </SimpleTooltip>
              </li>
            ))}
            {!map && <li className="font-mono text-xs text-faint">mapping ownership…</li>}
          </ol>
        </div>
      </div>
      <p className="mt-3 font-mono text-[10px] tracking-[0.14em] text-faint uppercase">
        amber ownership = one person wrote 60%+ of that module
      </p>
    </section>
  );
}
