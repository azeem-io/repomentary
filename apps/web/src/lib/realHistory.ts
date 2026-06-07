/**
 * Loader for real repo history artifacts produced by
 * apps/worker/scripts/extract-history.mjs (schema 1).
 *
 * Also adapts the raw commit stream into a SyntheticHistory-shaped object so
 * FilmChrome (sidebar/timeline/date) works unchanged on real data.
 */
import {
  generateSyntheticHistory,
  type RepoEvent,
  type SyntheticHistory,
} from "@repomentary/artifact";

export type ChangeOp = 0 | 1 | 2; // A | M | D

export interface RealCommit {
  /** Seconds since the first commit. */
  t: number;
  author: number;
  isMerge: boolean;
  changes: [ChangeOp, number][];
  total: number;
  subject: string;
}

export interface RealHistory {
  repo: string;
  startMs: number;
  endMs: number;
  spanSec: number;
  authors: string[];
  paths: string[];
  tags: { t: number; name: string }[];
  commits: RealCommit[];
  /** Adapter for FilmChrome + existing sketches. t = seconds since start. */
  chromeHistory: SyntheticHistory;
}

interface RawArtifact {
  schema: number;
  repo: string;
  startMs: number;
  endMs: number;
  authors: string[];
  paths: string[];
  tags: [number, string][];
  commits: [number, number, number, [number, number][], number, string?][];
}

const topSegment = (path: string): string => {
  const i = path.indexOf("/");
  return i === -1 ? "·root" : path.slice(0, i);
};

export async function loadRealHistory(url: string): Promise<RealHistory> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`failed to load ${url}: HTTP ${res.status}`);
  const raw = (await res.json()) as RawArtifact;
  if (raw.schema !== 1) throw new Error(`unsupported artifact schema ${raw.schema}`);

  const commits: RealCommit[] = raw.commits.map((c) => ({
    t: c[0],
    author: c[1],
    isMerge: c[2] === 1,
    changes: c[3] as [ChangeOp, number][],
    total: c[4],
    subject: c[5] ?? "",
  }));
  const spanSec = Math.max(1, (raw.endMs - raw.startMs) / 1000);

  // Major-ish releases only, keeps markers readable. Tag styles vary by
  // repo: "v2.0.0" (vite/react), "4.18.2" (express), "svelte@5.0.0"
  // (monorepos tagging their main package). Normalize all three to "vX.Y.Z",
  // dedupe (one release may tag several packages), then keep majors.
  const pkgPrefix = `${raw.repo.split("/")[1] ?? ""}@`;
  const seenTag = new Set<string>();
  const normTags: [number, string][] = [];
  for (const [t, name] of raw.tags) {
    const bare = name.startsWith(pkgPrefix) ? name.slice(pkgPrefix.length) : name;
    if (!/^v?\d+\.\d+\.\d+$/.test(bare)) continue;
    const clean = bare.startsWith("v") ? bare : `v${bare}`;
    if (seenTag.has(clean)) continue;
    seenTag.add(clean);
    normTags.push([t, clean]);
  }
  // Marker density cascade: majors (vX.0.0) for big tag lists, minors
  // (vX.Y.0) when a repo never leaves 0.x (chrono) or has few tags.
  const minorZeros = normTags.filter(([, name]) => /^v\d+\.\d+\.0$/.test(name));
  const majorZeros = minorZeros.filter(([, name]) => /^v\d+\.0\.0$/.test(name));
  const majors = normTags.length < 40 || majorZeros.length < 2 ? minorZeros : majorZeros;
  const tags = (majors.length >= 2 ? majors : normTags.slice(0, 12)).map(([t, name]) => ({
    t,
    name,
  }));

  // Cluster names: top-level dirs ranked by touch count.
  const touch = new Map<string, number>();
  for (const c of commits) {
    for (const [, pathIdx] of c.changes) {
      const seg = topSegment(raw.paths[pathIdx] ?? "");
      touch.set(seg, (touch.get(seg) ?? 0) + 1);
    }
  }
  const ranked = [...touch.entries()].sort((a, b) => b[1] - a[1]).map(([seg]) => seg);
  const clusterNames = ranked.slice(0, 9);
  if (ranked.length > 9) clusterNames.push("·misc");
  const clusterOf = (path: string): number => {
    const idx = clusterNames.indexOf(topSegment(path));
    return idx === -1 ? clusterNames.length - 1 : idx;
  };

  // Chrome-facing event stream.
  const events: RepoEvent[] = [];
  // A contributor "arrives" the moment their 5th commit lands, once, ever.
  const runningCommits = new Map<number, number>();

  for (const c of commits) {
    const firstPath = raw.paths[c.changes[0]?.[1] ?? 0] ?? "";
    const cluster = clusterOf(firstPath);
    const tally = (runningCommits.get(c.author) ?? 0) + 1;
    runningCommits.set(c.author, tally);
    if (tally === 5) {
      events.push({
        t: c.t,
        kind: "newContributor",
        author: c.author,
        magnitude: 0.3,
        cluster,
        label: raw.authors[c.author],
      });
    }
    // Recover branch/PR identity from the subject. Git deletes branch refs
    // on merge, but commit messages usually name them. Squash-merged PRs ("... (#123)")
    // with substantial changes count as merges too (vite squash-merges by default).
    const prTail = c.subject.match(/\(#(\d+)\)$/);
    const mergeHead = c.subject.match(/^Merge (?:pull request #(\d+) from (\S+)|branch '([^']+)')/);
    const isMergeLike = c.isMerge || (prTail !== null && c.total >= 25);
    // Keep labels SHORT and clean, the feed is a ticker, not a changelog.
    let mergeLabel: string | undefined;
    if (mergeHead) {
      mergeLabel = mergeHead[1]
        ? `PR #${mergeHead[1]}`
        : (mergeHead[3] ?? "branch").split("/").slice(-1)[0]?.slice(0, 20);
    } else if (prTail) {
      mergeLabel = `PR #${prTail[1]}`;
    }

    const deletes = c.changes.filter(([op]) => op === 2).length;
    if (deletes > 20 && deletes / Math.max(1, c.total) > 0.6) {
      events.push({
        t: c.t,
        kind: "massDelete",
        author: c.author,
        magnitude: Math.min(1, deletes / 80),
        cluster,
      });
    }
    events.push({
      t: c.t,
      kind: isMergeLike ? "merge" : "commit",
      author: c.author,
      magnitude: Math.min(1, c.total / 40),
      cluster,
      branch: isMergeLike ? undefined : 0,
      label: isMergeLike ? mergeLabel : undefined,
      path: firstPath || undefined,
    });
  }
  for (const tag of tags) {
    events.push({
      t: tag.t,
      kind: "release",
      author: 0,
      magnitude: 0.8,
      cluster: 0,
      label: tag.name,
    });
  }
  events.sort((a, b) => a.t - b.t);

  const chromeHistory: SyntheticHistory = {
    seed: 1,
    duration: spanSec,
    authors: raw.authors,
    clusters: clusterNames.length,
    clusterNames,
    startDateMs: raw.startMs,
    spanMs: raw.endMs - raw.startMs,
    events,
  };

  return {
    repo: raw.repo,
    startMs: raw.startMs,
    endMs: raw.endMs,
    spanSec,
    authors: raw.authors,
    paths: raw.paths,
    tags,
    commits,
    chromeHistory,
  };
}

/* ----------------------- shared loader for all sketches ----------------------- */

export interface RepoDataset {
  /** Stable id, persisted as the switcher selection. */
  id: string;
  /** owner/name, as shown in the switcher. */
  label: string;
  file: string;
  /** Scale hint for tooltips. */
  hint: string;
}

/** Real histories bundled with the app (extracted via apps/worker/scripts). */
export const REPO_DATASETS: RepoDataset[] = [
  { id: "vite", label: "vitejs/vite", file: "/data/vite.json", hint: "9.3k commits · 6 years" },
  {
    id: "react",
    label: "facebook/react",
    file: "/data/react.json",
    hint: "21.5k commits · 13 years",
  },
  {
    id: "svelte",
    label: "sveltejs/svelte",
    file: "/data/svelte.json",
    hint: "11.3k commits · 9.6 years",
  },
  {
    id: "express",
    label: "expressjs/express",
    file: "/data/express.json",
    hint: "6.1k commits · 17 years",
  },
  {
    id: "chrono",
    label: "vicolo-dev/chrono",
    file: "/data/chrono.json",
    hint: "1.2k commits · 2 years",
  },
];

const FALLBACK_DATASET = REPO_DATASETS[0] as RepoDataset;
const DATASET_KEY = "repomentary.dataset";

/** The selected dataset id, persisted across pages and sessions. */
export function getDatasetId(): string {
  if (typeof window === "undefined") return FALLBACK_DATASET.id;
  try {
    const stored = window.localStorage.getItem(DATASET_KEY);
    if (stored && REPO_DATASETS.some((d) => d.id === stored)) return stored;
  } catch {
    // storage blocked, fall through to the default
  }
  return FALLBACK_DATASET.id;
}

export function setDatasetId(id: string): void {
  try {
    window.localStorage.setItem(DATASET_KEY, id);
  } catch {
    // storage blocked, the switch still works, it just won't persist
  }
}

const datasetById = (id: string): RepoDataset =>
  REPO_DATASETS.find((d) => d.id === id) ?? FALLBACK_DATASET;

export interface SharedHistory {
  history: SyntheticHistory;
  repoName: string;
  isReal: boolean;
}

const chromeCache = new Map<string, Promise<SharedHistory>>();
const realCache = new Map<string, Promise<RealHistory>>();

/**
 * Every sketch's data source: the selected bundled repo when available, a
 * deterministic synthetic repo when not (offline, missing file). Cached per
 * dataset so revisits and parallel sketches share one fetch + parse.
 */
export function loadSharedHistory(datasetId: string = getDatasetId()): Promise<SharedHistory> {
  const ds = datasetById(datasetId);
  let p = chromeCache.get(ds.id);
  if (!p) {
    p = loadSharedRealHistory(ds.id)
      .then((real) => ({ history: real.chromeHistory, repoName: real.repo, isReal: true }))
      .catch(() => ({
        history: generateSyntheticHistory({
          seed: 24,
          duration: 95,
          clusters: 8,
          maxOpenBranches: 2,
        }),
        repoName: "repomentary/demo-repo",
        isReal: false,
      }));
    chromeCache.set(ds.id, p);
  }
  return p;
}

/** Full-fidelity history (file paths, raw commits) for path-level sketches (gource). */
export function loadSharedRealHistory(datasetId: string = getDatasetId()): Promise<RealHistory> {
  const ds = datasetById(datasetId);
  let p = realCache.get(ds.id);
  if (!p) {
    p = loadRealHistory(ds.file);
    realCache.set(ds.id, p);
  }
  return p;
}
