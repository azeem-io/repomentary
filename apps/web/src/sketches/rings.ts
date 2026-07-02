/**
 * Rings: a generative portrait of a repo as concentric growth rings, oldest at
 * the core and newest at the rim. Each ring is one slice of time. Band width
 * follows that slice's activity, colour follows its dominant language. Every
 * parameter is seeded from the repo, so the same repo always paints the same
 * piece and two repos look nothing alike. Painted with textured brush stamps,
 * not vector strokes, then finished with grain and a vignette.
 */
import { mulberry32, type Rng } from "@repomentary/artifact";
import { Container, Sprite, Text, Texture, TilingSprite } from "pixi.js";
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
  easeOutCubic,
  makeCaptureHandle,
  makeGlowTexture,
  makeRingTexture,
  requestRebuildSeek,
  type SketchInstance,
  type Transport,
} from "./common";

const INK = 0xe8ecff;
const ACCENT = 0xc9a86a; // warm gold, matches the printed-poster feel
const PLAY_SECONDS = 120;

function hashStr(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** HSL (h in [0,360)) to a packed rgb int. */
function hslToInt(h: number, s: number, l: number): number {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const hp = (((h % 360) + 360) % 360) / 60;
  const x = c * (1 - Math.abs((hp % 2) - 1));
  let r = 0;
  let g = 0;
  let b = 0;
  if (hp < 1) [r, g, b] = [c, x, 0];
  else if (hp < 2) [r, g, b] = [x, c, 0];
  else if (hp < 3) [r, g, b] = [0, c, x];
  else if (hp < 4) [r, g, b] = [0, x, c];
  else if (hp < 5) [r, g, b] = [x, 0, c];
  else [r, g, b] = [c, 0, x];
  const m = l - c / 2;
  return (
    (Math.round((r + m) * 255) << 16) | (Math.round((g + m) * 255) << 8) | Math.round((b + m) * 255)
  );
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

const extOf = (path: string): string => {
  const file = path.slice(path.lastIndexOf("/") + 1);
  const dot = file.lastIndexOf(".");
  return dot === -1 ? "·" : file.slice(dot + 1).toLowerCase();
};

/** A long soft brush mark, irregular so painted bands never look like vectors. */
function makeBrushTexture(): Texture {
  const w = 80;
  const h = 34;
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  if (ctx) {
    const core = ctx.createRadialGradient(w / 2, h / 2, 0, w / 2, h / 2, h / 2);
    core.addColorStop(0, "rgba(255,255,255,0.55)");
    core.addColorStop(0.7, "rgba(255,255,255,0.18)");
    core.addColorStop(1, "rgba(255,255,255,0)");
    ctx.fillStyle = core;
    ctx.fillRect(0, 0, w, h);
    for (let i = 0; i < 70; i++) {
      const px = w * (0.08 + 0.84 * Math.random());
      const py = h * (0.5 + (Math.random() - 0.5) * 0.72);
      const rr = 2 + Math.random() * 6;
      const a = 0.04 + Math.random() * 0.12;
      const g = ctx.createRadialGradient(px, py, 0, px, py, rr);
      g.addColorStop(0, `rgba(255,255,255,${a})`);
      g.addColorStop(1, "rgba(255,255,255,0)");
      ctx.fillStyle = g;
      ctx.fillRect(px - rr, py - rr, rr * 2, rr * 2);
    }
  }
  return Texture.from(canvas);
}

/** Mid-grey noise tile for an overlay-blended film grain. */
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

/** Transparent centre fading to dark at the edge, multiplied for a vignette. */
function makeVignetteTexture(size = 256): Texture {
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d");
  if (ctx) {
    const g = ctx.createRadialGradient(
      size / 2,
      size / 2,
      size * 0.28,
      size / 2,
      size / 2,
      size / 2,
    );
    g.addColorStop(0, "rgba(0,0,0,0)");
    g.addColorStop(0.7, "rgba(0,0,0,0.12)");
    g.addColorStop(1, "rgba(0,0,0,0.82)");
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, size, size);
  }
  return Texture.from(canvas);
}

interface Stamp {
  sprite: Sprite;
  tint: number;
  alphaT: number;
  scaleX: number;
  scaleY: number;
  delay: number; // ms after the ring is revealed before this stamp paints in
  t: number; // animation clock, < 0 while waiting on delay
  done: boolean;
}

interface Ring {
  index: number;
  midR: number;
  ext: string;
  commits: number;
  color: number;
  stamps: Stamp[];
  gold: Sprite | null;
  revealed: boolean;
}

export async function createSketch(
  host: HTMLElement,
  signal?: AbortSignal,
): Promise<SketchInstance> {
  const boot = await bootPixi(host, "#0c0a10");
  if (signal?.aborted) {
    boot.destroy();
    throw new DOMException("cancelled", "AbortError");
  }
  const { app, world, ui, hud, reducedMotion } = boot;

  const loadingText = new Text({
    text: `reading rings… (${REPO_DATASETS.find((d) => d.id === getDatasetId())?.label ?? "repo"})`,
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

  const params = { grain: 1, glow: 1, spin: 1 };

  /* --------------------------- seed + palette --------------------------- */

  const rng: Rng = mulberry32(hashStr(real.repo));
  const baseHue = rng() * 360;
  const spread = 22 + rng() * 46;
  const sat = 0.34 + rng() * 0.2;
  const light = 0.5 + rng() * 0.12;
  const palette: number[] = [];
  for (let i = 0; i < 6; i++) {
    const dir = i % 2 === 0 ? 1 : -1;
    const h = baseHue + dir * Math.ceil(i / 2) * spread;
    palette.push(hslToInt(h, sat * (0.8 + 0.4 * rng()), light * (0.78 + 0.4 * rng())));
  }

  // Rank languages repo-wide, map each to a palette swatch (stable per repo).
  const extTotals = new Map<string, number>();
  for (const c of real.commits) {
    for (const [, idx] of c.changes) {
      const e = extOf(real.paths[idx] ?? "");
      extTotals.set(e, (extTotals.get(e) ?? 0) + 1);
    }
  }
  const rankedExt = [...extTotals.entries()].sort((a, b) => b[1] - a[1]).map(([e]) => e);
  const swatchOf = new Map<string, number>();
  rankedExt.forEach((e, i) => {
    swatchOf.set(e, palette[i % palette.length] ?? palette[0] ?? 0);
  });

  /* ------------------------------ slices ------------------------------ */

  const monthSec = 30.44 * 24 * 3600;
  const ringCount = Math.max(20, Math.min(72, Math.round(real.spanSec / monthSec)));
  const sliceSec = real.spanSec / ringCount;
  const sliceCommits = new Array<number>(ringCount).fill(0);
  const sliceExt: Map<string, number>[] = Array.from({ length: ringCount }, () => new Map());
  for (const c of real.commits) {
    const ri = Math.min(ringCount - 1, Math.floor(c.t / sliceSec));
    sliceCommits[ri] = (sliceCommits[ri] ?? 0) + 1;
    const m = sliceExt[ri];
    if (m) {
      for (const [, idx] of c.changes) {
        const e = extOf(real.paths[idx] ?? "");
        m.set(e, (m.get(e) ?? 0) + 1);
      }
    }
  }
  const peakCommits = Math.max(1, ...sliceCommits);
  const releaseRing = new Set<number>();
  for (const tag of real.tags) {
    releaseRing.add(Math.min(ringCount - 1, Math.floor(tag.t / sliceSec)));
  }

  /* ------------------------------ layers ------------------------------ */

  const spotlight = new Sprite(makeGlowTexture(128));
  spotlight.anchor.set(0.5);
  spotlight.blendMode = "add";
  spotlight.tint = mix(ACCENT, 0xffffff, 0.3);
  const artLayer = new Container();
  const seed = new Sprite(makeGlowTexture(64));
  seed.anchor.set(0.5);
  seed.blendMode = "add";
  seed.tint = mix(ACCENT, 0xffffff, 0.4);
  const vignette = new Sprite(makeVignetteTexture(256));
  vignette.anchor.set(0.5);
  vignette.blendMode = "multiply";
  const grain = new TilingSprite({ texture: makeGrainTexture(128), width: 8, height: 8 });
  grain.blendMode = "overlay";
  world.addChild(spotlight, artLayer, seed, vignette, grain);

  const brushTex = makeBrushTexture();
  const ringTex = makeRingTexture(128);

  /* ----------------------- build rings + stamps ----------------------- */

  const rings: Ring[] = [];
  const animating = new Set<Stamp>();
  let innerR = 18;
  for (let i = 0; i < ringCount; i++) {
    const commits = sliceCommits[i] ?? 0;
    const thick = 4 + Math.sqrt(commits) * 2.6;
    const midR = innerR + thick / 2;
    // dominant language this slice
    let ext = "·";
    let best = -1;
    for (const [e, n] of sliceExt[i] ?? []) {
      if (n > best) {
        best = n;
        ext = e;
      }
    }
    const swatch = swatchOf.get(ext) ?? palette[0] ?? 0;
    const color = mix(swatch, 0xffffff, Math.min(0.28, (commits / peakCommits) * 0.28));

    // low-frequency wobble so rings are hand-drawn circles, not perfect ones
    const harmonics = [
      { k: 2 + Math.floor(rng() * 2), a: 0.012 + rng() * 0.03, p: rng() * Math.PI * 2 },
      { k: 4 + Math.floor(rng() * 3), a: 0.008 + rng() * 0.02, p: rng() * Math.PI * 2 },
    ];
    const rAt = (theta: number): number => {
      let f = 1;
      for (const hm of harmonics) f += hm.a * Math.sin(hm.k * theta + hm.p);
      return midR * f;
    };

    const stampCount = Math.max(10, Math.min(220, Math.round((2 * Math.PI * midR) / 7)));
    const arcStep = (2 * Math.PI * midR) / stampCount;
    const stamps: Stamp[] = [];
    for (let s = 0; s < stampCount; s++) {
      const theta = (s / stampCount) * Math.PI * 2 + rng() * 0.12;
      const r = rAt(theta);
      const sprite = new Sprite(brushTex);
      sprite.anchor.set(0.5);
      sprite.position.set(Math.cos(theta) * r, Math.sin(theta) * r);
      sprite.rotation = theta + Math.PI / 2 + (rng() - 0.5) * 0.5;
      sprite.visible = false;
      sprite.alpha = 0;
      const scaleY = (thick * (1.3 + rng() * 0.5)) / 34;
      const scaleX = (arcStep * (1.5 + rng() * 0.6)) / 80;
      sprite.scale.set(0, 0);
      const tint = mix(color, rng() > 0.5 ? 0xffffff : 0x000000, rng() * 0.22);
      sprite.tint = tint;
      artLayer.addChild(sprite);
      stamps.push({
        sprite,
        tint,
        alphaT: 0.55 + rng() * 0.32,
        scaleX,
        scaleY,
        delay: (s / stampCount) * 520,
        t: -1,
        done: false,
      });
    }

    let gold: Sprite | null = null;
    if (releaseRing.has(i)) {
      gold = new Sprite(ringTex);
      gold.anchor.set(0.5);
      gold.blendMode = "add";
      gold.tint = ACCENT;
      gold.alpha = 0;
      gold.scale.set((midR * 2.08) / 128);
      artLayer.addChild(gold);
    }

    rings.push({ index: i, midR, ext, commits, color, stamps, gold, revealed: false });
    innerR += thick + 1.2;
  }
  const virtualOuter = innerR;

  /* ------------------------------ chrome ------------------------------ */

  const chrome = new FilmChrome(ui, real.chromeHistory, {
    repoName: real.repo,
    accent: ACCENT,
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
  let spinAngle = 0;

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
    // backward reveals snap; feed replays from scratch if needed
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

  const POP = reducedMotion ? 1 : 360;

  const tick = () => {
    const dtMs = Math.min(app.ticker.deltaMS, 50);

    if (!paused && progress < 1) {
      progress = clamp01(progress + (dtMs / 1000) * (speed / PLAY_SECONDS));
    }
    feedTo(progress * real.spanSec);

    const revealF = progress * ringCount;

    // reveal / unreveal rings as the rim grows or a scrub rewinds
    for (const ring of rings) {
      const should = revealF >= ring.index;
      if (should && !ring.revealed) {
        ring.revealed = true;
        for (const st of ring.stamps) {
          st.t = reducedMotion ? POP : -st.delay;
          st.done = false;
          animating.add(st);
        }
      } else if (!should && ring.revealed) {
        ring.revealed = false;
        for (const st of ring.stamps) {
          st.sprite.visible = false;
          st.sprite.alpha = 0;
          st.sprite.scale.set(0, 0);
          st.t = -1;
          st.done = false;
          animating.delete(st);
        }
        if (ring.gold) ring.gold.alpha = 0;
      }
      if (ring.gold && ring.revealed) {
        const target = 0.5 * params.glow;
        ring.gold.alpha += (target - ring.gold.alpha) * Math.min(1, dtMs / 400);
      }
    }

    // animate the brush stamps painting in
    for (const st of animating) {
      st.t += dtMs;
      if (st.t < 0) continue;
      const k = clamp01(st.t / POP);
      const e = easeOutCubic(k);
      st.sprite.visible = true;
      st.sprite.alpha = st.alphaT * e;
      st.sprite.scale.set(st.scaleX * (0.6 + 0.4 * e), st.scaleY * (0.6 + 0.4 * e));
      if (k >= 1) {
        st.done = true;
        animating.delete(st);
      }
    }

    /* ----- layout (responsive, resolution independent) ----- */
    const cw = chrome.contentWidth(app.screen.width);
    const ch = chrome.contentHeight(app.screen.height);
    const cx = cw / 2;
    const cy = ch / 2;
    const fit = (Math.min(cw, ch) * 0.46) / virtualOuter;

    if (!reducedMotion) spinAngle += (dtMs / 1000) * 0.012 * params.spin;
    artLayer.position.set(cx, cy);
    artLayer.scale.set(fit);
    artLayer.rotation = spinAngle;

    spotlight.position.set(cx, cy);
    spotlight.scale.set((Math.min(cw, ch) * 1.1) / 128);
    spotlight.alpha = 0.14 * params.glow;

    seed.position.set(cx, cy);
    seed.scale.set(0.5 + Math.sin(performance.now() / 1400) * 0.05);
    seed.alpha = 0.7 * params.glow;

    vignette.position.set(cx, cy);
    vignette.scale.set((Math.max(cw, ch) * 1.25) / 256);

    grainScroll += dtMs * 0.03;
    grain.position.set(0, 0);
    grain.width = cw;
    grain.height = ch;
    grain.tilePosition.set((grainScroll % 128) | 0, ((grainScroll * 0.7) % 128) | 0);
    grain.alpha = 0.09 * params.grain;

    /* ----- chrome + hud ----- */
    const band = Math.min(ringCount, Math.floor(revealF) + 1);
    const cur = rings[Math.min(ringCount - 1, Math.floor(revealF))];
    chrome.update(dtMs, app.screen.width, app.screen.height, progress, [
      ["rings", ringCount],
      ["band", `${band}/${ringCount}`],
      ["language", cur ? `.${cur.ext}` : "—"],
    ]);
    hud.update(dtMs, `${ringCount} rings · ${rankedExt.length} languages`);
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
      accent: ACCENT,
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
        key: "spin",
        label: "rotation",
        kind: "range",
        min: 0,
        max: 3,
        step: 0.1,
        value: 1,
        set: (v) => {
          params.spin = v as number;
        },
      },
    ],
  };
}
