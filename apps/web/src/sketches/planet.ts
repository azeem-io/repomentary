/**
 * Planet sketch, flat orrery style. The repo is a disc divided into
 * territories, one per top-level directory, sized by their share of commits.
 * Files are dots that light up when touched. Branches orbit on drawn rings
 * and spiral in when merged. Contributors are moons, releases add permanent
 * rings, big commits arrive as comets.
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
  makeDotTexture,
  makeGlowTexture,
  makeRingTexture,
  type SketchInstance,
  Toasts,
} from "./common";

const VOID = "#07091a";
const CORE_COLOR = 0x14122e;
const RIM_COLOR = 0xe8ecff;
const RING_TINT = 0xc9b08f;
const EMBER = 0xffb454;
const MOON_TINT = 0xc9d4ff;
const LABEL_COLOR = 0xc9d4ff;

/** Bright territory palette; muted variants are derived. */
const SECTOR_COLORS = [
  0x6d5dfc, 0x4ecdc4, 0xffa3c2, 0xffd28f, 0x8fd0ff, 0xa5ffd0, 0xc2a8ff, 0xff8f70, 0xb8e986,
  0x7ea6ff,
];

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
  /** Polar position inside the territory (fractions, stable across growth). */
  angleFrac: number;
  radFrac: number;
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
  /** Current angular bounds (recomputed every frame). */
  a0: number;
  a1: number;
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
  cluster: number;
  fileIndex: number;
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

/** Flat disc with a crisp (lightly antialiased) edge, branch planets. */
function makeDiscTexture(size = 128): Texture {
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d");
  if (ctx) {
    const r = size / 2;
    const g = ctx.createRadialGradient(r, r, 0, r, r, r);
    g.addColorStop(0, "rgba(255,255,255,1)");
    g.addColorStop(0.94, "rgba(255,255,255,1)");
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
  const discTex = makeDiscTexture(128);

  const params = { rotation: 1, mergeSize: 1, cometAt: 0.72, dots: 1, shakeAmp: 1 };
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
  world.addChild(
    bgLayer,
    orbitGfx,
    releaseGfx,
    trailGfx,
    sectorGfx,
    fileLayer,
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

  const makeLabel = (size: number, alpha = 0.85): Text => {
    const t = new Text({
      text: "",
      style: { fontFamily: "monospace", fontSize: size, fill: LABEL_COLOR, align: "center" },
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
    chip.text = `[ labels: ${labelsOn ? "on" : "off"} — T ]`;
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
  let rotation = 0;
  const era = 1;

  // Organic rim: shared wobble so territory edges meet a continuous coastline.
  const w1 = rng() * Math.PI * 2;
  const w2 = rng() * Math.PI * 2;
  const rimAt = (theta: number, R: number): number =>
    R * (1 + 0.05 * Math.sin(3 * theta + w1) + 0.032 * Math.sin(7 * theta + w2));

  const sectors: SectorState[] = history.clusterNames.map((name, i) => {
    const bright = SECTOR_COLORS[i % SECTOR_COLORS.length] ?? 0x6d5dfc;
    return {
      name,
      bright,
      muted: mixColor(bright, CORE_COLOR, 0.5),
      weight: 1,
      share: 1 / history.clusters,
      commits: 0,
      flash: 0,
      darken: 0,
      files: [],
      label: makeLabel(13, 0.8),
      a0: 0,
      a1: 0,
    };
  });

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

  const igniteFile = (cluster: number, magnitude: number): FileDot | null => {
    const sector = sectors[cluster % sectors.length];
    if (!sector) return null;
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
      file = {
        name: makeFileName(sector),
        angleFrac: 0.12 + rng() * 0.76,
        radFrac: 0.3 + rng() * 0.58,
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

  const spawnBranch = (id: number, cluster: number, name: string) => {
    let slot = branchSlots.findIndex((used) => !used);
    if (slot === -1) slot = 0;
    branchSlots[slot] = true;
    const sector = sectors[cluster % sectors.length];
    const tint = sector ? sector.bright : 0x8fd0ff;

    const disc = new Sprite(discTex);
    disc.anchor.set(0.5);
    disc.tint = mixColor(tint, CORE_COLOR, 0.25);
    bodyLayer.addChild(disc);

    branches.push({
      id,
      name,
      cluster,
      disc,
      label: makeLabel(12, 0.9),
      mass: 6,
      commits: 0,
      orbitAngle: rng() * Math.PI * 2,
      orbitSpeed: (0.00026 + rng() * 0.0002) * (reducedMotion ? 0.5 : 1),
      slot,
      tint,
      state: "spawning",
      stateAge: 0,
      autoInfallAt: null,
      infallFromR: 0,
      pulse: 0,
      trail: [],
      trailCarry: 0,
      x: 0,
      y: 0,
      r: radiusOf(6),
    });
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
      shake.kick(0.22 + Math.min(0.6, b.mass / 34));
      zoomKick = Math.min(0.12, zoomKick + 0.05 + b.mass * 0.0012);
      impactWave.age = 0;
      impactWave.angle = Math.atan2(b.y, b.x);
      burst(b.x, b.y, Math.round(16 + b.mass * 1.4), b.tint, 0.3, true);
      burst(b.x, b.y, 12, EMBER, 0.22, true);
      shockwave(b.x, b.y, 2 + b.r / 26, 850, b.tint);
      shockwave(0, 0, 3 + displayR / 34, 1200, 0xffffff);
    } else {
      shockwave(0, 0, 2.4, 1400, b.tint);
    }
    const ignitions = Math.min(14, Math.max(3, Math.round(b.commits * 0.8)));
    for (let i = 0; i < ignitions; i++) igniteFile(b.cluster, 0.5);
    growthPulse = 1;
    branchSlots[b.slot] = false;
    b.disc.destroy();
    b.label.destroy();
    branches.splice(branches.indexOf(b), 1);
  };

  const biteSector = (cluster: number, magnitude: number) => {
    const sector = sectors[cluster % sectors.length];
    if (!sector) return;
    const lost = Math.min(mass - 14, mass * (0.05 + magnitude * 0.09));
    if (lost > 0) mass -= lost;
    sector.weight = Math.max(0.4, sector.weight * (1 - 0.35 * magnitude));
    sector.darken = 1;
    const mid = (sector.a0 + sector.a1) / 2;
    const x = Math.cos(mid) * displayR;
    const y = Math.sin(mid) * displayR;
    if (!reducedMotion) {
      shake.kick(0.18 + magnitude * 0.38);
      burst(x, y, Math.round(18 + magnitude * 26), EMBER, 0.32);
      shockwave(x, y, 1.8 + magnitude * 1.8, 800, EMBER);
    }
    const drop = Math.round(magnitude * 4);
    for (let i = 0; i < drop && sector.files.length > 1; i++) {
      const file = sector.files.pop();
      file?.sprite.destroy();
      if (file) usedFileNames.delete(file.name);
    }
  };

  const launchComet = (cluster: number, magnitude: number) => {
    const file = igniteFile(cluster, magnitude);
    if (!file || reducedMotion) return;
    const sector = sectors[cluster % sectors.length];
    if (!sector) return;
    const fileIndex = sector.files.indexOf(file);
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
      cluster,
      fileIndex,
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
        const branch = e.branch ? branches.find((x) => x.id === e.branch) : undefined;
        if (branch) {
          branch.mass += weightGain;
          branch.commits++;
          branch.pulse = 1;
        } else {
          mass += weightGain;
          const sector = sectors[e.cluster % sectors.length];
          if (sector) {
            sector.weight += weightGain;
            sector.commits++;
          }
          if (e.magnitude > params.cometAt) launchComet(e.cluster, e.magnitude);
          else igniteFile(e.cluster, e.magnitude);
        }
        const moon = moons.find((m) => m.author === e.author);
        if (moon) moon.commits++;
        break;
      }
      case "branchStart":
        if (e.branch) spawnBranch(e.branch, e.cluster, e.label ?? `branch-${e.branch}`);
        break;
      case "merge": {
        const branch = branches.find((x) => x.id === e.branch);
        if (branch && branch.state !== "infall") {
          branch.state = "infall";
          branch.stateAge = 0;
          branch.infallFromR = orbitRadiusFor(branch.slot);
        } else if (branches.length < 3) {
          // Real merge with no tracked branch lifecycle: a planet swings by
          // and is absorbed. Sized relative to the world so it stays visible.
          spawnBranch(9000 + Math.floor(rng() * 8999), e.cluster, e.label ?? "merge");
          const spawned = branches[branches.length - 1];
          if (spawned) {
            spawned.mass = Math.max(5 + e.magnitude * 16, mass * 0.05 * params.mergeSize);
            spawned.commits = 1 + Math.round(e.magnitude * 9);
            spawned.autoInfallAt = 2400 + rng() * 2200;
          }
        } else {
          mass += 2 + e.magnitude * 6;
          const sector = sectors[e.cluster % sectors.length];
          if (sector) {
            sector.weight += 2 + e.magnitude * 5;
            sector.flash = 1;
          }
          growthPulse = 1;
        }
        break;
      }
      case "massDelete":
        biteSector(e.cluster, e.magnitude);
        break;
      case "release":
        releaseFactors.push(1.42 + releaseFactors.length * 0.16);
        ringBirth = 0;
        growthPulse = 1;
        break;
      case "newContributor": {
        if (moons.length < 12) {
          const sprite = new Sprite(dotTex);
          sprite.anchor.set(0.5);
          sprite.tint = MOON_TINT;
          bodyLayer.addChild(sprite);
          moons.push({
            name: e.label ?? "someone",
            author: e.author,
            commits: 1,
            angle: rng() * Math.PI * 2,
            speed: (0.0001 + rng() * 0.00018) * (rng() < 0.5 ? 1 : -1),
            slot: moons.length,
            sprite,
            label: makeLabel(10, 0.55),
            x: 0,
            y: 0,
          });
        }
        if (e.label) toastsBottom.announce(`✦ ${e.label} joined`, 2200);
        break;
      }
    }
  };

  const player = new EventPlayer(history, history.duration / 110);
  const transport = player.transport();

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
    const theta = Math.atan2(wy, wx);
    const d = Math.hypot(wx, wy);
    for (const s of sectors) {
      // a0/a1 are continuous ascending; normalize theta into [a0, a0+2π)
      let t = theta;
      while (t < s.a0) t += Math.PI * 2;
      if (t <= s.a1 && d <= rimAt(t, displayR) * 1.02) return s;
    }
    return null;
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
      const cluster = sectors.indexOf(sector);
      for (let i = 0; i < 4; i++) {
        mass += 0.7;
        sector.weight += 0.9;
        sector.commits++;
        igniteFile(cluster, 0.4 + rng() * 0.5);
      }
      if (!reducedMotion) burst(wx, wy, 10, sector.bright, 0.16);
      return;
    }
    // Click the void → a comet finds a random territory.
    launchComet(Math.floor(rng() * sectors.length), 0.8);
  };
  app.stage.on("pointertap", onTap);

  const onKey = (ev: KeyboardEvent) => {
    if (ev.code === "KeyT") {
      labelsOn = !labelsOn;
      syncChip();
    } else if (ev.code === "Space") {
      ev.preventDefault();
      const ripest = [...branches]
        .filter((b) => b.state === "orbiting")
        .sort((a, b) => b.mass - a.mass)[0];
      if (ripest) {
        ripest.state = "infall";
        ripest.stateAge = 0;
        ripest.infallFromR = orbitRadiusFor(ripest.slot);
      } else {
        spawnBranch(
          900 + Math.floor(rng() * 99),
          Math.floor(rng() * sectors.length),
          "feat/surprise",
        );
        const b = branches[branches.length - 1];
        if (b) {
          b.mass = 10 + rng() * 12;
          b.commits = 6;
        }
      }
    }
  };
  window.addEventListener("keydown", onKey);

  /* -------------------------------- frame loop ------------------------------- */

  let zoom = 1;

  const tick = () => {
    const dtMs = Math.min(app.ticker.deltaMS, 50);

    if (governor.update(dtMs)) buildBackground();
    for (const e of player.update(dtMs)) onEvent(e);

    clockMs += dtMs;
    impactWave.age += dtMs;
    zoomKick = Math.max(0, zoomKick - dtMs * 0.00012);
    growthPulse = Math.max(0, growthPulse - dtMs / 900);
    rotation += dtMs * (reducedMotion ? 0.000012 : 0.00003) * params.rotation;
    ringBirth += dtMs;

    const targetR = radiusOf(mass);
    displayR += (targetR - displayR) * Math.min(1, dtMs / 350);
    const R = displayR * (1 + growthPulse * 0.035);

    halo.scale.set(R * 0.055);
    halo.alpha = 0.15 + growthPulse * 0.14;

    /* ----- territory shares (animated re-apportioning) ----- */
    const totalWeight = sectors.reduce((acc, s) => acc + s.weight, 0);
    let cursor = rotation;
    for (const s of sectors) {
      const target = s.weight / totalWeight;
      s.share += (target - s.share) * Math.min(1, dtMs / 1600);
    }
    const shareSum = sectors.reduce((acc, s) => acc + s.share, 0);
    for (const s of sectors) {
      const span = (s.share / shareSum) * Math.PI * 2;
      s.a0 = cursor;
      s.a1 = cursor + span;
      cursor += span;
    }

    /* ----- draw the planet ----- */
    sectorGfx.clear();
    const gap = 0.016;
    for (const s of sectors) {
      s.flash = Math.max(0, s.flash - dtMs / 700);
      s.darken = Math.max(0, s.darken - dtMs / 1100);
      const a0 = s.a0 + gap;
      const a1 = s.a1 - gap;
      if (a1 <= a0) continue;
      const steps = Math.max(6, Math.ceil((a1 - a0) / 0.09));
      const coreR = R * 0.17;
      let brightness = 0.18 + s.flash * 0.7;
      const waveT = impactWave.age / 650;
      if (waveT < 1) {
        const mid = (s.a0 + s.a1) / 2;
        let angDist = Math.abs(mid - impactWave.angle);
        angDist = Math.min(angDist % (Math.PI * 2), Math.PI * 2 - (angDist % (Math.PI * 2)));
        const front = waveT * Math.PI;
        const proximity = Math.max(0, 1 - Math.abs(angDist - front) / 0.9);
        brightness += proximity * (1 - waveT) * 0.55;
      }
      let color = mixColor(s.muted, s.bright, Math.min(1, brightness));
      if (s.darken > 0) color = mixColor(color, 0x000000, s.darken * 0.45);

      sectorGfx.moveTo(Math.cos(a0) * coreR, Math.sin(a0) * coreR);
      for (let i = 0; i <= steps; i++) {
        const t = a0 + ((a1 - a0) * i) / steps;
        const r = rimAt(t, R);
        sectorGfx.lineTo(Math.cos(t) * r, Math.sin(t) * r);
      }
      sectorGfx.lineTo(Math.cos(a1) * coreR, Math.sin(a1) * coreR);
      sectorGfx.arc(0, 0, coreR, a1, a0, true);
      sectorGfx.closePath();
      sectorGfx.fill({ color, alpha: 0.96 });
      if (s.flash > 0.15) {
        // Hot coastline while the territory is excited.
        for (let i = 0; i <= steps; i++) {
          const t = a0 + ((a1 - a0) * i) / steps;
          const r = rimAt(t, R) + 1;
          if (i === 0) sectorGfx.moveTo(Math.cos(t) * r, Math.sin(t) * r);
          else sectorGfx.lineTo(Math.cos(t) * r, Math.sin(t) * r);
        }
        sectorGfx.stroke({ color: s.bright, alpha: s.flash * 0.55, width: 2 });
      }
    }
    // Molten core, the repo's heartbeat.
    sectorGfx
      .circle(0, 0, R * 0.155)
      .fill({ color: mixColor(CORE_COLOR, 0xffffff, growthPulse * 0.5), alpha: 1 });
    // Coastline.
    const rimSteps = 90;
    for (let i = 0; i <= rimSteps; i++) {
      const t = (i / rimSteps) * Math.PI * 2;
      const r = rimAt(t, R) + 2;
      if (i === 0) sectorGfx.moveTo(Math.cos(t) * r, Math.sin(t) * r);
      else sectorGfx.lineTo(Math.cos(t) * r, Math.sin(t) * r);
    }
    sectorGfx.stroke({ color: RIM_COLOR, alpha: 0.22, width: 2 });

    /* ----- release rings ----- */
    releaseGfx.clear();
    for (let i = 0; i < releaseFactors.length; i++) {
      const factor = releaseFactors[i] ?? 1.4;
      const isNewest = i === releaseFactors.length - 1;
      const born = isNewest ? easeOutCubic(clamp01(ringBirth / 900)) : 1;
      const rr = R * (1 + (factor - 1) * born);
      releaseGfx
        .circle(0, 0, rr)
        .stroke({ color: RING_TINT, alpha: Math.max(0.07, 0.3 - i * 0.02) * born, width: 1.6 });
    }

    /* ----- file dots ----- */
    for (const s of sectors) {
      const span = s.a1 - s.a0;
      for (const f of s.files) {
        f.ignite = Math.max(0, f.ignite - dtMs / 1000);
        const t = s.a0 + span * f.angleFrac;
        const r = rimAt(t, R) * (0.22 + f.radFrac * 0.66);
        f.sprite.position.set(Math.cos(t) * r, Math.sin(t) * r);
        f.sprite.scale.set(0.16 + Math.min(0.2, f.changes * 0.014) + f.ignite * 0.3);
        f.sprite.alpha =
          (0.34 + 0.12 * Math.sin(clockMs * 0.002 + f.angleFrac * 6.28) + f.ignite * 0.6) *
          params.dots;
        f.sprite.tint = f.ignite > 0.4 ? 0xffffff : s.bright;
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
      let orbitR = orbitRadiusFor(b.slot);
      if (b.state === "infall") {
        const k = clamp01(b.stateAge / 1500);
        orbitR = b.infallFromR + (R - b.infallFromR) * (k * k * k);
      }
      b.r = radiusOf(b.mass);
      b.x = Math.cos(b.orbitAngle) * orbitR;
      b.y = Math.sin(b.orbitAngle) * orbitR;

      const spawnK = b.state === "spawning" ? easeOutBack(clamp01(b.stateAge / 500)) : 1;
      if (b.state === "spawning" && b.stateAge > 500) b.state = "orbiting";
      if (b.state === "orbiting" && b.autoInfallAt !== null && b.stateAge > b.autoInfallAt) {
        b.state = "infall";
        b.stateAge = 0;
        b.infallFromR = orbitRadiusFor(b.slot);
      }
      b.disc.position.set(b.x, b.y);
      // Never smaller than ~9px on screen, however far the camera pulls back.
      const renderBranchR = Math.max(b.r * (1 + b.pulse * 0.12), 9 / Math.max(0.12, zoom));
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
        trailGfx.moveTo(b.x, b.y).lineTo(0, 0);
        trailGfx.stroke({ color: b.tint, alpha: 0.12 + pullK * 0.22, width: 1.5 });
        const strobe = 0.5 + 0.5 * Math.sin(b.stateAge * 0.02);
        b.disc.tint = mixColor(mixColor(b.tint, CORE_COLOR, 0.25), 0xffffff, strobe * 0.5 * pullK);
      }

      if (b.state === "infall" && (Math.hypot(b.x, b.y) <= R + b.r * 0.4 || b.stateAge > 1600)) {
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

    /* ----- orbit guide lines ----- */
    orbitGfx.clear();
    for (const b of branches) {
      if (b.state === "infall") continue;
      orbitGfx.circle(0, 0, orbitRadiusFor(b.slot)).stroke({ color: b.tint, alpha: 0.1, width: 1 });
    }
    for (const m of moons) {
      orbitGfx
        .circle(0, 0, displayR * 1.5 + 26 + m.slot * 14)
        .stroke({ color: 0xe8ecff, alpha: 0.035, width: 1 });
    }

    /* ----- comets ----- */
    for (let i = comets.length - 1; i >= 0; i--) {
      const c = comets[i];
      if (!c?.active) continue;
      c.age += dtMs;
      const k = clamp01(c.age / c.dur);
      const sector = sectors[c.cluster % sectors.length];
      const file = sector?.files[c.fileIndex];
      // Homing target tracks the rotating planet.
      let tx = 0;
      let ty = 0;
      if (sector && file) {
        const t = sector.a0 + (sector.a1 - sector.a0) * file.angleFrac;
        const r = rimAt(t, R) * (0.22 + file.radFrac * 0.66);
        tx = Math.cos(t) * r;
        ty = Math.sin(t) * r;
      }
      const ease = k * k;
      const x = c.fromX + (tx - c.fromX) * ease;
      const y = c.fromY + (ty - c.fromY) * ease;
      c.head.position.set(x, y);
      c.trailCarry += dtMs;
      while (c.trailCarry > 18) {
        c.trailCarry -= 18;
        burst(x, y, 1, EMBER, 0.02);
      }
      if (k >= 1) {
        c.active = false;
        c.head.destroy();
        comets.splice(i, 1);
        if (sector) sector.flash = Math.min(1, sector.flash + 0.5);
        if (file) file.ignite = 1;
        if (!reducedMotion) {
          shake.kick(0.12 + c.magnitude * 0.2);
          burst(tx, ty, Math.round(10 + c.magnitude * 16), EMBER, 0.22);
          shockwave(tx, ty, 1.2 + c.magnitude, 700, EMBER);
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
      const mid = (s.a0 + s.a1) / 2;
      const lr = rimAt(mid, R) + 22;
      s.label.text = `${s.name}/`;
      s.label.position.set(Math.cos(mid) * lr, Math.sin(mid) * lr);
      s.label.rotation = -world.rotation;
      s.label.scale.set(1 / Math.max(0.45, zoom));
      labelFade(s.label, labelsOn && s.a1 - s.a0 > 0.18, 0.8);
    }
    for (const b of branches) {
      b.label.text = `${b.name} · ${b.commits}`;
      b.label.position.set(b.x, b.y - b.r - 14 / Math.max(0.3, zoom));
      b.label.rotation = -world.rotation;
      b.label.scale.set(1 / Math.max(0.45, zoom));
      labelFade(b.label, false, 0.9); // names live in the sidebar + hover
    }
    for (const m of moons) {
      m.label.text = m.name.split(" ")[0] ?? m.name;
      m.label.position.set(m.x, m.y - 13 / Math.max(0.3, zoom));
      m.label.rotation = -world.rotation;
      m.label.scale.set(1 / Math.max(0.45, zoom));
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
          const pct = Math.round(((s.a1 - s.a0) / (Math.PI * 2)) * 100);
          tip = `${s.name}/ · ${pct}% of planet · ${s.commits} commits`;
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
    const farthest = branches.reduce(
      (acc, b) => Math.max(acc, orbitRadiusFor(b.slot) + b.r + 20),
      Math.max(R * ringSpan + 30, displayR * 1.5 + 26 + moons.length * 14 + 24),
    );
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
      ["branches", branches.length],
      ["moons", moons.length],
      ["era", roman(era)],
    ]);
    hud.update(
      dtMs,
      `mass ${Math.round(mass)} · files ${fileCount} · branches ${branches.length} · moons ${moons.length} · era ${roman(era)} ${(player.progress * 100).toFixed(0)}%`,
    );
  };

  app.ticker.add(tick);

  return {
    destroy() {
      window.removeEventListener("keydown", onKey);
      boot.destroy();
    },
    transport,
    controls: [
      {
        key: "rotation",
        label: "world rotation",
        kind: "range",
        min: 0,
        max: 3,
        step: 0.1,
        value: 1,
        set: (v) => {
          params.rotation = v as number;
        },
      },
      {
        key: "mergeSize",
        label: "merge planet size",
        kind: "range",
        min: 0.5,
        max: 2,
        step: 0.1,
        value: 1,
        set: (v) => {
          params.mergeSize = v as number;
        },
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
