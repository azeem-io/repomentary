"use client";

import { useEffect, useState } from "react";
import { FloatingTip } from "@/components/ui/FloatingTip";
import { SimpleTooltip } from "@/components/ui/tooltip";
import type { RealHistory } from "@/lib/realHistory";
import { getDatasetId, loadSharedRealHistory } from "@/lib/realHistory";
import { useDatasetId } from "@/lib/useDataset";

const DAY = 86400e3;
const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const HOURS = [0, 6, 12, 18];
const COMMIT_TYPES = new Set([
  "feat",
  "fix",
  "docs",
  "style",
  "refactor",
  "perf",
  "test",
  "build",
  "ci",
  "chore",
  "revert",
]);

interface Cell {
  level: number;
  count: number;
  date: string;
}
interface Patterns {
  calendar: Cell[];
  calRange: string;
  punch: number[][];
  punchMax: number;
  years: { year: number; count: number }[];
  yearMax: number;
  types: { type: string; count: number }[];
  typed: number;
}

function compute(real: RealHistory): Patterns {
  const dayCount = new Map<string, number>();
  const punch = Array.from({ length: 7 }, () => new Array<number>(24).fill(0));
  const yearMap = new Map<number, number>();
  const types = new Map<string, number>();
  let typed = 0;

  for (const c of real.commits) {
    const d = new Date(real.startMs + c.t * 1000);
    const key = d.toISOString().slice(0, 10);
    dayCount.set(key, (dayCount.get(key) ?? 0) + 1);
    const row = punch[(d.getUTCDay() + 6) % 7];
    if (row) row[d.getUTCHours()] = (row[d.getUTCHours()] ?? 0) + 1;
    yearMap.set(d.getUTCFullYear(), (yearMap.get(d.getUTCFullYear()) ?? 0) + 1);
    const m = c.subject.match(/^(\w+)(\([^)]*\))?!?:/);
    const t = m?.[1] && COMMIT_TYPES.has(m[1]) ? m[1] : null;
    if (t) {
      types.set(t, (types.get(t) ?? 0) + 1);
      typed++;
    }
  }

  // Calendar: the last 53 weeks ending on the final commit's Saturday.
  const end = real.startMs + real.spanSec * 1000;
  const endDow = new Date(end).getUTCDay();
  const lastSat = end + (6 - endDow) * DAY;
  const calendar: Cell[] = [];
  let maxDaily = 1;
  for (let i = 370; i >= 0; i--) {
    const date = new Date(lastSat - i * DAY).toISOString().slice(0, 10);
    const count = dayCount.get(date) ?? 0;
    if (count > maxDaily) maxDaily = count;
    calendar.push({ level: 0, count, date });
  }
  for (const c of calendar) {
    c.level = c.count === 0 ? 0 : Math.max(1, Math.ceil((c.count / maxDaily) * 4));
  }

  const punchMax = Math.max(1, ...punch.flat());
  const years = [...yearMap.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([year, count]) => ({ year, count }));
  const yearMax = Math.max(1, ...years.map((y) => y.count));
  const typeList = [...types.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([type, count]) => ({ type, count }));

  return {
    calendar,
    calRange: `${calendar[0]?.date.slice(0, 7)} → ${calendar[calendar.length - 1]?.date.slice(0, 7)}`,
    punch,
    punchMax,
    years,
    yearMax,
    types: typeList,
    typed,
  };
}

const CAL_LEVELS = ["bg-star/[0.06]", "bg-amber/25", "bg-amber/45", "bg-amber/70", "bg-amber"];
const boxLabel = "font-mono text-[10px] tracking-[0.16em] text-faint uppercase";
const boxClass = "rounded-xl border border-star/10 bg-deep/40 p-5";

export default function CommitPatterns({ datasetId }: { datasetId?: string }) {
  const ctxId = useDatasetId();
  const id = datasetId ?? ctxId;
  const [p, setP] = useState<Patterns | null>(null);
  type Tip = { x: number; y: number; label: string } | null;
  const [tip, setTip] = useState<Tip>(null);
  const [punchTip, setPunchTip] = useState<Tip>(null);

  const makeMove = (set: (t: Tip) => void) => (e: React.PointerEvent<HTMLDivElement>) => {
    const label = (e.target as HTMLElement).dataset.tip;
    if (!label) {
      set(null);
      return;
    }
    const r = e.currentTarget.getBoundingClientRect();
    set({
      x: Math.max(40, Math.min(r.width - 40, e.clientX - r.left)),
      y: e.clientY - r.top,
      label,
    });
  };

  useEffect(() => {
    let cancelled = false;
    setP(null);
    loadSharedRealHistory(id ?? getDatasetId()).then((real) => {
      if (!cancelled) setP(compute(real));
    });
    return () => {
      cancelled = true;
    };
  }, [id]);

  return (
    <section className="border-t border-star/10 py-14">
      <h2 className={boxLabel}>activity patterns</h2>

      {/* contribution calendar */}
      <div className="mt-8">
        <div className="flex items-baseline justify-between">
          <p className={boxLabel}>contribution graph · last 52 weeks</p>
          <p className="font-mono text-[10px] text-faint">{p?.calRange ?? ""}</p>
        </div>
        <div
          className="relative mt-3"
          onPointerMove={makeMove(setTip)}
          onPointerLeave={() => setTip(null)}
        >
          <div
            className="grid grid-flow-col grid-rows-7 gap-[3px]"
            style={{ gridAutoColumns: "1fr" }}
          >
            {(p?.calendar ?? Array.from({ length: 371 }, () => null)).map((c, i) => (
              <span
                key={c?.date ?? i}
                data-tip={c ? `${c.date} · ${c.count} commits` : undefined}
                className={`aspect-square w-full rounded-[2px] ${c ? CAL_LEVELS[c.level] : "bg-star/[0.06]"}`}
              />
            ))}
          </div>
          {tip && <FloatingTip {...tip} />}
        </div>
        <div className="mt-2 flex items-center gap-1.5 font-mono text-[9px] tracking-[0.14em] text-faint uppercase">
          <span>less</span>
          {CAL_LEVELS.map((cls, i) => (
            <span key={i} className={`size-2.5 rounded-[2px] ${cls}`} />
          ))}
          <span>more</span>
        </div>
      </div>

      <div className="mt-8 grid gap-4 lg:grid-cols-2">
        {/* punchcard */}
        <div className={boxClass}>
          <p className={boxLabel}>punchcard · when commits land (utc)</p>
          <div className="mt-4 flex gap-2">
            <div className="flex flex-col justify-between py-0.5 font-mono text-[8px] text-faint">
              {WEEKDAYS.map((d) => (
                <span key={d}>{d[0]}</span>
              ))}
            </div>
            <div
              className="relative flex-1"
              onPointerMove={makeMove(setPunchTip)}
              onPointerLeave={() => setPunchTip(null)}
            >
              <div className="grid grid-rows-7 gap-[3px]">
                {(p?.punch ?? Array.from({ length: 7 }, () => new Array(24).fill(0))).map(
                  (row, ri) => (
                    <div key={WEEKDAYS[ri]} className="grid grid-cols-24 gap-[3px]">
                      {row.map((n, hi) => (
                        <span
                          key={hi}
                          data-tip={`${WEEKDAYS[ri]} ${hi}:00 · ${n}`}
                          className="aspect-square rounded-[2px]"
                          style={{
                            backgroundColor:
                              p && n > 0
                                ? `rgba(242,180,65,${0.12 + (n / p.punchMax) * 0.88})`
                                : "rgba(243,236,224,0.06)",
                          }}
                        />
                      ))}
                    </div>
                  ),
                )}
              </div>
              <div className="mt-1.5 flex justify-between font-mono text-[8px] text-faint">
                {HOURS.map((h) => (
                  <span key={h}>{h}:00</span>
                ))}
                <span>23</span>
              </div>
              {punchTip && <FloatingTip {...punchTip} />}
            </div>
          </div>
        </div>

        {/* commits per year + commit types */}
        <div className="grid gap-4">
          <div className={boxClass}>
            <p className={boxLabel}>commits per year</p>
            <div className="mt-4 flex h-20 items-end gap-1.5">
              {(p?.years ?? []).map((y) => (
                <SimpleTooltip key={y.year} content={`${y.year} · ${y.count.toLocaleString()}`}>
                  <span
                    className="flex-1 rounded-sm bg-amber/60 transition-colors hover:bg-amber"
                    style={{ height: `${Math.max(4, (y.count / (p?.yearMax ?? 1)) * 100)}%` }}
                  />
                </SimpleTooltip>
              ))}
            </div>
            <div className="mt-1 flex gap-1.5">
              {(p?.years ?? []).map((y) => (
                <span key={y.year} className="flex-1 text-center font-mono text-[8px] text-faint">
                  {`'${String(y.year).slice(2)}`}
                </span>
              ))}
            </div>
          </div>

          {p && p.typed > 0 && (
            <div className={boxClass}>
              <p className={boxLabel}>
                commit types ·{" "}
                {Math.round(
                  (p.typed /
                    Math.max(
                      1,
                      p.years.reduce((a, y) => a + y.count, 0),
                    )) *
                    100,
                )}
                % conventional
              </p>
              <ol className="mt-3 space-y-2">
                {p.types.slice(0, 5).map((t) => (
                  <li key={t.type} className="flex items-center gap-3">
                    <span className="w-14 shrink-0 font-mono text-[11px] text-star">{t.type}</span>
                    <span className="h-1.5 flex-1 overflow-hidden rounded-full bg-star/10">
                      <span
                        className="block h-full rounded-full bg-amber/70"
                        style={{ width: `${Math.round((t.count / p.types[0]!.count) * 100)}%` }}
                      />
                    </span>
                    <span className="w-12 shrink-0 text-right font-mono text-[11px] text-dim">
                      {t.count.toLocaleString()}
                    </span>
                  </li>
                ))}
              </ol>
            </div>
          )}
        </div>
      </div>
    </section>
  );
}
