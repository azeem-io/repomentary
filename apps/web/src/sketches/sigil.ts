/**
 * Sigil: the repo as a molten emblem of intersecting runes. Each major
 * top-level directory becomes one rune: a ring colored by its dominant
 * language, an inner star-polygon whose points count its languages, gauge
 * ticks for its size, and a cracked ring when it has rotted from deletes.
 * Contributors form a weighted sunburst. Every parameter is seeded from the
 * repo, drawn as continuous bloomed strokes (not stamps).
 */
import { mulberry32, type Rng } from "@repomentary/artifact";
import { BlurFilter, Container, Graphics, Sprite, Text, Texture, TilingSprite } from "pixi.js";
import {
  getDatasetId,
  loadSharedRealHistory,
  REPO_DATASETS,
  type RealHistory,
} from "@/lib/realHistory";
import { FilmChrome } from "./chrome";
import {
  bootPixi,
  clamp01,
  consumePendingSeek,
  makeCaptureHandle,
  makeGlowTexture,
  requestRebuildSeek,
  type SketchInstance,
  type Transport,
} from "./common";

const INK = 0xe8ecff;
const PLAY_SECONDS = 110;
const SLICES = 120;
const R0 = 300;

type Pt = { x: number; y: number };

function hashStr(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}
function hslToInt(h: number, sat: number, l: number): number {
  const hh = (((h % 360) + 360) % 360) / 360;
  const a = sat * Math.min(l, 1 - l);
  const f = (n: number): number => {
    const k = (n + hh * 12) % 12;
    return l - a * Math.max(-1, Math.min(k - 3, Math.min(9 - k, 1)));
  };
  return (Math.round(f(0) * 255) << 16) | (Math.round(f(8) * 255) << 8) | Math.round(f(4) * 255);
}
function mix(a: number, b: number, k: number): number {
  const ar = (a >> 16) & 0xff;
  const ag = (a >> 8) & 0xff;
  const ab = a & 0xff;
  const br = (b >> 16) & 0xff;
  const bg = (b >> 8) & 0xff;
  const bb = b & 0xff;
  return (
    (Math.round(ar + (br - ar) * k) << 16) |
    (Math.round(ag + (bg - ag) * k) << 8) |
    Math.round(ab + (bb - ab) * k)
  );
}
const topSeg = (p: string): string => {
  const i = p.indexOf("/");
  return i === -1 ? "·root" : p.slice(0, i);
};
const extOf = (p: string): string => {
  const f = p.slice(p.lastIndexOf("/") + 1);
  const d = f.lastIndexOf(".");
  return d === -1 ? "·" : f.slice(d + 1).toLowerCase();
};

function makeGrainTexture(size = 128): Texture {
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d");
  if (ctx) {
    const img = ctx.createImageData(size, size);
    for (let i = 0; i < img.data.length; i += 4) {
      const v = 108 + Math.floor(Math.random() * 60);
      img.data[i] = v;
      img.data[i + 1] = v;
      img.data[i + 2] = v;
      img.data[i + 3] = 255;
    }
    ctx.putImageData(img, 0, 0);
  }
  return Texture.from(canvas);
}
function makeVignetteTexture(size = 256): Texture {
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d");
  if (ctx) {
    const g = ctx.createRadialGradient(
      size / 2,
      size / 2,
      size * 0.26,
      size / 2,
      size / 2,
      size / 2,
    );
    g.addColorStop(0, "rgba(0,0,0,0)");
    g.addColorStop(0.64, "rgba(0,0,0,0.18)");
    g.addColorStop(1, "rgba(0,0,0,0.9)");
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, size, size);
  }
  return Texture.from(canvas);
}

/* ----------------------------- path builders ----------------------------- */

function ringPts(cx: number, cy: number, r: number, n: number, wob: number, seed: number): Pt[] {
  const out: Pt[] = [];
  for (let i = 0; i < n; i++) {
    const t = (i / n) * Math.PI * 2;
    const rr = r * (1 + wob * Math.sin(t * 3 + seed) + wob * 0.5 * Math.sin(t * 7 + seed * 2));
    out.push({ x: cx + Math.cos(t) * rr, y: cy + Math.sin(t) * rr });
  }
  return out;
}
function linePts(x1: number, y1: number, x2: number, y2: number): Pt[] {
  const len = Math.hypot(x2 - x1, y2 - y1);
  const n = Math.max(6, Math.round(len / 9));
  const out: Pt[] = [];
  for (let i = 0; i < n; i++) {
    const t = i / (n - 1);
    out.push({ x: x1 + (x2 - x1) * t, y: y1 + (y2 - y1) * t });
  }
  return out;
}
function arcPts(
  cx: number,
  cy: number,
  r: number,
  a0: number,
  a1: number,
  wob = 0,
  seed = 0,
): Pt[] {
  const len = Math.abs(a1 - a0) * r;
  const n = Math.max(8, Math.round(len / 9));
  const out: Pt[] = [];
  for (let i = 0; i < n; i++) {
    const t = a0 + (a1 - a0) * (i / (n - 1));
    const rr = r * (1 + wob * Math.sin(t * 3 + seed));
    out.push({ x: cx + Math.cos(t) * rr, y: cy + Math.sin(t) * rr });
  }
  return out;
}
/** Regular star polygon {n/step} as one or more closed point loops. */
function starPaths(
  cx: number,
  cy: number,
  r: number,
  n: number,
  step: number,
  rot: number,
): Pt[][] {
  const pts: Pt[] = [];
  for (let i = 0; i < n; i++) {
    const a = rot - Math.PI / 2 + (i * 2 * Math.PI) / n;
    pts.push({ x: cx + Math.cos(a) * r, y: cy + Math.sin(a) * r });
  }
  const paths: Pt[][] = [];
  const seen = new Array<boolean>(n).fill(false);
  for (let s = 0; s < n; s++) {
    if (seen[s]) continue;
    const path: Pt[] = [];
    let i = s;
    do {
      seen[i] = true;
      path.push(pts[i]!);
      i = (i + step) % n;
    } while (i !== s);
    if (path.length >= 2) paths.push(path);
  }
  return paths;
}
function perpOf(pts: Pt[], closed: boolean): Pt[] {
  const n = pts.length;
  const out: Pt[] = [];
  for (let i = 0; i < n; i++) {
    const pa = closed ? pts[(i - 1 + n) % n] : pts[Math.max(0, i - 1)];
    const pb = closed ? pts[(i + 1) % n] : pts[Math.min(n - 1, i + 1)];
    const tx = (pb?.x ?? 0) - (pa?.x ?? 0);
    const ty = (pb?.y ?? 0) - (pa?.y ?? 0);
    const l = Math.hypot(tx, ty) || 1;
    out.push({ x: -ty / l, y: tx / l });
  }
  return out;
}

export async function createSketch(
  host: HTMLElement,
  signal?: AbortSignal,
): Promise<SketchInstance> {
  const boot = await bootPixi(host, "#0c0e15");
  if (signal?.aborted) {
    boot.destroy();
    throw new DOMException("cancelled", "AbortError");
  }
  const { app, world, ui, hud, reducedMotion } = boot;

  const loadingText = new Text({
    text: `forging sigil… (${REPO_DATASETS.find((d) => d.id === getDatasetId())?.label ?? "repo"})`,
    style: { fontFamily: "monospace", fontSize: 14, fill: INK },
  });
  loadingText.anchor.set(0.5);
  loadingText.position.set(app.screen.width / 2, app.screen.height / 2);
  ui.addChild(loadingText);

  let real: RealHistory;
  try {
    real = await loadSharedRealHistory();
  } finally {
    loadingText.destroy();
  }
  if (signal?.aborted) {
    boot.destroy();
    throw new DOMException("cancelled", "AbortError");
  }

  const params = { glow: 1, grain: 1, sparks: 1, bloom: 1 };
  const seed = hashStr(real.repo);
  const rng: Rng = mulberry32(seed);
  const sliceSec = real.spanSec / SLICES;

  // per-repo genome: continuous hue + scheme so every repo has its own colors
  const baseHue = seed % 360;
  const SCHEMES = [
    [0, 26, -26, 52],
    [0, 120, 240, 60],
    [0, 180, 32, 210],
    [0, 150, 210, 32],
  ];
  const scheme = SCHEMES[hashStr(`${real.repo}/sch`) % SCHEMES.length]!;
  const sat = 0.58 + (hashStr(`${real.repo}/sat`) % 26) / 100;
  const lig = 0.56 + (hashStr(`${real.repo}/lig`) % 18) / 100;
  const paletteCols = scheme.map((o) => hslToInt(baseHue + o, sat, lig));
  const accentCol = hslToInt(baseHue, Math.min(0.92, sat * 0.95), 0.66);
  const rotCol = hslToInt(baseHue + (hashStr(`${real.repo}/rot`) % 2 ? 200 : 330), 0.82, 0.56);
  const HUE_NAMES: [number, string][] = [
    [16, "ember"],
    [45, "gold"],
    [70, "citrine"],
    [150, "jade"],
    [195, "teal"],
    [225, "azure"],
    [265, "indigo"],
    [300, "violet"],
    [330, "magenta"],
    [360, "crimson"],
  ];
  const paletteName = HUE_NAMES.find(([h]) => baseHue <= h)?.[1] ?? "ember";
  const composition = (hashStr(`${real.repo}/comp`) % 3) as 0 | 1 | 2;
  const filamentN = 4 + (hashStr(`${real.repo}/fil`) % 3);

  /* ----------------------- per-directory data ----------------------- */

  interface SegData {
    files: Set<number>;
    touch: number[];
    deletes: number;
    birth: number;
    lang: Map<string, number>;
    sub: Set<string>;
    depth: number;
  }
  const segs = new Map<string, SegData>();
  const cumTotal = new Array<number>(SLICES).fill(0);
  const authorCommits = new Map<number, number>();
  const globalLangs = new Set<string>();
  for (const c of real.commits) {
    authorCommits.set(c.author, (authorCommits.get(c.author) ?? 0) + 1);
    const slice = Math.min(SLICES - 1, Math.floor(c.t / sliceSec));
    for (const [op, idx] of c.changes) {
      const path = real.paths[idx] ?? "";
      const k = topSeg(path);
      let d = segs.get(k);
      if (!d) {
        d = {
          files: new Set(),
          touch: new Array(SLICES).fill(0),
          deletes: 0,
          birth: real.spanSec,
          lang: new Map(),
          sub: new Set(),
          depth: 1,
        };
        segs.set(k, d);
      }
      d.files.add(idx);
      d.touch[slice] = (d.touch[slice] ?? 0) + 1;
      if (op === 2) d.deletes++;
      if (c.t < d.birth) d.birth = c.t;
      const e = extOf(path);
      d.lang.set(e, (d.lang.get(e) ?? 0) + 1);
      globalLangs.add(e);
      const parts = path.split("/");
      if (parts.length > 1 && parts[1]) d.sub.add(parts[1]);
      if (parts.length > d.depth) d.depth = parts.length;
      cumTotal[slice] = (cumTotal[slice] ?? 0) + 1;
    }
  }
  for (let i = 1; i < SLICES; i++) cumTotal[i] = (cumTotal[i] ?? 0) + (cumTotal[i - 1] ?? 0);
  const totalTouches = Math.max(1, cumTotal[SLICES - 1] ?? 1);
  const ranked = [...segs.entries()]
    .sort((a, b) => b[1].files.size - a[1].files.size || (a[0] < b[0] ? -1 : 1))
    .slice(0, 6);
  const topAuthors = [...authorCommits.entries()].sort((a, b) => b[1] - a[1]).slice(0, 48);
  const maxAuthor = topAuthors[0]?.[1] ?? 1;
  const contributorCount = real.authors.length;
  const ageYears = real.spanSec / (365.25 * 24 * 3600);

  /* ------------------------------ layers ------------------------------ */

  const glowTex = makeGlowTexture(64);
  const bgGlow = new Sprite(glowTex);
  bgGlow.anchor.set(0.5);
  bgGlow.blendMode = "add";
  bgGlow.tint = hslToInt(baseHue, sat, 0.5);
  const glowLayer = new Container();
  glowLayer.blendMode = "add";
  glowLayer.filters = [new BlurFilter({ strength: 14, quality: 2, resolution: 0.5 })];
  const coreLayer = new Container();
  coreLayer.blendMode = "add";
  const sparkLayer = new Container();
  sparkLayer.blendMode = "add";
  const vignette = new Sprite(makeVignetteTexture(256));
  vignette.anchor.set(0.5);
  vignette.blendMode = "multiply";
  const grain = new TilingSprite({ texture: makeGrainTexture(128), width: 8, height: 8 });
  grain.blendMode = "overlay";
  world.addChild(bgGlow, glowLayer, coreLayer, sparkLayer, vignette, grain);

  /* ----------------------- stroke drawing helpers ----------------------- */

  const drawPoly = (g: Graphics, pts: Pt[], closed: boolean) => {
    if (pts.length < 2) return;
    g.moveTo(pts[0]!.x, pts[0]!.y);
    for (let i = 1; i < pts.length; i++) g.lineTo(pts[i]!.x, pts[i]!.y);
    if (closed) g.lineTo(pts[0]!.x, pts[0]!.y);
  };
  const drawBand = (
    gGlow: Graphics,
    gCore: Graphics,
    pts: Pt[],
    thickness: number,
    colMid: number,
    closed: boolean,
    fils: number,
  ) => {
    const perp = perpOf(pts, closed);
    const colCore = mix(colMid, 0xffffff, 0.62);
    drawPoly(gGlow, pts, closed);
    gGlow.stroke({
      width: thickness * 3.2,
      color: colMid,
      alpha: 0.05,
      cap: "round",
      join: "round",
    });
    drawPoly(gGlow, pts, closed);
    gGlow.stroke({
      width: thickness * 1.5,
      color: colMid,
      alpha: 0.09,
      cap: "round",
      join: "round",
    });
    for (let f = 0; f < fils; f++) {
      const base = fils > 1 ? (f / (fils - 1) - 0.5) * thickness : 0;
      const k1 = 0.12 + rng() * 0.22;
      const k2 = 0.4 + rng() * 0.7;
      const p1 = rng() * 6.28;
      const p2 = rng() * 6.28;
      const a1 = thickness * (0.3 + rng() * 0.4);
      const a2 = thickness * 0.18 * rng();
      const op: Pt[] = [];
      for (let i = 0; i < pts.length; i++) {
        const off = base + a1 * Math.sin(i * k1 + p1) + a2 * Math.sin(i * k2 + p2);
        op.push({ x: pts[i]!.x + perp[i]!.x * off, y: pts[i]!.y + perp[i]!.y * off });
      }
      drawPoly(gCore, op, closed);
      gCore.stroke({
        width: 0.8 + rng() * 0.9,
        color: colMid,
        alpha: 0.4,
        cap: "round",
        join: "round",
      });
    }
    drawPoly(gCore, pts, closed);
    gCore.stroke({ width: 1.3, color: colCore, alpha: 0.85, cap: "round", join: "round" });
  };

  /* ------------------------------ runes ------------------------------ */

  interface Rune {
    gGlow: Graphics;
    gCore: Graphics;
    birthSec: number;
    total: number;
    cum: number[];
    corrupt: boolean;
    seedPts: Pt[];
    revealed: boolean;
  }
  const runes: Rune[] = [];

  const placement = (rank: number, total: number): { cx: number; cy: number; r: number } => {
    if (composition === 1) {
      const r = R0 * 0.6;
      const cy = (rank - (total - 1) / 2) * R0 * 0.26;
      const cx = rank > 2 ? (rank % 2 === 0 ? 1 : -1) * R0 * 0.16 : 0;
      return { cx, cy, r };
    }
    if (composition === 2) {
      if (rank === 0) return { cx: 0, cy: 0, r: R0 * 0.5 };
      const a = ((rank - 1) / Math.max(1, total - 1)) * Math.PI * 2 - Math.PI / 2;
      return { cx: Math.cos(a) * R0 * 0.45, cy: Math.sin(a) * R0 * 0.45, r: R0 * 0.4 };
    }
    return { cx: 0, cy: 0, r: R0 * (1 - 0.13 * rank) };
  };

  const drawMedallion = (
    gGlow: Graphics,
    gCore: Graphics,
    mx: number,
    my: number,
    mr: number,
    langs: number,
    col: number,
    thick: number,
    rot: number,
  ) => {
    if (langs <= 1) {
      drawBand(gGlow, gCore, linePts(mx, my - mr, mx, my + mr), thick, col, false, 1);
      return;
    }
    if (langs === 2) {
      drawBand(gGlow, gCore, linePts(mx, my - mr, mx, my + mr), thick, col, false, 1);
      drawBand(gGlow, gCore, linePts(mx - mr, my, mx + mr, my), thick, col, false, 1);
      return;
    }
    const n = Math.min(7, langs);
    const step = n < 5 ? 1 : 2;
    for (const path of starPaths(mx, my, mr, n, step, rot))
      drawBand(gGlow, gCore, path, thick, col, true, 1);
  };
  const chevronIn = (
    gGlow: Graphics,
    gCore: Graphics,
    cx: number,
    cy: number,
    r: number,
    ang: number,
    sizeR: number,
    col: number,
    thick: number,
  ) => {
    const tip = { x: cx + Math.cos(ang) * (r - sizeR), y: cy + Math.sin(ang) * (r - sizeR) };
    const aL = ang - 0.11;
    const aR = ang + 0.11;
    const armL = {
      x: cx + Math.cos(aL) * (r + sizeR * 0.4),
      y: cy + Math.sin(aL) * (r + sizeR * 0.4),
    };
    const armR = {
      x: cx + Math.cos(aR) * (r + sizeR * 0.4),
      y: cy + Math.sin(aR) * (r + sizeR * 0.4),
    };
    drawBand(gGlow, gCore, [armL, tip, armR], thick, col, false, 1);
  };

  ranked.forEach(([segName, d], rank) => {
    const { cx, cy, r } = placement(rank, ranked.length);
    const share = d.files.size / Math.max(1, ranked[0]?.[1].files.size ?? 1);
    const thick = 2.5 + share * 5;
    const touchSum = d.touch.reduce((a, b) => a + b, 0);
    const churn = d.deletes / Math.max(1, touchSum);
    const corrupt = churn > 0.32;
    const langs = d.lang.size;
    let lang = "·";
    let bestN = -1;
    for (const [e, n] of d.lang) {
      if (n > bestN) {
        bestN = n;
        lang = e;
      }
    }
    const col = corrupt
      ? rotCol
      : (paletteCols[hashStr(lang) % paletteCols.length] ?? paletteCols[0]!);
    const rot = (hashStr(`${segName}/r`) % 628) / 100;
    const wob = corrupt ? 0.05 : 0.015;

    const gGlow = new Graphics();
    const gCore = new Graphics();
    gGlow.alpha = 0;
    gCore.alpha = 0;
    glowLayer.addChild(gGlow);
    coreLayer.addChild(gCore);

    const seedPts = ringPts(cx, cy, r, 90, wob, rank + seed * 0.001);
    // ring: solid when stable, cracked into arcs when rotted
    if (corrupt) {
      const seg = 5;
      for (let k = 0; k < seg; k++) {
        const a0 = (k / seg) * Math.PI * 2 + 0.2;
        const a1 = ((k + 1) / seg) * Math.PI * 2 - 0.2;
        drawBand(gGlow, gCore, arcPts(cx, cy, r, a0, a1, wob, rank), thick, col, false, filamentN);
      }
    } else {
      drawBand(gGlow, gCore, seedPts, thick, col, true, filamentN);
    }
    const breadth = d.sub.size;
    const depth = d.depth;
    // chevrons on the ring, points aimed inward — count by directory size
    const chevs = Math.max(3, Math.min(12, Math.round(Math.log2(d.files.size + 1))));
    for (let k = 0; k < chevs; k++) {
      chevronIn(
        gGlow,
        gCore,
        cx,
        cy,
        r,
        rot + (k / chevs) * Math.PI * 2,
        Math.min(16, r * 0.05 + 5),
        col,
        thick * 0.5,
      );
    }
    // partial arches nested just inside the ring — count by subfolder breadth
    const arches = Math.min(4, breadth);
    for (let k = 0; k < arches; k++) {
      const rr = r * (0.5 + 0.12 * k);
      const a0 = rot + k * 0.7;
      drawBand(
        gGlow,
        gCore,
        arcPts(cx, cy, rr, a0, a0 + 2.1, 0.01, k),
        thick * 0.45,
        col,
        false,
        2,
      );
    }
    // crescents floating just outside the ring — count by directory depth
    const cres = Math.min(4, Math.max(0, depth - 2));
    for (let k = 0; k < cres; k++) {
      const ac = rot + (k / Math.max(1, cres)) * Math.PI * 2 + 0.6;
      drawBand(
        gGlow,
        gCore,
        arcPts(cx, cy, r * 1.13, ac - 0.4, ac + 0.4),
        thick * 0.5,
        col,
        false,
        2,
      );
    }
    // language medallion at a hashed angle on the ring
    const mx = cx + Math.cos(rot) * r;
    const my = cy + Math.sin(rot) * r;
    drawMedallion(gGlow, gCore, mx, my, Math.max(8, r * 0.16), langs, col, thick * 0.4, rot);

    const cum = new Array<number>(SLICES).fill(0);
    let run = 0;
    for (let i = 0; i < SLICES; i++) {
      run += d.touch[i] ?? 0;
      cum[i] = run;
    }
    runes.push({
      gGlow,
      gCore,
      birthSec: d.birth,
      total: Math.max(1, run),
      cum,
      corrupt,
      seedPts,
      revealed: false,
    });
  });

  /* ------------------------------ spine ------------------------------ */

  const spineGlow = new Graphics();
  const spineCore = new Graphics();
  spineGlow.alpha = 0;
  spineCore.alpha = 0;
  glowLayer.addChild(spineGlow);
  coreLayer.addChild(spineCore);
  drawBand(spineGlow, spineCore, linePts(0, -R0 * 1.32, 0, R0 * 1.3), 4.5, accentCol, false, 3);
  // top cusp scales with repo age
  const cuspSpan = 0.2 + 0.18 * clamp01(ageYears / 8);
  drawBand(
    spineGlow,
    spineCore,
    arcPts(0, -R0 * 1.6, R0 * 1.68, Math.PI * (0.5 - cuspSpan), Math.PI * (0.5 + cuspSpan)),
    3.5,
    accentCol,
    false,
    2,
  );
  // bottom node: a compact radiant star, not a fan
  for (let k = 0; k < 14; k++) {
    const a = (k / 14) * Math.PI * 2;
    const rr = k % 2 === 0 ? R0 * 0.13 : R0 * 0.07;
    drawBand(
      spineGlow,
      spineCore,
      linePts(0, R0 * 1.3, Math.cos(a) * rr, R0 * 1.3 + Math.sin(a) * rr),
      2.2,
      accentCol,
      false,
      1,
    );
  }

  {
    const n = Math.max(3, Math.min(7, globalLangs.size));
    const step = n < 5 ? 1 : 2;
    for (const path of starPaths(0, 0, R0 * 0.13, n, step, 0.3)) {
      drawBand(spineGlow, spineCore, path, 2.6, accentCol, true, 2);
    }
  }

  /* ----------------------- contributor sunburst ----------------------- */

  const spokeGlow = new Graphics();
  const spokeCore = new Graphics();
  spokeGlow.alpha = 0;
  spokeCore.alpha = 0;
  glowLayer.addChild(spokeGlow);
  coreLayer.addChild(spokeCore);
  topAuthors.forEach(([, count], i) => {
    const a = (i / topAuthors.length) * Math.PI * 2 - Math.PI / 2;
    const share = count / maxAuthor;
    const len = R0 * (0.05 + 0.46 * Math.sqrt(share));
    const x0 = Math.cos(a) * R0 * 1.04;
    const y0 = Math.sin(a) * R0 * 1.04;
    const x1 = Math.cos(a) * (R0 * 1.04 + len);
    const y1 = Math.sin(a) * (R0 * 1.04 + len);
    spokeGlow
      .moveTo(x0, y0)
      .lineTo(x1, y1)
      .stroke({ width: 3 + share * 4, color: accentCol, alpha: 0.05 + 0.08 * share, cap: "round" });
    spokeCore
      .moveTo(x0, y0)
      .lineTo(x1, y1)
      .stroke({
        width: 1 + share * 2,
        color: mix(accentCol, 0xffffff, 0.3),
        alpha: 0.3 + 0.55 * share,
        cap: "round",
      });
  });

  /* ------------------------------ sparks ------------------------------ */

  interface Spark {
    sprite: Sprite;
    vx: number;
    vy: number;
    life: number;
    max: number;
  }
  const sparks: Spark[] = [];
  const spawnSpark = (origin: Pt) => {
    if (sparks.length > 120) return;
    const sprite = new Sprite(glowTex);
    sprite.anchor.set(0.5);
    sprite.tint = mix(accentCol, 0xffffff, rng() * 0.5);
    sprite.scale.set(0.04 + rng() * 0.07);
    sprite.position.set(origin.x, origin.y);
    sparkLayer.addChild(sprite);
    sparks.push({
      sprite,
      vx: (rng() - 0.5) * 16,
      vy: -16 - rng() * 40,
      life: 0,
      max: 800 + rng() * 900,
    });
  };

  /* ------------------------------ chrome ------------------------------ */

  const chrome = new FilmChrome(ui, real.chromeHistory, {
    repoName: real.repo,
    accent: accentCol,
    reducedMotion,
    clip: world,
    onSeek: (f) => seekTo(f),
  });

  /* ----------------------------- playback ----------------------------- */

  let progress = 0;
  let speed = 1;
  let paused = false;
  let feedCursor = 0;
  let grainScroll = 0;
  let flick = 0;

  const feedTo = (target: number) => {
    const events = real.chromeHistory.events;
    if (target < (events[feedCursor - 1]?.t ?? -1)) {
      chrome.reset();
      feedCursor = 0;
    }
    while (feedCursor < events.length) {
      const e = events[feedCursor];
      if (!e || e.t > target) break;
      chrome.onEvent(e);
      feedCursor++;
    }
  };
  function seekTo(frac: number): void {
    progress = clamp01(frac);
    feedTo(progress * real.spanSec);
  }
  {
    const resume = consumePendingSeek();
    if (resume !== null && resume > 0) seekTo(resume);
  }

  const transport: Transport = {
    paused: () => paused,
    toggle: () => {
      paused = !paused;
    },
    speed: () => speed,
    cycleSpeed: () => {
      speed = speed >= 8 ? 1 : speed * 2;
      return speed;
    },
    finished: () => progress >= 1,
    progress: () => progress,
    seek: seekTo,
    reset: () => requestRebuildSeek(0),
  };

  const cumAt = (cum: number[], p: number): number => {
    const f = p * (SLICES - 1);
    const i = Math.min(SLICES - 1, Math.floor(f));
    const j = Math.min(SLICES - 1, i + 1);
    const fr = f - i;
    return (cum[i] ?? 0) * (1 - fr) + (cum[j] ?? 0) * fr;
  };

  const tick = () => {
    const dtMs = Math.min(app.ticker.deltaMS, 50);
    if (!paused && progress < 1)
      progress = clamp01(progress + (dtMs / 1000) * (speed / PLAY_SECONDS));
    feedTo(progress * real.spanSec);

    const cumNow = cumAt(cumTotal, progress);
    const globalMaturity = clamp01(cumNow / totalTouches);
    const win = 0.06;
    const recent =
      (cumNow - cumAt(cumTotal, Math.max(0, progress - win))) / Math.max(1, totalTouches * win);
    const activity = clamp01(recent * 1.4);
    flick += dtMs / 1000;
    const ember = 0.84 + 0.16 * Math.sin(flick * 4.2) + 0.08 * Math.sin(flick * 11);

    const spineLit = clamp01((progress - 0.002) * 40);
    spineGlow.alpha = spineLit * (0.4 + 0.6 * globalMaturity) * ember * params.glow;
    spineCore.alpha = spineLit * (0.6 + 0.4 * globalMaturity) * ember;
    spokeGlow.alpha = globalMaturity * 0.5 * ember * params.glow;
    spokeCore.alpha = globalMaturity * 0.7;

    for (const ru of runes) {
      const born = progress * real.spanSec >= ru.birthSec;
      ru.revealed = born;
      const lit = born
        ? clamp01((progress * real.spanSec - ru.birthSec) / (real.spanSec * 0.02))
        : 0;
      const maturity = born ? clamp01(cumAt(ru.cum, progress) / ru.total) : 0;
      const cf = ru.corrupt ? 0.7 + 0.3 * Math.sin(flick * 7 + ru.birthSec) : 1;
      ru.gCore.alpha = lit * (0.4 + 0.6 * maturity) * ember * cf;
      ru.gGlow.alpha = lit * (0.5 + 0.5 * maturity) * ember * cf * params.glow;
      if (born && !reducedMotion && rng() < activity * params.sparks * 0.12 + 0.006) {
        const sp = ru.seedPts[(Math.random() * ru.seedPts.length) | 0];
        if (sp) spawnSpark(sp);
      }
    }

    for (let i = sparks.length - 1; i >= 0; i--) {
      const sp = sparks[i]!;
      sp.life += dtMs;
      const k = sp.life / sp.max;
      if (k >= 1) {
        sp.sprite.destroy();
        sparks.splice(i, 1);
        continue;
      }
      sp.sprite.x += (sp.vx * dtMs) / 1000;
      sp.sprite.y += (sp.vy * dtMs) / 1000;
      sp.sprite.alpha = (1 - k) * 0.8 * params.sparks;
    }

    const cw = chrome.contentWidth(app.screen.width);
    const ch = chrome.contentHeight(app.screen.height);
    const cx = cw / 2;
    const cy = ch / 2;
    const fit = (Math.min(cw, ch) * 0.4) / R0;
    const grow = 0.64 + 0.36 * globalMaturity + 0.008 * Math.sin(flick * 1.3);
    const scl = fit * grow;
    for (const layer of [glowLayer, coreLayer, sparkLayer]) {
      layer.position.set(cx, cy);
      layer.scale.set(scl);
    }
    const blur = glowLayer.filters?.[0] as BlurFilter | undefined;
    if (blur) blur.strength = 14 * params.bloom;

    bgGlow.position.set(cx, cy);
    bgGlow.scale.set((Math.max(cw, ch) * 1.7) / 128);
    bgGlow.alpha = (0.12 + 0.14 * globalMaturity) * ember;
    vignette.position.set(cx, cy);
    vignette.scale.set((Math.max(cw, ch) * 1.3) / 256);
    grainScroll += dtMs * 0.03;
    grain.width = cw;
    grain.height = ch;
    grain.tilePosition.set((grainScroll % 128) | 0, ((grainScroll * 0.7) % 128) | 0);
    grain.alpha = 0.08 * params.grain;

    const bornCount = runes.filter((r) => r.revealed).length;
    chrome.update(dtMs, app.screen.width, app.screen.height, progress, [
      ["runes", `${bornCount}/${runes.length}`],
      ["palette", paletteName],
      ["files", real.paths.length],
      ["age", `${ageYears.toFixed(1)}y`],
    ]);
    hud.update(dtMs, `${paletteName} · ${runes.length} runes · ${contributorCount} contributors`);
  };

  app.ticker.add(tick);

  return {
    destroy() {
      boot.destroy();
    },
    transport,
    capture: makeCaptureHandle(app, {
      title: real.repo,
      history: real.chromeHistory,
      accent: accentCol,
      setChromeHidden: (b) => chrome.setHidden(b),
      setHudVisible: (b) => hud.setVisible(b),
    }),
    controls: [
      {
        key: "speed",
        label: "playback speed (also ↑/↓)",
        kind: "range",
        min: 0.25,
        max: 8,
        step: 0.25,
        value: 1,
        set: (v) => {
          speed = v as number;
        },
      },
      {
        key: "glow",
        label: "ember glow",
        kind: "range",
        min: 0,
        max: 2,
        step: 0.1,
        value: 1,
        set: (v) => {
          params.glow = v as number;
        },
      },
      {
        key: "bloom",
        label: "bloom",
        kind: "range",
        min: 0,
        max: 2,
        step: 0.1,
        value: 1,
        set: (v) => {
          params.bloom = v as number;
        },
      },
      {
        key: "sparks",
        label: "sparks",
        kind: "range",
        min: 0,
        max: 2,
        step: 0.1,
        value: 1,
        set: (v) => {
          params.sparks = v as number;
        },
      },
      {
        key: "grain",
        label: "grain",
        kind: "range",
        min: 0,
        max: 2,
        step: 0.1,
        value: 1,
        set: (v) => {
          params.grain = v as number;
        },
      },
    ],
  };
}
