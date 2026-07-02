/**
 * City sketch: a skyline in time-lapse. Districts are directories, buildings
 * are files gaining floors per change, branches are construction cranes,
 * merges top out their towers, mass deletions demolish, releases launch
 * fireworks. A day/night cycle runs once per repo-year and windows light up
 * after dark.
 */
import { mulberry32, type RepoEvent, type Rng } from "@repomentary/artifact";
import { Container, Graphics, Sprite, Text } from "pixi.js";
import { loadSharedHistory } from "@/lib/realHistory";
import { FilmChrome } from "./chrome";
import {
  bootPixi,
  CameraShake,
  EventPlayer,
  FrameGovernor,
  makeCaptureHandle,
  makeDotTexture,
  makeGlowTexture,
  type SketchInstance,
  Toasts,
} from "./common";

const DISTRICT_COLORS = [
  0x6d5dfc, 0x4ecdc4, 0xffa3c2, 0xffd28f, 0x8fd0ff, 0xa5ffd0, 0xc2a8ff, 0xff8f70, 0xb8e986,
  0x7ea6ff,
];
const WINDOW_LIT = 0xffd9a0;
const INK = 0xe8ecff;

const FLOOR_H = 7;

/** Visual floors: linear to 30, then compressed. Real repos pour thousands
of changes into a few hot files and the skyline has to stay balanced. */
const effFloors = (floors: number): number => (floors <= 30 ? floors : 30 + (floors - 30) ** 0.62);
const MAX_BUILDINGS_PER_DISTRICT = 9;

/** Banded sky keyframes across one day: night → dawn → day → dusk → night. */
const SKY_STOPS = [
  { top: 0x05060f, bottom: 0x0d1126 }, // deep night
  { top: 0x1a1440, bottom: 0x8f4a5e }, // dawn
  { top: 0x20355f, bottom: 0x4a6a9a }, // day
  { top: 0x241140, bottom: 0xa05a38 }, // dusk
  { top: 0x05060f, bottom: 0x0d1126 }, // night again
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
];
const FILE_EXTS = [".ts", ".ts", ".tsx", ".json", ".css"];

interface Building {
  file: string;
  slotFrac: number;
  floors: number;
  shownFloors: number;
  flash: number;
  scaffold: boolean;
  /** 0..1 completion light-cascade after a merge. */
  cascade: number;
  collapse: number;
  branchId: number | null;
}

interface District {
  name: string;
  color: number;
  weight: number;
  share: number;
  commits: number;
  buildings: Building[];
  label: Text;
  x0: number;
  x1: number;
}

interface Crane {
  branchId: number;
  name: string;
  district: number;
  building: Building;
  age: number;
  work: number;
  leaving: number;
  /** Real histories lack branch lifecycles, top out automatically. */
  autoCompleteAt: number | null;
  flag: Text;
}

interface Blimp {
  name: string;
  x: number;
  y: number;
  dir: number;
  label: Text;
  done: boolean;
}

interface Puff {
  sprite: Sprite;
  vx: number;
  vy: number;
  life: number;
  maxLife: number;
  active: boolean;
}

interface Spark {
  sprite: Sprite;
  vx: number;
  vy: number;
  life: number;
  maxLife: number;
  gravity: boolean;
  active: boolean;
}

interface Rocket {
  x: number;
  y: number;
  vy: number;
  burstY: number;
  color: number;
  active: boolean;
}

function mixColor(a: number, b: number, k: number): number {
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

/** Cheap deterministic hash → [0,1). */
function hash01(a: number, b: number, c: number): number {
  let h = (a * 374761393 + b * 668265263 + c * 2147483647) | 0;
  h = (h ^ (h >> 13)) | 0;
  h = (h * 1274126177) | 0;
  return ((h ^ (h >> 16)) >>> 0) / 4294967296;
}

export async function createSketch(
  host: HTMLElement,
  signal?: AbortSignal,
): Promise<SketchInstance> {
  const boot = await bootPixi(host, "#05060f");
  if (signal?.aborted) {
    boot.destroy();
    throw new DOMException("cancelled", "AbortError");
  }
  const { app, world, ui, hud, reducedMotion } = boot;

  const rng: Rng = mulberry32(60601);
  const { history, repoName } = await loadSharedHistory();
  if (signal?.aborted) {
    boot.destroy();
    throw new DOMException("cancelled", "AbortError");
  }

  const glowTex = makeGlowTexture(64);
  const dotTex = makeDotTexture(16);
  const params = {
    blimpAt: 25,
    blimpSpeed: 1.2,
    cycle: 1,
    windowLit: 1,
    fireworks: true,
    fill: 0.78,
  };
  const commitTally = new Map<number, number>();
  const blimped = new Set<number>();
  const governor = new FrameGovernor();
  const shake = new CameraShake();
  const toastsTop = new Toasts(ui, "top", { fill: 0xffe9c2, fontSize: 16 });
  const chrome = new FilmChrome(ui, history, {
    repoName: repoName,
    accent: 0xffd28f,
    reducedMotion,
    clip: world,
    onSeek: (f) => transport.seek(f),
  });

  /* ------------------------------ layer stack ------------------------------ */

  const skyGfx = new Graphics();
  const starLayer = new Container();
  const sunGlow = new Sprite(glowTex);
  sunGlow.anchor.set(0.5);
  sunGlow.blendMode = "add";
  const cityGfx = new Graphics();
  const fxLayer = new Container();
  const labelLayer = new Container();
  world.addChild(skyGfx, starLayer, sunGlow, cityGfx, fxLayer, labelLayer);

  const buildStars = () => {
    starLayer.removeChildren();
    const count = Math.round(170 * governor.scale);
    for (let i = 0; i < count; i++) {
      const s = new Sprite(dotTex);
      s.anchor.set(0.5);
      s.position.set(rng() * app.screen.width, rng() * app.screen.height * 0.55);
      s.scale.set(0.05 + rng() * 0.1);
      s.alpha = 0.3 + rng() * 0.5;
      starLayer.addChild(s);
    }
  };
  buildStars();

  /* ------------------------------ city model ------------------------------ */

  let labelsOn = true;

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

  const districts: District[] = history.clusterNames.map((name, i) => ({
    name,
    color: DISTRICT_COLORS[i % DISTRICT_COLORS.length] ?? 0x6d5dfc,
    weight: 1,
    share: 1 / history.clusters,
    commits: 0,
    buildings: [],
    label: makeLabel(11, INK),
    x0: 0,
    x1: 0,
  }));

  const usedNames = new Set<string>();
  const newFileName = (d: District): string => {
    for (let i = 0; i < 8; i++) {
      const base = FILE_BASES[Math.floor(rng() * FILE_BASES.length)] ?? "mod";
      const ext = FILE_EXTS[Math.floor(rng() * FILE_EXTS.length)] ?? ".ts";
      const name = `${d.name}/${base}${ext}`;
      if (!usedNames.has(name)) {
        usedNames.add(name);
        return name;
      }
    }
    return `${d.name}/mod${Math.floor(rng() * 999)}.ts`;
  };

  const addBuilding = (
    districtIdx: number,
    scaffold: boolean,
    branchId: number | null,
  ): Building => {
    const d = districts[districtIdx % districts.length] as District;
    const slot = d.buildings.length;
    const b: Building = {
      file: newFileName(d),
      slotFrac: (slot + 1) / (MAX_BUILDINGS_PER_DISTRICT + 1),
      floors: 1,
      shownFloors: 0,
      flash: 1,
      scaffold,
      cascade: 0,
      collapse: 0,
      branchId,
    };
    d.buildings.push(b);
    return b;
  };

  const growSomething = (districtIdx: number, magnitude: number) => {
    const d = districts[districtIdx % districts.length] as District;
    d.weight += 0.5 + magnitude * 1.3;
    d.commits++;
    const normal = d.buildings.filter((b) => !b.scaffold);
    const cap = Math.min(18, Math.max(6, Math.round(4 + d.share * 60)));
    if (normal.length === 0 || (normal.length < cap && rng() < 0.3)) {
      addBuilding(districtIdx, false, null);
    } else {
      const b = normal[Math.floor(rng() * normal.length)];
      if (b) {
        b.floors += 1;
        b.flash = 1;
      }
    }
  };

  /* ------------------------------ cranes & blimps ------------------------------ */

  const cranes: Crane[] = [];
  const blimps: Blimp[] = [];
  let mergeSeq = 0;

  const spawnCrane = (branchId: number, districtIdx: number, name: string) => {
    const building = addBuilding(districtIdx, true, branchId);
    cranes.push({
      branchId,
      name,
      district: districtIdx % districts.length,
      building,
      age: 0,
      work: 0,
      leaving: 0,
      autoCompleteAt: null,
      flag: makeLabel(10, 0xffd28f),
    });
  };

  const completeCrane = (crane: Crane, magnitude: number) => {
    const b = crane.building;
    b.scaffold = false;
    b.cascade = 0.0001; // start the light cascade
    b.flash = 1;
    crane.leaving = 0.0001;
    const d = districts[crane.district] as District;
    d.weight += b.floors * 0.7 + magnitude * 3;
    if (!reducedMotion) shake.kick(0.18 + magnitude * 0.3);
  };

  let blimpLane = 0;
  const spawnBlimp = (name: string) => {
    // Every 5-commit contributor earns exactly one crossing, no cap; a blimp
    // is an ellipse, two triangles, and a label, so even a flotilla is free.
    const dir = rng() < 0.5 ? 1 : -1;
    blimpLane = (blimpLane + 1) % 7;
    blimps.push({
      name,
      x: dir === 1 ? -80 : chrome.contentWidth(app.screen.width) + 80,
      y: app.screen.height * (0.07 + blimpLane * 0.04),
      dir,
      label: makeLabel(10, INK),
      done: false,
    });
  };

  /* -------------------------------- fx pools -------------------------------- */

  const puffs: Puff[] = [];
  const puff = (x: number, y: number, count: number, tint: number) => {
    for (let i = 0; i < count; i++) {
      let p = puffs.find((q) => !q.active);
      if (!p) {
        if (puffs.length >= 90) return;
        const sprite = new Sprite(glowTex);
        sprite.anchor.set(0.5);
        fxLayer.addChild(sprite);
        p = { sprite, vx: 0, vy: 0, life: 0, maxLife: 1, active: false };
        puffs.push(p);
      }
      p.active = true;
      p.life = 0;
      p.maxLife = 500 + rng() * 500;
      p.vx = (rng() - 0.5) * 0.08;
      p.vy = -(0.01 + rng() * 0.04);
      p.sprite.visible = true;
      p.sprite.position.set(x + (rng() - 0.5) * 10, y);
      p.sprite.tint = tint;
      p.sprite.alpha = 0.5;
      p.sprite.scale.set(0.25 + rng() * 0.3);
    }
  };

  const sparks: Spark[] = [];
  const sparkBurst = (x: number, y: number, count: number, tint: number, speed: number) => {
    for (let i = 0; i < count; i++) {
      let s = sparks.find((q) => !q.active);
      if (!s) {
        if (sparks.length >= Math.round(420 * governor.scale)) return;
        const sprite = new Sprite(glowTex);
        sprite.anchor.set(0.5);
        sprite.blendMode = "add";
        fxLayer.addChild(sprite);
        s = { sprite, vx: 0, vy: 0, life: 0, maxLife: 1, gravity: true, active: false };
        sparks.push(s);
      }
      const angle = rng() * Math.PI * 2;
      const v = speed * (0.4 + rng() * 0.8);
      s.active = true;
      s.life = 0;
      s.maxLife = 700 + rng() * 600;
      s.vx = Math.cos(angle) * v;
      s.vy = Math.sin(angle) * v - 0.05;
      s.gravity = true;
      s.sprite.visible = true;
      s.sprite.position.set(x, y);
      s.sprite.tint = tint;
      s.sprite.alpha = 1;
      s.sprite.scale.set(0.12 + rng() * 0.14);
    }
  };

  const rockets: Rocket[] = [];
  const fireworks = (count: number) => {
    for (let i = 0; i < count; i++) {
      rockets.push({
        x: app.screen.width * (0.15 + rng() * 0.6),
        y: groundY(),
        vy: -(0.32 + rng() * 0.12),
        burstY: app.screen.height * (0.18 + rng() * 0.2),
        color: DISTRICT_COLORS[Math.floor(rng() * DISTRICT_COLORS.length)] ?? 0xffd28f,
        active: true,
      });
    }
  };

  let lightWave = 9999; // x-position of the release light wave

  /* ------------------------------ event wiring ------------------------------ */

  const demolish = (districtIdx: number, magnitude: number) => {
    const d = districts[districtIdx % districts.length] as District;
    const candidates = d.buildings.filter((b) => !b.scaffold && b.floors > 2);
    const victim = candidates.sort((a, b) => b.floors - a.floors)[0];
    if (!victim) return;
    victim.collapse = 0.0001;
    d.weight = Math.max(0.5, d.weight - victim.floors * 0.5 * magnitude);
    if (!reducedMotion) shake.kick(0.25 + magnitude * 0.35);
  };

  const onEvent = (e: RepoEvent) => {
    chrome.onEvent(e);
    switch (e.kind) {
      case "commit": {
        const tally = (commitTally.get(e.author) ?? 0) + 1;
        commitTally.set(e.author, tally);
        if (!blimped.has(e.author) && tally >= params.blimpAt) {
          blimped.add(e.author);
          const fullName = history.authors[e.author] ?? "someone";
          spawnBlimp(fullName.split(" ")[0] ?? fullName);
        }
        const crane = e.branch ? cranes.find((c) => c.branchId === e.branch) : undefined;
        if (crane && crane.leaving === 0) {
          crane.building.floors += 1;
          crane.building.flash = 1;
          crane.work = 1;
          const d = districts[crane.district] as District;
          d.weight += 0.4 + e.magnitude;
        } else {
          growSomething(e.cluster, e.magnitude);
        }
        break;
      }
      case "branchStart":
        if (e.branch) spawnCrane(e.branch, e.cluster, e.label ?? `branch-${e.branch}`);
        break;
      case "merge": {
        const crane = cranes.find((c) => c.branchId === e.branch && c.leaving === 0);
        if (crane) {
          completeCrane(crane, e.magnitude);
        } else if (cranes.length < 4) {
          // Real merge with no tracked branch: raise a quick tower, then top out.
          mergeSeq++;
          spawnCrane(9000 + mergeSeq, e.cluster, e.label ?? `merge #${mergeSeq}`);
          const fresh = cranes[cranes.length - 1];
          if (fresh) {
            fresh.building.floors = 2 + Math.round(e.magnitude * 9);
            fresh.autoCompleteAt = 1600 + rng() * 1400;
          }
        } else {
          growSomething(e.cluster, e.magnitude);
        }
        break;
      }
      case "massDelete":
        demolish(e.cluster, e.magnitude);
        break;
      case "release":
        if (!reducedMotion && params.fireworks) fireworks(3);
        lightWave = 0;
        break;
      case "newContributor":
        // Blimps launch from the live commit tally instead (tunable threshold).
        break;
    }
  };

  const player = new EventPlayer(history, history.duration / 110);
  const transport = player.transport();

  /* ------------------------------- interaction ------------------------------- */

  let pointerX = -9999;
  let pointerY = -9999;
  app.stage.eventMode = "static";
  app.stage.hitArea = app.screen;
  app.stage.on("pointermove", (ev: { global: { x: number; y: number } }) => {
    pointerX = ev.global.x;
    pointerY = ev.global.y;
  });
  app.stage.on("pointertap", (ev: { global: { x: number } }) => {
    const d = districts.find((q) => ev.global.x >= q.x0 && ev.global.x < q.x1);
    if (!d) return;
    const idx = districts.indexOf(d);
    for (let i = 0; i < 4; i++) growSomething(idx, 0.4 + rng() * 0.5);
    puff((d.x0 + d.x1) / 2, groundY() - 14, 5, d.color);
  });
  const onKey = (ev: KeyboardEvent) => {
    if (ev.code === "KeyT") labelsOn = !labelsOn;
    else if (ev.code === "Space") {
      ev.preventDefault();
      const working = cranes.filter((c) => c.leaving === 0);
      const ripest = working.sort((a, b) => b.building.floors - a.building.floors)[0];
      if (ripest) completeCrane(ripest, 0.8);
    }
  };
  window.addEventListener("keydown", onKey);

  // Hover tooltip.
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
      tipBg.roundRect(0, 0, w, h, 6).fill({ color: 0x05060f, alpha: 0.88 });
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

  const groundY = (): number => chrome.contentHeight(app.screen.height) - 34;
  let clock = 0;
  let cityScale = 1;

  const tick = () => {
    const dtMs = Math.min(app.ticker.deltaMS, 50);
    clock += dtMs;

    if (governor.update(dtMs)) buildStars();
    for (const e of player.update(dtMs)) onEvent(e);

    const contentW = chrome.contentWidth(app.screen.width);
    const gY = groundY();

    /* ----- day / night ----- */
    const yearsElapsed = (player.progress * history.spanMs) / (365.25 * 24 * 3600e3);
    const dayPhase = (yearsElapsed * params.cycle) % 1; // cycles per repo-year (tunable)
    const stop = dayPhase * (SKY_STOPS.length - 1);
    const si = Math.min(SKY_STOPS.length - 2, Math.floor(stop));
    const sk = stop - si;
    const s0 = SKY_STOPS[si] ?? SKY_STOPS[0];
    const s1 = SKY_STOPS[si + 1] ?? SKY_STOPS[0];
    const topColor = mixColor(s0?.top ?? 0, s1?.top ?? 0, sk);
    const botColor = mixColor(s0?.bottom ?? 0, s1?.bottom ?? 0, sk);
    // nightness: 1 at deep night, 0 at midday.
    const nightness = 0.5 + 0.5 * Math.cos(dayPhase * Math.PI * 2);

    skyGfx.clear();
    const bands = 6;
    for (let i = 0; i < bands; i++) {
      const c = mixColor(topColor, botColor, i / (bands - 1));
      skyGfx.rect(0, (gY / bands) * i, contentW, gY / bands + 1).fill({ color: c, alpha: 1 });
    }
    // Ground.
    skyGfx.rect(0, gY, contentW, app.screen.height - gY).fill({ color: 0x0a0d22, alpha: 1 });
    skyGfx.moveTo(0, gY).lineTo(contentW, gY).stroke({ color: INK, alpha: 0.25, width: 1.5 });

    // Sun / moon arc across the sky (sun by day, moon by night).
    const isDaySide = dayPhase > 0.25 && dayPhase < 0.75;
    const arcPhase = isDaySide ? (dayPhase - 0.25) / 0.5 : ((dayPhase + 0.25) % 1) / 0.5;
    const bodyX = contentW * (0.08 + arcPhase * 0.84);
    const bodyY = gY * (0.5 - Math.sin(arcPhase * Math.PI) * 0.38);
    sunGlow.position.set(bodyX, bodyY);
    sunGlow.tint = isDaySide ? 0xffd9a0 : 0xc9d4ff;
    sunGlow.scale.set(isDaySide ? 1.5 : 0.9);
    sunGlow.alpha = isDaySide ? 0.85 : 0.6;

    starLayer.alpha = nightness * 0.9;

    /* ----- district shares ----- */
    const totalWeight = districts.reduce((acc, d) => acc + d.weight, 0);
    for (const d of districts) {
      d.share += (d.weight / totalWeight - d.share) * Math.min(1, dtMs / 1500);
    }
    const shareSum = districts.reduce((acc, d) => acc + d.share, 0);
    let cx = 0;
    for (const d of districts) {
      const w = (d.share / shareSum) * (contentW - 24);
      d.x0 = 12 + cx;
      d.x1 = 12 + cx + w;
      cx += w;
    }

    /* ----- city scale (zoom out as towers rise) ----- */
    let tallest = 6;
    for (const d of districts) {
      for (const b of d.buildings) tallest = Math.max(tallest, effFloors(b.floors));
    }
    const maxH = gY * 0.62;
    const targetScale = Math.min(1, maxH / (tallest * FLOOR_H));
    cityScale += (targetScale - cityScale) * Math.min(1, dtMs / 800);

    /* ----- light wave (release) ----- */
    lightWave += dtMs * 0.9;

    /* ----- draw city ----- */
    cityGfx.clear();
    const windowSkip = governor.scale < 0.7 ? 2 : 1;
    for (const d of districts) {
      const dw = d.x1 - d.x0;
      // District ground strip.
      cityGfx.rect(d.x0, gY, dw - 2, 5).fill({ color: d.color, alpha: 0.4 });

      const n = d.buildings.length;
      const bw = Math.max(6, Math.min(58, ((dw - 10) / Math.max(1, n)) * params.fill));
      for (let bi = 0; bi < n; bi++) {
        const b = d.buildings[bi];
        if (!b) continue;
        const centerX = d.x0 + ((bi + 1) / (n + 1)) * dw;
        b.flash = Math.max(0, b.flash - dtMs / 600);
        if (b.cascade > 0 && b.cascade < 1) b.cascade = Math.min(1, b.cascade + dtMs / 800);
        if (b.collapse > 0 && b.collapse < 1) {
          b.collapse = Math.min(1, b.collapse + dtMs / 450);
          if (b.collapse >= 1) {
            b.floors = Math.max(1, Math.round(b.floors * 0.3));
            b.shownFloors = b.floors;
            b.collapse = 0;
            puff(centerX, gY - effFloors(b.floors) * FLOOR_H * cityScale, 8, 0x8c93b8);
          }
        }
        // Floors rise one at a time (snappy).
        const rise = Math.min(1, dtMs / 110);
        b.shownFloors += (b.floors - b.shownFloors) * rise;

        const squash = b.collapse > 0 ? 1 - b.collapse * 0.7 : 1;
        const shownEff = effFloors(b.shownFloors);
        const hPx = Math.max(3, shownEff * FLOOR_H * cityScale * squash);
        const x = centerX - bw / 2;
        const y = gY - hPx;

        const bodyMuted = mixColor(d.color, 0x0a0d22, 0.6);
        const body = mixColor(bodyMuted, d.color, b.flash * 0.8);
        if (b.scaffold) {
          // Under construction: outline + cross braces.
          cityGfx.rect(x, y, bw, hPx).stroke({ color: d.color, alpha: 0.8, width: 1.2 });
          const braces = Math.max(1, Math.floor(hPx / 14));
          for (let i = 0; i < braces; i++) {
            const by = y + (i / braces) * hPx;
            cityGfx
              .moveTo(x, by)
              .lineTo(x + bw, by + 14)
              .stroke({ color: d.color, alpha: 0.3, width: 1 });
          }
        } else {
          cityGfx.rect(x, y, bw, hPx).fill({ color: body, alpha: 0.97 });
          cityGfx
            .rect(x, y, bw, hPx)
            .stroke({ color: mixColor(d.color, INK, 0.3), alpha: 0.25, width: 1 });
          // Windows.
          const floorsVisible = Math.floor(shownEff);
          const dayIndex = Math.floor(yearsElapsed * 365);
          const cascadeFloor = b.cascade > 0 ? b.cascade * floorsVisible : -1;
          for (let f = 0; f < floorsVisible; f += windowSkip) {
            const wy = gY - (f + 0.65) * FLOOR_H * cityScale * squash;
            if (gY - wy > hPx) break;
            for (let wcol = 0; wcol < 2; wcol++) {
              const seed = hash01(bi * 97 + wcol, f, dayIndex);
              const litBase = seed < (0.18 + nightness * 0.5) * params.windowLit;
              const waveHit = Math.abs(centerX - lightWave) < 60;
              const cascadeHit = b.cascade > 0 && f <= cascadeFloor;
              const lit = litBase || waveHit || cascadeHit || b.flash > 0.5;
              if (!lit) continue;
              const wx = x + 2 + wcol * (bw / 2);
              cityGfx
                .rect(wx, wy, Math.max(1.5, bw / 2 - 4), Math.max(1.5, FLOOR_H * cityScale * 0.42))
                .fill({
                  color: WINDOW_LIT,
                  alpha: cascadeHit || waveHit ? 0.95 : 0.4 + nightness * 0.5,
                });
            }
          }
        }
      }
    }

    /* ----- cranes ----- */
    for (let i = cranes.length - 1; i >= 0; i--) {
      const c = cranes[i];
      if (!c) continue;
      c.age += dtMs;
      c.work = Math.max(0, c.work - dtMs / 700);
      if (c.autoCompleteAt !== null && c.leaving === 0 && c.age > c.autoCompleteAt) {
        completeCrane(c, 0.6);
      }
      if (c.leaving > 0) {
        c.leaving += dtMs / 900;
        if (c.leaving >= 1) {
          c.flag.destroy();
          cranes.splice(i, 1);
          continue;
        }
      }
      const d = districts[c.district] as District;
      const dw = d.x1 - d.x0;
      const b = c.building;
      const bi = Math.max(0, d.buildings.indexOf(b));
      const bx = d.x0 + ((bi + 1) / (d.buildings.length + 1)) * dw;
      const hPx = Math.max(10, effFloors(b.shownFloors) * FLOOR_H * cityScale);
      const mastX = bx + 16;
      const mastTop = gY - hPx - 34 - Math.sin(c.age * 0.001) * 2;
      const fade = c.leaving > 0 ? 1 - c.leaving : Math.min(1, c.age / 400);
      // Mast, jib, counter-jib, cable, hook.
      cityGfx
        .moveTo(mastX, gY)
        .lineTo(mastX, mastTop)
        .stroke({ color: 0xffd28f, alpha: 0.75 * fade, width: 2 });
      const jibLen = 30 + Math.sin(c.age * 0.0006) * 4;
      cityGfx
        .moveTo(mastX - 12, mastTop)
        .lineTo(mastX + jibLen, mastTop)
        .stroke({ color: 0xffd28f, alpha: 0.75 * fade, width: 1.5 });
      const hookX = mastX + jibLen - 8;
      const hookDrop = 10 + c.work * 16 + Math.sin(c.age * 0.002) * 3;
      cityGfx
        .moveTo(hookX, mastTop)
        .lineTo(hookX, mastTop + hookDrop)
        .stroke({ color: 0xffd28f, alpha: 0.6 * fade, width: 1 });
      cityGfx
        .rect(hookX - 2.5, mastTop + hookDrop, 5, 5)
        .fill({ color: 0xffd28f, alpha: 0.85 * fade });
      // Flag.
      c.flag.text = c.name;
      c.flag.position.set(mastX, mastTop - 16);
      c.flag.alpha = 0; // names live in the sidebar + hover
    }

    /* ----- blimps ----- */
    for (let i = blimps.length - 1; i >= 0; i--) {
      const bl = blimps[i];
      if (!bl) continue;
      bl.x += bl.dir * dtMs * (reducedMotion ? 0.012 : 0.022) * params.blimpSpeed;
      bl.y += Math.sin(clock * 0.001 + i) * 0.05;
      // One crossing, then gone, the moment belongs to their 5th commit.
      const gone = bl.dir === 1 ? bl.x > contentW + 90 : bl.x < -90;
      if (gone) {
        bl.label.destroy();
        blimps.splice(i, 1);
        continue;
      }
      const bw2 = 34;
      const bh2 = 12;
      cityGfx.ellipse(bl.x, bl.y, bw2 / 2, bh2 / 2).fill({ color: 0xc9d4ff, alpha: 0.85 });
      cityGfx
        .poly([
          bl.x - bl.dir * (bw2 / 2),
          bl.y,
          bl.x - bl.dir * (bw2 / 2 + 9),
          bl.y - 5,
          bl.x - bl.dir * (bw2 / 2 + 9),
          bl.y + 5,
        ])
        .fill({ color: 0x8c93b8, alpha: 0.85 });
      cityGfx.rect(bl.x - 4, bl.y + bh2 / 2, 8, 4).fill({ color: 0x8c93b8, alpha: 0.9 });
      bl.label.text = bl.name;
      bl.label.position.set(bl.x, bl.y + bh2 / 2 + 6);
      bl.label.alpha = labelsOn ? 0.85 : 0;
    }

    /* ----- district labels ----- */
    for (const d of districts) {
      d.label.text = `${d.name}/`;
      d.label.position.set((d.x0 + d.x1) / 2, gY + 10);
      const wide = d.x1 - d.x0 > 46;
      d.label.alpha += ((labelsOn && wide ? 0.8 : 0) - d.label.alpha) * Math.min(1, dtMs / 250);
    }

    /* ----- rockets & sparks & puffs ----- */
    for (const r of rockets) {
      if (!r.active) continue;
      r.y += r.vy * dtMs;
      cityGfx.rect(r.x - 1, r.y, 2, 8).fill({ color: 0xffe9c2, alpha: 0.9 });
      if (r.y <= r.burstY) {
        r.active = false;
        sparkBurst(r.x, r.y, 26, r.color, 0.22);
        if (!reducedMotion) shake.kick(0.1);
      }
    }
    for (const s of sparks) {
      if (!s.active) continue;
      s.life += dtMs;
      if (s.life >= s.maxLife) {
        s.active = false;
        s.sprite.visible = false;
        continue;
      }
      if (s.gravity) s.vy += 0.00045 * dtMs;
      s.vx *= Math.exp(-0.0008 * dtMs);
      s.sprite.x += s.vx * dtMs;
      s.sprite.y += s.vy * dtMs;
      s.sprite.alpha = 1 - s.life / s.maxLife;
    }
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
      p.sprite.alpha = 0.5 * (1 - p.life / p.maxLife);
      p.sprite.scale.set(p.sprite.scale.x + dtMs * 0.0004);
    }

    /* ----- hover ----- */
    let tipMsg: string | null = null;
    if (pointerX > -999 && pointerX < contentW) {
      for (const bl of blimps) {
        if (Math.hypot(pointerX - bl.x, pointerY - bl.y) < 26) {
          tipMsg = `${bl.name} · contributor`;
          break;
        }
      }
      if (!tipMsg) {
        outer: for (const d of districts) {
          const dw = d.x1 - d.x0;
          const n = d.buildings.length;
          const bw = Math.max(6, Math.min(58, ((dw - 10) / Math.max(1, n)) * params.fill));
          for (let bi = 0; bi < n; bi++) {
            const b = d.buildings[bi];
            if (!b) continue;
            const x = d.x0 + ((bi + 1) / (n + 1)) * dw - bw / 2;
            const hPx = Math.max(3, effFloors(b.shownFloors) * FLOOR_H * cityScale);
            if (pointerX >= x && pointerX <= x + bw && pointerY >= gY - hPx && pointerY <= gY) {
              tipMsg = b.scaffold
                ? `${b.file} · under construction · ${b.floors} floors`
                : `${b.file} · ${b.floors} floors`;
              break outer;
            }
          }
        }
      }
      if (!tipMsg && pointerY > gY && pointerY < gY + 26) {
        const d = districts.find((q) => pointerX >= q.x0 && pointerX < q.x1);
        if (d) {
          const pct = Math.round(((d.x1 - d.x0) / (contentW - 24)) * 100);
          tipMsg = `${d.name}/ · ${pct}% of the city · ${d.commits} commits`;
        }
      }
    }
    setTip(tipMsg);

    /* ----- chrome & camera ----- */
    let totalFloors = 0;
    let totalBuildings = 0;
    for (const d of districts) {
      totalBuildings += d.buildings.length;
      for (const b of d.buildings) totalFloors += b.floors;
    }
    chrome.update(dtMs, app.screen.width, app.screen.height, player.progress, [
      ["buildings", totalBuildings],
      ["floors", totalFloors],
      ["cranes", cranes.filter((c) => c.leaving === 0).length],
      ["blimps", blimps.length],
    ]);
    toastsTop.update(dtMs, contentW, app.screen.height);

    if (!reducedMotion) shake.update(dtMs, rng);
    world.position.set(shake.x, shake.y);

    hud.update(
      dtMs,
      `${totalBuildings} bldgs · ${totalFloors} floors · ${Math.round(nightness * 100)}% night · era ${(player.progress * 100).toFixed(0)}%`,
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
      history,
      accent: 0xffd28f,
      setChromeHidden: (b) => chrome.setHidden(b),
      setHudVisible: (b) => hud.setVisible(b),
      setLabels: (b) => {
        labelsOn = b;
      },
    }),
    controls: [
      {
        key: "blimpAt",
        label: "blimp at N commits",
        kind: "range",
        min: 1,
        max: 100,
        step: 1,
        value: 25,
        set: (v) => {
          params.blimpAt = v as number;
        },
      },
      {
        key: "blimpSpeed",
        label: "blimp speed",
        kind: "range",
        min: 0.5,
        max: 3,
        step: 0.1,
        value: 1.2,
        set: (v) => {
          params.blimpSpeed = v as number;
        },
      },
      {
        key: "cycle",
        label: "day/night cycles per year",
        kind: "range",
        min: 0.25,
        max: 4,
        step: 0.25,
        value: 1,
        set: (v) => {
          params.cycle = v as number;
        },
      },
      {
        key: "windowLit",
        label: "window glow",
        kind: "range",
        min: 0,
        max: 1.5,
        step: 0.05,
        value: 1,
        set: (v) => {
          params.windowLit = v as number;
        },
      },
      {
        key: "fill",
        label: "building width",
        kind: "range",
        min: 0.5,
        max: 0.95,
        step: 0.01,
        value: 0.78,
        set: (v) => {
          params.fill = v as number;
        },
      },
      {
        key: "fireworks",
        label: "release fireworks",
        kind: "toggle",
        value: true,
        set: (v) => {
          params.fireworks = v as boolean;
        },
      },
    ],
  };
}
