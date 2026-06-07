/**
 * Deterministic seeded RNG (mulberry32). Films must replay identically from
 * the same artifact, every random visual choice flows from a seed derived
 * from the artifact hash. Sketches use it too so reviews are reproducible.
 */
export type Rng = () => number;

export function mulberry32(seed: number): Rng {
  let a = seed >>> 0;
  return () => {
    a += 0x6d2b79f5;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Random in [min, max). */
export function range(rng: Rng, min: number, max: number): number {
  return min + rng() * (max - min);
}

/** Random integer in [0, n). */
export function index(rng: Rng, n: number): number {
  return Math.min(n - 1, Math.floor(rng() * n));
}

/** Approximate gaussian via central limit (mean 0, sd ~1). */
export function gaussian(rng: Rng): number {
  return (rng() + rng() + rng() + rng() - 2) * Math.SQRT2;
}
