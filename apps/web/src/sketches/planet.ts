/**
 * Planet sketch. The planet's surface is a country MAP: a capacity-constrained
 * weighted-Voronoi tessellation where each top-level directory owns a territory
 * sized by its share of commits, sharing borders with its neighbours and
 * filling the whole disc. Files are city-lights that flare on their territory
 * when touched. Branches spiral in and crash onto their directory when merged,
 * contributors are moons trailing short arcs, releases add rings.
 *
 * Hover anything for details. T toggles labels.
 */
import { mulberry32, type RepoEvent, type Rng } from "@repomentary/artifact";
import { Container, Graphics, Sprite, Text, Texture } from "pixi.js";
import { loadSharedHistory } from "@/lib/realHistory";
import { FilmChrome } from "./chrome";
import {
  bootPixi,
  CameraShake,
  clamp01,
  EventPlayer,
  easeOutBack,
  easeOutCubic,
  FrameGovernor,
  makeCaptureHandle,
  makeDotTexture,
  makeGlowTexture,
  makeRingTexture,
  type SketchInstance,
  Toasts,
} from "./common";

const VOID = "#07091a";
const CORE_COLOR = 0x14122e;
const RING_TINT = 0xc9b08f;
const EMBER = 0xffb454;
const LABEL_COLOR = 0xc9d4ff;

// Golden angle → sunflower (phyllotaxis) packing for a balanced island layout.
const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));
const MAP_RES = 300; // country-map raster resolution

/** Bright territory palette; muted variants are derived. */
/** Distinct pastel per index via golden-angle hue (works for any count). */
function hslToInt(h: number, sat: number, l: number): number {
  const hh = (((h % 360) + 360) % 360) / 360;
  const a = sat * Math.min(l, 1 - l);
  const f = (n: number): number => {
    const k = (n + hh * 12) % 12;
    return l - a * Math.max(-1, Math.min(k - 3, Math.min(9 - k, 1)));
  };
  return (Math.round(f(0) * 255) << 16) | (Math.round(f(8) * 255) << 8) | Math.round(f(4) * 255);
}

const FILE_BASES = [
  "index",
  "utils",
  "types",
  "config",
  "client",
  "server",
  "store",
  "router",
  "hooks",
  "parser",
  "engine",
  "render",
  "queue",
  "auth",
  "cache",
  "events",
  "scene",
  "worker",
];
const FILE_EXTS = [".ts", ".ts", ".tsx", ".json", ".md", ".css"];

const MASS_TO_R = 6;
const radiusOf = (mass: number): number => MASS_TO_R * Math.sqrt(mass);

/* --------------------------------- types ---------------------------------- */

interface FileDot {
  name: string;
  /** Offset within the island (unit disc), stable across growth. */
  ox: number;
  oy: number;
  /** World position, recomputed each frame (for comets + hover). */
  x: number;
  y: number;
  changes: number;
  ignite: number;
  sprite: Sprite;
}

interface SectorState {
  name: string;
  bright: number;
  muted: number;
  weight: number;
  /** Animated share of the full circle (sums to 1). */
  share: number;
  commits: number;
  flash: number;
  darken: number;
  files: FileDot[];
  label: Text;
  key: string;
  slot: number;
  /** Country: fixed normalized seed, cell centroid, world pos, colour bytes. */
  nx: number;
  ny: number;
  cnx: number;
  cny: number;
  cx: number;
  cy: number;
  r: number;
  g: number;
  b: number;
  pw: number;
  areaFrac: number;
}

interface BranchPlanet {
  id: number;
  name: string;
  cluster: number;
  disc: Sprite;
  label: Text;
  mass: number;
  commits: number;
  orbitAngle: number;
  orbitSpeed: number;
  slot: number;
  tint: number;
  state: "spawning" | "orbiting" | "infall";
  stateAge: number;
  /** Real histories lack branch lifecycles, auto-merge after this long. */
  autoInfallAt: number | null;
  infallFromR: number;
  pulse: number;
  trail: { x: number; y: number }[];
  trailCarry: number;
  x: number;
  y: number;
  r: number;
}

interface Moon {
  name: string;
  author: number;
  commits: number;
  angle: number;
  speed: number;
  slot: number;
  sprite: Sprite;
  label: Text;
  x: number;
  y: number;
}

interface Debris {
  sprite: Sprite;
  vx: number;
  vy: number;
  life: number;
  maxLife: number;
  grav: boolean;
  active: boolean;
}

interface Shockwave {
  sprite: Sprite;
  age: number;
  dur: number;
  toScale: number;
  active: boolean;
}

interface Comet {
  head: Sprite;
  fromX: number;
  fromY: number;
  tx: number;
  ty: number;
  key: string;
  age: number;
  dur: number;
  magnitude: number;
  trailCarry: number;
  active: boolean;
}

interface ShootingStar {
  sprite: Sprite;
  vx: number;
  vy: number;
  life: number;
  active: boolean;
}

/* --------------------------------- helpers --------------------------------- */

function mixColor(a: number, b: number, k: number): number {
  const ar = (a >> 16) & 0xff;
  const ag = (a >> 8) & 0xff;
  const ab = a & 0xff;
  const br = (b >> 16) & 0xff;
  const bg = (b >> 8) & 0xff;
  const bb = b & 0xff;
  const r = Math.round(ar + (br - ar) * k);
  const g = Math.round(ag + (bg - ag) * k);
  const bl = Math.round(ab + (bb - ab) * k);
  return (r << 16) | (g << 8) | bl;
}

function roman(n: number): string {
  const table: [number, string][] = [
    [10, "X"],
    [9, "IX"],
    [5, "V"],
    [4, "IV"],
    [1, "I"],
  ];
  let v = Math.max(1, Math.min(n, 39));
  let out = "";
  for (const [num, sym] of table) {
    while (v >= num) {
      out += sym;
      v -= num;
    }
  }
  return out;
}

/** Soft atmospheric halo ring that hugs the sphere's limb (additive). */
function makeAtmosphereTexture(size = 256): Texture {
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d");
  if (ctx) {
    const r = size / 2;
    const g = ctx.createRadialGradient(r, r, r * 0.5, r, r, r);
    g.addColorStop(0, "rgba(255,255,255,0)");
    g.addColorStop(0.72, "rgba(255,255,255,0)");
    g.addColorStop(0.86, "rgba(255,255,255,0.5)");
    g.addColorStop(0.95, "rgba(255,255,255,0.14)");
    g.addColorStop(1, "rgba(255,255,255,0)");
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, size, size);
  }
  return Texture.from(canvas);
}

/* ---------------------------------- sketch ---------------------------------- */

export async function createSketch(
  host: HTMLElement,
  signal?: AbortSignal,
): Promise<SketchInstance> {
  const boot = await bootPixi(host, VOID);
  if (signal?.aborted) {
    boot.destroy();
    throw new DOMException("cancelled", "AbortError");
  }
  const { app, world, ui, hud, reducedMotion } = boot;

  const rng: Rng = mulberry32(40961);
  const { history, repoName } = await loadSharedHistory();
  if (signal?.aborted) {
    boot.destroy();
    throw new DOMException("cancelled", "AbortError");
  }

  const glowTex = makeGlowTexture(64);
  const dotTex = makeDotTexture(16);
  const ringTex = makeRingTexture(128);
  const atmoTex = makeAtmosphereTexture(256);

  const params = { cometAt: 0.9, dots: 1, shakeAmp: 0.22 };
  const governor = new FrameGovernor();
  const shake = new CameraShake();
  const toastsTop = new Toasts(ui, "top", { fill: 0xffe9c2, fontSize: 16 });
  const toastsBottom = new Toasts(ui, "bottom", { fill: 0xc9d4ff, fontSize: 14 });
  const chrome = new FilmChrome(ui, history, {
    repoName: repoName,
    accent: 0x9a8cff,
    reducedMotion,
    clip: world,
    onSeek: (f) => transport.seek(f),
  });

  /* ------------------------------ layer stack ------------------------------ */

  const bgLayer = new Container(); // parallax stars + shooting stars
  const orbitGfx = new Graphics(); // orbit guide lines
  const releaseGfx = new Graphics(); // permanent release rings
  const trailGfx = new Graphics(); // branch motion trails
  const sectorGfx = new Graphics(); // the planet itself (territories)
  const fileLayer = new Container(); // file dots
  const bodyLayer = new Container(); // branch discs + moons
  const fxLayer = new Container(); // debris, shockwaves, comets
  const labelLayer = new Container(); // sector/branch/moon labels (world space)
  const atmo = new Sprite(atmoTex); // glowing atmospheric limb
  atmo.anchor.set(0.5);
  atmo.blendMode = "add";
  atmo.tint = 0x9ab4ff;
  // Country map: a weighted-Voronoi (power diagram) rasterised each ~90ms. The
  // whole disc is tiled into connected regions (one per directory) that share
  // borders and grow with commit share — one landmass, no gaps, no floating.
  const mapCanvas = document.createElement("canvas");
  mapCanvas.width = MAP_RES;
  mapCanvas.height = MAP_RES;
  const mapCtx = mapCanvas.getContext("2d");
  const mapImg = mapCtx ? mapCtx.createImageData(MAP_RES, MAP_RES) : null;
  const mapOwner = new Uint8Array(MAP_RES * MAP_RES);
  const mapTex = Texture.from(mapCanvas);
  mapTex.source.scaleMode = "linear"; // smooth the upscale (no pixelated borders)
  const mapSprite = new Sprite(mapTex);
  mapSprite.anchor.set(0.5);
  let mapAccum = 999;
  world.addChild(
    bgLayer,
    orbitGfx,
    releaseGfx,
    trailGfx,
    mapSprite,
    sectorGfx,
    fileLayer,
    atmo,
    bodyLayer,
    fxLayer,
    labelLayer,
  );

  // Faint flat halo so the world reads against the void (no 3D shading).
  const halo = new Sprite(glowTex);
  halo.anchor.set(0.5);
  halo.blendMode = "add";
  halo.tint = 0x6d5dfc;
  halo.alpha = 0.16;
  world.addChildAt(halo, 1);

  /* ------------------------------- background ------------------------------- */

  const shootingStars: ShootingStar[] = [];
  let nextShootingStar = 4000 + rng() * 6000;

  const buildBackground = () => {
    bgLayer.removeChildren();
    const count = Math.round(620 * governor.scale);
    const w = app.screen.width * 2.4;
    const h = app.screen.height * 2.4;
    for (let i = 0; i < count; i++) {
      const s = new Sprite(dotTex);
      s.anchor.set(0.5);
      s.position.set((rng() - 0.5) * w, (rng() - 0.5) * h);
      s.scale.set(0.05 + rng() * 0.15);
      s.alpha = 0.16 + rng() * 0.38;
      bgLayer.addChild(s);
    }
  };
  buildBackground();

  /* ------------------------------- label system ------------------------------ */

  let labelsOn = true;

  const makeLabel = (size: number, alpha = 0.85, fill: number = LABEL_COLOR): Text => {
    const t = new Text({
      text: "",
      style: { fontFamily: "monospace", fontSize: size, fill, align: "center" },
    });
    t.anchor.set(0.5);
    t.alpha = 0;
    t.visible = true;
    labelLayer.addChild(t);
    t.zIndex = 10;
    (t as unknown as { targetAlpha: number }).targetAlpha = alpha;
    return t;
  };

  // Clickable chip (screen space) to toggle labels; T does the same.
  const chip = new Text({
    text: "",
    style: { fontFamily: "monospace", fontSize: 12, fill: 0xe8ecff, align: "right" },
  });
  chip.anchor.set(1, 1);
  chip.alpha = 0.7;
  chip.eventMode = "static";
  chip.cursor = "pointer";
  chip.on("pointertap", () => {
    labelsOn = !labelsOn;
    syncChip();
  });
  const syncChip = () => {
    chip.text = `[ labels: ${labelsOn ? "on" : "off"} · T ]`;
  };
  syncChip();
  ui.addChild(chip);

  // Hover tooltip (screen space): dark pill + text.
  const tooltipBg = new Graphics();
  const tooltipText = new Text({
    text: "",
    style: { fontFamily: "monospace", fontSize: 12, fill: 0xffffff },
  });
  const tooltip = new Container();
  tooltip.addChild(tooltipBg, tooltipText);
  tooltip.visible = false;
  ui.addChild(tooltip);

  const setTooltip = (message: string | null, screenX: number, screenY: number) => {
    if (!message) {
      tooltip.visible = false;
      return;
    }
    if (tooltipText.text !== message) {
      tooltipText.text = message;
      const w = tooltipText.width + 16;
      const h = tooltipText.height + 8;
      tooltipBg.clear();
      tooltipBg.roundRect(0, 0, w, h, 6).fill({ color: 0x07091a, alpha: 0.85 });
      tooltipBg.roundRect(0, 0, w, h, 6).stroke({ color: 0xe8ecff, alpha: 0.18, width: 1 });
      tooltipText.position.set(8, 4);
    }
    const pad = 14;
    const w = tooltipBg.width;
    const h = tooltipBg.height;
    tooltip.position.set(
      Math.min(screenX + pad, app.screen.width - chrome.sidebarWidth - w - 6),
      Math.min(Math.max(6, screenY - h - pad), app.screen.height - h - 6),
    );
    tooltip.visible = true;
  };

  /* ------------------------------ planet state ------------------------------ */

  const START_MASS = 30;
  let mass = START_MASS;
  let clockMs = 0;
  let zoomKick = 0;
  const impactWave = { age: 99999, angle: 0 };
  let displayR = radiusOf(mass);
  let growthPulse = 0;
  const era = 1;

  const shortName = (n: string): string => {
    const parts = n.split(" ");
    return parts.length > 1 ? `${parts[0]} ${(parts[1] ?? "").charAt(0)}.` : n.slice(0, 14);
  };
  const extOf = (path?: string): string => {
    if (!path) return "·other";
    const slash = path.lastIndexOf("/");
    const dot = path.lastIndexOf(".");
    return dot > slash + 1 ? path.slice(dot) : "·other";
  };

  const keyOf = (mode: number, e: RepoEvent): string => {
    if (mode === 1) return history.authors[e.author] ?? "anon";
    if (mode === 2) return extOf(e.path);
    return history.clusterNames[e.cluster % Math.max(1, history.clusterNames.length)] ?? "·root";
  };
  const labelOf = (mode: number, key: string): string => (mode === 1 ? shortName(key) : key);
  const hashStr = (str: string): number => {
    let h = 2166136261;
    for (let i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return h >>> 0;
  };

  // The SHOWN territories are the LIVE top-N by commits-so-far (like Race): a key
  // earns a country only once it breaks into the current top, and loses it when
  // overtaken. `tally` = cumulative commit weight per key up to the playhead.
  let topCount = 14;
  let groupMode = 0;
  const tally = new Map<string, number>();
  const sectorByKey = new Map<string, SectorState>();
  let slots: (string | null)[] = new Array(topCount).fill(null);
  let sectors: SectorState[] = [];

  const seedFor = (slot: number): [number, number] => {
    const n = Math.max(1, slots.length);
    const sr = 0.62 * Math.sqrt((slot + 0.5) / n);
    return [sr * Math.cos(slot * GOLDEN_ANGLE), sr * Math.sin(slot * GOLDEN_ANGLE)];
  };
  const mkSector = (key: string, slot: number): SectorState => {
    const bright = hslToInt(hashStr(key) % 360, 0.6, 0.66);
    const [nx, ny] = seedFor(slot);
    return {
      name: labelOf(groupMode, key),
      key,
      slot,
      bright,
      muted: mixColor(bright, CORE_COLOR, 0.5),
      weight: tally.get(key) ?? 1,
      share: 1 / Math.max(1, topCount),
      commits: 0,
      flash: 0,
      darken: 0,
      files: [],
      label: makeLabel(15, 0.95, 0x0b0f1c),
      nx,
      ny,
      cnx: nx,
      cny: ny,
      cx: 0,
      cy: 0,
      r: (bright >> 16) & 0xff,
      g: (bright >> 8) & 0xff,
      b: bright & 0xff,
      pw: 0,
      areaFrac: 0,
    };
  };
  const dropSector = (sec: SectorState): void => {
    sec.label.destroy();
    for (const f of sec.files) f.sprite.destroy();
    slots[sec.slot] = null;
    sectorByKey.delete(sec.key);
  };
  // Reconcile the shown set to the live top-N by tally (hysteresis avoids flicker).
  const reconcile = (): void => {
    const ranked = [...tally.entries()].sort((a, b) => b[1] - a[1]).map(([k]) => k);
    const want = new Set(ranked.slice(0, topCount));
    const keepBand = new Set(ranked.slice(0, topCount + 3));
    for (const [k, sec] of [...sectorByKey]) {
      if (!keepBand.has(k)) dropSector(sec);
    }
    for (const k of ranked) {
      if (sectorByKey.size >= topCount) break;
      if (sectorByKey.has(k) || !want.has(k)) continue;
      const slot = slots.indexOf(null);
      if (slot === -1) break;
      slots[slot] = k;
      sectorByKey.set(k, mkSector(k, slot));
    }
    for (const [k, sec] of sectorByKey) sec.weight = tally.get(k) ?? 1;
    sectors = [...sectorByKey.values()];
  };

  const usedFileNames = new Set<string>();
  const fileBudgetPerSector = () => Math.round(22 * governor.scale) + 4;

  const makeFileName = (sector: SectorState): string => {
    for (let attempt = 0; attempt < 8; attempt++) {
      const base = FILE_BASES[Math.floor(rng() * FILE_BASES.length)] ?? "mod";
      const ext = FILE_EXTS[Math.floor(rng() * FILE_EXTS.length)] ?? ".ts";
      const name = `${sector.name}/${base}${ext}`;
      if (!usedFileNames.has(name)) {
        usedFileNames.add(name);
        return name;
      }
    }
    return `${sector.name}/mod${Math.floor(rng() * 999)}.ts`;
  };

  const igniteFile = (sector: SectorState, magnitude: number): FileDot | null => {
    let file: FileDot | undefined;
    const reuseExisting = sector.files.length > 0 && rng() < 0.6;
    if (reuseExisting || sector.files.length >= fileBudgetPerSector()) {
      file = sector.files[Math.floor(rng() * sector.files.length)];
    }
    if (!file) {
      const sprite = new Sprite(dotTex);
      sprite.anchor.set(0.5);
      sprite.tint = sector.bright;
      fileLayer.addChild(sprite);
      const fa = rng() * Math.PI * 2;
      const fr = Math.sqrt(rng()) * 0.82; // uniform inside the coast
      file = {
        name: makeFileName(sector),
        ox: Math.cos(fa) * fr,
        oy: Math.sin(fa) * fr,
        x: 0,
        y: 0,
        changes: 0,
        ignite: 0,
        sprite,
      };
      sector.files.push(file);
    }
    file.changes++;
    file.ignite = 1;
    sector.flash = Math.min(1, sector.flash + 0.35 + magnitude * 0.4);
    return file;
  };

  /* ------------------------------ pools & bodies ----------------------------- */

  const branches: BranchPlanet[] = [];
  const branchSlots = [false, false, false];
  const moons: Moon[] = [];
  const debris: Debris[] = [];
  const debrisBudget = () => Math.round(420 * governor.scale);
  const shocks: Shockwave[] = [];
  const comets: Comet[] = [];
  const releaseFactors: number[] = [];
  let ringBirth = 0;

  const burst = (
    x: number,
    y: number,
    count: number,
    tint: number,
    speed: number,
    grav = false,
  ) => {
    for (let i = 0; i < count; i++) {
      let d = debris.find((p) => !p.active);
      if (!d) {
        if (debris.length >= debrisBudget()) return;
        const sprite = new Sprite(glowTex);
        sprite.anchor.set(0.5);
        sprite.blendMode = "add";
        fxLayer.addChild(sprite);
        d = { sprite, vx: 0, vy: 0, life: 0, maxLife: 1, grav: false, active: false };
        debris.push(d);
      }
      const angle = rng() * Math.PI * 2;
      const v = speed * (0.35 + rng() * 0.9);
      d.active = true;
      d.sprite.visible = true;
      d.sprite.position.set(x, y);
      d.sprite.tint = tint;
      d.sprite.alpha = 0.95;
      d.sprite.scale.set(0.1 + rng() * 0.2);
      d.vx = Math.cos(angle) * v;
      d.vy = Math.sin(angle) * v;
      d.life = 0;
      d.maxLife = 480 + rng() * 680;
      d.grav = grav;
    }
  };

  const shockwave = (x: number, y: number, toScale: number, dur: number, tint: number) => {
    let s = shocks.find((q) => !q.active);
    if (!s) {
      if (shocks.length >= 24) return;
      const sprite = new Sprite(ringTex);
      sprite.anchor.set(0.5);
      sprite.blendMode = "add";
      fxLayer.addChild(sprite);
      s = { sprite, age: 0, dur: 1, toScale: 1, active: false };
      shocks.push(s);
    }
    s.active = true;
    s.age = 0;
    s.dur = dur;
    s.toScale = toScale;
    s.sprite.visible = true;
    s.sprite.position.set(x, y);
    s.sprite.tint = tint;
  };

  const orbitRadiusFor = (slot: number): number => displayR * 1.85 + 52 + slot * 56;

  const absorbBranch = (b: BranchPlanet) => {
    mass += b.mass;
    const sector = sectors[b.cluster % sectors.length];
    if (sector) {
      sector.weight += b.mass * 0.9;
      sector.flash = 1;
      sector.commits += b.commits;
    }
    if (!reducedMotion) {
      shake.kick(0.03 + Math.min(0.06, b.mass / 320));
      zoomKick = Math.min(0.12, zoomKick + 0.05 + b.mass * 0.0012);
      impactWave.age = 0;
      impactWave.angle = Math.atan2(b.y, b.x);
      burst(b.x, b.y, Math.round(6 + b.mass * 0.5), b.tint, 0.16, true);
      shockwave(b.x, b.y, 1.3 + b.r / 44, 850, b.tint);
    } else {
      shockwave(b.x, b.y, 1.2, 1200, b.tint);
    }
    const ignitions = Math.min(14, Math.max(3, Math.round(b.commits * 0.8)));
    for (let i = 0; i < ignitions && sector; i++) igniteFile(sector, 0.5);
    growthPulse = 1;
    branchSlots[b.slot] = false;
    b.disc.destroy();
    b.label.destroy();
    branches.splice(branches.indexOf(b), 1);
  };

  const biteSector = (sector: SectorState, magnitude: number) => {
    const lost = Math.min(mass - 14, mass * (0.05 + magnitude * 0.09));
    if (lost > 0) mass -= lost;
    sector.darken = 1;
    const x = sector.cx;
    const y = sector.cy;
    if (!reducedMotion) {
      shake.kick(0.04 + magnitude * 0.1);
      burst(x, y, Math.round(18 + magnitude * 26), EMBER, 0.32);
      shockwave(x, y, 0.9 + magnitude * 0.9, 800, EMBER);
    }
    const drop = Math.round(magnitude * 4);
    for (let i = 0; i < drop && sector.files.length > 1; i++) {
      const file = sector.files.pop();
      file?.sprite.destroy();
      if (file) usedFileNames.delete(file.name);
    }
  };

  const launchComet = (sector: SectorState, magnitude: number) => {
    const file = igniteFile(sector, magnitude);
    if (reducedMotion) return;
    const spread = displayR * (0.05 + 0.4 * Math.sqrt(Math.max(0, sector.share)));
    const tx = sector.cx + (file ? file.ox * spread : 0);
    const ty = sector.cy + (file ? file.oy * spread : 0);
    const side = rng() * Math.PI * 2;
    const dist = Math.max(app.screen.width, app.screen.height) * 0.75;
    const head = new Sprite(glowTex);
    head.anchor.set(0.5);
    head.blendMode = "add";
    head.tint = EMBER;
    head.scale.set(0.34 + magnitude * 0.3);
    fxLayer.addChild(head);
    comets.push({
      head,
      fromX: Math.cos(side) * dist,
      fromY: Math.sin(side) * dist,
      tx,
      ty,
      key: sector.key,
      age: 0,
      dur: 800 - magnitude * 250,
      magnitude,
      trailCarry: 0,
      active: true,
    });
  };

  /* ------------------------------ era handling ------------------------------ */

  const eraCard = new Text({
    text: "",
    style: { fontFamily: "monospace", fontSize: 34, fill: 0xe8ecff, align: "center" },
  });
  eraCard.anchor.set(0.5);
  eraCard.alpha = 0;
  ui.addChild(eraCard);
  let eraCardAge = Infinity;

  const showEraCard = () => {
    eraCard.text = `ERA ${roman(era)}`;
    eraCardAge = 0;
  };
  showEraCard();

  /* ------------------------------ event wiring ------------------------------ */

  const onEvent = (e: RepoEvent) => {
    chrome.onEvent(e);
    switch (e.kind) {
      case "commit": {
        const weightGain = 0.5 + e.magnitude * 1.4;
        mass += weightGain;
        const k = keyOf(groupMode, e);
        tally.set(k, (tally.get(k) ?? 0) + weightGain);
        const sector = sectorByKey.get(k);
        if (sector) {
          sector.commits++;
          if (e.magnitude > params.cometAt) launchComet(sector, e.magnitude);
          else igniteFile(sector, e.magnitude);
        }
        break;
      }
      case "merge": {
        // A PR merge streaks in as an asteroid and crashes into its territory.
        mass += 2 + e.magnitude * 6;
        growthPulse = 1;
        const k = keyOf(groupMode, e);
        tally.set(k, (tally.get(k) ?? 0) + (2 + e.magnitude * 5));
        const sector = sectorByKey.get(k);
        if (sector) {
          sector.flash = 1;
          launchComet(sector, Math.max(e.magnitude, 0.55));
        }
        break;
      }
      case "massDelete": {
        const k = keyOf(groupMode, e);
        const cur = tally.get(k) ?? 0;
        tally.set(k, Math.max(0, cur - cur * 0.3 * e.magnitude));
        const sector = sectorByKey.get(k);
        if (sector) biteSector(sector, e.magnitude);
        break;
      }
      case "release":
        releaseFactors.push(1.42 + releaseFactors.length * 0.16);
        ringBirth = 0;
        growthPulse = 1;
        break;
    }
  };

  const player = new EventPlayer(history, history.duration / 110);
  const transport = player.transport();

  // Rebuild the tally for a grouping by replaying commits up to the playhead,
  // then reconcile the shown top-N.
  const resetGrouping = (mode: number): void => {
    for (const sec of sectorByKey.values()) {
      sec.label.destroy();
      for (const f of sec.files) f.sprite.destroy();
    }
    sectorByKey.clear();
    slots = new Array(topCount).fill(null);
    groupMode = mode;
    tally.clear();
    const now = player.progress * history.duration;
    for (const e of history.events) {
      if (e.t > now) break;
      const k = keyOf(mode, e);
      if (e.kind === "commit") tally.set(k, (tally.get(k) ?? 0) + (0.5 + e.magnitude * 1.4));
      else if (e.kind === "merge") tally.set(k, (tally.get(k) ?? 0) + (2 + e.magnitude * 5));
    }
    reconcile();
  };
  const switchMode = (m: number): void => {
    if (m === groupMode) return;
    resetGrouping(m);
  };
  const setTopCount = (n: number): void => {
    topCount = Math.max(4, Math.round(n));
    for (const sec of sectorByKey.values()) {
      sec.label.destroy();
      for (const f of sec.files) f.sprite.destroy();
    }
    sectorByKey.clear();
    slots = new Array(topCount).fill(null);
    reconcile();
  };

  /* ------------------------------- interaction ------------------------------ */

  let pointerX = -9999;
  let pointerY = -9999;

  const toWorld = (sx: number, sy: number): { x: number; y: number } => {
    const dx = sx - world.position.x;
    const dy = sy - world.position.y;
    const cos = Math.cos(-world.rotation);
    const sin = Math.sin(-world.rotation);
    return {
      x: (dx * cos - dy * sin) / world.scale.x,
      y: (dx * sin + dy * cos) / world.scale.y,
    };
  };

  app.stage.eventMode = "static";
  app.stage.hitArea = app.screen;
  app.stage.on("pointermove", (event: { global: { x: number; y: number } }) => {
    pointerX = event.global.x;
    pointerY = event.global.y;
  });

  const sectorAtWorld = (wx: number, wy: number): SectorState | null => {
    const nx = wx / displayR;
    const ny = wy / displayR;
    if (nx * nx + ny * ny > 0.94) return null;
    let best: SectorState | null = null;
    let bestV = Number.POSITIVE_INFINITY;
    for (const s of sectors) {
      const dx = nx - s.nx;
      const dy = ny - s.ny;
      const v = dx * dx + dy * dy - s.pw;
      if (v < bestV) {
        bestV = v;
        best = s;
      }
    }
    return best;
  };

  const onTap = (event: { global: { x: number; y: number } }) => {
    const { x: wx, y: wy } = toWorld(event.global.x, event.global.y);
    // Click a branch → merge it now.
    for (const b of branches) {
      if (b.state === "orbiting" && Math.hypot(wx - b.x, wy - b.y) < b.r + 10) {
        b.state = "infall";
        b.stateAge = 0;
        b.infallFromR = orbitRadiusFor(b.slot);
        return;
      }
    }
    // Click the planet → commit shower in that territory.
    const sector = sectorAtWorld(wx, wy);
    if (sector) {
      const k = sector.key;
      for (let i = 0; i < 4; i++) {
        mass += 0.7;
        tally.set(k, (tally.get(k) ?? 0) + 0.9);
        sector.commits++;
        igniteFile(sector, 0.4 + rng() * 0.5);
      }
      if (!reducedMotion) burst(wx, wy, 10, sector.bright, 0.16);
      return;
    }
    // Click the void → an asteroid finds a random live territory.
    const rs = sectors[Math.floor(rng() * sectors.length)];
    if (rs) launchComet(rs, 0.8);
  };
  app.stage.on("pointertap", onTap);

  const onKey = (ev: KeyboardEvent) => {
    if (ev.code === "KeyT") {
      labelsOn = !labelsOn;
      syncChip();
    } else if (ev.code === "KeyG") {
      switchMode((groupMode + 1) % 3);
    } else if (ev.code === "Space") {
      ev.preventDefault();
      // Fire a demo asteroid into a random live territory.
      const rs = sectors[Math.floor(rng() * sectors.length)];
      if (rs) launchComet(rs, 0.9);
    }
  };
  window.addEventListener("keydown", onKey);

  /* -------------------------------- frame loop ------------------------------- */

  let zoom = 1;

  const tick = () => {
    const dtMs = Math.min(app.ticker.deltaMS, 50);

    if (governor.update(dtMs)) buildBackground();
    for (const e of player.update(dtMs)) onEvent(e);
    reconcile();

    clockMs += dtMs;
    impactWave.age += dtMs;
    zoomKick = Math.max(0, zoomKick - dtMs * 0.00012);
    growthPulse = Math.max(0, growthPulse - dtMs / 900);
    ringBirth += dtMs;

    const targetR = radiusOf(mass);
    displayR += (targetR - displayR) * Math.min(1, dtMs / 350);
    const R = displayR * (1 + growthPulse * 0.035);

    halo.scale.set(R * 0.02);
    halo.alpha = 0.07 + growthPulse * 0.1;

    /* ----- territory shares (animated re-apportioning) ----- */
    const totalWeight = sectors.reduce((acc, s) => acc + s.weight, 0) || 1;
    for (const s of sectors) {
      const target = s.weight / totalWeight;
      s.share += (target - s.share) * Math.min(1, dtMs / 1600);
    }

    /* ----- draw the planet (one landmass: a weighted-Voronoi country map) ----- */
    atmo.scale.set((R * 1.12 * 2) / 256);
    atmo.alpha = 0.34 + growthPulse * 0.5;
    mapSprite.scale.set((R * 2) / MAP_RES); // normalized +/-1 -> +/-R

    for (const s of sectors) {
      s.cx = s.cnx * R; // cell centroid in world space (labels / files / merge target)
      s.cy = s.cny * R;
      s.flash = Math.max(0, s.flash - dtMs / 700);
    }

    // Rasterise the power diagram a few times a second (cheap, decoupled from 60fps).
    mapAccum += dtMs;
    if (mapImg && mapCtx && mapAccum >= 90) {
      mapAccum = 0;
      const ns = sectors.length;
      const SX = new Float64Array(ns);
      const SY = new Float64Array(ns);
      const W = new Float64Array(ns);
      const CR = new Float64Array(ns);
      const CG = new Float64Array(ns);
      const CB = new Float64Array(ns);
      const AX = new Float64Array(ns);
      const AY = new Float64Array(ns);
      const AN = new Float64Array(ns);
      for (let i = 0; i < ns; i++) {
        const s = sectors[i];
        if (!s) continue;
        SX[i] = s.nx;
        SY[i] = s.ny;
        W[i] = s.pw; // capacity-constrained weight (area converges to share)
        const glow = 1 + s.flash * 0.45;
        CR[i] = Math.min(255, s.r * glow);
        CG[i] = Math.min(255, s.g * glow);
        CB[i] = Math.min(255, s.b * glow);
      }
      const data = mapImg.data;
      const owner = mapOwner;
      const inv = 2 / MAP_RES;
      const edge = 0.97 * 0.97;
      for (let py = 0; py < MAP_RES; py++) {
        const ny = (py + 0.5) * inv - 1;
        for (let px = 0; px < MAP_RES; px++) {
          const nx = (px + 0.5) * inv - 1;
          const p = py * MAP_RES + px;
          const idx = p * 4;
          const rr = nx * nx + ny * ny;
          if (rr > edge) {
            data[idx + 3] = 0;
            owner[p] = 255;
            continue;
          }
          let best = 0;
          let bestV = Number.POSITIVE_INFINITY;
          for (let i = 0; i < ns; i++) {
            const ddx = nx - (SX[i] ?? 0);
            const ddy = ny - (SY[i] ?? 0);
            const v = ddx * ddx + ddy * ddy - (W[i] ?? 0);
            if (v < bestV) {
              bestV = v;
              best = i;
            }
          }
          owner[p] = best;
          AX[best] = (AX[best] ?? 0) + nx;
          AY[best] = (AY[best] ?? 0) + ny;
          AN[best] = (AN[best] ?? 0) + 1;
          const shade = 0.74 + 0.26 * (1 - rr); // gentle roundness
          data[idx] = (CR[best] ?? 0) * shade;
          data[idx + 1] = (CG[best] ?? 0) * shade;
          data[idx + 2] = (CB[best] ?? 0) * shade;
          data[idx + 3] = 255;
        }
      }
      // Country borders: darken where the owning directory changes.
      for (let py = 1; py < MAP_RES; py++) {
        for (let px = 1; px < MAP_RES; px++) {
          const p = py * MAP_RES + px;
          const o = owner[p];
          if (o === 255) continue;
          if (o !== owner[p - 1] || o !== owner[p - MAP_RES]) {
            const idx = p * 4;
            data[idx] = (data[idx] ?? 0) * 0.4;
            data[idx + 1] = (data[idx + 1] ?? 0) * 0.4;
            data[idx + 2] = (data[idx + 2] ?? 0) * 0.45;
          }
        }
      }
      let inside = 0;
      for (let i = 0; i < ns; i++) inside += AN[i] ?? 0;
      inside = inside || 1;
      let totShare = 0;
      for (const sc of sectors) totShare += sc.share;
      totShare = totShare || 1;
      let meanPw = 0;
      for (let i = 0; i < ns; i++) {
        const s = sectors[i];
        if (!s) continue;
        const c = AN[i] ?? 0;
        s.areaFrac = c / inside;
        // Capacity constraint: nudge weight so the painted area matches commit share.
        s.pw += (s.share / totShare - s.areaFrac) * 0.6;
        s.pw = Math.max(-1, Math.min(1, s.pw));
        if (c > 0) {
          s.cnx = (AX[i] ?? 0) / c;
          s.cny = (AY[i] ?? 0) / c;
        }
        meanPw += s.pw;
      }
      meanPw /= ns || 1;
      for (const sc of sectors) sc.pw -= meanPw; // only weight differences matter
      mapCtx.putImageData(mapImg, 0, 0);
      mapTex.source.update();
    }

    /* ----- release rings ----- */
    releaseGfx.clear();
    for (let i = 0; i < releaseFactors.length; i++) {
      const factor = releaseFactors[i] ?? 1.4;
      const isNewest = i === releaseFactors.length - 1;
      const born = isNewest ? easeOutCubic(clamp01(ringBirth / 900)) : 1;
      const rr = R * (1 + (factor - 1) * born);
      releaseGfx
        .circle(0, 0, rr)
        .stroke({ color: RING_TINT, alpha: Math.max(0.05, 0.18 - i * 0.015) * born, width: 1.4 });
    }

    /* ----- file city-lights within their country ----- */
    for (const s of sectors) {
      const spread = R * (0.05 + 0.4 * Math.sqrt(Math.max(0, s.share)));
      for (const f of s.files) {
        f.ignite = Math.max(0, f.ignite - dtMs / 1000);
        f.x = s.cx + f.ox * spread;
        f.y = s.cy + f.oy * spread;
        f.sprite.position.set(f.x, f.y);
        f.sprite.scale.set(0.16 + Math.min(0.2, f.changes * 0.014) + f.ignite * 0.34);
        f.sprite.alpha =
          (0.42 + 0.14 * Math.sin(clockMs * 0.002 + f.ox * 6.28) + f.ignite * 0.45) * params.dots;
        f.sprite.tint =
          f.ignite > 0.55 ? mixColor(s.bright, 0xffffff, 0.7) : mixColor(s.bright, 0xffe6b0, 0.4);
      }
    }

    /* ----- branches ----- */
    trailGfx.clear();
    for (let i = branches.length - 1; i >= 0; i--) {
      const b = branches[i];
      if (!b) continue;
      b.stateAge += dtMs;
      b.pulse = Math.max(0, b.pulse - dtMs / 500);
      const speedFactor = b.state === "infall" ? 2.6 : 1;
      b.orbitAngle += b.orbitSpeed * dtMs * speedFactor;
      const orbitR = orbitRadiusFor(b.slot);
      b.r = radiusOf(b.mass);
      const infSec = sectors[b.cluster % sectors.length];
      if (b.state === "infall") {
        // Spiral gently inward and settle onto the directory's territory centre.
        const tx = infSec ? infSec.cx : 0;
        const ty = infSec ? infSec.cy : 0;
        const curR = Math.hypot(b.x, b.y) || 1;
        const curA = Math.atan2(b.y, b.x);
        const tgtR = Math.hypot(tx, ty);
        let dA = Math.atan2(ty, tx) - curA;
        dA = Math.atan2(Math.sin(dA), Math.cos(dA)); // shortest turn
        const k = Math.min(1, dtMs / 950);
        const nr = curR + (tgtR - curR) * k;
        const na = curA + dA * k * 0.6;
        b.x = Math.cos(na) * nr;
        b.y = Math.sin(na) * nr;
      } else {
        b.x = Math.cos(b.orbitAngle) * orbitR;
        b.y = Math.sin(b.orbitAngle) * orbitR;
      }

      const spawnK = b.state === "spawning" ? easeOutBack(clamp01(b.stateAge / 500)) : 1;
      if (b.state === "spawning" && b.stateAge > 500) b.state = "orbiting";
      if (b.state === "orbiting" && b.autoInfallAt !== null && b.stateAge > b.autoInfallAt) {
        b.state = "infall";
        b.stateAge = 0;
        b.infallFromR = orbitRadiusFor(b.slot);
      }
      b.disc.position.set(b.x, b.y);
      // Never smaller than ~9px on screen, however far the camera pulls back.
      const renderBranchR = Math.max(b.r * 0.5 * (1 + b.pulse * 0.12), 6 / Math.max(0.12, zoom));
      b.disc.scale.set((renderBranchR * 2 * spawnK) / 128);

      // Motion trail.
      b.trailCarry += dtMs;
      if (b.trailCarry > 40) {
        b.trailCarry = 0;
        b.trail.push({ x: b.x, y: b.y });
        if (b.trail.length > 22) b.trail.shift();
      }
      for (let p = 1; p < b.trail.length; p++) {
        const prev = b.trail[p - 1];
        const cur = b.trail[p];
        if (!prev || !cur) continue;
        trailGfx.moveTo(prev.x, prev.y).lineTo(cur.x, cur.y);
        trailGfx.stroke({ color: b.tint, alpha: (p / b.trail.length) * 0.3, width: 1.4 });
      }

      if (b.state === "infall") {
        // Anticipation: a gravity tether reels it in; the disc strobes.
        const pullK = clamp01(b.stateAge / 1500);
        const strobe = 0.5 + 0.5 * Math.sin(b.stateAge * 0.02);
        b.disc.tint = mixColor(mixColor(b.tint, CORE_COLOR, 0.25), 0xffffff, strobe * 0.5 * pullK);
      }

      if (
        b.state === "infall" &&
        (Math.hypot(b.x - (infSec ? infSec.cx : 0), b.y - (infSec ? infSec.cy : 0)) <=
          b.r + R * 0.1 ||
          b.stateAge > 1600)
      ) {
        absorbBranch(b);
      }
    }

    /* ----- moons ----- */
    for (const m of moons) {
      m.angle += m.speed * dtMs;
      const mr = displayR * 1.5 + 26 + m.slot * 14;
      m.x = Math.cos(m.angle) * mr;
      m.y = Math.sin(m.angle) * mr;
      m.sprite.position.set(m.x, m.y);
      m.sprite.scale.set((0.45 + Math.min(0.75, m.commits * 0.008)) / Math.max(0.3, zoom));
    }

    /* ----- orbit trails (short arcs behind each body, not a full grid) ----- */
    orbitGfx.clear();
    for (const b of branches) {
      if (b.state === "infall") continue;
      orbitGfx
        .arc(0, 0, orbitRadiusFor(b.slot), b.orbitAngle - 0.5, b.orbitAngle)
        .stroke({ color: b.tint, alpha: 0.18, width: 1.5 });
    }
    for (const m of moons) {
      orbitGfx
        .arc(0, 0, displayR * 1.5 + 26 + m.slot * 14, m.angle - 0.55, m.angle)
        .stroke({ color: 0xc9d4ff, alpha: 0.13, width: 1.5 });
    }

    /* ----- comets ----- */
    for (let i = comets.length - 1; i >= 0; i--) {
      const c = comets[i];
      if (!c?.active) continue;
      c.age += dtMs;
      const k = clamp01(c.age / c.dur);
      const ease = k * k;
      const x = c.fromX + (c.tx - c.fromX) * ease;
      const y = c.fromY + (c.ty - c.fromY) * ease;
      c.head.position.set(x, y);
      c.trailCarry += dtMs;
      while (c.trailCarry > 34) {
        c.trailCarry -= 34;
        burst(x, y, 1, EMBER, 0.012);
      }
      if (k >= 1) {
        c.active = false;
        c.head.destroy();
        comets.splice(i, 1);
        const sec = sectorByKey.get(c.key);
        if (sec) sec.flash = Math.min(1, sec.flash + 0.5);
        if (!reducedMotion) {
          shake.kick(0.03 + c.magnitude * 0.05);
          burst(c.tx, c.ty, Math.round(5 + c.magnitude * 8), EMBER, 0.14);
          shockwave(c.tx, c.ty, 0.6 + c.magnitude * 0.5, 700, EMBER);
        }
      }
    }

    /* ----- shooting stars (ambience) ----- */
    if (!reducedMotion) {
      nextShootingStar -= dtMs;
      if (nextShootingStar <= 0) {
        nextShootingStar = 7000 + rng() * 8000;
        let star = shootingStars.find((s) => !s.active);
        if (!star) {
          const sprite = new Sprite(glowTex);
          sprite.anchor.set(0.5);
          sprite.blendMode = "add";
          bgLayer.addChild(sprite);
          star = { sprite, vx: 0, vy: 0, life: 0, active: false };
          shootingStars.push(star);
        }
        const w = app.screen.width;
        const startX = (rng() - 0.5) * w * 1.6;
        const startY = -app.screen.height * (0.7 + rng() * 0.3);
        const angle = Math.PI * (0.35 + rng() * 0.3);
        const speed = 0.9 + rng() * 0.5;
        star.active = true;
        star.life = 0;
        star.vx = Math.cos(angle) * speed;
        star.vy = Math.sin(angle) * speed;
        star.sprite.visible = true;
        star.sprite.position.set(startX, startY);
        star.sprite.tint = 0xe8ecff;
        star.sprite.rotation = angle;
        star.sprite.scale.set(1.6, 0.12);
      }
      for (const s of shootingStars) {
        if (!s.active) continue;
        s.life += dtMs;
        s.sprite.x += s.vx * dtMs;
        s.sprite.y += s.vy * dtMs;
        s.sprite.alpha = 0.5 * (1 - s.life / 1400);
        if (s.life > 1400) {
          s.active = false;
          s.sprite.visible = false;
        }
      }
    }

    /* ----- debris & shockwaves ----- */
    for (const d of debris) {
      if (!d.active) continue;
      d.life += dtMs;
      if (d.life >= d.maxLife) {
        d.active = false;
        d.sprite.visible = false;
        continue;
      }
      const drag = Math.exp(-0.0014 * dtMs);
      d.vx *= drag;
      d.vy *= drag;
      if (d.grav) {
        // Arc back home: gentle pull toward the planet's heart.
        const dist = Math.max(20, Math.hypot(d.sprite.x, d.sprite.y));
        d.vx += (-d.sprite.x / dist) * 0.0011 * dtMs;
        d.vy += (-d.sprite.y / dist) * 0.0011 * dtMs;
      }
      d.sprite.x += d.vx * dtMs;
      d.sprite.y += d.vy * dtMs;
      d.sprite.alpha = 0.95 * (1 - d.life / d.maxLife);
    }
    for (const s of shocks) {
      if (!s.active) continue;
      s.age += dtMs;
      const k = clamp01(s.age / s.dur);
      if (k >= 1) {
        s.active = false;
        s.sprite.visible = false;
        continue;
      }
      const eased = easeOutCubic(k);
      s.sprite.scale.set(0.1 + s.toScale * eased);
      s.sprite.alpha = 0.8 * (1 - eased);
    }

    /* ----- labels ----- */
    const labelFade = (text: Text, on: boolean, target: number) => {
      const goal = on ? target : 0;
      text.alpha += (goal - text.alpha) * Math.min(1, dtMs / 250);
    };
    for (const s of sectors) {
      s.label.text = groupMode === 0 ? `${s.name}/` : s.name;
      s.label.position.set(s.cx, s.cy);
      s.label.rotation = -world.rotation;
      // Scale with the planet radius (world space) so labels grow with it.
      s.label.scale.set(Math.max(0.7, R / 220));
      labelFade(s.label, labelsOn && s.areaFrac >= 0.03, 0.95);
    }
    for (const b of branches) {
      b.label.text = `${b.name} · ${b.commits}`;
      b.label.position.set(b.x, b.y - b.r - 14 / Math.max(0.3, zoom));
      b.label.rotation = -world.rotation;
      b.label.scale.set(1 / Math.max(0.22, zoom));
      labelFade(b.label, false, 0.9); // names live in the sidebar + hover
    }
    for (const m of moons) {
      m.label.text = m.name.split(" ")[0] ?? m.name;
      m.label.position.set(m.x, m.y - 13 / Math.max(0.3, zoom));
      m.label.rotation = -world.rotation;
      m.label.scale.set(1 / Math.max(0.22, zoom));
      labelFade(m.label, labelsOn, 0.5);
    }

    /* ----- hover tooltip ----- */
    let tip: string | null = null;
    if (pointerX > -999) {
      const { x: wx, y: wy } = toWorld(pointerX, pointerY);
      for (const b of branches) {
        if (Math.hypot(wx - b.x, wy - b.y) < b.r + 8) {
          tip = `${b.name} · branch · ${b.commits} commits`;
          break;
        }
      }
      if (!tip) {
        for (const m of moons) {
          if (Math.hypot(wx - m.x, wy - m.y) < 12 / Math.max(0.3, zoom)) {
            tip = `${m.name} · contributor · ${m.commits} commits`;
            break;
          }
        }
      }
      if (!tip) {
        let best: FileDot | null = null;
        let bestSector: SectorState | null = null;
        let bestD = 9 / Math.max(0.2, zoom);
        for (const s of sectors) {
          for (const f of s.files) {
            const d = Math.hypot(wx - f.sprite.x, wy - f.sprite.y);
            if (d < bestD) {
              bestD = d;
              best = f;
              bestSector = s;
            }
          }
        }
        if (best && bestSector) {
          tip = `${best.name} · ${best.changes} change${best.changes === 1 ? "" : "s"}`;
        }
      }
      if (!tip) {
        const s = sectorAtWorld(wx, wy);
        if (s) {
          const pct = Math.round((s.areaFrac ?? 0) * 100);
          const nm = groupMode === 0 ? `${s.name}/` : s.name;
          tip = `${nm} · ${pct}% of planet · ${s.commits} commits`;
        }
      }
    }
    setTooltip(tip, pointerX, pointerY);

    /* ----- era card ----- */
    eraCardAge += dtMs;
    const ek = clamp01(eraCardAge / 2600);
    eraCard.alpha = ek < 0.2 ? ek / 0.2 : ek > 0.75 ? (1 - ek) / 0.25 : 1;
    if (ek >= 1) eraCard.alpha = 0;
    eraCard.position.set(chrome.contentWidth(app.screen.width) / 2, app.screen.height * 0.42);

    /* ----- toasts, chip ----- */
    toastsTop.update(dtMs, chrome.contentWidth(app.screen.width), app.screen.height);
    toastsBottom.update(
      dtMs,
      chrome.contentWidth(app.screen.width),
      chrome.contentHeight(app.screen.height),
    );
    chip.position.set(
      chrome.contentWidth(app.screen.width) - 14,
      chrome.contentHeight(app.screen.height) - 10,
    );

    /* ----- camera ----- */
    const ringSpan =
      releaseFactors.length > 0 ? (releaseFactors[releaseFactors.length - 1] ?? 1.4) : 1.3;
    // Fit the planet (+ its release rings) only, never the transient asteroids,
    // so merges no longer make the viewport re-zoom and jump.
    const farthest = Math.max(displayR * 1.34, R * Math.min(ringSpan + 0.1, 1.7));
    const minDim = Math.min(
      chrome.contentWidth(app.screen.width),
      chrome.contentHeight(app.screen.height),
    );
    const targetZoom = Math.min(1.25, Math.max(0.16, (minDim * 0.44) / farthest));
    zoom += (targetZoom - zoom) * Math.min(1, dtMs / 600);

    if (!reducedMotion) shake.update(dtMs, rng);
    world.scale.set(zoom * (1 + zoomKick));
    world.rotation = reducedMotion ? 0 : Math.sin(clockMs * 0.00006) * 0.05;
    world.position.set(
      chrome.contentWidth(app.screen.width) / 2 + shake.x * params.shakeAmp,
      chrome.contentHeight(app.screen.height) / 2 + shake.y * params.shakeAmp,
    );

    const fileCount = sectors.reduce((acc, s) => acc + s.files.length, 0);
    chrome.update(dtMs, app.screen.width, app.screen.height, player.progress, [
      ["files", fileCount],
      ["mass", Math.round(mass)],
      ["dirs", sectors.length],
      ["era", roman(era)],
    ]);
    hud.update(
      dtMs,
      `mass ${Math.round(mass)} · files ${fileCount} · ${sectors.length} directories · era ${roman(era)} ${(player.progress * 100).toFixed(0)}%`,
    );
  };

  app.ticker.add(tick);

  return {
    destroy() {
      window.removeEventListener("keydown", onKey);
      boot.destroy();
    },
    transport,
    capture: makeCaptureHandle(app, {
      title: repoName,
      history: history,
      accent: 0x9a8cff,
      setChromeHidden: (b) => chrome.setHidden(b),
      setHudVisible: (b) => hud.setVisible(b),
      setLabels: (b) => {
        labelsOn = b;
      },
    }),
    controls: [
      {
        key: "mode",
        label: "view by (also G)",
        kind: "enum",
        options: [
          { label: "directory", value: 0 },
          { label: "author", value: 1 },
          { label: "language", value: 2 },
        ],
        value: 0,
        set: (v) => switchMode(v as number),
      },
      {
        key: "count",
        label: "top authors / languages",
        kind: "range",
        min: 6,
        max: 24,
        step: 1,
        value: 14,
        set: (v) => setTopCount(v as number),
      },
      {
        key: "cometAt",
        label: "comet threshold",
        kind: "range",
        min: 0.4,
        max: 1,
        step: 0.02,
        value: 0.72,
        set: (v) => {
          params.cometAt = v as number;
        },
      },
      {
        key: "dots",
        label: "file dot brightness",
        kind: "range",
        min: 0,
        max: 1.5,
        step: 0.05,
        value: 1,
        set: (v) => {
          params.dots = v as number;
        },
      },
      {
        key: "shakeAmp",
        label: "impact shake",
        kind: "range",
        min: 0,
        max: 2,
        step: 0.1,
        value: 1,
        set: (v) => {
          params.shakeAmp = v as number;
        },
      },
    ],
  };
}
