import { gaussian, index, mulberry32, range } from "./random";
import type { RepoEvent, SyntheticHistory } from "./types";

const FIRST_NAMES = [
  "Ada",
  "Linus",
  "Grace",
  "Edsger",
  "Margaret",
  "Dennis",
  "Barbara",
  "Ken",
  "Radia",
  "Bjarne",
  "Frances",
  "Guido",
  "Hedy",
  "Anders",
  "Katherine",
  "Brendan",
];

const LAST_NAMES = [
  "Lovelace",
  "Hopper",
  "Hamilton",
  "Ritchie",
  "Liskov",
  "Thompson",
  "Perlman",
  "Kernighan",
  "Johnson",
  "Wing",
  "Allen",
  "Stroustrup",
  "Sammet",
  "Eich",
  "Goldberg",
  "Torvalds",
];

const CLUSTER_NAME_POOL = [
  "src",
  "lib",
  "docs",
  "tests",
  "app",
  "core",
  "packages",
  "tools",
  "api",
  "ci",
];

const BRANCH_PREFIXES = ["feat", "fix", "chore", "refactor", "perf"];
const BRANCH_TOPICS = [
  "auth",
  "dark-mode",
  "cache",
  "router",
  "search",
  "onboarding",
  "exports",
  "i18n",
  "hooks",
  "parser",
  "streaming",
  "themes",
];

export interface SyntheticOptions {
  seed?: number;
  /** Simulated duration (abstract seconds). Sketches usually play 1 unit = 1 real second. */
  duration?: number;
  authorCount?: number;
  clusters?: number;
  /** Average commits per time unit during normal activity. */
  baseRate?: number;
  /** Max concurrently open feature branches. */
  maxOpenBranches?: number;
}

interface OpenBranch {
  id: number;
  openedAt: number;
  commits: number;
  author: number;
  cluster: number;
}

/**
 * Generates a plausible repo life: quiet start, growth, eras of intensity,
 * and REAL branch lifecycles, `branchStart` opens a branch, commits may land
 * on it, and a `merge` closes it with magnitude proportional to the work it
 * accumulated. Trunk work carries `branch: 0`. Deterministic per options.
 */
export function generateSyntheticHistory(opts: SyntheticOptions = {}): SyntheticHistory {
  const seed = opts.seed ?? 1337;
  const duration = opts.duration ?? 120;
  const authorCount = Math.min(opts.authorCount ?? 12, FIRST_NAMES.length);
  const clusters = opts.clusters ?? 7;
  const baseRate = opts.baseRate ?? 3;
  const maxOpenBranches = opts.maxOpenBranches ?? 2;

  const rng = mulberry32(seed);

  const authors: string[] = [];
  for (let i = 0; i < authorCount; i++) {
    authors.push(`${FIRST_NAMES[i]} ${LAST_NAMES[(i * 5 + index(rng, 4)) % LAST_NAMES.length]}`);
  }

  // Calendar span: the repo is born somewhere in 2013–2019 and lives 7–12 years.
  const startDateMs = Date.UTC(2013 + index(rng, 7), index(rng, 12), 1 + index(rng, 27));
  const spanMs = (7 + rng() * 5) * 365.25 * 24 * 3600 * 1000;

  const clusterNames: string[] = [];
  for (let i = 0; i < clusters; i++) {
    clusterNames.push(CLUSTER_NAME_POOL[i % CLUSTER_NAME_POOL.length] ?? `dir${i}`);
  }

  const events: RepoEvent[] = [];

  // Activity envelope: ramps in, has 2–4 "eras" of intensity.
  const eras = 2 + index(rng, 3);
  const eraBoundaries: number[] = [0];
  for (let i = 1; i < eras; i++) eraBoundaries.push(range(rng, 0.2, 0.9) * duration);
  eraBoundaries.sort((a, b) => a - b);
  const eraIntensity = eraBoundaries.map(() => range(rng, 0.4, 1.6));

  const intensityAt = (t: number): number => {
    const ramp = Math.min(1, t / (duration * 0.12));
    let intensity = eraIntensity[0] ?? 1;
    for (let i = 0; i < eraBoundaries.length; i++) {
      const boundary = eraBoundaries[i] ?? 0;
      if (t >= boundary) intensity = eraIntensity[i] ?? 1;
    }
    return ramp * intensity;
  };

  // Contributor pool grows over time.
  let activeAuthors = 2;
  const joinTimes: number[] = [];
  for (let i = 2; i < authorCount; i++) joinTimes.push(range(rng, 0.1, 0.95) * duration);
  joinTimes.sort((a, b) => a - b);
  let nextJoin = 0;

  // Branch lifecycle state.
  const openBranches: OpenBranch[] = [];
  let nextBranchId = 1;

  let t = 0;
  let sinceRelease = 0;
  while (t < duration) {
    const intensity = intensityAt(t);
    const gap = -Math.log(1 - rng()) / Math.max(0.2, baseRate * intensity);
    t += gap;
    if (t >= duration) break;
    sinceRelease += gap;

    // Contributor joins?
    while (nextJoin < joinTimes.length && (joinTimes[nextJoin] ?? Infinity) <= t) {
      activeAuthors = Math.min(authorCount, activeAuthors + 1);
      events.push({
        t,
        kind: "newContributor",
        author: activeAuthors - 1,
        magnitude: 0.3,
        cluster: index(rng, clusters),
        label: authors[activeAuthors - 1],
      });
      nextJoin++;
    }

    // Open a new branch sometimes (not in the very first stretch).
    if (t > duration * 0.06 && openBranches.length < maxOpenBranches && rng() < 0.06) {
      const branch: OpenBranch = {
        id: nextBranchId++,
        openedAt: t,
        commits: 0,
        author: index(rng, activeAuthors),
        cluster: index(rng, clusters),
      };
      openBranches.push(branch);
      const prefix = BRANCH_PREFIXES[index(rng, BRANCH_PREFIXES.length)] ?? "feat";
      const topic = BRANCH_TOPICS[index(rng, BRANCH_TOPICS.length)] ?? "things";
      events.push({
        t,
        kind: "branchStart",
        author: branch.author,
        magnitude: 0.4,
        cluster: branch.cluster,
        branch: branch.id,
        label: `${prefix}/${topic}`,
      });
      continue;
    }

    // Merge a ripe branch (enough work, lived long enough).
    const ripeIndex = openBranches.findIndex(
      (b) => b.commits >= 3 && t - b.openedAt > range(rng, 4, 7),
    );
    if (ripeIndex !== -1 && rng() < 0.3) {
      const branch = openBranches[ripeIndex];
      if (branch) {
        openBranches.splice(ripeIndex, 1);
        events.push({
          t,
          kind: "merge",
          author: branch.author,
          magnitude: Math.min(1, 0.3 + branch.commits * 0.06 + (t / duration) * 0.15),
          cluster: branch.cluster,
          branch: branch.id,
        });
      }
      continue;
    }

    // Release cadence: every ~20–30 units.
    if (sinceRelease > range(rng, 20, 30)) {
      sinceRelease = 0;
      const major = 1 + Math.floor((t / duration) * 3);
      const minor = index(rng, 10);
      events.push({
        t,
        kind: "release",
        author: index(rng, activeAuthors),
        magnitude: 0.8,
        cluster: index(rng, clusters),
        label: `v${major}.${minor}.0`,
      });
      continue;
    }

    // Rare mass deletion (refactor), never in the first 15%.
    if (t > duration * 0.15 && rng() < 0.02) {
      events.push({
        t,
        kind: "massDelete",
        author: index(rng, activeAuthors),
        magnitude: Math.min(1, 0.5 + rng() * 0.5),
        cluster: index(rng, clusters),
        branch: 0,
      });
      continue;
    }

    // Plain commit, sometimes on an open branch, otherwise trunk.
    const onBranch = openBranches.length > 0 && rng() < 0.45;
    const target = onBranch ? openBranches[index(rng, openBranches.length)] : undefined;
    if (target) target.commits++;
    events.push({
      t,
      kind: "commit",
      author: target ? target.author : index(rng, activeAuthors),
      magnitude: Math.min(1, Math.abs(gaussian(rng)) * 0.25 + 0.08),
      cluster: target ? target.cluster : index(rng, clusters),
      branch: target ? target.id : 0,
    });
  }

  return { seed, duration, authors, clusters, clusterNames, startDateMs, spanMs, events };
}
