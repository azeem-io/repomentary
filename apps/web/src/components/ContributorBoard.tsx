"use client";

import { useEffect, useState } from "react";
import { SimpleTooltip } from "@/components/ui/tooltip";
import { getDatasetId, loadSharedRealHistory } from "@/lib/realHistory";
import { useDatasetId } from "@/lib/useDataset";

interface Row {
  name: string;
  commits: number;
  share: number;
}

const boxLabel = "font-mono text-[10px] tracking-[0.16em] text-faint uppercase";

/** Full contributor leaderboard (more than the homepage top 3). */
export default function ContributorBoard({ datasetId }: { datasetId?: string }) {
  const ctxId = useDatasetId();
  const id = datasetId ?? ctxId;
  const [rows, setRows] = useState<Row[] | null>(null);
  const [total, setTotal] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setRows(null);
    loadSharedRealHistory(id ?? getDatasetId()).then((real) => {
      if (cancelled) return;
      const tally = new Map<number, number>();
      for (const c of real.commits) tally.set(c.author, (tally.get(c.author) ?? 0) + 1);
      const sum = real.commits.length;
      const top = [...tally.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 15)
        .map(([idx, n]) => ({ name: real.authors[idx] ?? "·", commits: n, share: n / sum }));
      setTotal(tally.size);
      setRows(top);
    });
    return () => {
      cancelled = true;
    };
  }, [id]);

  const max = rows?.[0]?.commits ?? 1;

  return (
    <section className="border-t border-star/10 py-14">
      <div className="flex items-baseline justify-between">
        <h2 className={boxLabel}>contributors</h2>
        <p className="font-mono text-[11px] tracking-[0.18em] text-dim">
          {total ? `${total.toLocaleString()} total · top 15` : ""}
        </p>
      </div>

      <ol className="mt-6 grid gap-x-10 gap-y-3 sm:grid-cols-2">
        {(rows ?? Array.from({ length: 8 }, () => null)).map((r, i) => (
          <li key={r?.name ?? i} className="flex items-center gap-3">
            <span className="w-5 shrink-0 text-right font-mono text-[11px] text-faint">
              {i + 1}
            </span>
            <SimpleTooltip content={r?.name ?? ""}>
              <span className="w-36 shrink-0 truncate font-mono text-xs text-star">
                {r?.name ?? "…"}
              </span>
            </SimpleTooltip>
            <span className="h-1.5 flex-1 overflow-hidden rounded-full bg-star/10">
              <span
                className="block h-full rounded-full bg-amber/70"
                style={{ width: r ? `${Math.round((r.commits / max) * 100)}%` : "0%" }}
              />
            </span>
            <span className="w-12 shrink-0 text-right font-mono text-[11px] text-dim">
              {r ? r.commits.toLocaleString() : ""}
            </span>
          </li>
        ))}
      </ol>
    </section>
  );
}
