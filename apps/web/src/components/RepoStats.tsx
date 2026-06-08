"use client";

import type { SyntheticHistory } from "@repomentary/artifact";
import { type RefObject, useEffect, useRef, useState } from "react";
import { SimpleTooltip } from "@/components/ui/tooltip";
import { getDatasetId, loadSharedHistory, REPO_DATASETS } from "@/lib/realHistory";
import { useDatasetId } from "@/lib/useDataset";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const BUCKETS = 140;
const DAY = 24 * 3600e3;
const YEAR = 365 * DAY;

interface Contributor {
  name: string;
  share: number;
}

interface Stats {
  repo: string;
  commits: number;
  contributors: number;
  years: number;
  releases: number;
  perWeek: number;
  mergePct: number;
  busFactor: number;
  top3: Contributor[];
  activityScore: number;
  activityWord: string;
  peakLabel: string;
  peakCount: number;
  bornLabel: string;
  newcomers: number;
  driveByPct: number;
  weekday: number[];
  busiestDay: string;
  weekendPct: number;
  halfLifeYear: number;
  halfLifeWord: string;
  releaseEvery: number | null;
  longestGap: number;
  spark: string;
  area: string;
  releases_xy: { x: number; name: string }[];
  startYear: number;
  endYear: number;
  startMs: number;
  spanMs: number;
  monthly: Map<number, number>;
}

function activityWord(score: number): string {
  if (score >= 9) return "Blazing";
  if (score >= 7) return "Active";
  if (score >= 5) return "Steady";
  if (score >= 3) return "Cooling";
  return "Dormant";
}

function compute(h: SyntheticHistory, repo: string): Stats {
  let merges = 0;
  let releases = 0;
  let recent = 0;
  const endMs = h.startDateMs + h.spanMs;
  const recentFrom = endMs - 90 * DAY;
  const newFrom = endMs - YEAR;
  const authorCount = new Map<number, number>();
  const authorFirst = new Map<number, number>();
  const monthTally = new Map<number, number>();
  const weekday = new Array<number>(7).fill(0);
  const buckets = new Array<number>(BUCKETS).fill(0);
  const releasesXY: { x: number; name: string }[] = [];
  const commitTimes: number[] = [];
  let firstRelease = 0;
  let lastRelease = 0;

  for (const e of h.events) {
    const ms = h.startDateMs + (e.t / h.duration) * h.spanMs;
    if (e.kind === "release") {
      releases++;
      releasesXY.push({ x: (e.t / h.duration) * 100, name: e.label ?? "release" });
      if (!firstRelease) firstRelease = ms;
      lastRelease = ms;
      continue;
    }
    if (e.kind !== "commit" && e.kind !== "merge") continue;
    if (e.kind === "merge") merges++;
    commitTimes.push(ms);
    authorCount.set(e.author, (authorCount.get(e.author) ?? 0) + 1);
    if (!authorFirst.has(e.author)) authorFirst.set(e.author, ms);
    if (ms >= recentFrom) recent++;
    const d = new Date(ms);
    monthTally.set(
      d.getUTCFullYear() * 12 + d.getUTCMonth(),
      (monthTally.get(d.getUTCFullYear() * 12 + d.getUTCMonth()) ?? 0) + 1,
    );
    const wd = (d.getUTCDay() + 6) % 7;
    weekday[wd] = (weekday[wd] ?? 0) + 1;
    const bi = Math.min(BUCKETS - 1, Math.floor((e.t / h.duration) * BUCKETS));
    buckets[bi] = (buckets[bi] ?? 0) + 1;
  }

  const commits = commitTimes.length;
  const ranked = [...authorCount.entries()].sort((a, b) => b[1] - a[1]);
  const top3: Contributor[] = ranked.slice(0, 3).map(([idx, n]) => ({
    name: h.authors[idx] ?? "·",
    share: commits ? n / commits : 0,
  }));

  let acc = 0;
  let busFactor = 0;
  for (const [, n] of ranked) {
    acc += n;
    busFactor++;
    if (acc >= commits / 2) break;
  }

  let newcomers = 0;
  let oneAndDone = 0;
  for (const [idx, n] of authorCount) {
    if (n === 1) oneAndDone++;
    if ((authorFirst.get(idx) ?? 0) >= newFrom) newcomers++;
  }

  const peak = [...monthTally.entries()].sort((a, b) => b[1] - a[1])[0] ?? [0, 0];

  // Half-life: the date by which half of all commits had landed.
  const halfMs = commitTimes[Math.floor(commits / 2)] ?? h.startDateMs;
  const halfWord = halfMs < h.startDateMs + h.spanMs / 2 ? "front-loaded" : "back-loaded";

  // Longest silent stretch between consecutive commits.
  let longestGap = 0;
  for (let i = 1; i < commitTimes.length; i++) {
    const g = (commitTimes[i] as number) - (commitTimes[i - 1] as number);
    if (g > longestGap) longestGap = g;
  }

  const busyIdx = weekday.indexOf(Math.max(...weekday));
  const weekend = (weekday[5] ?? 0) + (weekday[6] ?? 0);

  const periods = Math.max(1, h.spanMs / (90 * DAY));
  const ratio = recent / Math.max(1, commits / periods);
  const activityScore = Math.max(1, Math.min(10, Math.round(ratio * 5)));

  const peakV = Math.max(1, ...buckets);
  const spark = buckets
    .map(
      (v, i) => `${((i / (BUCKETS - 1)) * 100).toFixed(2)},${(30 - (v / peakV) * 28).toFixed(2)}`,
    )
    .join(" ");
  const born = new Date(h.startDateMs);

  return {
    repo,
    commits,
    contributors: h.authors.length,
    years: h.spanMs / (365.25 * DAY),
    releases,
    perWeek: Math.max(1, Math.round(commits / Math.max(1, h.spanMs / (7 * DAY)))),
    mergePct: commits ? Math.round((merges / commits) * 100) : 0,
    busFactor,
    top3,
    activityScore,
    activityWord: activityWord(activityScore),
    peakLabel: `${MONTHS[peak[0] % 12]} ${Math.floor(peak[0] / 12)}`,
    peakCount: peak[1],
    bornLabel: `${MONTHS[born.getUTCMonth()]} ${born.getUTCFullYear()}`,
    newcomers,
    driveByPct: authorCount.size ? Math.round((oneAndDone / authorCount.size) * 100) : 0,
    weekday,
    busiestDay: WEEKDAYS[busyIdx] ?? "·",
    weekendPct: commits ? Math.round((weekend / commits) * 100) : 0,
    halfLifeYear: new Date(halfMs).getUTCFullYear(),
    halfLifeWord: halfWord,
    releaseEvery:
      releases >= 2 ? Math.round((lastRelease - firstRelease) / (releases - 1) / DAY) : null,
    longestGap: Math.round(longestGap / DAY),
    spark,
    area: `0,30 ${spark} 100,30`,
    releases_xy: releasesXY,
    startYear: new Date(h.startDateMs).getUTCFullYear(),
    endYear: new Date(endMs).getUTCFullYear(),
    startMs: h.startDateMs,
    spanMs: h.spanMs,
    monthly: monthTally,
  };
}

function prefersReduced(): boolean {
  return (
    typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

function useCountUp(target: number, active: boolean): number {
  const [v, setV] = useState(0);
  const prev = useRef(0);
  useEffect(() => {
    if (!active) return;
    if (prefersReduced()) {
      setV(target);
      prev.current = target;
      return;
    }
    const from = prev.current;
    const start = performance.now();
    let raf = 0;
    const tick = (now: number) => {
      const p = Math.min(1, (now - start) / 900);
      setV(Math.round(from + (target - from) * (1 - (1 - p) ** 3)));
      if (p < 1) raf = requestAnimationFrame(tick);
      else prev.current = target;
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [target, active]);
  return v;
}

function useInView<T extends HTMLElement>(): [RefObject<T | null>, boolean] {
  const ref = useRef<T>(null);
  const [seen, setSeen] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el || seen) return;
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          setSeen(true);
          io.disconnect();
        }
      },
      { threshold: 0.2 },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [seen]);
  return [ref, seen];
}

function Stat({ value, label }: { value: string; label: string }) {
  return (
    <div>
      <div className="font-display text-2xl font-bold text-star sm:text-3xl">{value}</div>
      <div className="mt-1 font-mono text-[10px] tracking-[0.16em] text-faint uppercase">
        {label}
      </div>
    </div>
  );
}

function Fact({ value, label }: { value: string; label: string }) {
  return (
    <div>
      <div className="font-display text-lg font-bold text-amber">{value}</div>
      <div className="mt-0.5 font-mono text-[9px] tracking-[0.14em] text-faint uppercase">
        {label}
      </div>
    </div>
  );
}

const boxClass = "rounded-xl border border-star/10 bg-deep/40 p-5";
const boxLabel = "font-mono text-[10px] tracking-[0.16em] text-faint uppercase";

interface Hover {
  xPct: number;
  label: string;
  count: number;
}

export default function RepoStats({ datasetId }: { datasetId?: string }) {
  const ctxId = useDatasetId();
  const id = datasetId ?? ctxId;
  const [stats, setStats] = useState<Stats | null>(null);
  const [sectionRef, inView] = useInView<HTMLElement>();
  const tlRef = useRef<HTMLDivElement>(null);
  const [hover, setHover] = useState<Hover | null>(null);

  useEffect(() => {
    let cancelled = false;
    const dsId = id ?? getDatasetId();
    const repo = REPO_DATASETS.find((d) => d.id === dsId)?.label ?? dsId;
    loadSharedHistory(dsId).then(({ history }) => {
      if (!cancelled) setStats(compute(history, repo));
    });
    return () => {
      cancelled = true;
    };
  }, [id]);

  const commits = useCountUp(stats?.commits ?? 0, inView);

  const onTimelineMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!stats || !tlRef.current) return;
    const rect = tlRef.current.getBoundingClientRect();
    const frac = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    const d = new Date(stats.startMs + frac * stats.spanMs);
    setHover({
      xPct: frac * 100,
      label: `${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`,
      count: stats.monthly.get(d.getUTCFullYear() * 12 + d.getUTCMonth()) ?? 0,
    });
  };

  const wkMax = stats ? Math.max(1, ...stats.weekday) : 1;

  return (
    <section ref={sectionRef} id="numbers" className="scroll-mt-20 border-t border-star/10 py-14">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className={boxLabel}>the numbers</h2>
        <p className="font-mono text-[11px] tracking-[0.18em] text-dim">
          {stats?.repo ?? "loading…"}
        </p>
      </div>

      {/* headline band */}
      <div className="mt-8 grid grid-cols-2 gap-x-6 gap-y-8 sm:grid-cols-4 lg:grid-cols-6">
        <div className="col-span-2">
          <div className="font-display text-5xl font-extrabold tracking-tight text-amber sm:text-6xl">
            {commits.toLocaleString()}
          </div>
          <div className="mt-1 font-mono text-[10px] tracking-[0.16em] text-faint uppercase">
            commits
          </div>
        </div>
        <Stat value={stats ? stats.contributors.toLocaleString() : "·"} label="contributors" />
        <Stat value={stats ? `${Math.round(stats.years)} yrs` : "·"} label="of history" />
        <Stat value={stats ? stats.releases.toString() : "·"} label="releases" />
        <Stat value={stats ? `${stats.perWeek}/wk` : "·"} label="avg cadence" />
      </div>

      {/* bento: four labelled boxes */}
      <div className="mt-10 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <div className={boxClass}>
          <p className={boxLabel}>recent activity</p>
          <div className="mt-2 flex items-baseline gap-2">
            <span className="font-serif text-3xl text-amber">{stats?.activityWord ?? "·"}</span>
            <span className="font-mono text-sm text-dim">
              {stats ? `${stats.activityScore}/10` : ""}
            </span>
          </div>
          <div className="mt-3 flex gap-1">
            {Array.from({ length: 10 }, (_, i) => (
              <span
                key={i}
                className={`h-1.5 flex-1 rounded-full ${stats && i < stats.activityScore ? "bg-amber" : "bg-star/12"}`}
              />
            ))}
          </div>
          <p className="mt-2 font-mono text-[10px] tracking-[0.12em] text-faint uppercase">
            last 90 days vs lifetime pace
          </p>
        </div>

        <div className={boxClass}>
          <p className={boxLabel}>top contributors</p>
          <ol className="mt-3 space-y-2.5">
            {(stats?.top3 ?? []).map((c, i) => (
              <li key={c.name} className="flex items-center gap-3">
                <span className="grid size-5 shrink-0 place-items-center rounded-full bg-amber/15 font-mono text-[10px] text-amber">
                  {i + 1}
                </span>
                <span className="w-20 shrink-0 truncate font-mono text-xs text-star">{c.name}</span>
                <span className="h-1.5 flex-1 overflow-hidden rounded-full bg-star/10">
                  <span
                    className="block h-full rounded-full bg-amber/70"
                    style={{ width: `${Math.round(c.share * 100)}%` }}
                  />
                </span>
                <span className="w-8 shrink-0 text-right font-mono text-[11px] text-dim">
                  {Math.round(c.share * 100)}%
                </span>
              </li>
            ))}
          </ol>
        </div>

        <div className={`${boxClass} grid grid-cols-2 content-center gap-x-4 gap-y-5`}>
          <Fact value={stats ? `${stats.busFactor}` : "·"} label="wrote half" />
          <Fact value={stats ? `+${stats.newcomers}` : "·"} label="joined last yr" />
          <Fact value={stats ? `${stats.driveByPct}%` : "·"} label="one-commit only" />
          <Fact value={stats?.bornLabel ?? "·"} label="first commit" />
        </div>

        <div className={boxClass}>
          <p className={boxLabel}>weekly rhythm</p>
          <div className="mt-3 flex h-14 items-end gap-1.5">
            {(stats?.weekday ?? new Array(7).fill(0)).map((n, i) => (
              <span
                key={WEEKDAYS[i]}
                className={`flex-1 rounded-sm ${stats && n === Math.max(...stats.weekday) ? "bg-amber" : "bg-amber/30"}`}
                style={{ height: `${Math.max(6, (n / wkMax) * 100)}%` }}
              />
            ))}
          </div>
          <div className="mt-1 flex gap-1.5">
            {WEEKDAYS.map((d) => (
              <span key={d} className="flex-1 text-center font-mono text-[8px] text-faint">
                {d[0]}
              </span>
            ))}
          </div>
          <p className="mt-2 font-mono text-[10px] tracking-[0.12em] text-faint uppercase">
            busiest {stats?.busiestDay ?? "·"} · {stats?.weekendPct ?? 0}% on weekends
          </p>
        </div>
      </div>

      {/* highlighted facts row */}
      <div className="mt-4 flex flex-wrap gap-x-10 gap-y-5 rounded-xl border border-star/10 bg-deep/40 px-5 py-4">
        <Fact value={stats ? `${stats.mergePct}%` : "·"} label="via merges" />
        <Fact
          value={stats ? `${stats.peakLabel}` : "·"}
          label={`busiest month · ${stats?.peakCount.toLocaleString() ?? ""}`}
        />
        <Fact
          value={stats ? `${stats.halfLifeYear}` : "·"}
          label={`half its work by · ${stats?.halfLifeWord ?? ""}`}
        />
        <Fact
          value={stats?.releaseEvery ? `${stats.releaseEvery}d` : "·"}
          label="between releases"
        />
        <Fact value={stats ? `${stats.longestGap}d` : "·"} label="longest silence" />
      </div>

      {/* interactive timeline */}
      <div className="mt-10">
        <div
          ref={tlRef}
          className="relative h-24 w-full cursor-crosshair"
          onPointerMove={onTimelineMove}
          onPointerLeave={() => setHover(null)}
        >
          <div className={inView ? "tl-reveal tl-in h-full w-full" : "tl-reveal h-full w-full"}>
            <svg
              viewBox="0 0 100 30"
              preserveAspectRatio="none"
              className="h-full w-full"
              aria-hidden
            >
              <title>commit activity over time</title>
              {stats && (
                <>
                  <polygon points={stats.area} fill="var(--color-amber)" fillOpacity="0.1" />
                  <polyline
                    points={stats.spark}
                    fill="none"
                    stroke="var(--color-amber)"
                    strokeOpacity="0.7"
                    strokeWidth="0.4"
                    vectorEffect="non-scaling-stroke"
                  />
                </>
              )}
            </svg>
          </div>
          {stats?.releases_xy.map((r, i) => (
            <SimpleTooltip key={`${r.x}-${i}`} content={r.name}>
              <span
                style={{ left: `${r.x}%` }}
                className="absolute bottom-5 size-1.5 -translate-x-1/2 rotate-45 bg-amber/70 transition-transform hover:scale-150"
              />
            </SimpleTooltip>
          ))}
          {hover && (
            <>
              <span
                style={{ left: `${hover.xPct}%` }}
                className="pointer-events-none absolute inset-y-0 w-px bg-star/30"
              />
              <div
                style={{ left: `${Math.max(8, Math.min(92, hover.xPct))}%` }}
                className="pointer-events-none absolute -top-2 -translate-x-1/2 rounded-md border border-star/15 bg-raised px-2.5 py-1 text-center whitespace-nowrap shadow-lg"
              >
                <div className="font-mono text-[11px] text-star">{hover.label}</div>
                <div className="font-mono text-[10px] text-amber">
                  {hover.count.toLocaleString()} commit{hover.count === 1 ? "" : "s"}
                </div>
              </div>
            </>
          )}
        </div>
        {stats && (
          <div className="mt-1 flex justify-between font-mono text-[10px] tracking-[0.16em] text-faint uppercase">
            <span>{stats.startYear}</span>
            <span>{stats.releases} releases · hover to explore</span>
            <span>{stats.endYear}</span>
          </div>
        )}
      </div>
    </section>
  );
}
