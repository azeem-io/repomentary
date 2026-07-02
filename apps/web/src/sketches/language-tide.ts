/**
 * Tide: a streamgraph of the repo over time, split by language, directory, or
 * author. Centred silhouette bands (inside-out ordered) rise and fall across
 * history so you can read the tech migration, where work moved, or who carried
 * the repo. Smooth bands, glowing bloomed crests, a tidal sway, grain, vignette.
 */
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
const PLAY_SECONDS = 110;
const SLICES = 160;
const TOP = 9;

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
  dart: 0x37b8c4,
  snap: 0xff7aa0,
  lock: 0x8a8a9c,
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
  return d === -1 ? "?" : f.slice(d + 1).toLowerCase();
};
const topSeg = (p: string): string => {
  const i = p.indexOf("/");
  return i === -1 ? "·root" : p.slice(0, i);
};
const shortName = (n: string): string => {
  const parts = n.split(" ");
  return parts.length > 1 ? `${parts[0]} ${(parts[1] ?? " ").charAt(0)}.` : n.slice(0, 14);
};

function makeGrainTexture(size = 128): Texture {
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d");
  if (ctx) {
    const img = ctx.createImageData(size, size);
    for (let i = 0; i < img.data.length; i += 4) {
      const v = 110 + Math.floor(Math.random() * 56);
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
    g.addColorStop(0.72, "rgba(0,0,0,0.1)");
    g.addColorStop(1, "rgba(0,0,0,0.78)");
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, size, size);
  }
  return Texture.from(canvas);
}

interface Band {
  name: string;
  color: number;
  low: number[];
  high: number[];
  peakSlice: number;
  total: number;
  label: Text;
}
interface BandSet {
  bands: Band[];
  sliceTotal: number[];
  maxTotal: number;
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
    text: `reading the tide… (${REPO_DATASETS.find((d) => d.id === getDatasetId())?.label ?? "repo"})`,
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

  const params = { glow: 1, grain: 1, sway: 0, mode: 0 };
  const sliceSec = real.spanSec / SLICES;

  const labelLayer = new Container();
  ui.addChild(labelLayer);
  let labelsOn = false;

  const smooth = (a: number[]): number[] => {
    const out = new Array<number>(SLICES).fill(0);
    const w = 3;
    for (let i = 0; i < SLICES; i++) {
      let s = 0;
      let n = 0;
      for (let k = -w; k <= w; k++) {
        const j = i + k;
        if (j >= 0 && j < SLICES) {
          s += a[j] ?? 0;
          n++;
        }
      }
      out[i] = s / Math.max(1, n);
    }
    return out;
  };

  // group by a key derived per change; color by language palette or golden-angle hue
  const buildSet = (
    keyOf: (path: string, authorName: string) => string,
    palette: "lang" | "hue",
  ): BandSet => {
    const raw = new Map<string, number[]>();
    const totals = new Map<string, number>();
    for (const c of real.commits) {
      const s = Math.min(SLICES - 1, Math.floor(c.t / sliceSec));
      const author = real.authors[c.author] ?? "anon";
      for (const [, idx] of c.changes) {
        const k = keyOf(real.paths[idx] ?? "", author);
        let arr = raw.get(k);
        if (!arr) {
          arr = new Array<number>(SLICES).fill(0);
          raw.set(k, arr);
        }
        arr[s] = (arr[s] ?? 0) + 1;
        totals.set(k, (totals.get(k) ?? 0) + 1);
      }
    }
    const top = [...totals.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, TOP)
      .map(([k]) => k);
    const topSet = new Set(top);
    const other = new Array<number>(SLICES).fill(0);
    for (const [k, arr] of raw) {
      if (topSet.has(k)) continue;
      for (let i = 0; i < SLICES; i++) other[i] = (other[i] ?? 0) + (arr[i] ?? 0);
    }
    const groups = top.map((k, rank) => ({
      name: palette === "lang" ? (k === "?" ? "other" : `.${k}`) : k,
      arr: smooth(raw.get(k) ?? new Array<number>(SLICES).fill(0)),
      total: totals.get(k) ?? 0,
      color:
        palette === "lang"
          ? (LANG_COLORS[k] ?? hslToInt(hashStr(k) % 360, 0.68, 0.62))
          : hslToInt((rank * 137.5) % 360, 0.6, 0.62),
    }));
    if (other.some((v) => v > 0)) {
      groups.push({
        name: "other",
        arr: smooth(other),
        total: other.reduce((a, b) => a + b, 0),
        color: 0x8a8a9c,
      });
    }

    // inside-out ordering: biggest band centred
    const ordered: typeof groups = [];
    let toEnd = true;
    for (const g of [...groups].sort((a, b) => b.total - a.total)) {
      if (toEnd) ordered.push(g);
      else ordered.unshift(g);
      toEnd = !toEnd;
    }

    const sliceTotal = new Array<number>(SLICES).fill(0);
    for (let i = 0; i < SLICES; i++) {
      let t = 0;
      for (const g of ordered) t += g.arr[i] ?? 0;
      sliceTotal[i] = t;
    }
    const maxTotal = Math.max(1, ...sliceTotal);

    const bands: Band[] = ordered.map((g) => {
      let peak = 0;
      let pv = -1;
      for (let i = 0; i < SLICES; i++) {
        if ((g.arr[i] ?? 0) > pv) {
          pv = g.arr[i] ?? 0;
          peak = i;
        }
      }
      const label = new Text({
        text: g.name,
        style: { fontFamily: "monospace", fontSize: 12, fontWeight: "bold", fill: 0xffffff },
      });
      label.anchor.set(0.5);
      label.alpha = 0;
      labelLayer.addChild(label);
      return {
        name: g.name,
        color: g.color,
        low: [],
        high: [],
        peakSlice: peak,
        total: g.total,
        label,
      };
    });
    for (let i = 0; i < SLICES; i++) {
      let acc = -(sliceTotal[i] ?? 0) / 2;
      for (let b = 0; b < bands.length; b++) {
        const v = ordered[b]?.arr[i] ?? 0;
        bands[b]!.low[i] = acc;
        bands[b]!.high[i] = acc + v;
        acc += v;
      }
    }
    return { bands, sliceTotal, maxTotal };
  };

  const sets: BandSet[] = [
    buildSet((p) => extOf(p), "lang"),
    buildSet((p) => topSeg(p), "hue"),
    buildSet((_p, a) => shortName(a), "hue"),
  ];
  const modeNames = ["language", "directory", "author"];

  /* ------------------------------ layers ------------------------------ */

  const bandGfx = new Graphics();
  const crestGlow = new Graphics();
  const crestCore = new Graphics();
  const glowLayer = new Container();
  glowLayer.blendMode = "add";
  glowLayer.filters = [new BlurFilter({ strength: 12, quality: 2, resolution: 0.5 })];
  glowLayer.addChild(crestGlow);
  const coreLayer = new Container();
  coreLayer.blendMode = "add";
  coreLayer.addChild(crestCore);
  const vignette = new Sprite(makeVignetteTexture(256));
  vignette.anchor.set(0.5);
  vignette.blendMode = "multiply";
  const grain = new TilingSprite({ texture: makeGrainTexture(128), width: 8, height: 8 });
  grain.blendMode = "overlay";
  world.addChild(bandGfx, glowLayer, coreLayer, vignette, grain);

  /* ------------------------------ chrome ------------------------------ */

  const chrome = new FilmChrome(ui, real.chromeHistory, {
    repoName: real.repo,
    accent: 0xf7df5e,
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
  let clock = 0;

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

  const onKey = (ev: KeyboardEvent) => {
    if (ev.code === "KeyT") labelsOn = !labelsOn;
    else if (ev.code === "KeyG") params.mode = (params.mode + 1) % 3;
  };
  window.addEventListener("keydown", onKey);

  /* ------------------------------- loop ------------------------------- */

  const tick = () => {
    const dtMs = Math.min(app.ticker.deltaMS, 50);
    if (!paused && progress < 1)
      progress = clamp01(progress + (dtMs / 1000) * (speed / PLAY_SECONDS));
    feedTo(progress * real.spanSec);
    clock += dtMs / 1000;

    const mode = Math.round(params.mode) % 3;
    const set = sets[mode]!;
    const cw = chrome.contentWidth(app.screen.width);
    const ch = chrome.contentHeight(app.screen.height);
    const margin = 46;
    const x0 = margin;
    const x1 = cw - margin;
    const cy = ch / 2;
    const vScale = (ch * 0.66) / set.maxTotal;
    const xAt = (i: number) => x0 + (i / (SLICES - 1)) * (x1 - x0);
    const sway = (i: number) =>
      reducedMotion ? 0 : Math.sin(i * 0.25 + clock * 0.8) * 6 * params.sway;
    const cur = progress * (SLICES - 1);
    const curI = Math.floor(cur);
    const frac = cur - curI;
    const yLow = (b: Band, i: number) => cy + (b.low[i] ?? 0) * vScale + sway(i);
    const yHigh = (b: Band, i: number) => cy + (b.high[i] ?? 0) * vScale + sway(i);
    const interp = (arr: number[]) =>
      (arr[curI] ?? 0) * (1 - frac) + (arr[Math.min(SLICES - 1, curI + 1)] ?? 0) * frac;
    const xc = x0 + (cur / (SLICES - 1)) * (x1 - x0);

    // hide labels for non-active sets
    for (let m = 0; m < sets.length; m++) {
      if (m === mode) continue;
      for (const b of sets[m]!.bands) b.label.visible = false;
    }

    bandGfx.clear();
    crestGlow.clear();
    crestCore.clear();

    for (const b of set.bands) {
      bandGfx.moveTo(xAt(0), yHigh(b, 0));
      for (let i = 1; i <= curI; i++) bandGfx.lineTo(xAt(i), yHigh(b, i));
      const hC = cy + interp(b.high) * vScale + sway(cur);
      const lC = cy + interp(b.low) * vScale + sway(cur);
      bandGfx.lineTo(xc, hC);
      bandGfx.lineTo(xc, lC);
      for (let i = curI; i >= 0; i--) bandGfx.lineTo(xAt(i), yLow(b, i));
      bandGfx.fill({ color: b.color, alpha: 0.5 });

      crestGlow.moveTo(xAt(0), yHigh(b, 0));
      crestCore.moveTo(xAt(0), yHigh(b, 0));
      for (let i = 1; i <= curI; i++) {
        crestGlow.lineTo(xAt(i), yHigh(b, i));
        crestCore.lineTo(xAt(i), yHigh(b, i));
      }
      crestGlow.lineTo(xc, hC);
      crestCore.lineTo(xc, hC);
      crestGlow.stroke({ width: 3.5, color: b.color, alpha: 0.5 * params.glow, cap: "round" });
      crestCore.stroke({
        width: 1.2,
        color: mix(b.color, 0xffffff, 0.5),
        alpha: 0.85,
        cap: "round",
      });
    }

    const topY = cy + interp(set.bands[set.bands.length - 1]?.high ?? [0]) * vScale + sway(cur);
    const botY = cy + interp(set.bands[0]?.low ?? [0]) * vScale + sway(cur);
    crestCore.moveTo(xc, botY).lineTo(xc, topY).stroke({ width: 1.5, color: 0xffffff, alpha: 0.5 });
    crestGlow
      .moveTo(xc, botY)
      .lineTo(xc, topY)
      .stroke({ width: 5, color: INK, alpha: 0.4 * params.glow });

    for (const b of set.bands) {
      const i = b.peakSlice;
      const thick = ((b.high[i] ?? 0) - (b.low[i] ?? 0)) * vScale;
      const show = labelsOn && i <= cur && thick > 16;
      b.label.visible = show;
      if (show) {
        b.label.position.set(xAt(i), (yLow(b, i) + yHigh(b, i)) / 2);
        b.label.alpha = 0.95;
      }
    }

    vignette.position.set(cw / 2, cy);
    vignette.scale.set((Math.max(cw, ch) * 1.4) / 256);
    grainScroll += dtMs * 0.03;
    grain.width = cw;
    grain.height = ch;
    grain.tilePosition.set((grainScroll % 128) | 0, ((grainScroll * 0.7) % 128) | 0);
    grain.alpha = 0.07 * params.grain;

    let domName = "?";
    let domV = -1;
    for (const b of set.bands) {
      const v =
        (b.high[Math.min(SLICES - 1, curI)] ?? 0) - (b.low[Math.min(SLICES - 1, curI)] ?? 0);
      if (v > domV) {
        domV = v;
        domName = b.name;
      }
    }
    const tot = set.sliceTotal[Math.min(SLICES - 1, curI)] ?? 1;
    chrome.update(dtMs, app.screen.width, app.screen.height, progress, [
      ["split", modeNames[mode] ?? "language"],
      ["leading", domName],
      ["share", `${Math.round((domV / Math.max(1, tot)) * 100)}%`],
    ]);
    hud.update(dtMs, `tide · split by ${modeNames[mode]} · ${set.bands.length} bands`);
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
      accent: 0xf7df5e,
      setChromeHidden: (b) => chrome.setHidden(b),
      setHudVisible: (b) => hud.setVisible(b),
      setLabels: (b) => {
        labelsOn = b;
      },
    }),
    controls: [
      {
        key: "mode",
        label: "split by (also G)",
        kind: "enum",
        options: [
          { label: "language", value: 0 },
          { label: "directory", value: 1 },
          { label: "author", value: 2 },
        ],
        value: 0,
        set: (v) => {
          params.mode = v as number;
        },
      },
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
        key: "glow",
        label: "crest glow",
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
        key: "sway",
        label: "tidal sway",
        kind: "range",
        min: 0,
        max: 2,
        step: 0.1,
        value: 0,
        set: (v) => {
          params.sway = v as number;
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
