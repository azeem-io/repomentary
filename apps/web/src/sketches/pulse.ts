/**
 * Pulse: the repo's vital signs as a stack of seismograph lanes, one per top
 * contributor. Time runs left to right; each lane spikes with that person's
 * commit activity and flatlines when they go quiet, so you read who carried
 * which era at a glance. Glowing traces (bloomed), a faint monitor grid,
 * release flags across all lanes, grain and vignette. Trace draws in with time.
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
  makeGlowTexture,
  requestRebuildSeek,
  type SketchInstance,
  type Transport,
} from "./common";

const INK = 0xe8ecff;
const PLAY_SECONDS = 110;
const SLICES = 220;

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
const shortName = (n: string): string => {
  const parts = n.split(" ");
  return parts.length > 1 ? `${parts[0]} ${(parts[1] ?? " ").charAt(0)}.` : n.slice(0, 16);
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
      size * 0.35,
      size / 2,
      size / 2,
      size / 2,
    );
    g.addColorStop(0, "rgba(0,0,0,0)");
    g.addColorStop(0.74, "rgba(0,0,0,0.1)");
    g.addColorStop(1, "rgba(0,0,0,0.72)");
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, size, size);
  }
  return Texture.from(canvas);
}

interface Lane {
  name: string;
  color: number;
  val: number[];
  total: number;
  label: Text;
}

export async function createSketch(
  host: HTMLElement,
  signal?: AbortSignal,
): Promise<SketchInstance> {
  const boot = await bootPixi(host, "#070a0c");
  if (signal?.aborted) {
    boot.destroy();
    throw new DOMException("cancelled", "AbortError");
  }
  const { app, world, ui, hud, reducedMotion } = boot;

  const loadingText = new Text({
    text: `taking the pulse… (${REPO_DATASETS.find((d) => d.id === getDatasetId())?.label ?? "repo"})`,
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

  const params = { glow: 1, grain: 1, gain: 1 };
  const sliceSec = real.spanSec / SLICES;

  /* ----------------------- per-contributor per-slice ----------------------- */

  const perAuthor = new Map<number, number[]>();
  const totals = new Map<number, number>();
  for (const c of real.commits) {
    const s = Math.min(SLICES - 1, Math.floor(c.t / sliceSec));
    let arr = perAuthor.get(c.author);
    if (!arr) {
      arr = new Array<number>(SLICES).fill(0);
      perAuthor.set(c.author, arr);
    }
    arr[s] = (arr[s] ?? 0) + 1;
    totals.set(c.author, (totals.get(c.author) ?? 0) + 1);
  }
  const N = Math.min(8, perAuthor.size);
  const topAuthors = [...totals.entries()].sort((a, b) => b[1] - a[1]).slice(0, N);
  let globalMax = 1;
  for (const [a] of topAuthors) {
    const arr = perAuthor.get(a) ?? [];
    for (const v of arr) if (v > globalMax) globalMax = v;
  }

  const labelLayer = new Container();
  ui.addChild(labelLayer);
  let labelsOn = true;

  const lanes: Lane[] = topAuthors.map(([a, tot], i) => {
    const name = shortName(real.authors[a] ?? "anon");
    const color = hslToInt((i * 137.5 + 20) % 360, 0.62, 0.62);
    const label = new Text({
      text: name,
      style: { fontFamily: "monospace", fontSize: 11, fontWeight: "bold", fill: color },
    });
    label.anchor.set(0, 0.5);
    labelLayer.addChild(label);
    return {
      name,
      color,
      val: perAuthor.get(a) ?? new Array<number>(SLICES).fill(0),
      total: tot,
      label,
    };
  });

  // release fractions for flags
  const tagFracs = real.tags.map((t) => ({ p: t.t / real.spanSec, name: t.name }));

  /* ------------------------------ layers ------------------------------ */

  const glowTex = makeGlowTexture(32);
  const grid = new Graphics();
  const fillGfx = new Graphics();
  const glowWrap = new Container();
  glowWrap.blendMode = "add";
  glowWrap.filters = [new BlurFilter({ strength: 10, quality: 2, resolution: 0.5 })];
  const traceGlow = new Graphics();
  glowWrap.addChild(traceGlow);
  const traceCore = new Graphics();
  traceCore.blendMode = "add";
  const dots = new Container();
  dots.blendMode = "add";
  const laneDots: Sprite[] = lanes.map((l) => {
    const sp = new Sprite(glowTex);
    sp.anchor.set(0.5);
    sp.tint = mix(l.color, 0xffffff, 0.4);
    sp.scale.set(0.5);
    dots.addChild(sp);
    return sp;
  });
  const vignette = new Sprite(makeVignetteTexture(256));
  vignette.anchor.set(0.5);
  vignette.blendMode = "multiply";
  const grain = new TilingSprite({ texture: makeGrainTexture(128), width: 8, height: 8 });
  grain.blendMode = "overlay";
  world.addChild(grid, fillGfx, glowWrap, traceCore, dots, vignette, grain);

  /* ------------------------------ chrome ------------------------------ */

  const chrome = new FilmChrome(ui, real.chromeHistory, {
    repoName: real.repo,
    accent: lanes[0]?.color ?? 0x5adcff,
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
  };
  window.addEventListener("keydown", onKey);

  /* ------------------------------- loop ------------------------------- */

  const tick = () => {
    const dtMs = Math.min(app.ticker.deltaMS, 50);
    if (!paused && progress < 1)
      progress = clamp01(progress + (dtMs / 1000) * (speed / PLAY_SECONDS));
    feedTo(progress * real.spanSec);
    clock += dtMs / 1000;

    const cw = chrome.contentWidth(app.screen.width);
    const ch = chrome.contentHeight(app.screen.height);
    const x0 = 132;
    const x1 = cw - 30;
    const topPad = 84;
    const botPad = 30;
    const laneH = (ch - topPad - botPad) / N;
    const amp = laneH * 0.46;
    const xAt = (i: number) => x0 + (i / (SLICES - 1)) * (x1 - x0);
    const laneY = (k: number) => topPad + (k + 0.5) * laneH;
    const vAt = (l: Lane, i: number) =>
      (Math.sqrt(l.val[i] ?? 0) / Math.sqrt(globalMax)) * amp * params.gain;
    const cur = progress * (SLICES - 1);
    const curI = Math.floor(cur);
    const frac = cur - curI;
    const xc = x0 + (cur / (SLICES - 1)) * (x1 - x0);

    grid.clear();
    fillGfx.clear();
    traceGlow.clear();
    traceCore.clear();

    // monitor grid
    for (let k = 0; k < N; k++) {
      const by = laneY(k);
      grid.moveTo(x0, by).lineTo(x1, by).stroke({ color: 0x1c2a30, alpha: 0.7, width: 1 });
    }
    for (let g = 0; g <= 8; g++) {
      const gx = x0 + (g / 8) * (x1 - x0);
      grid
        .moveTo(gx, topPad - 6)
        .lineTo(gx, ch - botPad)
        .stroke({ color: 0x12191e, alpha: 0.7, width: 1 });
    }
    // release flags across all lanes
    for (const t of tagFracs) {
      const fx = x0 + t.p * (x1 - x0);
      const played = t.p <= progress;
      grid
        .moveTo(fx, topPad - 6)
        .lineTo(fx, ch - botPad)
        .stroke({ color: 0xffd24a, alpha: played ? 0.28 : 0.1, width: 1 });
    }

    for (let k = 0; k < N; k++) {
      const l = lanes[k]!;
      const by = laneY(k);
      // filled area under the trace
      fillGfx.moveTo(x0, by);
      for (let i = 0; i <= curI; i++) fillGfx.lineTo(xAt(i), by - vAt(l, i));
      const vC = vAt(l, curI) * (1 - frac) + vAt(l, Math.min(SLICES - 1, curI + 1)) * frac;
      fillGfx.lineTo(xc, by - vC);
      fillGfx.lineTo(xc, by);
      fillGfx.fill({ color: l.color, alpha: 0.12 });

      // glowing trace
      traceGlow.moveTo(x0, by);
      traceCore.moveTo(x0, by);
      for (let i = 1; i <= curI; i++) {
        traceGlow.lineTo(xAt(i), by - vAt(l, i));
        traceCore.lineTo(xAt(i), by - vAt(l, i));
      }
      traceGlow.lineTo(xc, by - vC);
      traceCore.lineTo(xc, by - vC);
      traceGlow.stroke({
        width: 3.5,
        color: l.color,
        alpha: 0.5 * params.glow,
        cap: "round",
        join: "round",
      });
      traceCore.stroke({
        width: 1.3,
        color: mix(l.color, 0xffffff, 0.5),
        alpha: 0.95,
        cap: "round",
        join: "round",
      });

      // leading pulse dot
      const dot = laneDots[k]!;
      dot.position.set(xc, by - vC);
      dot.alpha = 0.9;
      dot.scale.set(0.4 + 0.2 * Math.sin(clock * 6 + k));

      // lane label
      l.label.visible = labelsOn;
      if (labelsOn) {
        l.label.position.set(18, by);
        l.label.alpha = 0.9;
      }
    }

    vignette.position.set(cw / 2, ch / 2);
    vignette.scale.set((Math.max(cw, ch) * 1.4) / 256);
    grainScroll += dtMs * 0.03;
    grain.width = cw;
    grain.height = ch;
    grain.tilePosition.set((grainScroll % 128) | 0, ((grainScroll * 0.7) % 128) | 0);
    grain.alpha = 0.06 * params.grain;

    // who's hottest right now
    let hot = "—";
    let hotV = -1;
    for (const l of lanes) {
      const v = l.val[Math.min(SLICES - 1, curI)] ?? 0;
      if (v > hotV) {
        hotV = v;
        hot = l.name;
      }
    }
    chrome.update(dtMs, app.screen.width, app.screen.height, progress, [
      ["lanes", N],
      ["active", hotV > 0 ? hot : "quiet"],
    ]);
    hud.update(dtMs, `pulse · ${N} contributors`);
  };

  app.ticker.add(tick);

  return {
    destroy() {
      window.removeEventListener("keydown", onKey);
      glowTex.destroy(true);
      boot.destroy();
    },
    transport,
    controls: [
      {
        key: "labels",
        label: "lane labels (also T)",
        kind: "toggle",
        value: true,
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
        key: "gain",
        label: "gain",
        kind: "range",
        min: 0.3,
        max: 2,
        step: 0.1,
        value: 1,
        set: (v) => {
          params.gain = v as number;
        },
      },
      {
        key: "glow",
        label: "glow",
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
