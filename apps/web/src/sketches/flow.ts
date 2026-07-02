/**
 * Flow: the repo as a flowing painting whose CURRENTS are its structure. Each
 * major top-level directory is a vortex (swirl centre) sized by its share of
 * the code and spun by a seeded direction; particles advect around these eddies
 * so the shape of the flow is the shape of the repo. Trails accumulate in a
 * feedback buffer into smeared light-ribbons, colored by the languages and
 * weighted by the language mix at the current moment. Bloomed, grained.
 */
import { mulberry32, type Rng } from "@repomentary/artifact";
import {
  BlurFilter,
  Container,
  Graphics,
  RenderTexture,
  Sprite,
  Text,
  Texture,
  TilingSprite,
} from "pixi.js";
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
  FrameGovernor,
  makeCaptureHandle,
  makeGlowTexture,
  requestRebuildSeek,
  type SketchInstance,
  type Transport,
} from "./common";

const INK = 0xe8ecff;
const PLAY_SECONDS = 110;
const SLICES = 120;

const LANG_COLORS: Record<string, number> = {
  js: 0xf7df5e,
  jsx: 0xf7df5e,
  mjs: 0xf7df5e,
  cjs: 0xf7df5e,
  ts: 0x4d9bff,
  tsx: 0x4d9bff,
  json: 0xb5b5c8,
  py: 0x5ec8ff,
  rb: 0xff5a5a,
  go: 0x5adcff,
  rs: 0xff8a4a,
  java: 0xff7a3a,
  c: 0x8aa0ff,
  cpp: 0x8aa0ff,
  h: 0x8aa0ff,
  cs: 0x9b6bff,
  php: 0x9b8aff,
  css: 0x4ad6c0,
  scss: 0xff6ad5,
  html: 0xff7a45,
  svelte: 0xff6a3d,
  vue: 0x57e08a,
  md: 0x9aa3bd,
  yml: 0xe0a85a,
  yaml: 0xe0a85a,
  sh: 0x7ae07a,
  svg: 0xd06aff,
  scala: 0xff5a4a,
  kt: 0xc06aff,
  swift: 0xff7a4a,
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
const topSeg = (p: string): string => {
  const i = p.indexOf("/");
  return i === -1 ? "·root" : p.slice(0, i);
};
const extOf = (p: string): string => {
  const f = p.slice(p.lastIndexOf("/") + 1);
  const d = f.lastIndexOf(".");
  return d === -1 ? "·" : f.slice(d + 1).toLowerCase();
};
const langColor = (e: string): number => LANG_COLORS[e] ?? hslToInt(hashStr(e) % 360, 0.7, 0.62);

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
      size * 0.34,
      size / 2,
      size / 2,
      size / 2,
    );
    g.addColorStop(0, "rgba(0,0,0,0)");
    g.addColorStop(0.7, "rgba(0,0,0,0.12)");
    g.addColorStop(1, "rgba(0,0,0,0.7)");
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, size, size);
  }
  return Texture.from(canvas);
}

interface Particle {
  x: number;
  y: number;
  px: number;
  py: number;
  age: number;
  life: number;
  color: number;
  speed: number;
  heat: number;
}
interface Vortex {
  nx: number; // offset from centre, in units of rad
  ny: number;
  spin: number;
  share: number;
  birthSec: number;
  cum: number[];
  total: number;
  color: number;
  core: Sprite;
  name: string;
  label: Text;
}

export async function createSketch(
  host: HTMLElement,
  signal?: AbortSignal,
): Promise<SketchInstance> {
  const boot = await bootPixi(host, "#080a12");
  if (signal?.aborted) {
    boot.destroy();
    throw new DOMException("cancelled", "AbortError");
  }
  const { app, world, ui, hud, reducedMotion } = boot;

  const loadingText = new Text({
    text: `pouring flow… (${REPO_DATASETS.find((d) => d.id === getDatasetId())?.label ?? "repo"})`,
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

  const params = { glow: 1, grain: 1, trails: 1, flow: 1, commitSparks: true };
  const seed = hashStr(real.repo);
  const rng: Rng = mulberry32(seed);
  const governor = new FrameGovernor();
  const sliceSec = real.spanSec / SLICES;

  /* ----------------- per-directory data + language mix ----------------- */

  interface SegData {
    files: Set<number>;
    touch: number[];
    birth: number;
    lang: Map<string, number>;
  }
  const segs = new Map<string, SegData>();
  const langTotals = new Map<string, number>();
  const cumTotal = new Array<number>(SLICES).fill(0);
  for (const c of real.commits) {
    const slice = Math.min(SLICES - 1, Math.floor(c.t / sliceSec));
    for (const [, idx] of c.changes) {
      const path = real.paths[idx] ?? "";
      const k = topSeg(path);
      let d = segs.get(k);
      if (!d) {
        d = {
          files: new Set(),
          touch: new Array(SLICES).fill(0),
          birth: real.spanSec,
          lang: new Map(),
        };
        segs.set(k, d);
      }
      d.files.add(idx);
      d.touch[slice] = (d.touch[slice] ?? 0) + 1;
      if (c.t < d.birth) d.birth = c.t;
      const e = extOf(path);
      d.lang.set(e, (d.lang.get(e) ?? 0) + 1);
      langTotals.set(e, (langTotals.get(e) ?? 0) + 1);
      cumTotal[slice] = (cumTotal[slice] ?? 0) + 1;
    }
  }
  for (let i = 1; i < SLICES; i++) cumTotal[i] = (cumTotal[i] ?? 0) + (cumTotal[i - 1] ?? 0);
  const totalTouches = Math.max(1, cumTotal[SLICES - 1] ?? 1);
  const topLangs = [...langTotals.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([e]) => e);
  const langCum: Record<string, number[]> = {};
  for (const e of topLangs) langCum[e] = new Array<number>(SLICES).fill(0);
  for (const c of real.commits) {
    const slice = Math.min(SLICES - 1, Math.floor(c.t / sliceSec));
    for (const [, idx] of c.changes) {
      const e = extOf(real.paths[idx] ?? "");
      if (langCum[e]) langCum[e][slice] = (langCum[e][slice] ?? 0) + 1;
    }
  }
  for (const e of topLangs) {
    const arr = langCum[e]!;
    for (let i = 1; i < SLICES; i++) arr[i] = (arr[i] ?? 0) + (arr[i - 1] ?? 0);
  }
  const dominant = topLangs[0] ?? "·";

  const ranked = [...segs.entries()]
    .sort((a, b) => b[1].files.size - a[1].files.size || (a[0] < b[0] ? -1 : 1))
    .slice(0, 6);
  const maxFiles = Math.max(1, ranked[0]?.[1].files.size ?? 1);

  function cumAt(cum: number[], p: number): number {
    const f = p * (SLICES - 1);
    const i = Math.min(SLICES - 1, Math.floor(f));
    const j = Math.min(SLICES - 1, i + 1);
    const fr = f - i;
    return (cum[i] ?? 0) * (1 - fr) + (cum[j] ?? 0) * fr;
  }

  /* ------------------------------ layers ------------------------------ */

  const glowTex = makeGlowTexture(64);
  const trailSprite = new Sprite(Texture.EMPTY);
  const bloomSprite = new Sprite(Texture.EMPTY);
  bloomSprite.blendMode = "add";
  bloomSprite.filters = [new BlurFilter({ strength: 16, quality: 2, resolution: 0.4 })];
  const coreLayer = new Container();
  coreLayer.blendMode = "add";
  const vignette = new Sprite(makeVignetteTexture(256));
  vignette.anchor.set(0.5);
  vignette.blendMode = "multiply";
  const grain = new TilingSprite({ texture: makeGrainTexture(128), width: 8, height: 8 });
  grain.blendMode = "overlay";
  world.addChild(trailSprite, bloomSprite, coreLayer, vignette, grain);

  let labelsOn = false;
  const labelLayer = new Container();
  ui.addChild(labelLayer);

  // vortices = directories
  const vortices: Vortex[] = ranked.map(([segName, d], rank) => {
    let lang = "·";
    let bestN = -1;
    for (const [e, n] of d.lang) {
      if (n > bestN) {
        bestN = n;
        lang = e;
      }
    }
    const cum = new Array<number>(SLICES).fill(0);
    let run = 0;
    for (let i = 0; i < SLICES; i++) {
      run += d.touch[i] ?? 0;
      cum[i] = run;
    }
    // biggest dir is the central eddy; the rest ring around it
    let nx = 0;
    let ny = 0;
    if (rank > 0) {
      const a = ((rank - 1) / Math.max(1, ranked.length - 1)) * Math.PI * 2 + (seed % 628) / 100;
      nx = Math.cos(a) * 0.42;
      ny = Math.sin(a) * 0.42;
    }
    const core = new Sprite(glowTex);
    core.anchor.set(0.5);
    core.blendMode = "add";
    core.tint = langColor(lang);
    core.alpha = 0;
    coreLayer.addChild(core);
    const label = new Text({
      text: segName === "·root" ? "(root)" : segName,
      style: { fontFamily: "monospace", fontSize: 12, fontWeight: "bold", fill: 0xffffff },
    });
    label.anchor.set(0.5, 1);
    label.alpha = 0;
    labelLayer.addChild(label);
    return {
      nx,
      ny,
      spin: hashStr(`${segName}/spin`) % 2 ? 1 : -1,
      share: Math.sqrt(d.files.size / maxFiles),
      birthSec: d.birth,
      cum,
      total: Math.max(1, run),
      color: langColor(lang),
      core,
      name: segName,
      label,
    };
  });

  // language legend (color -> language), hidden by default
  const legend = new Container();
  legend.alpha = 0;
  ui.addChild(legend);
  topLangs.forEach((e, i) => {
    const dot = new Sprite(glowTex);
    dot.anchor.set(0.5);
    dot.tint = langColor(e);
    dot.scale.set(0.16);
    dot.position.set(8, i * 18 + 8);
    const t = new Text({
      text: `.${e}`,
      style: { fontFamily: "monospace", fontSize: 11, fill: 0xc9d4ff },
    });
    t.anchor.set(0, 0.5);
    t.position.set(20, i * 18 + 8);
    legend.addChild(dot, t);
  });

  // detached layers for the feedback buffer
  const fadeQuad = new Graphics();
  const pgfx = new Graphics();
  pgfx.blendMode = "add";
  let rt: RenderTexture | null = null;
  let rtW = 0;
  let rtH = 0;
  const ensureRT = (w: number, h: number) => {
    if (rt && rtW === w && rtH === h) return;
    rt?.destroy(true);
    rt = RenderTexture.create({ width: w, height: h, resolution: 1 });
    rtW = w;
    rtH = h;
    trailSprite.texture = rt;
    bloomSprite.texture = rt;
    fadeQuad.clear().rect(0, 0, w, h).fill({ color: 0x000000, alpha: 1 });
  };

  /* ----------------------------- particles ----------------------------- */

  const MAX = 1900;
  const particles: Particle[] = [];
  let cx = 0;
  let cy = 0;
  let cw = 0;
  let ch = 0;
  let rad = 300;

  // active vortices for the current frame (set in tick, read by field)
  let active: { vx: number; vy: number; str: number; spin: number }[] = [];
  const baseSwirl = rng() > 0.5 ? 1 : -1;

  const field = (x: number, y: number): number => {
    let fx = 0;
    let fy = 0;
    for (const v of active) {
      const dx = x - v.vx;
      const dy = y - v.vy;
      const d2 = dx * dx + dy * dy;
      const r = Math.sqrt(d2) + 1;
      const inf = v.str / (1 + d2 / (rad * rad * 0.18));
      // tangential (swirl) + slight inward pull
      fx += ((-dy / r) * v.spin + (-dx / r) * 0.25) * inf;
      fy += ((dx / r) * v.spin + (-dy / r) * 0.25) * inf;
    }
    // gentle global drift so empty regions still move
    const gx = x - cx;
    const gy = y - cy;
    const gr = Math.hypot(gx, gy) + 1;
    fx += (-gy / gr) * baseSwirl * 0.12;
    fy += (gx / gr) * baseSwirl * 0.12;
    return Math.atan2(fy, fx);
  };

  const pickLang = (p: number): string => {
    let total = 0;
    const w: number[] = [];
    for (const e of topLangs) {
      const v = cumAt(langCum[e]!, p);
      w.push(v);
      total += v;
    }
    if (total <= 0) return dominant;
    let r = rng() * total;
    for (let i = 0; i < topLangs.length; i++) {
      r -= w[i] ?? 0;
      if (r <= 0) return topLangs[i] ?? dominant;
    }
    return dominant;
  };
  const spawn = (pr: Particle, p: number) => {
    pr.x = rng() * cw;
    pr.y = rng() * ch;
    pr.px = pr.x;
    pr.py = pr.y;
    pr.age = 0;
    pr.life = 80 + rng() * 240;
    pr.speed = 0.6 + rng() * 1.0;
    pr.color = langColor(pickLang(p));
    pr.heat = 0;
  };

  /* ------------------------------ chrome ------------------------------ */

  const chrome = new FilmChrome(ui, real.chromeHistory, {
    repoName: real.repo,
    accent: langColor(dominant),
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
  let needsClear = true;
  let commitCursor = 0;
  const sparks: Particle[] = [];
  const vortexByName = new Map<string, Vortex>();
  for (const v of vortices) vortexByName.set(v.name, v);
  const commitDirSeg = (ci: number): string =>
    topSeg(real.paths[real.commits[ci]?.changes[0]?.[1] ?? 0] ?? "");
  const commitLang = (ci: number): string =>
    extOf(real.paths[real.commits[ci]?.changes[0]?.[1] ?? 0] ?? "");

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
    if (f < progress) needsClear = true;
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

  /* ------------------------------- loop ------------------------------- */

  const tick = () => {
    const dtMs = Math.min(app.ticker.deltaMS, 50);
    governor.update(dtMs);
    if (!paused && progress < 1)
      progress = clamp01(progress + (dtMs / 1000) * (speed / PLAY_SECONDS));
    feedTo(progress * real.spanSec);

    cw = chrome.contentWidth(app.screen.width);
    ch = chrome.contentHeight(app.screen.height);
    cx = cw / 2;
    cy = ch / 2;
    rad = Math.min(cw, ch) * 0.5;
    ensureRT(Math.max(2, Math.floor(cw)), Math.max(2, Math.floor(ch)));
    trailSprite.position.set(0, 0);
    bloomSprite.position.set(0, 0);
    bloomSprite.alpha = 0.5 * params.glow;

    const cumNow = cumAt(cumTotal, progress);
    const win = 0.05;
    const recent =
      (cumNow - cumAt(cumTotal, Math.max(0, progress - win))) / Math.max(1, totalTouches * win);
    const activity = clamp01(0.2 + recent * 1.1);
    const nowSec = progress * real.spanSec;

    // build active vortices + update their core glows
    active = [];
    for (const v of vortices) {
      const born = nowSec >= v.birthSec;
      const bornRamp = born ? clamp01((nowSec - v.birthSec) / (real.spanSec * 0.04)) : 0;
      const str = v.share * bornRamp;
      const vx = cx + v.nx * rad;
      const vy = cy + v.ny * rad;
      if (str > 0.02) active.push({ vx, vy, str, spin: v.spin });
      const mat = born ? clamp01(cumAt(v.cum, progress) / v.total) : 0;
      v.core.position.set(vx, vy);
      v.core.alpha = bornRamp * (0.12 + 0.3 * mat) * (0.6 + 0.4 * activity) * params.glow;
      v.core.scale.set(
        ((rad * (0.18 + 0.22 * v.share)) / 64) * (0.9 + 0.2 * Math.sin(progress * 30 + v.nx)),
      );
    }

    const target = Math.floor(MAX * governor.scale);
    while (particles.length < target) {
      const pr: Particle = {
        x: 0,
        y: 0,
        px: 0,
        py: 0,
        age: 0,
        life: 0,
        color: 0xffffff,
        speed: 1,
        heat: 0,
      };
      spawn(pr, progress);
      particles.push(pr);
    }

    // commit sparks: each real commit fires a bright particle at its dir's swirl
    {
      let i = commitCursor;
      while (i < real.commits.length && (real.commits[i]?.t ?? Infinity) <= nowSec) i++;
      const count = i - commitCursor;
      if (params.commitSparks && count > 0 && count <= 40) {
        for (let k = commitCursor; k < i; k++) {
          const v = vortexByName.get(commitDirSeg(k));
          if (!v) continue;
          const vx = cx + v.nx * rad;
          const vy = cy + v.ny * rad;
          if (sparks.length < 600) {
            sparks.push({
              x: vx + (rng() - 0.5) * 14,
              y: vy + (rng() - 0.5) * 14,
              px: vx,
              py: vy,
              age: 0,
              life: 55 + rng() * 45,
              color: langColor(commitLang(k)),
              speed: 0.8 + rng() * 0.6,
              heat: 1,
            });
          }
        }
      }
      commitCursor = i;
    }

    if (rt) {
      const renderer = app.renderer;
      if (needsClear) {
        renderer.render({ container: fadeQuad, target: rt, clear: true });
        needsClear = false;
        sparks.length = 0;
        let ci = 0;
        while (ci < real.commits.length && (real.commits[ci]?.t ?? Infinity) <= nowSec) ci++;
        commitCursor = ci;
      } else {
        // higher fade => reaches a steady flowing state instead of saturating
        fadeQuad.alpha = clamp01(0.06 / Math.max(0.4, params.trails));
        renderer.render({ container: fadeQuad, target: rt, clear: false });
      }

      pgfx.clear();
      const margin = 90;
      const step = (paused ? 0.25 : 1) * (0.7 + speed * 0.16);
      for (const pr of particles) {
        pr.px = pr.x;
        pr.py = pr.y;
        const ang = field(pr.x, pr.y);
        const sp = pr.speed * step * 2.4 * params.flow;
        pr.x += Math.cos(ang) * sp;
        pr.y += Math.sin(ang) * sp;
        pr.age += 1;
        if (pr.age > pr.life || pr.x < -10 || pr.x > cw + 10 || pr.y < -10 || pr.y > ch + 10) {
          spawn(pr, progress);
          continue;
        }
        // soft fade near any frame edge -> no hard cutout
        const edge = clamp01(Math.min(pr.x, cw - pr.x, pr.y, ch - pr.y) / margin);
        const a = (0.06 + 0.3 * activity) * edge * Math.min(1, pr.age / 8);
        if (a <= 0.002) continue;
        pgfx
          .moveTo(pr.px, pr.py)
          .lineTo(pr.x, pr.y)
          .stroke({ width: 1.3, color: pr.color, alpha: a, cap: "round" });
      }
      // bright commit sparks on top of the field
      for (let i = sparks.length - 1; i >= 0; i--) {
        const sp = sparks[i]!;
        sp.px = sp.x;
        sp.py = sp.y;
        const ang = field(sp.x, sp.y);
        const spd = sp.speed * step * 2.4 * params.flow;
        sp.x += Math.cos(ang) * spd;
        sp.y += Math.sin(ang) * spd;
        sp.age += 1;
        sp.heat = 1 - sp.age / sp.life;
        if (sp.age > sp.life || sp.x < -10 || sp.x > cw + 10 || sp.y < -10 || sp.y > ch + 10) {
          sparks.splice(i, 1);
          continue;
        }
        const edge = clamp01(Math.min(sp.x, cw - sp.x, sp.y, ch - sp.y) / 90);
        const a = (0.2 + 0.55 * sp.heat) * edge;
        pgfx
          .moveTo(sp.px, sp.py)
          .lineTo(sp.x, sp.y)
          .stroke({ width: 0.9 + sp.heat * 0.8, color: sp.color, alpha: a, cap: "round" });
      }
      renderer.render({ container: pgfx, target: rt, clear: false });
    }

    vignette.position.set(cx, cy);
    vignette.scale.set((Math.max(cw, ch) * 1.35) / 256);
    grainScroll += dtMs * 0.03;
    grain.width = cw;
    grain.height = ch;
    grain.tilePosition.set((grainScroll % 128) | 0, ((grainScroll * 0.7) % 128) | 0);
    grain.alpha = 0.07 * params.grain;

    // labels: directory name at each born current; language legend
    for (const v of vortices) {
      const born = nowSec >= v.birthSec;
      v.label.visible = labelsOn && born;
      if (labelsOn && born) {
        v.label.position.set(
          cx + v.nx * rad,
          cy + v.ny * rad - (rad * (0.1 + 0.12 * v.share) + 6) * 0.7,
        );
        v.label.alpha = 0.9;
      }
    }
    legend.alpha += ((labelsOn ? 0.85 : 0) - legend.alpha) * Math.min(1, dtMs / 200);
    legend.position.set(14, 86);

    chrome.update(dtMs, app.screen.width, app.screen.height, progress, [
      ["currents", `${active.length}/${vortices.length}`],
      ["palette", `.${dominant}`],
      ["languages", topLangs.length],
    ]);
    hud.update(dtMs, `flow · ${active.length} currents · ${particles.length} particles`);
  };

  const onKey = (ev: KeyboardEvent) => {
    if (ev.code === "KeyT") labelsOn = !labelsOn;
  };
  window.addEventListener("keydown", onKey);

  app.ticker.add(tick);

  return {
    destroy() {
      window.removeEventListener("keydown", onKey);
      rt?.destroy(true);
      fadeQuad.destroy();
      pgfx.destroy();
      glowTex.destroy(true);
      boot.destroy();
    },
    transport,
    capture: makeCaptureHandle(app, {
      title: real.repo,
      history: real.chromeHistory,
      accent: langColor(dominant),
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
        key: "commitSparks",
        label: "commit sparks",
        kind: "toggle",
        value: true,
        set: (v) => {
          params.commitSparks = v as boolean;
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
        key: "flow",
        label: "flow speed",
        kind: "range",
        min: 0.2,
        max: 2.5,
        step: 0.1,
        value: 1,
        set: (v) => {
          params.flow = v as number;
        },
      },
      {
        key: "trails",
        label: "trail length",
        kind: "range",
        min: 0.4,
        max: 2,
        step: 0.1,
        value: 1,
        set: (v) => {
          params.trails = v as number;
        },
      },
      {
        key: "glow",
        label: "bloom",
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
