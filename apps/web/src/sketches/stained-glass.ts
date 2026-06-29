/**
 * Stained Glass: an ever-expanding leaded mosaic of the whole repo, baked into a
 * high-res texture and viewed through a centre-locked camera that only zooms out
 * as the window grows. Every file is a uniquely-cut jewel shard, cut in when the
 * file is first committed and coloured forever; a commit brightens its own pane.
 * Rippled cathedral-glass texture multiplied over the colour; light bleeds
 * through from a blurred copy behind. Hover (T) to read a file.
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
  requestRebuildSeek,
  type SketchInstance,
  type Transport,
} from "./common";

const INK = 0xe8ecff;
const PLAY_SECONDS = 110;
const MAXP = 8000;
const RW = 1920;
const RH = 1040;
const ZMAX = 1.6;

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
  snap: 332,
  lock: 210,
  txt: 90,
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
const extOf = (p: string): string => {
  const f = p.slice(p.lastIndexOf("/") + 1);
  const d = f.lastIndexOf(".");
  return d === -1 ? "·" : f.slice(d + 1).toLowerCase();
};

// rippled cathedral-glass texture, multiplied over the shard colours (seeds,
// streaks, ripples). Mostly light so multiply mainly imprints darker mottle.
function makeCathedralTexture(size = 256): Texture {
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d");
  if (ctx) {
    const img = ctx.createImageData(size, size);
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        let v =
          212 +
          22 * Math.sin(x * 0.016 + Math.sin(y * 0.009) * 6) +
          14 * Math.sin(y * 0.024 + 1.7) +
          8 * Math.sin((x + y) * 0.013);
        v += (Math.random() - 0.5) * 6;
        v = Math.max(168, Math.min(255, v));
        const i = (y * size + x) * 4;
        img.data[i] = v;
        img.data[i + 1] = v;
        img.data[i + 2] = v;
        img.data[i + 3] = 255;
      }
    }
    ctx.putImageData(img, 0, 0);
    // big, soft, gentle patches (no sharp dots)
    ctx.globalCompositeOperation = "multiply";
    for (let i = 0; i < 26; i++) {
      const x = Math.random() * size;
      const y = Math.random() * size;
      const r = 36 + Math.random() * 90;
      const g = ctx.createRadialGradient(x, y, 0, x, y, r);
      g.addColorStop(0, "rgba(206,206,206,1)");
      g.addColorStop(1, "rgba(255,255,255,1)");
      ctx.fillStyle = g;
      ctx.fillRect(x - r, y - r, r * 2, r * 2);
    }
    ctx.globalCompositeOperation = "source-over";
  }
  return Texture.from(canvas);
}

type Pt = { x: number; y: number };
interface Shard {
  poly: Pt[];
  cx: number;
  cy: number;
  minx: number;
  miny: number;
  maxx: number;
  maxy: number;
  color: number;
  path: string;
  born: boolean;
  heat: number;
}

export async function createSketch(
  host: HTMLElement,
  signal?: AbortSignal,
): Promise<SketchInstance> {
  const boot = await bootPixi(host, "#05060a");
  if (signal?.aborted) {
    boot.destroy();
    throw new DOMException("cancelled", "AbortError");
  }
  const { app, world, ui, hud, reducedMotion } = boot;

  const loadingText = new Text({
    text: `cutting the glass… (${REPO_DATASETS.find((d) => d.id === getDatasetId())?.label ?? "repo"})`,
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

  const params = { glow: 1, texture: 0.3, light: 1 };
  const rng: Rng = mulberry32(hashStr(real.repo));
  let labelsOn = false;

  /* ----------------------- pick files + tessellate ----------------------- */

  const touches = new Float32Array(real.paths.length);
  const birth = new Map<number, number>();
  for (const c of real.commits) {
    for (const [, idx] of c.changes) {
      touches[idx] = (touches[idx] ?? 0) + 1;
      if (!birth.has(idx)) birth.set(idx, c.t);
    }
  }
  const kept = [...real.paths.keys()]
    .filter((i) => (touches[i] ?? 0) > 0)
    .sort((a, b) => (touches[b] ?? 0) - (touches[a] ?? 0))
    .slice(0, MAXP);
  const K = kept.length;

  const cells: { x: number; y: number; w: number; h: number }[] = [];
  const subdivide = (x: number, y: number, w: number, h: number, n: number) => {
    if (n <= 1 || (w < 0.004 && h < 0.004)) {
      cells.push({ x, y, w, h });
      return;
    }
    const n1 = Math.max(1, Math.round(n * (0.42 + rng() * 0.16)));
    const n2 = n - n1;
    const ratio = (n1 / n) * (0.88 + rng() * 0.24);
    if (w >= h) {
      const wl = Math.max(0.003, Math.min(w - 0.003, w * ratio));
      subdivide(x, y, wl, h, n1);
      subdivide(x + wl, y, w - wl, h, n2);
    } else {
      const hl = Math.max(0.003, Math.min(h - 0.003, h * ratio));
      subdivide(x, y, w, hl, n1);
      subdivide(x, y + hl, w, h - hl, n2);
    }
  };
  subdivide(0, 0, 1, 1, Math.max(1, K));
  cells.sort((a, b) => {
    const da = (a.x + a.w / 2 - 0.5) ** 2 + (a.y + a.h / 2 - 0.5) ** 2;
    const db = (b.x + b.w / 2 - 0.5) ** 2 + (b.y + b.h / 2 - 0.5) ** 2;
    return da - db;
  });
  const byBirth = [...kept].sort((a, b) => (birth.get(a) ?? 0) - (birth.get(b) ?? 0));

  const shardOf = new Map<number, Shard>();
  const shards: Shard[] = [];
  for (let i = 0; i < byBirth.length && i < cells.length; i++) {
    const idx = byBirth[i]!;
    const ce = cells[i]!;
    const e = extOf(real.paths[idx] ?? "");
    const hue = LANG_HUE[e] ?? hashStr(e) % 360;
    // wider lightness range + a touch less saturation = less cartoonish
    const color = hslToInt(hue + (rng() - 0.5) * 16, 0.5 + rng() * 0.28, 0.32 + rng() * 0.3);
    const jx = ce.w * 0.07;
    const jy = ce.h * 0.07;
    const poly: Pt[] = [
      { x: (ce.x + (rng() - 0.5) * jx) * RW, y: (ce.y + (rng() - 0.5) * jy) * RH },
      { x: (ce.x + ce.w + (rng() - 0.5) * jx) * RW, y: (ce.y + (rng() - 0.5) * jy) * RH },
      { x: (ce.x + ce.w + (rng() - 0.5) * jx) * RW, y: (ce.y + ce.h + (rng() - 0.5) * jy) * RH },
      { x: (ce.x + (rng() - 0.5) * jx) * RW, y: (ce.y + ce.h + (rng() - 0.5) * jy) * RH },
    ];
    let minx = Infinity;
    let miny = Infinity;
    let maxx = -Infinity;
    let maxy = -Infinity;
    for (const p of poly) {
      minx = Math.min(minx, p.x);
      miny = Math.min(miny, p.y);
      maxx = Math.max(maxx, p.x);
      maxy = Math.max(maxy, p.y);
    }
    const sh: Shard = {
      poly,
      cx: (minx + maxx) / 2,
      cy: (miny + maxy) / 2,
      minx,
      miny,
      maxx,
      maxy,
      color,
      path: real.paths[idx] ?? "",
      born: false,
      heat: 0,
    };
    shards.push(sh);
    shardOf.set(idx, sh);
  }

  /* ------------------------------ layers ------------------------------ */

  const rt = RenderTexture.create({ width: RW, height: RH, resolution: 2 });
  const cam = new Container();
  const blurMosaic = new Sprite(rt);
  blurMosaic.blendMode = "screen";
  blurMosaic.filters = [new BlurFilter({ strength: 26, quality: 2, resolution: 0.3 })];
  const mosaic = new Sprite(rt);
  const glassTex = makeCathedralTexture(512);
  const glassOverlay = new TilingSprite({ texture: glassTex, width: RW, height: RH });
  glassOverlay.blendMode = "multiply";
  glassOverlay.tileScale.set(2.6);
  const flareGfx = new Graphics();
  flareGfx.blendMode = "add";
  cam.addChild(blurMosaic, mosaic, glassOverlay, flareGfx);
  world.addChild(cam);

  const baker = new Graphics();

  // hover tooltip
  const tipBg = new Graphics();
  const tipText = new Text({
    text: "",
    style: { fontFamily: "monospace", fontSize: 12, fill: 0xffffff },
  });
  const tip = new Container();
  tip.addChild(tipBg, tipText);
  tip.visible = false;
  ui.addChild(tip);
  let pointerX = -9999;
  let pointerY = -9999;
  app.stage.eventMode = "static";
  app.stage.hitArea = app.screen;
  app.stage.on("pointermove", (e: { global: { x: number; y: number } }) => {
    pointerX = e.global.x;
    pointerY = e.global.y;
  });

  /* ------------------------------ chrome ------------------------------ */

  const chrome = new FilmChrome(ui, real.chromeHistory, {
    repoName: real.repo,
    accent: 0xcfa9ff,
    reducedMotion,
    clip: world,
    onSeek: (f) => seekTo(f),
  });

  /* ----------------------------- playback ----------------------------- */

  let progress = 0;
  let speed = 1;
  let paused = false;
  let feedCursor = 0;
  let commitCursor = 0;
  let bornCount = 0;
  let needClear = true;
  const bakeQueue: Shard[] = [];
  let flares: Shard[] = [];
  let bbMinX = -1;
  let bbMinY = -1;
  let bbMaxX = -1;
  let bbMaxY = -1;
  let zoom = ZMAX;

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
    if (f < progress) needClear = true;
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

  const bakeShard = (sh: Shard) => {
    const p = sh.poly;
    baker.moveTo(p[0]!.x, p[0]!.y);
    for (let i = 1; i < p.length; i++) baker.lineTo(p[i]!.x, p[i]!.y);
    baker.lineTo(p[0]!.x, p[0]!.y);
    baker.fill({ color: sh.color, alpha: 1 });
    const lead = Math.max(2.5, Math.min(sh.maxx - sh.minx, sh.maxy - sh.miny) * 0.06);
    baker.moveTo(p[0]!.x, p[0]!.y);
    for (let i = 1; i < p.length; i++) baker.lineTo(p[i]!.x, p[i]!.y);
    baker.lineTo(p[0]!.x, p[0]!.y);
    baker.stroke({ color: 0x040308, alpha: 0.96, width: lead, join: "round", cap: "round" });
  };
  const flushBake = (limit: number) => {
    if (bakeQueue.length === 0) return;
    let done = 0;
    baker.clear();
    while (bakeQueue.length > 0 && done < limit) {
      bakeShard(bakeQueue.shift()!);
      done++;
    }
    app.renderer.render({ container: baker, target: rt, clear: false });
    baker.clear();
  };

  const tick = () => {
    const dtMs = Math.min(app.ticker.deltaMS, 50);
    if (!paused && progress < 1)
      progress = clamp01(progress + (dtMs / 1000) * (speed / PLAY_SECONDS));
    feedTo(progress * real.spanSec);
    const nowSec = progress * real.spanSec;

    if (needClear) {
      baker.clear().rect(0, 0, RW, RH).fill({ color: 0x05060a, alpha: 1 });
      app.renderer.render({ container: baker, target: rt, clear: true });
      baker.clear();
      for (const sh of shards) {
        sh.born = false;
        sh.heat = 0;
      }
      bornCount = 0;
      commitCursor = 0;
      bakeQueue.length = 0;
      flares = [];
      bbMinX = bbMinY = bbMaxX = bbMaxY = -1;
      zoom = ZMAX;
      needClear = false;
    }

    // process commits: cut new shards, light up touched ones
    let budget = 5000;
    let flareBudget = 50;
    while (commitCursor < real.commits.length && budget > 0) {
      const c = real.commits[commitCursor];
      if (!c || c.t > nowSec) break;
      commitCursor++;
      for (const [, idx] of c.changes) {
        budget--;
        const sh = shardOf.get(idx);
        if (!sh) continue;
        if (!sh.born) {
          sh.born = true;
          bornCount++;
          bakeQueue.push(sh);
          if (bbMinX < 0) {
            bbMinX = sh.minx;
            bbMinY = sh.miny;
            bbMaxX = sh.maxx;
            bbMaxY = sh.maxy;
          } else {
            bbMinX = Math.min(bbMinX, sh.minx);
            bbMinY = Math.min(bbMinY, sh.miny);
            bbMaxX = Math.max(bbMaxX, sh.maxx);
            bbMaxY = Math.max(bbMaxY, sh.maxy);
          }
        }
        if (flareBudget > 0) {
          if (sh.heat <= 0) flares.push(sh);
          sh.heat = 1;
          flareBudget--;
        }
      }
    }
    flushBake(240);

    const cw = chrome.contentWidth(app.screen.width);
    const ch = chrome.contentHeight(app.screen.height);

    /* camera: centre-locked, zoom-only, monotonic (only out), slow ease */
    if (bbMinX >= 0) {
      const cxr = RW / 2;
      const cyr = RH / 2;
      const halfX = Math.max(RW * 0.07, cxr - bbMinX, bbMaxX - cxr) * 1.06;
      const halfY = Math.max(RH * 0.07, cyr - bbMinY, bbMaxY - cyr) * 1.06;
      const targetZoom = Math.min((cw * 0.94) / (2 * halfX), (ch * 0.94) / (2 * halfY), ZMAX);
      const desired = Math.min(zoom, targetZoom); // never zoom back in
      zoom += (desired - zoom) * Math.min(1, dtMs / 900);
    }
    cam.scale.set(zoom);
    cam.position.set(cw / 2 - (RW / 2) * zoom, ch / 2 - (RH / 2) * zoom);
    blurMosaic.alpha = 0.4 * params.light;
    glassOverlay.alpha = params.texture;

    // flares: brighten the shard's own pane, fading back
    flareGfx.clear();
    const next: Shard[] = [];
    for (const sh of flares) {
      sh.heat = Math.max(0, sh.heat - dtMs / 700);
      if (sh.heat <= 0.01) continue;
      const p = sh.poly;
      flareGfx.moveTo(p[0]!.x, p[0]!.y);
      for (let i = 1; i < p.length; i++) flareGfx.lineTo(p[i]!.x, p[i]!.y);
      flareGfx.lineTo(p[0]!.x, p[0]!.y);
      flareGfx.fill({ color: mix(sh.color, 0xffffff, 0.7), alpha: sh.heat * 0.6 * params.glow });
      next.push(sh);
    }
    flares = next;

    /* hover label */
    let tipMsg: string | null = null;
    if (labelsOn && pointerX > -999 && pointerX < cw) {
      const lx = (pointerX - cam.position.x) / zoom;
      const ly = (pointerY - cam.position.y) / zoom;
      let best = Infinity;
      let bestSh: Shard | null = null;
      for (const sh of shards) {
        if (!sh.born) continue;
        if (lx < sh.minx || lx > sh.maxx || ly < sh.miny || ly > sh.maxy) continue;
        const d = (lx - sh.cx) ** 2 + (ly - sh.cy) ** 2;
        if (d < best) {
          best = d;
          bestSh = sh;
        }
      }
      if (bestSh) tipMsg = bestSh.path;
    }
    if (tipMsg) {
      if (tipText.text !== tipMsg) {
        tipText.text = tipMsg;
        const w = tipText.width + 14;
        const h = tipText.height + 8;
        tipBg.clear().roundRect(0, 0, w, h, 6).fill({ color: 0x07091a, alpha: 0.9 });
        tipBg.roundRect(0, 0, w, h, 6).stroke({ color: INK, alpha: 0.2, width: 1 });
        tipText.position.set(7, 4);
      }
      tip.position.set(
        Math.min(pointerX + 12, cw - tipBg.width - 6),
        Math.max(8, pointerY - tipBg.height - 12),
      );
      tip.visible = true;
    } else {
      tip.visible = false;
    }

    chrome.update(dtMs, app.screen.width, app.screen.height, progress, [
      ["shards", K],
      ["cut", `${bornCount}`],
    ]);
    hud.update(dtMs, `stained glass · ${K} shards`);
  };

  app.ticker.add(tick);

  return {
    destroy() {
      window.removeEventListener("keydown", onKey);
      rt.destroy(true);
      baker.destroy();
      glassTex.destroy(true);
      boot.destroy();
    },
    transport,
    controls: [
      {
        key: "labels",
        label: "hover labels (also T)",
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
        key: "glow",
        label: "commit glow",
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
        key: "texture",
        label: "glass texture",
        kind: "range",
        min: 0,
        max: 1,
        step: 0.05,
        value: 0.3,
        set: (v) => {
          params.texture = v as number;
        },
      },
      {
        key: "light",
        label: "back-light",
        kind: "range",
        min: 0,
        max: 2,
        step: 0.1,
        value: 1,
        set: (v) => {
          params.light = v as number;
        },
      },
    ],
  };
}
