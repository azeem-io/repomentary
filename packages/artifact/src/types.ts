/**
 * Shared artifact types, v0. Only what the motion sketches need for now;
 * the real versioned schema lands with the ingestion worker. Rule: sketches
 * and films consume events from this package, never raw git data.
 */

/** Kinds of dramatic beats a film can render. */
export type RepoEventKind =
  | "commit"
  | "branchStart"
  | "merge"
  | "massDelete"
  | "release"
  | "newContributor";

export interface RepoEvent {
  /** Simulation time in abstract "repo seconds" since t=0 (sketches map this to wall clock). */
  t: number;
  kind: RepoEventKind;
  /** Stable author index into `SyntheticHistory.authors`. */
  author: number;
  /**
   * How big this event feels, 0..1. Files touched for commits/merges,
   * deletion breadth for massDelete, hype for releases.
   */
  magnitude: number;
  /** Cluster (≈ top-level directory) this event primarily hits. */
  cluster: number;
  /**
   * Branch identity: 0 = main/trunk, >0 = a feature branch.
   * `branchStart` opens an id; commits may carry it; `merge` closes it
   * (the merge's magnitude reflects the branch's accumulated work).
   */
  branch?: number;
  /** Optional human label (release tag, contributor name reveal, …). */
  label?: string;
  /** Representative file path for commit/merge events (real histories). */
  path?: string;
}

export interface SyntheticHistory {
  seed: number;
  /** Total simulated duration in the same units as `RepoEvent.t`. */
  duration: number;
  authors: string[];
  /** Number of file clusters (≈ top-level dirs). */
  clusters: number;
  /** Human names for each cluster (e.g. "src", "docs"), same length as `clusters`. */
  clusterNames: string[];
  /** Calendar anchor: t=0 maps to this UTC epoch-ms… */
  startDateMs: number;
  /** …and t=duration maps to startDateMs + spanMs. */
  spanMs: number;
  events: RepoEvent[];
}

/** Schema version constant, bumped when the (future) binary layout changes. */
export const ARTIFACT_SCHEMA_VERSION = 0;
