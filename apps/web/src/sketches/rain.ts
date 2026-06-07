/**
 * Rain sketch: commits fall as drops into a pool that rises over the repo's
 * life. Spring-wave water sim with splash crowns and ripples. Merges are
 * mega-drops with a beat of slow motion, releases re-tint the water,
 * contributors float as lanterns. Runs hands-off, made for screen recording.
 */
import { mulberry32, type RepoEvent, type Rng } from "@repomentary/artifact";
import { Container, Graphics, Sprite, Text } from "pixi.js";
import { loadSharedHistory } from "@/lib/realHistory";
import { FilmChrome } from "./chrome";
import {
  bootPixi,
  CameraShake,
  clamp01,
  EventPlayer,
  FrameGovernor,
  makeDotTexture,
  makeGlowTexture,
  type SketchInstance,
  Toasts,
} from "./common";

const VOID = "#07091a";

/** Water ages, releases advance through these. */
const AGES = [
  { fill: 0x241f5e, line: 0x8c7bff, drop: 0xcfc6ff },
  { fill: 0x123f42, line: 0x39d4c2, drop: 0xbdfff4 },
  { fill: 0x423510, line: 0xe8b64f, drop: 0xffe9bd },
  { fill: 0x431b2e, line: 0xe86f9b, drop: 0xffd3e2 },
  { fill: 0x132f42, line: 0x6fc3e8, drop: 0xd3efff },
];

interface Drop {
  sprite: Sprite;
  x: number;
  y: number;
  vx: number;
  vy: number;
  size: number;
  mega: boolean;
  megaName: string | null;
  splash: boolean;
  slowmoArmed: boolean;
  active: boolean;
}

interface Ripple {
  x: number;
  age: number;
  strength: number;
  active: boolean;
}

interface Lantern {
  name: string;
  x: number;
  y: number;
  vy: number;
  drift: number;
  phase: number;
  glow: Sprite;
  core: Sprite;
}

interface Bubble {
  x: number;
  y: number;
  vy: number;
  phase: number;
  size: number;
  sprite: Sprite;
  active: boolean;
}

interface Whirl {
  x: number;
  age: number;
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

  const rng: Rng = mulberry32(11211);
  const { history, repoName } = await loadSharedHistory();
  if (signal?.aborted) {
    boot.destroy();
    throw new DOMException("cancelled", "AbortError");
  }

  const glowTex = makeGlowTexture(64);
  const dotTex = makeDotTexture(16);
  const params = { dropSize: 1, splash: 1, slowmo: true, maxFill: 0.73 };
  const governor = new FrameGovernor();
  const shake = new CameraShake();
  const toastsTop = new Toasts(ui, "top", { fill: 0xffe9c2, fontSize: 16 });
  const chrome = new FilmChrome(ui, history, {
    repoName: repoName,
    accent: 0x8c7bff,
    reducedMotion,
    clip: world,
    onSeek: (f) => transport.seek(f),
  });

  // Total "volume" the history will pour in, used to normalize the level.
  const totalVolume = history.events.reduce(
    (acc, e) => acc + (e.kind === "commit" ? 1 : e.kind === "merge" ? 2.2 : 0),
    0,
  );

  /* ------------------------------ layer stack ------------------------------ */

  const bgLayer = new Container();
  const waterGfx = new Graphics();
  const sparkleLayer = new Container(); // drifting lights inside the water
  const rippleGfx = new Graphics();
  const lanternLayer = new Container();
  const dropLayer = new Container();
  world.addChild(bgLayer, waterGfx, sparkleLayer, rippleGfx, lanternLayer, dropLayer);

  const buildBackground = () => {
    bgLayer.removeChildren();
    const count = Math.round(220 * governor.scale);
    for (let i = 0; i < count; i++) {
      const s = new Sprite(dotTex);
      s.anchor.set(0.5);
      s.position.set(rng() * app.screen.width, rng() * app.screen.height * 0.8);
      s.scale.set(0.05 + rng() * 0.12);
      s.alpha = 0.1 + rng() * 0.25;
      bgLayer.addChild(s);
    }
  };
  buildBackground();

  /* ------------------------------ water springs ------------------------------ */

  const N = Math.min(220, Math.max(110, Math.round(app.screen.width / 8)));
  const ys = new Float32Array(N); // surface offset (+down)
  const vs = new Float32Array(N);
  const lDeltas = new Float32Array(N);
  const rDeltas = new Float32Array(N);

  const xOf = (i: number): number => (i / (N - 1)) * app.screen.width;
  const indexOf = (x: number): number =>
    Math.max(0, Math.min(N - 1, Math.round((x / app.screen.width) * (N - 1))));

  let poured = 0; // volume absorbed so far this era
  let drained = 0; // volume lost to mass deletions
  let levelFrac = 0.14; // animated toward target
  const targetLevel = (): number =>
    0.13 + (params.maxFill - 0.13) * clamp01((poured - drained) / Math.max(1, totalVolume));
  const levelY = (): number => app.screen.height * (1 - levelFrac);

  const surfaceYAt = (x: number): number => {
    const f = (x / app.screen.width) * (N - 1);
    const i = Math.max(0, Math.min(N - 2, Math.floor(f)));
    const t = f - i;
    return levelY() + (ys[i] ?? 0) * (1 - t) + (ys[i + 1] ?? 0) * t;
  };

  const kick = (x: number, power: number, radius = 2) => {
    const center = indexOf(x);
    for (let di = -radius; di <= radius; di++) {
      const i = center + di;
      if (i < 0 || i >= N) continue;
      const falloff = Math.exp(-(di * di) / Math.max(1, radius));
      vs[i] = (vs[i] ?? 0) + power * falloff;
    }
  };

  const stepWater = (steps: number) => {
    for (let s = 0; s < steps; s++) {
      for (let i = 0; i < N; i++) {
        vs[i] = ((vs[i] ?? 0) - 0.02 * (ys[i] ?? 0)) * 0.988;
        ys[i] = (ys[i] ?? 0) + (vs[i] ?? 0) * 16;
      }
      for (let pass = 0; pass < 3; pass++) {
        for (let i = 0; i < N; i++) {
          if (i > 0) {
            lDeltas[i] = 0.12 * ((ys[i] ?? 0) - (ys[i - 1] ?? 0));
            vs[i - 1] = (vs[i - 1] ?? 0) + (lDeltas[i] ?? 0) * 0.06;
          }
          if (i < N - 1) {
            rDeltas[i] = 0.12 * ((ys[i] ?? 0) - (ys[i + 1] ?? 0));
            vs[i + 1] = (vs[i + 1] ?? 0) + (rDeltas[i] ?? 0) * 0.06;
          }
        }
      }
    }
  };

  /* ------------------------------ color of the age ------------------------------ */

  let age = 0;
  let fillColor = AGES[0]?.fill ?? 0x241f5e;
  let lineColor = AGES[0]?.line ?? 0x8c7bff;
  let dropColor = AGES[0]?.drop ?? 0xcfc6ff;

  const advanceAge = () => {
    age++;
    const target = AGES[age % AGES.length];
    if (!target) return;
    // colors lerp toward these in the tick
    targetFill = target.fill;
    targetLine = target.line;
    targetDrop = target.drop;
  };
  let targetFill = fillColor;
  let targetLine = lineColor;
  let targetDrop = dropColor;

  /* --------------------------------- pools ---------------------------------- */

  const drops: Drop[] = [];
  const dropBudget = () => Math.round(160 * governor.scale);
  const getDrop = (): Drop | null => {
    for (const d of drops) {
      if (!d.active) return d;
    }
    if (drops.length >= dropBudget()) return null;
    const sprite = new Sprite(glowTex);
    sprite.anchor.set(0.5);
    sprite.blendMode = "add";
    dropLayer.addChild(sprite);
    const d: Drop = {
      sprite,
      x: 0,
      y: 0,
      vx: 0,
      vy: 0,
      size: 1,
      mega: false,
      megaName: null,
      splash: false,
      slowmoArmed: false,
      active: false,
    };
    drops.push(d);
    return d;
  };

  const spawnDrop = (x: number, size: number, opts: { mega?: boolean; name?: string } = {}) => {
    const d = getDrop();
    if (!d) return;
    d.active = true;
    d.x = x;
    d.y = reducedMotion ? surfaceYAt(x) - 60 : -30 - rng() * app.screen.height * 0.25;
    d.vx = 0;
    d.vy = opts.mega ? 0.12 : 0.05 + rng() * 0.2;
    d.size = size * params.dropSize;
    d.mega = opts.mega ?? false;
    d.megaName = opts.name ?? null;
    d.splash = false;
    d.slowmoArmed = d.mega && !reducedMotion && params.slowmo;
    d.sprite.visible = true;
    d.sprite.tint = d.mega ? 0xffffff : dropColor;
    d.sprite.alpha = 0.95;
  };

  const spawnSplashlet = (x: number, y: number, power: number) => {
    const d = getDrop();
    if (!d) return;
    d.active = true;
    d.splash = true;
    d.mega = false;
    d.megaName = null;
    d.slowmoArmed = false;
    d.x = x;
    d.y = y;
    d.vx = (rng() - 0.5) * 0.4 * power;
    d.vy = -(0.18 + rng() * 0.38) * power;
    d.size = 0.12 + rng() * 0.16;
    d.sprite.visible = true;
    d.sprite.tint = lineColor;
    d.sprite.alpha = 0.9;
  };

  const ripples: Ripple[] = [];
  const ripple = (x: number, strength: number) => {
    let r = ripples.find((q) => !q.active);
    if (!r) {
      if (ripples.length >= 26) return;
      r = { x: 0, age: 0, strength: 1, active: false };
      ripples.push(r);
    }
    r.active = true;
    r.x = x;
    r.age = 0;
    r.strength = strength;
  };

  const lanterns: Lantern[] = [];
  const addLantern = (name: string) => {
    if (lanterns.length >= 14) return;
    const glow = new Sprite(glowTex);
    glow.anchor.set(0.5);
    glow.blendMode = "add";
    glow.tint = 0xffd9a0;
    glow.alpha = 0.55;
    glow.scale.set(0.5);
    const core = new Sprite(dotTex);
    core.anchor.set(0.5);
    core.tint = 0xfff3da;
    core.scale.set(0.22);
    lanternLayer.addChild(glow, core);
    const x = chrome.contentWidth(app.screen.width) * (0.08 + rng() * 0.84);
    lanterns.push({
      name,
      x,
      y: -20,
      vy: 0,
      drift: (rng() - 0.5) * 0.004,
      phase: rng() * Math.PI * 2,
      glow,
      core,
    });
  };

  const bubbles: Bubble[] = [];
  const burstBubbles = (count: number) => {
    for (let i = 0; i < count; i++) {
      let b = bubbles.find((q) => !q.active);
      if (!b) {
        if (bubbles.length >= 40) break;
        const sprite = new Sprite(dotTex);
        sprite.anchor.set(0.5);
        sprite.alpha = 0.5;
        sparkleLayer.addChild(sprite);
        b = { x: 0, y: 0, vy: 0, phase: 0, size: 1, sprite, active: false };
        bubbles.push(b);
      }
      b.active = true;
      b.x = app.screen.width * (0.1 + rng() * 0.8);
      b.y = app.screen.height - 10 - rng() * 40;
      b.vy = -(0.04 + rng() * 0.09);
      b.phase = rng() * Math.PI * 2;
      b.size = 0.1 + rng() * 0.14;
      b.sprite.visible = true;
      b.sprite.tint = lineColor;
    }
  };

  const sparkles: { sprite: Sprite; xFrac: number; yFrac: number; phase: number }[] = [];
  for (let i = 0; i < 46; i++) {
    const sprite = new Sprite(dotTex);
    sprite.anchor.set(0.5);
    sprite.scale.set(0.08 + rng() * 0.1);
    sparkleLayer.addChild(sprite);
    sparkles.push({ sprite, xFrac: rng(), yFrac: rng(), phase: rng() * Math.PI * 2 });
  }

  const whirl: Whirl = { x: 0, age: 9999, active: false };

  /* ------------------------------ score keeping ------------------------------ */

  const eraCard = new Text({
    text: "",
    style: { fontFamily: "monospace", fontSize: 30, fill: 0xe8ecff, align: "center" },
  });
  eraCard.anchor.set(0.5);
  eraCard.alpha = 0;
  ui.addChild(eraCard);
  let eraCardAge = 0;
  const eraNum = 1;
  const showEra = (sub?: string) => {
    eraCard.text = sub ? `every drop is a commit\n\n${sub}` : `ERA ${eraNum}`;
    eraCardAge = 0;
  };
  showEra("watch the codebase fill");

  /* ------------------------------ event handling ------------------------------ */

  const branchNames = new Map<number, string>();
  let draining = 0;

  const xForCluster = (cluster: number): number => {
    const w = chrome.contentWidth(app.screen.width);
    const lane = (cluster + 0.5) / history.clusters;
    return w * 0.06 + lane * w * 0.88 + (rng() - 0.5) * w * 0.07;
  };

  const onEvent = (e: RepoEvent) => {
    chrome.onEvent(e);
    switch (e.kind) {
      case "commit":
        poured += 1;
        spawnDrop(xForCluster(e.cluster), 0.22 + e.magnitude * 0.5);
        break;
      case "branchStart":
        if (e.branch && e.label) branchNames.set(e.branch, e.label);
        break;
      case "merge":
        poured += 2.2;
        spawnDrop(xForCluster(e.cluster), 1 + e.magnitude * 0.9, {
          mega: true,
          name: e.branch ? branchNames.get(e.branch) : undefined,
        });
        break;
      case "massDelete":
        drained += Math.min(poured * 0.06, 6 + e.magnitude * 8);
        whirl.active = true;
        whirl.age = 0;
        whirl.x = xForCluster(e.cluster);
        break;
      case "release":
        advanceAge();
        burstBubbles(14 + Math.round(e.magnitude * 10));
        break;
      case "newContributor":
        if (e.label) addLantern(e.label.split(" ")[0] ?? e.label);
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
  app.stage.on("pointermove", (event: { global: { x: number; y: number } }) => {
    pointerX = event.global.x;
    pointerY = event.global.y;
  });
  app.stage.on("pointertap", (event: { global: { x: number } }) => {
    poured += 1;
    spawnDrop(event.global.x, 0.3 + rng() * 0.5);
  });
  const onKey = (ev: KeyboardEvent) => {
    if (ev.code === "Space") {
      ev.preventDefault();
      spawnDrop(app.screen.width * (0.2 + rng() * 0.6), 1.5, { mega: true, name: "feat/surprise" });
      poured += 2.2;
    }
  };
  window.addEventListener("keydown", onKey);

  // Tiny tooltip for lanterns.
  const tipBg = new Graphics();
  const tipText = new Text({
    text: "",
    style: { fontFamily: "monospace", fontSize: 12, fill: 0xffffff },
  });
  const tip = new Container();
  tip.addChild(tipBg, tipText);
  tip.visible = false;
  ui.addChild(tip);

  /* -------------------------------- frame loop -------------------------------- */

  let clock = 0;
  let slowmo = 0;
  let waterCarry = 0;

  const tick = () => {
    const realDt = Math.min(app.ticker.deltaMS, 50);
    clock += realDt;

    // Slow motion: ease back to full speed.
    slowmo = Math.max(0, slowmo - realDt);
    const timeScale = reducedMotion ? 1 : slowmo > 0 ? 0.32 : 1;
    const dtMs = realDt * timeScale;

    if (governor.update(realDt)) buildBackground();
    for (const e of player.update(dtMs)) onEvent(e);

    // Level seeks its target; draining overrides.
    if (draining > 0) {
      draining -= realDt;
      levelFrac += (0.13 - levelFrac) * Math.min(1, realDt / 320);
      kick(whirl.x || app.screen.width / 2, 0.4, 5);
      if (draining <= 0) {
        poured = 0;
        drained = 0;
        chrome.reset();
        branchNames.clear();
        for (const l of lanterns) {
          l.glow.destroy();
          l.core.destroy();
        }
        lanterns.length = 0;
        showEra();
      }
    } else {
      levelFrac += (targetLevel() - levelFrac) * Math.min(1, dtMs / 2400);
    }

    // Water physics (fixed 16ms substeps).
    waterCarry += dtMs;
    let steps = 0;
    while (waterCarry >= 16 && steps < 4) {
      waterCarry -= 16;
      steps++;
    }
    if (steps > 0) stepWater(steps);

    // Whirlpool suction.
    if (whirl.active) {
      whirl.age += dtMs;
      if (whirl.age > 700) whirl.active = false;
      else kick(whirl.x, 0.18, 4);
    }

    // Colors drift toward the current age.
    fillColor = mixColor(fillColor, targetFill, Math.min(1, dtMs / 900));
    lineColor = mixColor(lineColor, targetLine, Math.min(1, dtMs / 900));
    dropColor = mixColor(dropColor, targetDrop, Math.min(1, dtMs / 900));

    /* ----- drops ----- */
    let activeDrops = 0;
    for (const d of drops) {
      if (!d.active) continue;
      activeDrops++;
      d.vy += 0.0024 * dtMs;
      d.x += d.vx * dtMs;
      d.y += d.vy * dtMs;
      const stretch = Math.min(1.6, 1 + d.vy * 0.55);
      d.sprite.scale.set((d.size * 1.1) / stretch ** 0.5, d.size * stretch);
      d.sprite.position.set(d.x, d.y);
      d.sprite.rotation = d.splash ? Math.atan2(d.vy, d.vx) - Math.PI / 2 : 0;

      // Mega drops earn a breath of slow motion on approach.
      if (d.slowmoArmed && d.y > app.screen.height * 0.45) {
        d.slowmoArmed = false;
        slowmo = 520;
      }

      const sy = surfaceYAt(d.x);
      if (d.y >= sy) {
        d.active = false;
        d.sprite.visible = false;
        if (d.splash) {
          kick(d.x, 0.06, 1);
          continue;
        }
        // Plunge!
        const power = d.mega ? 1.6 + d.size * 0.5 : 0.35 + d.size * 0.9;
        kick(d.x, power * 0.55 * params.splash, d.mega ? 6 : 2);
        ripple(d.x, power);
        const crown = Math.round((d.mega ? 16 : 3 + d.size * 6) * params.splash);
        for (let i = 0; i < crown; i++) spawnSplashlet(d.x, sy - 2, d.mega ? 1.6 : 1);
        if (d.mega) {
          if (!reducedMotion) shake.kick(0.4 + d.size * 0.18);
          ripple(d.x, 2.4);
          ripple(d.x, 1.6);
        }
      }
    }

    /* ----- water body ----- */
    waterGfx.clear();
    const bottom = app.screen.height;
    waterGfx.moveTo(0, bottom);
    for (let i = 0; i < N; i++) waterGfx.lineTo(xOf(i), levelY() + (ys[i] ?? 0));
    waterGfx.lineTo(app.screen.width, bottom);
    waterGfx.closePath();
    waterGfx.fill({ color: fillColor, alpha: 0.92 });
    // Surface line (bright) + soft inner glow line.
    for (let i = 0; i < N; i++) {
      const x = xOf(i);
      const y = levelY() + (ys[i] ?? 0);
      if (i === 0) waterGfx.moveTo(x, y);
      else waterGfx.lineTo(x, y);
    }
    waterGfx.stroke({ color: lineColor, alpha: 0.95, width: 2 });
    for (let i = 0; i < N; i++) {
      const x = xOf(i);
      const y = levelY() + (ys[i] ?? 0) + 5;
      if (i === 0) waterGfx.moveTo(x, y);
      else waterGfx.lineTo(x, y);
    }
    waterGfx.stroke({ color: lineColor, alpha: 0.2, width: 5 });

    /* ----- ripples ----- */
    rippleGfx.clear();
    for (const r of ripples) {
      if (!r.active) continue;
      r.age += dtMs;
      const k = clamp01(r.age / 900);
      if (k >= 1) {
        r.active = false;
        continue;
      }
      const rx = 6 + k * 90 * r.strength;
      const alpha = (1 - k) * 0.5;
      rippleGfx.ellipse(r.x, surfaceYAt(r.x), rx, rx * 0.22).stroke({
        color: lineColor,
        alpha,
        width: 1.5,
      });
    }

    /* ----- lanterns (buoyant) ----- */
    for (const l of lanterns) {
      l.x += l.drift * dtMs + Math.sin(clock * 0.0004 + l.phase) * 0.02;
      l.x = Math.max(10, Math.min(app.screen.width - 10, l.x));
      const targetY = surfaceYAt(l.x) - 5;
      l.vy += (targetY - l.y) * 0.00035 * dtMs;
      l.vy *= Math.exp(-0.004 * dtMs);
      l.y += l.vy * dtMs;
      const breathe = 0.5 + 0.12 * Math.sin(clock * 0.0021 + l.phase);
      l.glow.position.set(l.x, l.y);
      l.glow.alpha = breathe;
      l.core.position.set(l.x, l.y);
    }

    /* ----- bubbles ----- */
    for (const b of bubbles) {
      if (!b.active) continue;
      b.phase += dtMs * 0.004;
      b.y += b.vy * dtMs;
      b.x += Math.sin(b.phase) * 0.25;
      b.sprite.position.set(b.x, b.y);
      b.sprite.scale.set(b.size);
      const sy = surfaceYAt(b.x);
      if (b.y <= sy + 2) {
        b.active = false;
        b.sprite.visible = false;
        kick(b.x, 0.05, 1);
        spawnSplashlet(b.x, sy - 2, 0.6);
      }
    }

    /* ----- sparkles inside the water ----- */
    for (const sp of sparkles) {
      const x = sp.xFrac * app.screen.width;
      const depth = bottom - levelY();
      const y = levelY() + 14 + sp.yFrac * Math.max(8, depth - 22);
      sp.sprite.position.set(x, y);
      sp.sprite.tint = lineColor;
      sp.sprite.alpha = 0.05 + 0.08 * (1 + Math.sin(clock * 0.0014 + sp.phase)) * 0.5;
    }

    /* ----- era card ----- */
    eraCardAge += realDt;
    const ek = clamp01(eraCardAge / 3000);
    eraCard.alpha = ek < 0.15 ? ek / 0.15 : ek > 0.72 ? (1 - ek) / 0.28 : 1;
    if (ek >= 1) eraCard.alpha = 0;
    eraCard.position.set(chrome.contentWidth(app.screen.width) / 2, app.screen.height * 0.3);

    /* ----- lantern tooltip ----- */
    let tipShown = false;
    for (const l of lanterns) {
      if (Math.hypot(pointerX - l.x, pointerY - l.y) < 16) {
        const msg = `${l.name} · keeping the light on`;
        if (tipText.text !== msg) {
          tipText.text = msg;
          const w = tipText.width + 14;
          const h = tipText.height + 8;
          tipBg.clear();
          tipBg.roundRect(0, 0, w, h, 6).fill({ color: 0x07091a, alpha: 0.85 });
          tipText.position.set(7, 4);
        }
        tip.position.set(Math.min(pointerX + 12, app.screen.width - tipBg.width - 6), l.y - 34);
        tip.visible = true;
        tipShown = true;
        break;
      }
    }
    if (!tipShown) tip.visible = false;

    /* ----- chrome, toasts & camera ----- */
    chrome.update(realDt, app.screen.width, app.screen.height, player.progress, [
      ["level", `${Math.round(levelFrac * 100)}% full`],
      ["lanterns", lanterns.length],
      ["era", eraNum],
      ["drops", activeDrops],
    ]);
    toastsTop.update(realDt, chrome.contentWidth(app.screen.width), app.screen.height);
    if (!reducedMotion) shake.update(realDt, rng);
    world.position.set(shake.x, shake.y);

    hud.update(
      realDt,
      `drops ${activeDrops} · level ${(levelFrac * 100).toFixed(0)}% · era ${eraNum} ${(player.progress * 100).toFixed(0)}%${slowmo > 0 ? " · slow-mo" : ""}`,
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
        key: "dropSize",
        label: "drop size",
        kind: "range",
        min: 0.5,
        max: 2,
        step: 0.1,
        value: 1,
        set: (v) => {
          params.dropSize = v as number;
        },
      },
      {
        key: "splash",
        label: "splash power",
        kind: "range",
        min: 0.4,
        max: 2,
        step: 0.1,
        value: 1,
        set: (v) => {
          params.splash = v as number;
        },
      },
      {
        key: "maxFill",
        label: "max water level",
        kind: "range",
        min: 0.3,
        max: 0.9,
        step: 0.01,
        value: 0.73,
        set: (v) => {
          params.maxFill = v as number;
        },
      },
      {
        key: "slowmo",
        label: "merge slow-motion",
        kind: "toggle",
        value: true,
        set: (v) => {
          params.slowmo = v as boolean;
        },
      },
    ],
  };
}
