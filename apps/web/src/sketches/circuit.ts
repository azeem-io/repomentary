/**
 * Circuit: the repo as a dense printed circuit board. A central CPU (labelled
 * with the repo name) is the source and grows as the repo grows; top-level
 * directories are components wired to it, their major sub-folders branch off as
 * smaller components, and each upgrades (flash + grow: LED -> capacitor ->
 * resistor -> crystal -> IC) as its folder accrues code. Every commit fires a
 * current pulse from the CPU; the pulse runs beneath the solid components.
 * Releases are SMD packages ringing the CPU. Camera zooms out as it grows.
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
  requestRebuildSeek,
  type SketchInstance,
  type Transport,
} from "./common";

const INK = 0xe8ecff;
const COPPER = 0xc8a23c;
const COPPER_HI = 0xffe6a0;
const CURRENT = 0x55ffe0;
const BODY = 0x0a1411;
const PLAY_SECONDS = 110;
const SLICES = 120;
const RP = 300;
const RS = 540;
const ZMAX = 2.2;
const TIER_T = [0, 40, 150, 500, 1500];
const TIER_TYPE = ["led", "capacitor", "resistor", "crystal", "ic"] as const;

const LANG_HUE: Record<string, number> = {
  js: 48,
  jsx: 48,
  mjs: 48,
  cjs: 48,
  ts: 212,
  tsx: 212,
  json: 280,
  py: 205,
  rb: 355,
  go: 186,
  rs: 24,
  java: 18,
  c: 225,
  cpp: 225,
  h: 225,
  cs: 265,
  php: 255,
  css: 168,
  scss: 320,
  html: 18,
  svelte: 12,
  vue: 148,
  md: 295,
  yml: 40,
  yaml: 40,
  sh: 132,
  svg: 286,
  dart: 188,
};

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
  const ar = (a >> 16) & 0xff,
    ag = (a >> 8) & 0xff,
    ab = a & 0xff;
  const br = (b >> 16) & 0xff,
    bg = (b >> 8) & 0xff,
    bb = b & 0xff;
  return (
    (Math.round(ar + (br - ar) * k) << 16) |
    (Math.round(ag + (bg - ag) * k) << 8) |
    Math.round(ab + (bb - ab) * k)
  );
}
const seg1Of = (p: string): string => {
  const i = p.indexOf("/");
  return i === -1 ? "·root" : p.slice(0, i);
};
const seg2Of = (p: string): string | null => {
  const parts = p.split("/");
  return parts.length >= 2 ? `${parts[0]}/${parts[1]}` : null;
};
const lastSeg = (k: string): string => k.split("/").slice(-1)[0] ?? k;
const extOf = (p: string): string => {
  const f = p.slice(p.lastIndexOf("/") + 1);
  const d = f.lastIndexOf(".");
  return d === -1 ? "·" : f.slice(d + 1).toLowerCase();
};
const tierOf = (cum: number): number => {
  let t = 0;
  for (let i = TIER_T.length - 1; i >= 0; i--) {
    if (cum >= (TIER_T[i] ?? 0)) {
      t = i;
      break;
    }
  }
  return t;
};

function makeGrainTexture(size = 128): Texture {
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d");
  if (ctx) {
    const img = ctx.createImageData(size, size);
    for (let i = 0; i < img.data.length; i += 4) {
      const v = 112 + Math.floor(Math.random() * 48);
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
      size * 0.32,
      size / 2,
      size / 2,
      size / 2,
    );
    g.addColorStop(0, "rgba(0,0,0,0)");
    g.addColorStop(0.72, "rgba(0,0,0,0.12)");
    g.addColorStop(1, "rgba(0,0,0,0.78)");
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, size, size);
  }
  return Texture.from(canvas);
}

type Pt = { x: number; y: number };
interface Comp {
  key: string;
  name: string;
  depth: number;
  parent: Comp | null;
  vx: number;
  vy: number;
  ang: number;
  lang: number;
  birthSec: number;
  cum: number[];
  born: boolean;
  heat: number;
  reveal: number;
  tier: number;
  prevTier: number;
  upgrade: number;
  label: Text;
}
interface Pulse {
  comp: Comp;
  t: number;
  speed: number;
}
interface Rel {
  name: string;
  frac: number;
  vx: number;
  vy: number;
  born: boolean;
  heat: number;
  label: Text;
}

export async function createSketch(
  host: HTMLElement,
  signal?: AbortSignal,
): Promise<SketchInstance> {
  const boot = await bootPixi(host, "#06100c");
  if (signal?.aborted) {
    boot.destroy();
    throw new DOMException("cancelled", "AbortError");
  }
  const { app, world, ui, hud, reducedMotion } = boot;

  const loadingText = new Text({
    text: `etching the board… (${REPO_DATASETS.find((d) => d.id === getDatasetId())?.label ?? "repo"})`,
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

  const params = { glow: 1, grain: 1, current: 1 };
  const rng: Rng = mulberry32(hashStr(real.repo));
  const sliceSec = real.spanSec / SLICES;
  let labelsOn = false;
  let speed = 1;

  /* ----------------------- aggregate level 1 + 2 ----------------------- */

  interface Agg {
    files: Set<number>;
    touch: number[];
    birth: number;
    lang: Map<string, number>;
  }
  const ensure = (m: Map<string, Agg>, k: string): Agg => {
    let a = m.get(k);
    if (!a) {
      a = {
        files: new Set(),
        touch: new Array(SLICES).fill(0),
        birth: real.spanSec,
        lang: new Map(),
      };
      m.set(k, a);
    }
    return a;
  };
  const l1 = new Map<string, Agg>();
  const l2 = new Map<string, Agg>();
  for (const c of real.commits) {
    const s = Math.min(SLICES - 1, Math.floor(c.t / sliceSec));
    for (const [, idx] of c.changes) {
      const path = real.paths[idx] ?? "";
      const e = extOf(path);
      const a1 = ensure(l1, seg1Of(path));
      a1.files.add(idx);
      a1.touch[s] = (a1.touch[s] ?? 0) + 1;
      if (c.t < a1.birth) a1.birth = c.t;
      a1.lang.set(e, (a1.lang.get(e) ?? 0) + 1);
      const k2 = seg2Of(path);
      if (k2) {
        const a2 = ensure(l2, k2);
        a2.files.add(idx);
        a2.touch[s] = (a2.touch[s] ?? 0) + 1;
        if (c.t < a2.birth) a2.birth = c.t;
        a2.lang.set(e, (a2.lang.get(e) ?? 0) + 1);
      }
    }
  }
  const primaries = [...l1.entries()]
    .sort((a, b) => b[1].files.size - a[1].files.size || (a[0] < b[0] ? -1 : 1))
    .slice(0, 10);
  const primarySet = new Set(primaries.map(([k]) => k));

  const mkLabel = (text: string): Text => {
    const t = new Text({ text, style: { fontFamily: "monospace", fontSize: 9, fill: COPPER_HI } });
    t.anchor.set(0.5, 0);
    t.alpha = 0;
    ui.addChild(t);
    return t;
  };
  const mkComp = (key: string, a: Agg, depth: number, parent: Comp | null): Comp => {
    let lang = "·";
    let bn = -1;
    for (const [e, n] of a.lang) {
      if (n > bn) {
        bn = n;
        lang = e;
      }
    }
    const cum = new Array<number>(SLICES).fill(0);
    let run = 0;
    for (let i = 0; i < SLICES; i++) {
      run += a.touch[i] ?? 0;
      cum[i] = run;
    }
    return {
      key,
      name: lastSeg(key),
      depth,
      parent,
      vx: 0,
      vy: 0,
      ang: 0,
      lang:
        LANG_HUE[lang] !== undefined
          ? hslToInt(LANG_HUE[lang]!, 0.7, 0.6)
          : hslToInt(hashStr(lang) % 360, 0.6, 0.6),
      birthSec: a.birth,
      cum,
      born: false,
      heat: 0,
      reveal: 0,
      tier: -1,
      prevTier: -1,
      upgrade: 0,
      label: mkLabel(lastSeg(key)),
    };
  };

  const comps: Comp[] = [];
  const byKey = new Map<string, Comp>();
  const Np = primaries.length;
  primaries.forEach(([key, a], i) => {
    const comp = mkComp(key, a, 1, null);
    const ang = -Math.PI / 2 + (i / Math.max(1, Np)) * Math.PI * 2;
    comp.ang = ang;
    comp.vx = Math.cos(ang) * RP;
    comp.vy = Math.sin(ang) * RP;
    comps.push(comp);
    byKey.set(key, comp);
  });
  for (const p of comps.filter((c) => c.depth === 1)) {
    const kids = [...l2.entries()]
      .filter(([k, a]) => k.startsWith(`${p.key}/`) && a.files.size >= 4)
      .sort((a, b) => b[1].files.size - a[1].files.size)
      .slice(0, 4);
    const nk = kids.length;
    const spread = Math.min(0.62, ((Math.PI * 2) / Math.max(1, Np)) * 0.85);
    kids.forEach(([key, a], j) => {
      const comp = mkComp(key, a, 2, p);
      const off = nk > 1 ? (j - (nk - 1) / 2) * (spread / (nk - 1)) : 0;
      const ang = p.ang + off;
      comp.ang = ang;
      comp.vx = Math.cos(ang) * RS;
      comp.vy = Math.sin(ang) * RS;
      comps.push(comp);
      byKey.set(key, comp);
    });
  }
  const routeOf = (path: string): Comp | null => {
    const k2 = seg2Of(path);
    if (k2 && byKey.has(k2)) return byKey.get(k2)!;
    const k1 = seg1Of(path);
    if (primarySet.has(k1)) return byKey.get(k1) ?? null;
    return null;
  };

  const rels: Rel[] = real.tags.map((t, i) => {
    // drop releases into the empty angular gaps BETWEEN the primary spokes,
    // at inner radii, so a release package never lands on a connection trace.
    const gaps = Math.max(1, Np);
    const gi = i % gaps;
    const ring = Math.floor(i / gaps) % 3;
    const baseAng = -Math.PI / 2 + ((gi + 0.5) / gaps) * Math.PI * 2;
    const ang = baseAng + (rng() - 0.5) * 0.1;
    const r = RP * (0.62 + 0.15 * ring) + (rng() - 0.5) * 18;
    const label = new Text({
      text: t.name,
      style: { fontFamily: "monospace", fontSize: 8, fill: 0xffd98a },
    });
    label.anchor.set(0.5, 0);
    label.alpha = 0;
    ui.addChild(label);
    return {
      name: t.name,
      frac: t.t / real.spanSec,
      vx: Math.cos(ang) * r,
      vy: Math.sin(ang) * r,
      born: false,
      heat: 0,
      label,
    };
  });

  // faint background decor (dead-end traces + pads) for board density
  const decor: { a: Pt; b: Pt }[] = [];
  for (let i = 0; i < 60; i++) {
    const ang = rng() * Math.PI * 2;
    const r = RP * 0.6 + rng() * (RS * 1.1);
    const ax = Math.cos(ang) * r;
    const ay = Math.sin(ang) * r;
    const len = 20 + rng() * 90;
    const horiz = rng() > 0.5;
    decor.push({
      a: { x: ax, y: ay },
      b: { x: ax + (horiz ? len : 0), y: ay + (horiz ? 0 : len) },
    });
  }

  const repoName = (real.repo.split("/")[1] ?? real.repo).toUpperCase();

  /* ------------------------------ layers ------------------------------ */

  const cam = new Container();
  const glowLayer = new Container();
  glowLayer.blendMode = "add";
  glowLayer.filters = [new BlurFilter({ strength: 12, quality: 2, resolution: 0.5 })];
  const glowGfx = new Graphics();
  glowLayer.addChild(glowGfx);
  const coreGfx = new Graphics();
  coreGfx.blendMode = "add";
  const chipGfx = new Graphics();
  const boardGfx = new Graphics();
  // order: board (bottom) -> glow -> trace cores + pulses -> component bodies (top, solid)
  cam.addChild(boardGfx, glowLayer, coreGfx, chipGfx);
  const vignette = new Sprite(makeVignetteTexture(256));
  vignette.anchor.set(0.5);
  vignette.blendMode = "multiply";
  const grain = new TilingSprite({ texture: makeGrainTexture(128), width: 8, height: 8 });
  grain.blendMode = "overlay";
  world.addChild(cam, vignette, grain);

  const cpuLabel = new Text({
    text: repoName,
    style: { fontFamily: "monospace", fontSize: 14, fontWeight: "bold", fill: COPPER_HI },
  });
  cpuLabel.anchor.set(0.5);
  ui.addChild(cpuLabel);

  const chrome = new FilmChrome(ui, real.chromeHistory, {
    repoName: real.repo,
    accent: COPPER_HI,
    reducedMotion,
    clip: world,
    onSeek: (f) => seekTo(f),
  });

  /* ----------------------------- playback ----------------------------- */

  let progress = 0;
  let paused = false;
  let feedCursor = 0;
  let commitCursor = 0;
  let clock = 0;
  let cpuFlash = 0;
  let needReset = false;
  const pulses: Pulse[] = [];
  let camS = ZMAX;
  let camInit = false;

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
    const f = clamp01(frac);
    if (f < progress) needReset = true;
    progress = f;
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

  const onKey = (ev: KeyboardEvent) => {
    if (ev.code === "KeyT") labelsOn = !labelsOn;
  };
  window.addEventListener("keydown", onKey);

  const cumAt = (cum: number[], p: number): number => {
    const f = p * (SLICES - 1);
    const i = Math.min(SLICES - 1, Math.floor(f));
    const j = Math.min(SLICES - 1, i + 1);
    const fr = f - i;
    return (cum[i] ?? 0) * (1 - fr) + (cum[j] ?? 0) * fr;
  };
  const traceTo = (from: Pt, to: Pt): Pt[] => {
    const cham = 30;
    const sdx = Math.sign(to.x - from.x) || 1;
    const sdy = Math.sign(to.y - from.y) || 1;
    return [from, { x: to.x - sdx * cham, y: from.y }, { x: to.x, y: from.y + sdy * cham }, to];
  };
  const compTrace = (c: Comp): Pt[] => {
    const from = c.parent ? { x: c.parent.vx, y: c.parent.vy } : { x: 0, y: 0 };
    return traceTo(from, { x: c.vx, y: c.vy });
  };
  const pulsePath = (c: Comp): Pt[] => {
    if (!c.parent) return compTrace(c);
    return [...compTrace(c.parent), ...compTrace(c).slice(1)];
  };
  const samplePath = (pts: Pt[], t: number): Pt => {
    const segLen: number[] = [];
    let total = 0;
    for (let i = 1; i < pts.length; i++) {
      const l = Math.hypot(pts[i]!.x - pts[i - 1]!.x, pts[i]!.y - pts[i - 1]!.y);
      segLen.push(l);
      total += l;
    }
    let d = clamp01(t) * total;
    for (let i = 1; i < pts.length; i++) {
      const l = segLen[i - 1] ?? 0;
      if (d <= l || i === pts.length - 1) {
        const f = l > 0 ? d / l : 0;
        return {
          x: pts[i - 1]!.x + (pts[i]!.x - pts[i - 1]!.x) * f,
          y: pts[i - 1]!.y + (pts[i]!.y - pts[i - 1]!.y) * f,
        };
      }
      d -= l;
    }
    return pts[pts.length - 1]!;
  };
  const strokePoly = (g: Graphics, pts: Pt[], opt: Parameters<Graphics["stroke"]>[0]) => {
    g.moveTo(pts[0]!.x, pts[0]!.y);
    for (let i = 1; i < pts.length; i++) g.lineTo(pts[i]!.x, pts[i]!.y);
    g.stroke(opt);
  };
  const compSize = (c: Comp, tier = c.tier): number =>
    (c.depth === 1 ? 36 : 23) * (0.62 + 0.12 * Math.max(0, tier)) + (c.depth === 1 ? 6 : 0);

  const drawShape = (type: string, c: Comp, sz: number, a: number) => {
    const edge = mix(COPPER, c.lang, 0.45);
    const lit = c.heat;
    const fillC = mix(BODY, c.lang, 0.1 + 0.5 * lit); // body brightens on commit
    const halo = (0.06 + 0.5 * lit) * a * params.glow;
    const x = c.vx;
    const y = c.vy;
    if (type === "ic") {
      const w = sz * 1.6;
      const h = sz;
      for (let k = 0; k < 5; k++) {
        const px = x - w / 2 + (w * (k + 0.5)) / 5;
        chipGfx.rect(px - 1.2, y - h / 2 - 4, 2.4, 4).fill({ color: COPPER, alpha: 0.8 * a });
        chipGfx.rect(px - 1.2, y + h / 2, 2.4, 4).fill({ color: COPPER, alpha: 0.8 * a });
      }
      chipGfx.roundRect(x - w / 2, y - h / 2, w, h, 3).fill({ color: fillC, alpha: a });
      chipGfx
        .roundRect(x - w / 2, y - h / 2, w, h, 3)
        .stroke({ color: edge, alpha: 0.85 * a, width: 1.4 });
      chipGfx.circle(x - w / 2 + 4, y - h / 2 + 4, 1.4).fill({ color: COPPER_HI, alpha: 0.85 * a });
      glowGfx
        .roundRect(x - w / 2 - 2, y - h / 2 - 2, w + 4, h + 4, 4)
        .fill({ color: c.lang, alpha: halo });
    } else if (type === "resistor") {
      const w = sz * 1.7;
      const h = sz * 0.6;
      chipGfx
        .moveTo(x - w / 2 - 5, y)
        .lineTo(x - w / 2, y)
        .stroke({ color: COPPER, alpha: 0.8 * a, width: 2 });
      chipGfx
        .moveTo(x + w / 2, y)
        .lineTo(x + w / 2 + 5, y)
        .stroke({ color: COPPER, alpha: 0.8 * a, width: 2 });
      chipGfx
        .roundRect(x - w / 2, y - h / 2, w, h, h / 2)
        .fill({ color: mix(0x2a2014, c.lang, 0.25 * lit), alpha: a });
      for (let b = 0; b < 3; b++) {
        const bx = x - w * 0.26 + b * w * 0.26;
        chipGfx
          .rect(bx - 1.6, y - h / 2, 3.2, h)
          .fill({ color: mix(c.lang, 0xffffff, 0.1 * b), alpha: 0.95 * a });
      }
      glowGfx.roundRect(x - w / 2, y - h / 2, w, h, h / 2).fill({ color: c.lang, alpha: halo });
    } else if (type === "capacitor") {
      const r = sz * 0.5;
      chipGfx
        .moveTo(x, y - r - 5)
        .lineTo(x, y - r)
        .stroke({ color: COPPER, alpha: 0.8 * a, width: 2 });
      chipGfx
        .moveTo(x, y + r)
        .lineTo(x, y + r + 5)
        .stroke({ color: COPPER, alpha: 0.8 * a, width: 2 });
      chipGfx.circle(x, y, r).fill({ color: mix(0x10202a, c.lang, 0.25 * lit), alpha: a });
      chipGfx.circle(x, y, r).stroke({ color: edge, alpha: 0.8 * a, width: 1.4 });
      chipGfx.rect(x - r * 0.5, y - r * 0.9, r, 2).fill({ color: COPPER_HI, alpha: 0.7 * a });
      glowGfx.circle(x, y, r + 2).fill({ color: c.lang, alpha: halo });
    } else if (type === "crystal") {
      const w = sz * 1.1;
      const h = sz * 0.8;
      chipGfx
        .moveTo(x - w * 0.25, y + h / 2)
        .lineTo(x - w * 0.25, y + h / 2 + 5)
        .stroke({ color: COPPER, alpha: 0.8 * a, width: 2 });
      chipGfx
        .moveTo(x + w * 0.25, y + h / 2)
        .lineTo(x + w * 0.25, y + h / 2 + 5)
        .stroke({ color: COPPER, alpha: 0.8 * a, width: 2 });
      chipGfx
        .roundRect(x - w / 2, y - h / 2, w, h, h * 0.45)
        .fill({ color: mix(0x1a1f24, c.lang, 0.22 * lit), alpha: a });
      chipGfx
        .roundRect(x - w / 2, y - h / 2, w, h, h * 0.45)
        .stroke({ color: 0x9fb0c0, alpha: 0.75 * a, width: 1.4 });
      glowGfx.roundRect(x - w / 2, y - h / 2, w, h, h * 0.45).fill({ color: c.lang, alpha: halo });
    } else {
      const r = sz * 0.46;
      chipGfx
        .moveTo(x - 3, y + r)
        .lineTo(x - 3, y + r + 6)
        .stroke({ color: COPPER, alpha: 0.8 * a, width: 2 });
      chipGfx
        .moveTo(x + 3, y + r)
        .lineTo(x + 3, y + r + 4)
        .stroke({ color: COPPER, alpha: 0.8 * a, width: 2 });
      chipGfx.circle(x, y, r).fill({ color: mix(c.lang, 0x05060a, 0.5 - 0.45 * lit), alpha: a });
      chipGfx.circle(x, y, r).stroke({ color: edge, alpha: 0.7 * a, width: 1.2 });
      glowGfx
        .circle(x, y, r * 1.3)
        .fill({ color: c.lang, alpha: (0.12 + 0.8 * c.heat) * a * params.glow });
    }
  };

  const tick = () => {
    const dtMs = Math.min(app.ticker.deltaMS, 50);
    if (!paused && progress < 1)
      progress = clamp01(progress + (dtMs / 1000) * (speed / PLAY_SECONDS));
    feedTo(progress * real.spanSec);
    clock += dtMs / 1000;
    const nowSec = progress * real.spanSec;

    if (needReset) {
      for (const c of comps) {
        c.born = false;
        c.heat = 0;
        c.reveal = 0;
        c.tier = -1;
        c.upgrade = 0;
      }
      for (const r of rels) {
        r.born = false;
        r.heat = 0;
      }
      pulses.length = 0;
      commitCursor = 0;
      camS = ZMAX;
      needReset = false;
    }

    for (const r of rels) {
      if (!r.born && r.frac <= progress) {
        r.born = true;
        r.heat = 1;
        cpuFlash = 1;
      }
      r.heat = Math.max(0, r.heat - dtMs / 800);
    }
    cpuFlash = Math.max(0, cpuFlash - dtMs / 700);

    let budget = 4500;
    let pulseBudget = 36;
    while (commitCursor < real.commits.length && budget > 0) {
      const c = real.commits[commitCursor];
      if (!c || c.t > nowSec) break;
      commitCursor++;
      for (const [, idx] of c.changes) {
        budget--;
        const comp = routeOf(real.paths[idx] ?? "");
        if (!comp) continue;
        if (!comp.born) comp.born = true;
        comp.heat = 1;
        if (pulseBudget > 0 && comp.reveal > 0.4 && pulses.length < 280) {
          pulses.push({ comp, t: 0, speed: 0.8 + rng() * 0.6 });
          pulseBudget--;
        }
      }
    }

    let bornCount = 0;
    let halfX = RP * 0.5;
    let halfY = RP * 0.5;
    for (const c of comps) {
      if (nowSec >= c.birthSec) c.born = true;
      const target = c.born ? 1 : 0;
      c.reveal += (target - c.reveal) * Math.min(1, dtMs / 320);
      c.heat = Math.max(0, c.heat - dtMs / 700);
      c.upgrade = Math.max(0, c.upgrade - dtMs / 950);
      if (!c.born) continue;
      const nt = tierOf(cumAt(c.cum, progress));
      if (nt > c.tier) {
        if (c.tier >= 0) {
          c.prevTier = c.tier;
          c.upgrade = 1;
        }
        c.tier = nt;
        c.heat = 1;
      }
      if (c.reveal > 0.3) {
        bornCount++;
        const sz = compSize(c);
        halfX = Math.max(halfX, Math.abs(c.vx) + sz);
        halfY = Math.max(halfY, Math.abs(c.vy) + sz);
      }
    }
    const growth = clamp01(bornCount / Math.max(1, comps.length));

    const cw = chrome.contentWidth(app.screen.width);
    const ch2 = chrome.contentHeight(app.screen.height);
    const targetS = Math.min((cw * 0.46) / (halfX * 1.08), (ch2 * 0.46) / (halfY * 1.08), ZMAX);
    if (!camInit) {
      camS = targetS;
      camInit = true;
    } else {
      const desired = Math.min(camS, targetS);
      camS += (desired - camS) * Math.min(1, dtMs / 800);
    }
    cam.scale.set(camS);
    cam.position.set(cw / 2, ch2 / 2);

    const ember = 0.9 + 0.1 * Math.sin(clock * 4);
    glowGfx.clear();
    coreGfx.clear();
    chipGfx.clear();
    boardGfx.clear();

    // faint background decor
    for (const d of decor) {
      boardGfx
        .moveTo(d.a.x, d.a.y)
        .lineTo(d.b.x, d.b.y)
        .stroke({ color: 0x123a2a, alpha: 0.35, width: 1 });
      boardGfx.circle(d.b.x, d.b.y, 1.6).fill({ color: 0x14402e, alpha: 0.4 });
    }

    // traces (parent -> comp)
    for (const c of comps) {
      if (c.reveal < 0.02) continue;
      const path = compTrace(c);
      const segLen: number[] = [];
      let total = 0;
      for (let i = 1; i < path.length; i++) {
        const l = Math.hypot(path[i]!.x - path[i - 1]!.x, path[i]!.y - path[i - 1]!.y);
        segLen.push(l);
        total += l;
      }
      const lim = c.reveal * total;
      const drawPts: Pt[] = [path[0]!];
      let acc = 0;
      for (let i = 1; i < path.length; i++) {
        const l = segLen[i - 1] ?? 0;
        if (acc + l <= lim) {
          drawPts.push(path[i]!);
          acc += l;
        } else {
          const f = l > 0 ? (lim - acc) / l : 0;
          drawPts.push({
            x: path[i - 1]!.x + (path[i]!.x - path[i - 1]!.x) * f,
            y: path[i - 1]!.y + (path[i]!.y - path[i - 1]!.y) * f,
          });
          break;
        }
      }
      const glowA = (0.2 + 0.5 * c.heat) * ember * params.glow;
      const wMul = c.depth === 1 ? 1 : 0.7;
      strokePoly(glowGfx, drawPts, {
        width: 5 * wMul,
        color: COPPER,
        alpha: glowA,
        cap: "round",
        join: "round",
      });
      strokePoly(coreGfx, drawPts, {
        width: 1.5 * wMul,
        color: mix(COPPER_HI, 0xffffff, c.heat * 0.5),
        alpha: 0.8 * ember,
        cap: "round",
        join: "round",
      });
    }

    // pulses from the CPU (drawn under the components)
    for (let i = pulses.length - 1; i >= 0; i--) {
      const pu = pulses[i]!;
      pu.t += (dtMs / 1000) * pu.speed * 0.8;
      if (pu.t >= 1 || !pu.comp.born) {
        if (pu.comp.born) pu.comp.heat = Math.min(1, pu.comp.heat + 0.4);
        pulses.splice(i, 1);
        continue;
      }
      const path = pulsePath(pu.comp);
      const head = samplePath(path, pu.t);
      const tail = samplePath(path, Math.max(0, pu.t - 0.05));
      glowGfx
        .moveTo(tail.x, tail.y)
        .lineTo(head.x, head.y)
        .stroke({ width: 6, color: CURRENT, alpha: 0.5 * params.current, cap: "round" });
      coreGfx
        .moveTo(tail.x, tail.y)
        .lineTo(head.x, head.y)
        .stroke({
          width: 2,
          color: mix(CURRENT, 0xffffff, 0.5),
          alpha: 0.95 * params.current,
          cap: "round",
        });
      coreGfx.circle(head.x, head.y, 3).fill({ color: 0xffffff, alpha: params.current });
    }

    // release components (SMD packages scattered off the traces) + labels
    let relBorn = 0;
    for (const r of rels) {
      if (!r.born) continue;
      relBorn++;
      const w = 24;
      const h = 14;
      const lit = mix(0x241a08, 0xffd24a, 0.2 + 0.7 * r.heat);
      chipGfx.roundRect(r.vx - w / 2, r.vy - h / 2, w, h, 2).fill({ color: lit, alpha: 0.98 });
      chipGfx
        .roundRect(r.vx - w / 2, r.vy - h / 2, w, h, 2)
        .stroke({ color: COPPER_HI, alpha: 0.8, width: 1.2 });
      chipGfx.rect(r.vx - w / 2 + 2, r.vy - h / 2, 3, h).fill({ color: 0xffd98a, alpha: 0.9 });
      glowGfx
        .roundRect(r.vx - w / 2 - 2, r.vy - h / 2 - 2, w + 4, h + 4, 3)
        .fill({ color: 0xffd24a, alpha: (0.15 + 0.6 * r.heat) * params.glow });
      r.label.visible = labelsOn;
      if (labelsOn) {
        r.label.position.set(cw / 2 + r.vx * camS, ch2 / 2 + (r.vy + h) * camS);
        r.label.alpha = 0.85;
      }
    }

    // components + labels (drawn last = on top, solid)
    for (const c of comps) {
      if (c.reveal < 0.3) continue;
      const tNew = TIER_TYPE[Math.max(0, c.tier)] ?? "led";
      if (c.upgrade > 0.02 && c.prevTier >= 0 && c.prevTier !== c.tier) {
        // morph: old part dissolves as the new, larger part materialises in place
        const pp = 1 - c.upgrade;
        const szN = compSize(c, c.tier);
        const szO = compSize(c, c.prevTier);
        const sz = szO + (szN - szO) * pp;
        drawShape(TIER_TYPE[c.prevTier] ?? "led", c, sz, c.reveal * c.upgrade);
        drawShape(tNew, c, sz, c.reveal * (1 - c.upgrade));
        glowGfx
          .circle(c.vx, c.vy, sz * (0.85 + (1 - c.upgrade) * 0.8))
          .stroke({ color: 0xffffff, alpha: c.upgrade * 0.55 * params.glow, width: 2 });
      } else {
        drawShape(tNew, c, compSize(c, c.tier), c.reveal);
      }
      c.label.visible = labelsOn && c.reveal > 0.5;
      if (c.label.visible) {
        c.label.position.set(cw / 2 + c.vx * camS, ch2 / 2 + (c.vy + compSize(c) + 2) * camS);
        c.label.alpha = 0.85 * c.reveal;
      }
    }

    // CPU (centre, source) — bigger by default, grows with the repo
    const cpu = 130 + 90 * growth;
    const cpins = 8;
    for (let k = 0; k < cpins; k++) {
      const o = -cpu / 2 + (cpu * (k + 0.5)) / cpins;
      chipGfx.rect(o - 1.3, -cpu / 2 - 6, 2.6, 6).fill({ color: COPPER, alpha: 0.75 });
      chipGfx.rect(o - 1.3, cpu / 2, 2.6, 6).fill({ color: COPPER, alpha: 0.75 });
      chipGfx.rect(-cpu / 2 - 6, o - 1.3, 6, 2.6).fill({ color: COPPER, alpha: 0.75 });
      chipGfx.rect(cpu / 2, o - 1.3, 6, 2.6).fill({ color: COPPER, alpha: 0.75 });
    }
    chipGfx.roundRect(-cpu / 2, -cpu / 2, cpu, cpu, 7).fill({ color: 0x0a1512, alpha: 1 });
    chipGfx
      .roundRect(-cpu / 2, -cpu / 2, cpu, cpu, 7)
      .stroke({ color: COPPER_HI, alpha: 0.95, width: 2 });
    chipGfx
      .roundRect(-cpu * 0.32, -cpu * 0.32, cpu * 0.64, cpu * 0.64, 4)
      .stroke({ color: COPPER, alpha: 0.5, width: 1 });
    chipGfx.circle(-cpu / 2 + 8, -cpu / 2 + 8, 2.2).fill({ color: COPPER_HI, alpha: 0.9 });
    glowGfx
      .roundRect(-cpu / 2, -cpu / 2, cpu, cpu, 7)
      .fill({ color: COPPER, alpha: (0.12 + 0.4 * cpuFlash) * ember * params.glow });
    cpuLabel.position.set(cw / 2, ch2 / 2);
    cpuLabel.scale.set(Math.min(1.4, camS * (cpu / 130)));

    vignette.position.set(cw / 2, ch2 / 2);
    vignette.scale.set((Math.max(cw, ch2) * 1.35) / 256);
    grain.width = cw;
    grain.height = ch2;
    grain.tilePosition.set(((clock * 30) % 128) | 0, ((clock * 21) % 128) | 0);
    grain.alpha = 0.05 * params.grain;

    chrome.update(dtMs, app.screen.width, app.screen.height, progress, [
      ["components", `${bornCount}/${comps.length}`],
      ["releases", `${relBorn}/${rels.length}`],
      ["current", pulses.length],
    ]);
    hud.update(dtMs, `circuit · ${comps.length} components · ${rels.length} releases`);
  };

  app.ticker.add(tick);

  return {
    destroy() {
      window.removeEventListener("keydown", onKey);
      boot.destroy();
    },
    transport,
    capture: makeCaptureHandle(app, {
      title: real.repo,
      history: real.chromeHistory,
      accent: COPPER_HI,
      setChromeHidden: (b) => chrome.setHidden(b),
      setHudVisible: (b) => hud.setVisible(b),
      setLabels: (b) => {
        labelsOn = b;
      },
    }),
    controls: [
      {
        key: "labels",
        label: "labels (also T)",
        kind: "toggle",
        value: false,
        set: (v) => {
          labelsOn = v as boolean;
        },
      },
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
        key: "current",
        label: "current",
        kind: "range",
        min: 0,
        max: 2,
        step: 0.1,
        value: 1,
        set: (v) => {
          params.current = v as number;
        },
      },
      {
        key: "glow",
        label: "copper glow",
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
