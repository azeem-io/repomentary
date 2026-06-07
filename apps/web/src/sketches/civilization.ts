/**
 * Civilization sketch: a top-down map where every top-level folder is a city
 * and the busiest one is the capital. Commits add rooftops, growth raises
 * walls, roads connect cities to the capital, merges send caravans down
 * them, releases build monuments, and contributors walk around as people.
 * Idle folders dim and decay, mass deletions start fires.
 *
 * Hover to inspect. Click a city for a build burst. Tuning panel covers
 * people, glow, roads, walls.
 */
import { mulberry32, type RepoEvent, type Rng } from "@repomentary/artifact";
import { Container, Graphics, Sprite, Text, Texture } from "pixi.js";
import { loadSharedHistory } from "@/lib/realHistory";
import { FilmChrome } from "./chrome";
import {
  bootPixi,
  EventPlayer,
  easeOutBack,
  FrameGovernor,
  makeDotTexture,
  makeGlowTexture,
  type SketchInstance,
} from "./common";

const GROUND = "#0a0e12";
const INK = 0xe8ecff;
const AMBER = 0xffd28f;
const WINDOW_WARM = 0xffd9a0;
const RUIN = 0x3a2f2a;
const TREE_GREEN = 0x2e5d46;
const CITY_COLORS = [
  0xc9a227, 0x4ecdc4, 0xd97f94, 0x8fd0ff, 0xa5ffd0, 0xc2a8ff, 0xff8f70, 0xb8e986, 0x7ea6ff,
  0xd9c2a0,
];

interface Building {
  sprite: Sprite;
  windowOn: boolean;
  ruin: boolean;
  spawnAge: number;
  /** Rooftops are polar-relative so settlements can grow under them. */
  r?: number;
  theta?: number;
  /** City rooftops: fraction of the city's CURRENT radius (fills the disc). */
  frac?: number;
}

interface City {
  cluster: number;
  name: string;
  color: number;
  x: number;
  y: number;
  buildings: Building[];
  commits: number;
  wallLevel: number;
  wallPulse: number;
  roadTraffic: number;
  connected: boolean;
  flash: number;
  /** 0 = thriving · 1 = abandoned (folder went quiet). */
  dimness: number;
  lastActive: number;
  fireQueue: { building: Building; at: number }[];
  founded: boolean;
  foundPulse: number;
  /** Road-to-capital construction progress 0..1. */
  roadBuild: number;
  subCounts: Map<string, number>;
  towns: Town[];
  label: Text;
}

interface Town {
  name: string;
  parent: City;
  /** Fixed bearing from the parent; distance follows the parent's growth. */
  angle: number;
  x: number;
  y: number;
  buildings: Building[];
  roadBuild: number;
  spawnPulse: number;
  label: Text;
}

interface Person {
  author: number;
  name: string;
  color: number;
  body: Sprite;
  head: Sprite;
  label: Text;
  x: number;
  y: number;
  /** smoothed velocity, for curved turns */
  vx: number;
  vy: number;
  /** per-person walk phase offset */
  phase: number;
  /** no new strolls until this clock time */
  restUntil: number;
  /** Walk target (waypoints; >1 entries = traveling between cities). */
  path: { x: number; y: number }[];
  homeCity: number;
  lastSim: number;
}

interface Caravan {
  from: number;
  to: number;
  k: number;
  offset: number;
  returning: boolean;
  active: boolean;
}

interface Puff {
  sprite: Sprite;
  life: number;
  maxLife: number;
  vx: number;
  vy: number;
  active: boolean;
}

interface Monument {
  sprite: Sprite;
  glow: Sprite;
  label: string;
  x: number;
  y: number;
  spawnAge: number;
}

/** Rooftop: rounded square with a subtle bevel, tinted per city. */
function makeRoofTexture(size = 14): Texture {
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d");
  if (ctx) {
    ctx.fillStyle = "#ffffff";
    ctx.beginPath();
    ctx.roundRect(1, 1, size - 2, size - 2, 2.5);
    ctx.fill();
    ctx.fillStyle = "rgba(0,0,0,0.28)";
    ctx.beginPath();
    ctx.roundRect(1, size / 2, size - 2, size / 2 - 1, 2.5);
    ctx.fill();
  }
  return Texture.from(canvas);
}

/** A little three-point crown for the top committer. */
function makeCrownTexture(): Texture {
  const w = 18;
  const h = 12;
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  if (ctx) {
    ctx.fillStyle = "#ffffff";
    ctx.beginPath();
    ctx.moveTo(1, h - 2);
    ctx.lineTo(1, 3);
    ctx.lineTo(5, 7);
    ctx.lineTo(9, 1);
    ctx.lineTo(13, 7);
    ctx.lineTo(17, 3);
    ctx.lineTo(17, h - 2);
    ctx.closePath();
    ctx.fill();
  }
  return Texture.from(canvas);
}

/** Tall thin obelisk for release monuments. */
function makeObeliskTexture(): Texture {
  const w = 10;
  const h = 20;
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  if (ctx) {
    ctx.fillStyle = "#ffffff";
    ctx.beginPath();
    ctx.moveTo(w / 2, 0);
    ctx.lineTo(w - 2, h * 0.35);
    ctx.lineTo(w - 3, h);
    ctx.lineTo(3, h);
    ctx.lineTo(2, h * 0.35);
    ctx.closePath();
    ctx.fill();
  }
  return Texture.from(canvas);
}

export async function createSketch(
  host: HTMLElement,
  signal?: AbortSignal,
): Promise<SketchInstance> {
  const boot = await bootPixi(host, GROUND);
  if (signal?.aborted) {
    boot.destroy();
    throw new DOMException("cancelled", "AbortError");
  }
  const { app, world, ui, hud, reducedMotion } = boot;

  const rng: Rng = mulberry32(77001);
  const { history, repoName } = await loadSharedHistory();
  if (signal?.aborted) {
    boot.destroy();
    throw new DOMException("cancelled", "AbortError");
  }

  const params = { people: 35, glow: 1, roads: 1, walls: true, subTowns: true };
  const governor = new FrameGovernor();
  const chrome = new FilmChrome(ui, history, {
    repoName,
    accent: AMBER,
    reducedMotion,
    clip: world,
    onSeek: (f) => transport.seek(f),
  });

  const glowTex = makeGlowTexture(64);
  const dotTex = makeDotTexture(16);
  const roofTex = makeRoofTexture(14);
  const obeliskTex = makeObeliskTexture();
  const crownTex = makeCrownTexture();

  /* ------------------------------ layer stack ------------------------------ */

  const terrainGfx = new Graphics(); // ground shading (static per era)
  const groveLayer = new Container(); // trees (static per era)
  const roadGfx = new Graphics(); // inter-city roads + caravans
  const cityGfx = new Graphics(); // ring roads, walls, plaza
  const buildingLayer = new Container();
  const fxLayer = new Container(); // smoke, fireworks
  const monumentLayer = new Container();
  const peopleLayer = new Container();
  const labelLayer = new Container();
  world.addChild(
    terrainGfx,
    groveLayer,
    roadGfx,
    cityGfx,
    buildingLayer,
    fxLayer,
    monumentLayer,
    peopleLayer,
    labelLayer,
  );

  /* ----------------------------- map geography ----------------------------- */

  // Capital = busiest cluster across the whole history.
  const clusterActivity = new Array<number>(history.clusters).fill(0);
  for (const e of history.events) {
    if (e.kind === "commit" || e.kind === "merge") {
      clusterActivity[e.cluster % history.clusters] =
        (clusterActivity[e.cluster % history.clusters] ?? 0) + 1;
    }
  }
  const capitalCluster = clusterActivity.indexOf(Math.max(...clusterActivity));
  const maxActivity = Math.max(1, ...clusterActivity);
  const totalActivity = clusterActivity.reduce((a, b) => a + b, 0);
  /** Proportional sprite budget per city (real share of ~1500 rooftops). */
  const cityCap = (cluster: number): number =>
    Math.max(
      36,
      Math.min(
        500,
        Math.round((1500 * (clusterActivity[cluster] ?? 1)) / Math.max(1, totalActivity)),
      ),
    );

  const cities: City[] = [];
  const cityOf = (cluster: number): City => cities[cluster % cities.length] as City;

  const makeLabel = (size: number, fill: number): Text => {
    const t = new Text({
      text: "",
      style: { fontFamily: "monospace", fontSize: size, fill, align: "center" },
    });
    t.anchor.set(0.5, 0);
    t.alpha = 0;
    labelLayer.addChild(t);
    return t;
  };

  const layoutCities = () => {
    const w = chrome.contentWidth(app.screen.width);
    const h = chrome.contentHeight(app.screen.height);
    const cx = w / 2;
    const cy = h / 2 + 10;
    const spreadX = w * 0.36;
    const spreadY = h * 0.34;
    let ringIdx = 0;
    for (let c = 0; c < history.clusters; c++) {
      const city = cities[c];
      if (!city) continue;
      if (c === capitalCluster) {
        city.x = cx;
        city.y = cy;
        continue;
      }
      const angle = (ringIdx / Math.max(1, history.clusters - 1)) * Math.PI * 2 + 0.6;
      const wobble = 0.82 + ((hashSeed(c) % 100) / 100) * 0.36;
      city.x = cx + Math.cos(angle) * spreadX * wobble;
      city.y = cy + Math.sin(angle) * spreadY * wobble;
      ringIdx++;
    }
  };

  function hashSeed(n: number): number {
    let h = (n * 2654435761) | 0;
    h = (h ^ (h >> 13)) | 0;
    return (h >>> 0) % 997;
  }

  for (let c = 0; c < history.clusters; c++) {
    cities.push({
      cluster: c,
      name: history.clusterNames[c] ?? `dir${c}`,
      color: CITY_COLORS[c % CITY_COLORS.length] ?? AMBER,
      x: 0,
      y: 0,
      buildings: [],
      commits: 0,
      wallLevel: 0,
      wallPulse: 0,
      roadTraffic: 0,
      connected: false,
      flash: 0,
      dimness: 0,
      lastActive: 0,
      fireQueue: [],
      founded: false,
      foundPulse: 0,
      roadBuild: 0,
      subCounts: new Map(),
      towns: [],
      label: makeLabel(11, INK),
    });
  }
  layoutCities();

  // TRUE size comparison: radius reflects the city's real commit count,
  // normalized so the busiest folder ends the film at ~120px.
  const cityRadius = (city: City): number =>
    10 + 112 * Math.sqrt(Math.min(1, city.commits / maxActivity));

  /* ------------------------------- terrain ------------------------------- */

  const buildTerrain = () => {
    const w = chrome.contentWidth(app.screen.width);
    const h = chrome.contentHeight(app.screen.height);
    terrainGfx.clear();
    groveLayer.removeChildren();
    const tRng = mulberry32(5150);
    // Soft ground patches.
    for (let i = 0; i < 26; i++) {
      terrainGfx
        .ellipse(tRng() * w, tRng() * h, 60 + tRng() * 140, 40 + tRng() * 90)
        .fill({ color: 0x0d141a, alpha: 0.5 });
    }
    // Groves between settlements.
    for (let i = 0; i < Math.round(90 * governor.scale); i++) {
      const gx = tRng() * w;
      const gy = tRng() * h;
      const nearCity = cities.some((c) => Math.hypot(c.x - gx, c.y - gy) < 90);
      if (nearCity) continue;
      const tree = new Sprite(dotTex);
      tree.anchor.set(0.5);
      tree.tint = TREE_GREEN;
      tree.alpha = 0.3 + tRng() * 0.3;
      tree.scale.set(0.25 + tRng() * 0.35);
      tree.position.set(gx, gy);
      groveLayer.addChild(tree);
    }
  };
  buildTerrain();

  /* ------------------------------- builders -------------------------------- */

  const personCommits = new Map<number, number>();
  let leaderAuthor = -1;

  const addBuilding = (city: City, magnitude: number) => {
    city.commits++;
    city.flash = 1;
    if (!city.founded) {
      city.founded = true;
      city.foundPulse = 1;
    }
    const cap = Math.round(cityCap(city.cluster) * governor.scale);
    if (city.buildings.length >= cap) {
      const b = city.buildings[Math.floor(rng() * city.buildings.length)];
      if (b && !b.ruin) b.spawnAge = 0; // re-roof pop
      return;
    }
    const i = city.buildings.length;
    // Roofs hold a FRACTION of the city's radius, as the city grows, every
    // roof glides outward with it, so the disc stays filled rim to core.
    const frac = Math.min(1, (i + 0.5) / cap) * (0.92 + rng() * 0.12);
    const theta = i * 2.39996 + hashSeed(city.cluster) * 0.01;
    const sprite = new Sprite(roofTex);
    sprite.anchor.set(0.5);
    const r0 = 7 + Math.max(2, cityRadius(city) - 11) * Math.sqrt(frac);
    sprite.position.set(city.x + Math.cos(theta) * r0, city.y + Math.sin(theta) * r0);
    sprite.rotation = theta + Math.PI / 2 + (rng() - 0.5) * 0.3;
    sprite.scale.set((0.5 + magnitude * 0.45 + rng() * 0.2) * 0.9);
    sprite.tint = mixTint(city.color, 0xffffff, 0.12 + rng() * 0.2);
    buildingLayer.addChild(sprite);
    city.buildings.push({
      sprite,
      windowOn: rng() < 0.4,
      ruin: false,
      spawnAge: 0.0001,
      theta,
      frac,
    });

    // Walls at population milestones (relative to the city's own capacity).
    const fill = city.buildings.length / Math.max(1, cityCap(city.cluster));
    const level = fill >= 0.85 ? 3 : fill >= 0.55 ? 2 : fill >= 0.25 ? 1 : 0;
    if (level > city.wallLevel) {
      city.wallLevel = level;
      city.wallPulse = 1;
    }
  };

  /* ------------------------------- sub-towns -------------------------------- */

  const SUB_SPAWN_AT = 40;
  const subSegment = (path: string | undefined, cityName: string): string | null => {
    if (!path?.startsWith(`${cityName}/`)) return null;
    const parts = path.split("/");
    // Need a real folder (cityName/sub/...): at least three parts.
    if (parts.length < 3) return null;
    const seg = parts[1];
    return seg && !seg.includes(".") ? seg : null;
  };

  const maybeGrowTown = (city: City, path: string | undefined, magnitude: number): boolean => {
    if (!params.subTowns) return false;
    const seg = subSegment(path, city.name);
    if (!seg) return false;
    city.subCounts.set(seg, (city.subCounts.get(seg) ?? 0) + 1);
    let town = city.towns.find((t) => t.name === seg);
    if (!town) {
      if (
        city.towns.length >= 3 ||
        city.buildings.length < 60 ||
        (city.subCounts.get(seg) ?? 0) < SUB_SPAWN_AT
      ) {
        return false;
      }
      // Spread bearings ~115° apart so siblings never pile up; keep clear of
      // the capital road corridor by seeding from the city's own bearing.
      const toCapital = Math.atan2(
        cityOf(capitalCluster).y - city.y,
        cityOf(capitalCluster).x - city.x,
      );
      const angle = toCapital + Math.PI * 0.6 + city.towns.length * 2.0;
      town = {
        name: seg,
        parent: city,
        angle,
        x: city.x,
        y: city.y,
        buildings: [],
        roadBuild: 0.001,
        spawnPulse: 1,
        label: makeLabel(9, INK),
      };
      city.towns.push(town);
    }
    if (town.buildings.length >= 40) {
      const b = town.buildings[Math.floor(rng() * town.buildings.length)];
      if (b) b.spawnAge = 0;
      return true;
    }
    const i = town.buildings.length;
    const sprite = new Sprite(roofTex);
    sprite.anchor.set(0.5);
    const theta = i * 2.39996;
    sprite.rotation = theta + Math.PI / 2 + (rng() - 0.5) * 0.3;
    sprite.scale.set((0.3 + magnitude * 0.18) * 0.85); // hamlet-scale rooftops
    sprite.tint = mixTint(city.color, 0xffffff, 0.22);
    buildingLayer.addChild(sprite);
    town.buildings.push({
      sprite,
      windowOn: rng() < 0.35,
      ruin: false,
      spawnAge: 0.0001,
      r: 3 + 3.1 * Math.sqrt(i),
      theta,
    });
    return true;
  };

  function mixTint(a: number, b: number, k: number): number {
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

  const burnCity = (city: City, magnitude: number) => {
    // Fire SPREADS: ignite an epicenter, then schedule neighbors by distance.
    const alive = city.buildings.filter((b) => !b.ruin);
    if (alive.length === 0) return;
    const epicenter = alive[Math.floor(rng() * alive.length)];
    if (!epicenter) return;
    const toBurn = Math.min(alive.length, Math.round(3 + magnitude * 7));
    const sorted = [...alive].sort(
      (a, b) =>
        Math.hypot(a.sprite.x - epicenter.sprite.x, a.sprite.y - epicenter.sprite.y) -
        Math.hypot(b.sprite.x - epicenter.sprite.x, b.sprite.y - epicenter.sprite.y),
    );
    for (let i = 0; i < toBurn; i++) {
      const b = sorted[i];
      if (b) city.fireQueue.push({ building: b, at: clock + i * 130 });
    }
  };

  const puffs: Puff[] = [];
  const smoke = (x: number, y: number) => {
    let p = puffs.find((q) => !q.active);
    if (!p) {
      if (puffs.length >= 60) return;
      const sprite = new Sprite(glowTex);
      sprite.anchor.set(0.5);
      fxLayer.addChild(sprite);
      p = { sprite, life: 0, maxLife: 1, vx: 0, vy: 0, active: false };
      puffs.push(p);
    }
    p.active = true;
    p.life = 0;
    p.maxLife = 900 + rng() * 700;
    p.vx = (rng() - 0.5) * 0.012;
    p.vy = -(0.008 + rng() * 0.012);
    p.sprite.visible = true;
    p.sprite.position.set(x, y);
    p.sprite.tint = 0x777788;
    p.sprite.alpha = 0.4;
    p.sprite.scale.set(0.2 + rng() * 0.2);
  };

  /* ------------------------ roads, caravans, monuments ------------------------ */

  const caravans: Caravan[] = [];
  const monuments: Monument[] = [];

  interface Spark {
    sprite: Sprite;
    vx: number;
    vy: number;
    life: number;
    maxLife: number;
    rise: boolean;
    active: boolean;
  }
  const sparks: Spark[] = [];
  const spark = (x: number, y: number, tint: number, speed: number, rise: boolean) => {
    let sp = sparks.find((q) => !q.active);
    if (!sp) {
      if (sparks.length >= Math.round(160 * governor.scale)) return;
      const sprite = new Sprite(glowTex);
      sprite.anchor.set(0.5);
      sprite.blendMode = "add";
      fxLayer.addChild(sprite);
      sp = { sprite, vx: 0, vy: 0, life: 0, maxLife: 1, rise: false, active: false };
      sparks.push(sp);
    }
    const angle = rng() * Math.PI * 2;
    sp.active = true;
    sp.rise = rise;
    sp.life = 0;
    sp.maxLife = rise ? 1600 + rng() * 800 : 600 + rng() * 500;
    sp.vx = rise ? (rng() - 0.5) * 0.01 : Math.cos(angle) * speed;
    sp.vy = rise ? -(0.015 + rng() * 0.02) : Math.sin(angle) * speed;
    sp.sprite.visible = true;
    sp.sprite.position.set(x, y);
    sp.sprite.tint = tint;
    sp.sprite.alpha = 0.9;
    sp.sprite.scale.set(rise ? 0.18 : 0.12 + rng() * 0.12);
  };

  const festival = () => {
    const capital = cityOf(capitalCluster);
    // Fireworks bloom above the capital…
    for (let burst = 0; burst < 3; burst++) {
      const bx = capital.x + (rng() - 0.5) * 80;
      const by = capital.y - 40 - rng() * 50;
      for (let i = 0; i < 14; i++) spark(bx, by, AMBER, 0.07 + rng() * 0.05, false);
    }
    // …and every connected city raises lanterns.
    for (const city of cities) {
      if (city.cluster !== capitalCluster && !city.connected) continue;
      city.flash = 1;
      for (let i = 0; i < 3; i++) {
        spark(
          city.x + (rng() - 0.5) * cityRadius(city),
          city.y + (rng() - 0.5) * cityRadius(city),
          WINDOW_WARM,
          0,
          true,
        );
      }
    }
  };

  const roadPoint = (a: City, b: City, kIn: number): { x: number; y: number } => {
    // CANONICAL geometry: the curve belongs to the unordered pair, so a→b at k
    // and b→a at 1-k are the SAME point, caravans always ride the drawn road.
    const flip = a.cluster > b.cluster;
    const from = flip ? b : a;
    const to = flip ? a : b;
    const k = flip ? 1 - kIn : kIn;
    const mx = (from.x + to.x) / 2;
    const my = (from.y + to.y) / 2;
    const dx = to.x - from.x;
    const dy = to.y - from.y;
    const len = Math.max(1, Math.hypot(dx, dy));
    const bow =
      Math.min(40, len * 0.12) * (hashSeed(from.cluster * 7 + to.cluster) % 2 === 0 ? 1 : -1);
    const cxp = mx + (-dy / len) * bow;
    const cyp = my + (dx / len) * bow;
    const inv = 1 - k;
    return {
      x: inv * inv * from.x + 2 * inv * k * cxp + k * k * to.x,
      y: inv * inv * from.y + 2 * inv * k * cyp + k * k * to.y,
    };
  };

  const sendCaravan = (cluster: number, magnitude = 0.4) => {
    const city = cityOf(cluster);
    if (!city.connected || city.cluster === capitalCluster) return;
    city.roadTraffic += 1;
    // Bigger merges send a small train of wagons.
    const wagons = magnitude > 0.7 ? 3 : magnitude > 0.4 ? 2 : 1;
    for (let w = 0; w < wagons; w++) {
      let c = caravans.find((q) => !q.active);
      if (!c) {
        if (caravans.length >= 18) break;
        c = { from: 0, to: 0, k: 0, offset: 0, returning: false, active: false };
        caravans.push(c);
      }
      c.active = true;
      c.from = city.cluster;
      c.to = capitalCluster;
      c.k = -w * 0.05; // staggered start
      c.offset = w;
      c.returning = false;
    }
  };

  const raiseMonument = (label: string) => {
    const capital = cityOf(capitalCluster);
    const i = monuments.length;
    const angle = -Math.PI / 2 + (i - 3) * 0.32;
    const r = cityRadius(capital) + 26 + (i % 2) * 10;
    const x = capital.x + Math.cos(angle) * r;
    const y = capital.y + Math.sin(angle) * r;
    const glow = new Sprite(glowTex);
    glow.anchor.set(0.5);
    glow.blendMode = "add";
    glow.tint = AMBER;
    glow.alpha = 0.5;
    glow.scale.set(0.7);
    glow.position.set(x, y);
    const sprite = new Sprite(obeliskTex);
    sprite.anchor.set(0.5, 1);
    sprite.tint = AMBER;
    sprite.position.set(x, y + 6);
    monumentLayer.addChild(glow, sprite);
    monuments.push({ sprite, glow, label, x, y, spawnAge: 0.0001 });
  };

  /* --------------------------------- people --------------------------------- */

  const people = new Map<number, Person>();
  const crown = new Sprite(crownTex);
  crown.anchor.set(0.5, 1);
  crown.tint = AMBER;
  crown.scale.set(1.05);
  crown.visible = false;
  labelLayer.addChild(crown); // above every name, the king is never buried
  const leaderHalo = new Sprite(glowTex);
  leaderHalo.anchor.set(0.5);
  leaderHalo.blendMode = "add";
  leaderHalo.tint = AMBER;
  leaderHalo.alpha = 0;
  leaderHalo.scale.set(0.55);
  peopleLayer.addChildAt(leaderHalo, 0);
  const footprints: { sprite: Sprite; life: number; active: boolean }[] = [];
  const dropFootprint = (x: number, y: number, tint: number) => {
    let f = footprints.find((q) => !q.active);
    if (!f) {
      if (footprints.length >= 90) return;
      const sprite = new Sprite(dotTex);
      sprite.anchor.set(0.5);
      sprite.scale.set(0.12);
      peopleLayer.addChildAt(sprite, 0);
      f = { sprite, life: 0, active: false };
      footprints.push(f);
    }
    f.active = true;
    f.life = 0;
    f.sprite.visible = true;
    f.sprite.position.set(x, y);
    f.sprite.tint = tint;
    f.sprite.alpha = 0.5;
  };

  const isPermanent = (author: number): boolean => {
    // The top-10 all-time committers are citizens for life.
    const mine = personCommits.get(author) ?? 0;
    if (mine < 20) return false;
    let higher = 0;
    for (const v of personCommits.values()) if (v > mine) higher++;
    return higher < 10;
  };

  const evictIdlest = () => {
    if (people.size <= params.people) return;
    let idlest: Person | null = null;
    for (const p of people.values()) {
      if (isPermanent(p.author)) continue;
      if (!idlest || p.lastSim < idlest.lastSim) idlest = p;
    }
    if (idlest) {
      idlest.body.destroy();
      idlest.head.destroy();
      idlest.label.destroy();
      people.delete(idlest.author);
    }
  };

  const personArrives = (author: number, cluster: number, simNow: number) => {
    const city = cityOf(cluster);
    let p = people.get(author);
    if (!p) {
      const name = history.authors[author] ?? "anon";
      const color = CITY_COLORS[hashSeed(author) % CITY_COLORS.length] ?? INK;
      const body = new Sprite(dotTex);
      body.anchor.set(0.5);
      body.tint = color;
      body.scale.set(0.42);
      const head = new Sprite(dotTex);
      head.anchor.set(0.5);
      head.tint = 0xffffff;
      head.scale.set(0.2);
      peopleLayer.addChild(body, head);
      const label = makeLabel(9, INK);
      label.text = name.split(" ")[0] ?? name;
      const angle = rng() * Math.PI * 2;
      p = {
        author,
        name,
        color,
        body,
        head,
        label,
        x: city.x + Math.cos(angle) * (cityRadius(city) + 14),
        y: city.y + Math.sin(angle) * (cityRadius(city) + 14),
        vx: 0,
        vy: 0,
        phase: rng() * Math.PI * 2,
        restUntil: 0,
        path: [],
        homeCity: cluster,
        lastSim: simNow,
      };
      people.set(author, p);
      evictIdlest();
    }
    p.lastSim = simNow;
    if (p.homeCity !== cluster) {
      // Walk the road network: home → capital → destination.
      const fromCity = cityOf(p.homeCity);
      const toCity = cityOf(cluster);
      const capital = cityOf(capitalCluster);
      p.path = [];
      const seg = (a: City, b: City) => {
        for (let i = 1; i <= 14; i++) p?.path.push(roadPoint(a, b, i / 14));
      };
      if (p.homeCity !== capitalCluster && cluster !== capitalCluster) {
        seg(fromCity, capital);
        seg(capital, toCity);
      } else {
        seg(fromCity, toCity);
      }
      p.homeCity = cluster;
    } else if (p.path.length === 0 && clock >= p.restUntil && rng() < 0.6) {
      // pick a new spot in town, then rest a while
      const city2 = cityOf(cluster);
      const angle = rng() * Math.PI * 2;
      const rr = rng() * (cityRadius(city2) + 16);
      p.path = [{ x: city2.x + Math.cos(angle) * rr, y: city2.y + Math.sin(angle) * rr }];
    }
  };

  /* ------------------------------ event wiring ------------------------------ */

  let simSec = 0;

  const onEvent = (e: RepoEvent) => {
    chrome.onEvent(e);
    switch (e.kind) {
      case "commit": {
        const city = cityOf(e.cluster);
        if (city.dimness > 0.5) city.flash = 1; // the lights come back on
        city.lastActive = simSec;
        personCommits.set(e.author, (personCommits.get(e.author) ?? 0) + 1);
        if (!maybeGrowTown(city, e.path, e.magnitude)) addBuilding(city, e.magnitude);
        else addBuilding(city, e.magnitude * 0.4); // town grew; parent still hums
        personArrives(e.author, e.cluster, simSec);
        break;
      }
      case "merge": {
        const city = cityOf(e.cluster);
        city.lastActive = simSec;
        personCommits.set(e.author, (personCommits.get(e.author) ?? 0) + 2);
        if (!maybeGrowTown(city, e.path, e.magnitude)) {
          addBuilding(city, Math.min(1, e.magnitude + 0.2));
        }
        sendCaravan(e.cluster, e.magnitude);
        personArrives(e.author, e.cluster, simSec);
        focusOn(city, 0.1);
        break;
      }
      case "massDelete":
        // small and local; the camera stays put
        burnCity(cityOf(e.cluster), e.magnitude * 0.5);
        break;
      case "release":
        if (e.label) raiseMonument(e.label);
        festival();
        focusOn(cityOf(capitalCluster), 0.5);
        break;
      case "newContributor":
        break;
    }
  };

  const player = new EventPlayer(history, history.duration / 140);
  const transport = player.transport();

  /* ------------------------------- interaction ------------------------------- */

  // Ken Burns camera: drifts toward where history is happening.
  const capitalHome = cityOf(capitalCluster);
  const focus = { x: capitalHome.x, y: capitalHome.y, tx: capitalHome.x, ty: capitalHome.y };
  let zoomPulse = 0;
  let lastFocusMove = -9999;
  const focusOn = (city: City, strength = 0.12) => {
    // throttled so the camera moves at most about once a second
    if (clock - lastFocusMove < 900) return;
    lastFocusMove = clock;
    const cw = chrome.contentWidth(app.screen.width);
    const ch = chrome.contentHeight(app.screen.height);
    // Blend the target toward the active city (bounded so edges stay visible).
    focus.tx = focus.tx + (city.x - focus.tx) * strength;
    focus.ty = focus.ty + (city.y - focus.ty) * strength;
    // keep the pan small; cities must stay in frame
    focus.tx = Math.max(cw * 0.44, Math.min(cw * 0.56, focus.tx));
    focus.ty = Math.max(ch * 0.44, Math.min(ch * 0.56, focus.ty));
    zoomPulse = Math.min(0.35, zoomPulse + strength * 0.18);
  };

  const toWorld = (sx: number, sy: number): { x: number; y: number } => {
    const cw = chrome.contentWidth(app.screen.width);
    const ch = chrome.contentHeight(app.screen.height);
    return {
      x: (sx - cw / 2) / world.scale.x + world.pivot.x,
      y: (sy - ch / 2) / world.scale.y + world.pivot.y,
    };
  };

  let pointerX = -9999;
  let pointerY = -9999;
  app.stage.eventMode = "static";
  app.stage.hitArea = app.screen;
  app.stage.on("pointermove", (ev: { global: { x: number; y: number } }) => {
    pointerX = ev.global.x;
    pointerY = ev.global.y;
  });
  app.stage.on("pointertap", (ev: { global: { x: number; y: number } }) => {
    const wpt = toWorld(ev.global.x, ev.global.y);
    let nearest: City | null = null;
    let best = 140;
    for (const city of cities) {
      const d = Math.hypot(wpt.x - city.x, wpt.y - city.y);
      if (d < best) {
        best = d;
        nearest = city;
      }
    }
    if (nearest) {
      for (let i = 0; i < 5; i++) addBuilding(nearest, 0.4 + rng() * 0.5);
    }
  });

  const tipBg = new Graphics();
  const tipText = new Text({
    text: "",
    style: { fontFamily: "monospace", fontSize: 12, fill: 0xffffff },
  });
  const tip = new Container();
  tip.addChild(tipBg, tipText);
  tip.visible = false;
  ui.addChild(tip);
  const setTip = (msg: string | null) => {
    if (!msg) {
      tip.visible = false;
      return;
    }
    if (tipText.text !== msg) {
      tipText.text = msg;
      const w = tipText.width + 14;
      const h = tipText.height + 8;
      tipBg.clear();
      tipBg.roundRect(0, 0, w, h, 6).fill({ color: 0x07091a, alpha: 0.9 });
      tipBg.roundRect(0, 0, w, h, 6).stroke({ color: INK, alpha: 0.2, width: 1 });
      tipText.position.set(7, 4);
    }
    tip.position.set(
      Math.min(pointerX + 12, chrome.contentWidth(app.screen.width) - tipBg.width - 6),
      Math.max(8, pointerY - tipBg.height - 12),
    );
    tip.visible = true;
  };

  /* -------------------------------- frame loop -------------------------------- */

  let clock = 0;

  const tick = () => {
    const dtMs = Math.min(app.ticker.deltaMS, 50);
    clock += dtMs;
    simSec += (dtMs / 1000) * (history.duration / 140);

    if (governor.update(dtMs)) buildTerrain();
    for (const e of player.update(dtMs)) onEvent(e);

    /* ----- cities: lifecycle, rings, walls ----- */
    cityGfx.clear();
    for (const city of cities) {
      city.flash = Math.max(0, city.flash - dtMs / 700);
      city.wallPulse = Math.max(0, city.wallPulse - dtMs / 900);
      // Folders that go quiet fade toward abandonment; activity revives them.
      const idleFrac =
        city.buildings.length === 0 ? 0 : (simSec - city.lastActive) / history.duration;
      const targetDim = Math.min(0.78, Math.max(0, (idleFrac - 0.035) / 0.07) * 0.78);
      city.dimness += (targetDim - city.dimness) * Math.min(1, dtMs / 1200);
      // join the road network once the city matters, and only after the
      // capital exists
      if (
        !city.connected &&
        city.cluster !== capitalCluster &&
        city.buildings.length >= 12 &&
        cityOf(capitalCluster).founded
      ) {
        city.connected = true;
        city.roadTraffic = 1;
        city.roadBuild = 0.001;
      }
      // Spreading fires.
      while (city.fireQueue.length > 0 && (city.fireQueue[0]?.at ?? Infinity) <= clock) {
        const item = city.fireQueue.shift();
        if (item && !item.building.ruin) {
          item.building.ruin = true;
          item.building.sprite.tint = RUIN;
          smoke(item.building.sprite.x, item.building.sprite.y);
          spark(item.building.sprite.x, item.building.sprite.y, 0xff8f50, 0.05, false);
        }
      }
      const radius = cityRadius(city);

      // Ring roads: an honor reserved for true metropolises, kept faint.
      if (cityCap(city.cluster) > 140) {
        const ringStep = Math.round(cityCap(city.cluster) / 3);
        const rings = Math.min(2, Math.floor(city.buildings.length / ringStep));
        for (let i = 1; i <= rings; i++) {
          const rr =
            7 + (radius - 11) * Math.sqrt(Math.min(1, (i * ringStep) / cityCap(city.cluster)));
          cityGfx
            .circle(city.x, city.y, Math.max(8, rr))
            .stroke({ color: mixTint(city.color, 0x000000, 0.25), alpha: 0.13, width: 1.2 });
        }
      }
      // Walls (irregular octagon-ish ring).
      if (params.walls && city.wallLevel > 0) {
        const wr = radius + 7 + city.wallPulse * 6;
        const sides = 10;
        for (let i = 0; i <= sides; i++) {
          const a = (i / sides) * Math.PI * 2;
          const wob = 1 + 0.05 * Math.sin(a * 3 + city.cluster);
          const px = city.x + Math.cos(a) * wr * wob;
          const py = city.y + Math.sin(a) * wr * wob;
          if (i === 0) cityGfx.moveTo(px, py);
          else cityGfx.lineTo(px, py);
        }
        cityGfx.stroke({
          color: mixTint(city.color, 0xffffff, 0.3),
          alpha: (0.4 + city.wallPulse * 0.5) * (1 - city.dimness * 0.8),
          width: city.wallLevel,
        });
      }
      // City glow when active.
      if (city.flash > 0.02) {
        cityGfx
          .circle(city.x, city.y, radius + 4)
          .stroke({ color: city.color, alpha: city.flash * 0.4, width: 2 });
      }
      // expanding ring when a folder first appears
      if (city.foundPulse > 0) {
        city.foundPulse = Math.max(0, city.foundPulse - dtMs / 1600);
        const k = 1 - city.foundPulse;
        cityGfx
          .circle(city.x, city.y, 8 + k * 46)
          .stroke({ color: city.color, alpha: city.foundPulse * 0.7, width: 2 });
      }
    }

    /* ----- buildings: spawn pop + warm windows ----- */
    const nightFlicker = 0.85 + 0.15 * Math.sin(clock * 0.0014);
    for (const city of cities) {
      const liveRadius = Math.max(2, cityRadius(city) - 11);
      for (const b of city.buildings) {
        if (b.frac !== undefined && b.theta !== undefined) {
          const rr = 7 + liveRadius * Math.sqrt(b.frac);
          b.sprite.position.set(city.x + Math.cos(b.theta) * rr, city.y + Math.sin(b.theta) * rr);
        }
        if (b.spawnAge > 0 && b.spawnAge < 1) {
          b.spawnAge = Math.min(1, b.spawnAge + dtMs / 380);
          const pop = easeOutBack(b.spawnAge);
          b.sprite.alpha = Math.min(1, b.spawnAge * 2);
          const target = b.sprite.scale.x === 0 ? 0.7 : b.sprite.scale.x;
          b.sprite.scale.set(Math.max(0.05, target * (0.5 + pop * 0.5)));
        }
        if (b.ruin) {
          b.sprite.alpha = 0.5 + 0.12 * Math.sin(clock * 0.003 + b.sprite.x);
        } else if (b.spawnAge >= 1) {
          b.sprite.alpha = 1 - city.dimness * 0.62;
        }
        if (!b.ruin && b.windowOn && city.dimness < 0.4) {
          b.sprite.tint = mixTint(b.sprite.tint, WINDOW_WARM, 0.06 * params.glow * nightFlicker);
        }
      }
    }

    /* ----- roads + caravans ----- */
    roadGfx.clear();
    const capital = cityOf(capitalCluster);
    for (const city of cities) {
      if (!city.connected || city.cluster === capitalCluster) continue;
      if (city.roadBuild < 1) city.roadBuild = Math.min(1, city.roadBuild + dtMs / 1600);
      const width = Math.min(5, 1 + Math.log2(1 + city.roadTraffic)) * params.roads;
      // Trim to the city borders, roads belong to the land, not the plazas.
      const dist = Math.max(1, Math.hypot(capital.x - city.x, capital.y - city.y));
      const t0 = Math.min(0.45, (cityRadius(city) + 5) / dist);
      const t1Full = Math.max(0.55, 1 - (cityRadius(capital) + 5) / dist);
      const t1 = t0 + (t1Full - t0) * city.roadBuild;
      const samples = 22;
      const pts: { x: number; y: number }[] = [];
      for (let i = 0; i <= samples; i++) {
        pts.push(roadPoint(city, capital, t0 + ((t1 - t0) * i) / samples));
      }
      // Casing.
      pts.forEach((pt, i) => {
        if (i === 0) roadGfx.moveTo(pt.x, pt.y);
        else roadGfx.lineTo(pt.x, pt.y);
      });
      roadGfx.stroke({ color: 0x000000, alpha: 0.35, width: width + 2.5 });
      // Dashed core, every other segment.
      for (let i = 0; i < samples; i += 2) {
        const a = pts[i];
        const b = pts[i + 1];
        if (!a || !b) continue;
        roadGfx.moveTo(a.x, a.y).lineTo(b.x, b.y);
      }
      roadGfx.stroke({ color: 0xcdb98f, alpha: 0.38 * params.roads, width });
      // Gate lamps where the road meets each settlement.
      const gateA = pts[0];
      const gateB = pts[pts.length - 1];
      if (gateA) {
        roadGfx.circle(gateA.x, gateA.y, 2).fill({ color: WINDOW_WARM, alpha: 0.8 });
      }
      if (gateB && city.roadBuild >= 1) {
        roadGfx.circle(gateB.x, gateB.y, 2).fill({ color: WINDOW_WARM, alpha: 0.8 });
      }
    }
    for (const c of caravans) {
      if (!c.active) continue;
      c.k += dtMs / 2600;
      if (c.k >= 1) {
        if (!c.returning) {
          // Deliver, then head home.
          c.returning = true;
          c.k = 0;
          const swap = c.from;
          c.from = c.to;
          c.to = swap;
          capital.flash = Math.max(capital.flash, 0.6);
        } else {
          c.active = false;
        }
        continue;
      }
      if (c.k < 0) continue; // staggered wagons not yet departed
      const pt = roadPoint(cityOf(c.from), cityOf(c.to), c.k);
      const dim = c.returning ? 0.55 : 1;
      roadGfx.circle(pt.x, pt.y, 2.6).fill({ color: AMBER, alpha: 0.95 * dim });
      roadGfx.circle(pt.x, pt.y, 5.5).fill({ color: AMBER, alpha: 0.2 * dim });
    }

    /* ----- monuments ----- */
    for (const m of monuments) {
      if (m.spawnAge > 0 && m.spawnAge < 1) {
        m.spawnAge = Math.min(1, m.spawnAge + dtMs / 600);
        const pop = easeOutBack(m.spawnAge);
        m.sprite.scale.set(pop);
        m.glow.alpha = 0.5 * m.spawnAge;
      }
      m.glow.scale.set(0.6 + 0.08 * Math.sin(clock * 0.002 + m.x));
    }

    /* ----- people ----- */
    for (const p of people.values()) {
      const target = p.path[0];
      if (target) {
        const dx = target.x - p.x;
        const dy = target.y - p.y;
        const d = Math.max(0.001, Math.hypot(dx, dy));
        const traveling = p.path.length > 1;
        let maxStep = (traveling ? 0.085 : 0.028) * dtMs;
        // slow down near the final stop so walkers settle instead of
        // orbiting it
        if (p.path.length === 1 && d < 26) maxStep *= Math.max(0.1, d / 26);
        // Steering: velocity bends toward the target instead of snapping.
        const steer = Math.min(1, dtMs / 240);
        p.vx += ((dx / d) * maxStep - p.vx) * steer;
        p.vy += ((dy / d) * maxStep - p.vy) * steer;
        p.x += p.vx;
        p.y += p.vy;
        // pass mid-path waypoints loosely, settle the final one tightly
        if (d < (p.path.length > 1 ? Math.max(6, maxStep * 2.5) : 3)) {
          p.path.shift();
          if (p.path.length === 0) {
            if (!traveling) p.restUntil = clock + 1200 + rng() * 2600;
            p.vx *= 0.3;
            p.vy *= 0.3;
          }
        }
      } else {
        p.vx *= 0.86;
        p.vy *= 0.86;
        p.x += p.vx;
        p.y += p.vy;
      }
      const idleFrac = (simSec - p.lastSim) / history.duration;
      const permanent = isPermanent(p.author);
      let fade = idleFrac > 0.01 ? Math.max(0, 1 - (idleFrac - 0.01) / 0.02) : 1;
      if (permanent) fade = Math.max(0.55, fade); // regulars never leave the map
      if (fade <= 0) {
        p.body.destroy();
        p.head.destroy();
        p.label.destroy();
        people.delete(p.author);
        continue;
      }
      if (p.path.length > 1 && Math.floor(clock / 90) !== Math.floor((clock - dtMs) / 90)) {
        dropFootprint(p.x, p.y, p.color);
      }
      const pace = Math.min(1, Math.hypot(p.vx, p.vy) / (0.03 * dtMs + 0.001));
      const bob = Math.sin(clock * 0.018 + p.phase) * 0.8 * pace;
      p.body.position.set(p.x, p.y + bob);
      p.head.position.set(p.x, p.y - 2 + bob);
      p.body.alpha = 0.95 * fade;
      p.head.alpha = fade;
      p.label.position.set(p.x, p.y + 6);
      const labelBase = p.path.length > 1 ? 0.9 : permanent ? 0.5 : 0.16;
      p.label.alpha = labelBase * fade;
    }

    /* ----- festival sparks & embers ----- */
    for (const sp of sparks) {
      if (!sp.active) continue;
      sp.life += dtMs;
      if (sp.life >= sp.maxLife) {
        sp.active = false;
        sp.sprite.visible = false;
        continue;
      }
      if (!sp.rise) sp.vy += 0.00018 * dtMs; // fireworks fall
      sp.sprite.x += sp.vx * dtMs;
      sp.sprite.y += sp.vy * dtMs;
      sp.sprite.alpha = 0.9 * (1 - sp.life / sp.maxLife);
    }

    /* ----- smoke ----- */
    for (const p of puffs) {
      if (!p.active) continue;
      p.life += dtMs;
      if (p.life >= p.maxLife) {
        p.active = false;
        p.sprite.visible = false;
        continue;
      }
      p.sprite.x += p.vx * dtMs;
      p.sprite.y += p.vy * dtMs;
      p.sprite.alpha = 0.4 * (1 - p.life / p.maxLife);
      p.sprite.scale.set(p.sprite.scale.x + dtMs * 0.0003);
    }

    /* ----- the crown finds the top committer ----- */
    {
      let best = -1;
      let bestCount = 0;
      for (const [author, count] of personCommits) {
        if (count > bestCount) {
          bestCount = count;
          best = author;
        }
      }
      if (best !== leaderAuthor && best !== -1) {
        leaderAuthor = best;
        const newLeader = people.get(best);
        if (newLeader) {
          for (let i = 0; i < 10; i++) spark(newLeader.x, newLeader.y - 6, AMBER, 0.05, false);
        }
      }
      const leader = leaderAuthor === -1 ? undefined : people.get(leaderAuthor);
      if (leader) {
        crown.visible = true;
        crown.position.set(leader.x, leader.y - 7 + Math.sin(clock * 0.004) * 0.8);
        crown.alpha = 1;
        leaderHalo.alpha = 0.3 + 0.08 * Math.sin(clock * 0.003);
        leaderHalo.position.set(leader.x, leader.y);
      } else {
        crown.visible = false;
        leaderHalo.alpha = 0;
      }
    }

    /* ----- footprints fade ----- */
    for (const f of footprints) {
      if (!f.active) continue;
      f.life += dtMs;
      if (f.life >= 1600) {
        f.active = false;
        f.sprite.visible = false;
        continue;
      }
      f.sprite.alpha = 0.5 * (1 - f.life / 1600);
    }

    /* ----- sub-towns: local roads, rings, rooftops ----- */
    for (const city of cities) {
      for (const town of city.towns) {
        town.spawnPulse = Math.max(0, town.spawnPulse - dtMs / 1400);
        if (town.roadBuild < 1) town.roadBuild = Math.min(1, town.roadBuild + dtMs / 1100);
        const tr = 4 + 3.1 * Math.sqrt(town.buildings.length);
        // Towns ride OUTWARD as the parent grows, never swallowed, gap held.
        const townDist = cityRadius(city) + 16 + tr;
        town.x = city.x + Math.cos(town.angle) * townDist;
        town.y = city.y + Math.sin(town.angle) * townDist;
        const fade = 1 - city.dimness * 0.62;
        // Local road: straight, trimmed to both borders.
        const dx = town.x - city.x;
        const dy = town.y - city.y;
        const d = Math.max(1, Math.hypot(dx, dy));
        const fromK = (cityRadius(city) + 3) / d;
        const toK = fromK + (1 - fromK - (tr + 4) / d) * town.roadBuild;
        roadGfx
          .moveTo(city.x + dx * fromK, city.y + dy * fromK)
          .lineTo(city.x + dx * toK, city.y + dy * toK)
          .stroke({ color: 0xcdb98f, alpha: 0.25 * params.roads * fade, width: 1.4 });
        // Town ring + spawn pulse.
        cityGfx
          .circle(town.x, town.y, tr + 3)
          .stroke({ color: mixTint(city.color, 0xffffff, 0.2), alpha: 0.3 * fade, width: 1 });
        if (town.spawnPulse > 0) {
          cityGfx
            .circle(town.x, town.y, tr + 4 + (1 - town.spawnPulse) * 24)
            .stroke({ color: city.color, alpha: town.spawnPulse * 0.6, width: 1.5 });
        }
        // Rooftops follow the migrating town (polar-relative) + pop + dim.
        for (const b of town.buildings) {
          b.sprite.position.set(
            town.x + Math.cos(b.theta ?? 0) * (b.r ?? 0),
            town.y + Math.sin(b.theta ?? 0) * (b.r ?? 0),
          );
          if (b.spawnAge > 0 && b.spawnAge < 1) {
            b.spawnAge = Math.min(1, b.spawnAge + dtMs / 380);
            b.sprite.alpha = Math.min(1, b.spawnAge * 2) * fade;
          } else {
            b.sprite.alpha = fade;
          }
        }
        town.label.text = town.name;
        town.label.position.set(town.x, town.y + tr + 6);
        town.label.alpha += (0.55 * fade - town.label.alpha) * Math.min(1, dtMs / 300);
      }
    }

    /* ----- city labels ----- */
    for (const city of cities) {
      city.label.text = `${city.name}/`;
      city.label.position.set(city.x, city.y + cityRadius(city) + 10);
      const base = city.founded ? (city.cluster === capitalCluster ? 0.95 : 0.7) : 0;
      const target = base * (1 - city.dimness * 0.7);
      city.label.alpha += (target - city.label.alpha) * Math.min(1, dtMs / 300);
    }

    /* ----- hover ----- */
    let tipMsg: string | null = null;
    const wpt = toWorld(pointerX, pointerY);
    for (const p of people.values()) {
      if (Math.hypot(wpt.x - p.x, wpt.y - p.y) < 10) {
        tipMsg = `${p.name} · in ${cityOf(p.homeCity).name}/`;
        break;
      }
    }
    if (!tipMsg) {
      for (const m of monuments) {
        if (Math.hypot(wpt.x - m.x, wpt.y - m.y) < 14) {
          tipMsg = `⟡ ${m.label} monument`;
          break;
        }
      }
    }
    if (!tipMsg) {
      outer: for (const city of cities) {
        for (const town of city.towns) {
          const tr = 4 + 3.1 * Math.sqrt(town.buildings.length);
          if (Math.hypot(wpt.x - town.x, wpt.y - town.y) < tr + 8) {
            tipMsg = `${city.name}/${town.name} · ${town.buildings.length} buildings`;
            break outer;
          }
        }
      }
    }
    if (!tipMsg) {
      for (const city of cities) {
        if (Math.hypot(wpt.x - city.x, wpt.y - city.y) < cityRadius(city) + 12) {
          const cap = city.cluster === capitalCluster ? " · CAPITAL" : "";
          tipMsg = `${city.name}/ · ${city.buildings.length} buildings · ${city.commits} commits${cap}`;
          break;
        }
      }
    }
    setTip(tipMsg);

    /* ----- Ken Burns camera ----- */
    {
      const cw = chrome.contentWidth(app.screen.width);
      const ch = chrome.contentHeight(app.screen.height);
      // Target slowly relaxes back to the map center between beats.
      focus.tx += (cw / 2 - focus.tx) * Math.min(1, dtMs / 9000);
      focus.ty += (ch / 2 - focus.ty) * Math.min(1, dtMs / 9000);
      focus.x += (focus.tx - focus.x) * Math.min(1, dtMs / 5200);
      focus.y += (focus.ty - focus.y) * Math.min(1, dtMs / 5200);
      zoomPulse = Math.max(0, zoomPulse - dtMs / 6000);
      const z = reducedMotion ? 1 : 1.01 + zoomPulse * 0.025 + 0.006 * Math.sin(clock * 0.00004);
      world.pivot.set(focus.x, focus.y);
      world.position.set(cw / 2, ch / 2);
      world.scale.set(z);
    }

    /* ----- chrome ----- */
    let totalBuildings = 0;
    for (const city of cities) totalBuildings += city.buildings.length;
    chrome.update(dtMs, app.screen.width, app.screen.height, player.progress, [
      ["buildings", totalBuildings],
      ["people", people.size],
      ["monuments", monuments.length],
      ["caravans", caravans.filter((c) => c.active).length],
    ]);

    hud.update(
      dtMs,
      `${totalBuildings} buildings · ${people.size} people · capital ${cityOf(capitalCluster).name}/`,
    );
  };

  app.ticker.add(tick);

  return {
    destroy() {
      boot.destroy();
    },
    transport,
    controls: [
      {
        key: "people",
        label: "people on map",
        kind: "range",
        min: 10,
        max: 60,
        step: 1,
        value: 35,
        set: (v) => {
          params.people = v as number;
        },
      },
      {
        key: "subTowns",
        label: "sub-folder towns",
        kind: "toggle",
        value: true,
        set: (v) => {
          params.subTowns = v as boolean;
        },
      },
      {
        key: "glow",
        label: "window warmth",
        kind: "range",
        min: 0,
        max: 1.5,
        step: 0.05,
        value: 1,
        set: (v) => {
          params.glow = v as number;
        },
      },
      {
        key: "roads",
        label: "road brightness",
        kind: "range",
        min: 0.3,
        max: 2,
        step: 0.1,
        value: 1,
        set: (v) => {
          params.roads = v as number;
        },
      },
      {
        key: "walls",
        label: "city walls",
        kind: "toggle",
        value: true,
        set: (v) => {
          params.walls = v as boolean;
        },
      },
    ],
  };
}
