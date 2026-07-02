/**
 * Gource-style sketch over real repo history, after Andrew Caudwell's
 * Gource (gource.io). No code shared, just the anatomy: a force-directed
 * directory tree, files as extension-colored dots (add/modify/delete), contributors
 * flying to their work and beaming at the files they touch. The camera
 * auto-fits the tree. Adds the shared chrome, hover inspection, pause and
 * speed controls, and release markers from real tags.
 */
import { mulberry32, type Rng } from "@repomentary/artifact";
import {
  type ForceLink,
  forceCollide,
  forceLink,
  forceManyBody,
  forceSimulation,
  forceX,
  forceY,
  type SimulationLinkDatum,
  type SimulationNodeDatum,
} from "d3-force";
import { Container, Graphics, Sprite, Text, Texture } from "pixi.js";
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
  makeDotTexture,
  makeGlowTexture,
  makeRingTexture,
  requestRebuildSeek,
  type SketchInstance,
  Toasts,
  type Transport,
} from "./common";

const INK = 0xe8ecff;
const DELETE_RED = 0xff5d3a;
const PLAY_SECONDS = 300; // whole history at 1x

interface DirNode extends SimulationNodeDatum {
  kind: "dir";
  path: string;
  name: string;
  depth: number;
  parent: DirNode | null;
  childDirs: number;
  files: FileNode[];
  label: Text | null;
  hue: number;
  dying: number;
}

interface FileNode extends SimulationNodeDatum {
  kind: "file";
  pathIdx: number;
  dir: DirNode;
  color: number;
  sprite: Sprite;
  flash: number;
  dying: number;
  deleted: boolean;
  lastTouched: number;
  labelAge: number;
  label: Text | null;
}

type SimNode = DirNode | FileNode;
type SimLink = SimulationLinkDatum<SimNode>;

interface UserNode {
  author: number;
  name: string;
  color: number;
  glow: Sprite;
  core: Sprite;
  label: Text;
  x: number;
  y: number;
  tx: number;
  ty: number;
  lastSim: number;
  commits: number;
}

interface Beam {
  user: UserNode;
  file: FileNode;
  age: number;
}

/** hue [0,1) → rgb int (s=0.62, l=0.62), Gource-ish file palette. */
function hueColor(h: number, s = 0.62, l = 0.62): number {
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const f = (t0: number): number => {
    let t = t0;
    if (t < 0) t += 1;
    if (t > 1) t -= 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };
  const r = Math.round(f(h + 1 / 3) * 255);
  const g = Math.round(f(h) * 255);
  const b = Math.round(f(h - 1 / 3) * 255);
  return (r << 16) | (g << 8) | b;
}

function hashStr(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** Person silhouette (head + shoulders), the classic "who" icon. */
function makePersonTexture(size = 64): Texture {
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d");
  if (ctx) {
    ctx.fillStyle = "#ffffff";
    ctx.beginPath();
    ctx.arc(size / 2, size * 0.3, size * 0.18, 0, Math.PI * 2);
    ctx.fill();
    ctx.beginPath();
    ctx.ellipse(size / 2, size * 0.78, size * 0.3, size * 0.26, 0, Math.PI, 0);
    ctx.closePath();
    ctx.fill();
  }
  return Texture.from(canvas);
}

const extOf = (path: string): string => {
  const file = path.slice(path.lastIndexOf("/") + 1);
  const dot = file.lastIndexOf(".");
  return dot === -1 ? "" : file.slice(dot + 1);
};

export async function createSketch(
  host: HTMLElement,
  signal?: AbortSignal,
): Promise<SketchInstance> {
  const boot = await bootPixi(host, "#07091a");
  if (signal?.aborted) {
    boot.destroy();
    throw new DOMException("cancelled", "AbortError");
  }
  const { app, world, ui, hud, reducedMotion } = boot;

  const loadingText = new Text({
    text: `cloning history… (${REPO_DATASETS.find((d) => d.id === getDatasetId())?.label ?? "repo"})`,
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

  const rng: Rng = mulberry32(7);
  const params = {
    glow: 1,
    beams: 1,
    maxUsers: 14,
    fileLabels: true,
    dirLabelDepth: 2,
    fileLife: 0.04,
  };
  const glowTex = makeGlowTexture(64);
  const dotTex = makeDotTexture(16);
  const ringTex = makeRingTexture(128);
  const personTex = makePersonTexture(64);
  const governor = new FrameGovernor();
  const toastsTop = new Toasts(ui, "top", { fill: 0xffe9c2, fontSize: 16 });
  const chrome = new FilmChrome(ui, real.chromeHistory, {
    repoName: real.repo,
    accent: 0x8fd0ff,
    reducedMotion,
    clip: world,
    onSeek: (f) => seekTo(f),
  });

  /* ------------------------------ layer stack ------------------------------ */

  const edgeGfx = new Graphics();
  const beamGfx = new Graphics();
  beamGfx.blendMode = "add";
  const fileLayer = new Container();
  const fxLayer = new Container();
  const userLayer = new Container();
  const labelLayer = new Container();
  world.addChild(edgeGfx, beamGfx, fileLayer, fxLayer, userLayer, labelLayer);

  /* ------------------------------- tree model ------------------------------- */

  const dirs = new Map<string, DirNode>();
  const nodes: SimNode[] = [];
  const links: SimLink[] = [];

  const simulation = forceSimulation<SimNode>(nodes)
    .force(
      "link",
      forceLink<SimNode, SimLink>(links)
        .distance((l) => {
          const t = l.target as SimNode;
          // Files sit close to their dir (short leaf springs); dirs branch out.
          return t.kind === "file" ? 8 : 18 + 46 / (t.depth * 0.55 + 1);
        })
        .strength((l) => ((l.target as SimNode).kind === "file" ? 0.9 : 0.85)),
    )
    .force(
      "charge",
      // Files don't repel at all — collision alone stops overlap, so they pack
      // into a tight cluster on their hub instead of a wide sunburst. Dirs still
      // push apart hard so the tree branches read clearly.
      forceManyBody<SimNode>()
        .strength((n) => (n.kind === "file" ? 0 : -55))
        .theta(0.9)
        .distanceMax(300),
    )
    .force("collide", forceCollide<SimNode>((n) => (n.kind === "file" ? 3.4 : 9)).strength(1))
    .force("x", forceX<SimNode>(0).strength(0.012))
    .force("y", forceY<SimNode>(0).strength(0.012))
    .alphaDecay(0.015)
    .alphaTarget(0.05)
    .stop();

  // Batch sim rebuilds: many touchFile calls in one commit flush once per frame.
  let simDirty = false;
  const markSim = () => {
    simDirty = true;
  };
  const syncSim = () => {
    simulation.nodes(nodes);
    (simulation.force("link") as ForceLink<SimNode, SimLink>).links(links);
    simulation.alpha(Math.max(simulation.alpha(), 0.45));
  };

  const makeDirLabel = (name: string): Text => {
    const t = new Text({
      text: name,
      style: { fontFamily: "monospace", fontSize: 10, fill: INK },
    });
    t.anchor.set(0.5, 1);
    t.alpha = 0;
    labelLayer.addChild(t);
    return t;
  };

  const ensureDir = (dirPath: string): DirNode => {
    const existing = dirs.get(dirPath);
    if (existing) return existing;
    const slash = dirPath.lastIndexOf("/");
    const parentPath = slash === -1 ? "" : dirPath.slice(0, slash);
    const name = dirPath === "" ? (real.repo.split("/")[1] ?? "root") : dirPath.slice(slash + 1);
    const parent = dirPath === "" ? null : ensureDir(parentPath);
    const angle = (hashStr(dirPath) % 6283) / 1000;
    const dist = parent ? 30 : 0;
    const node: DirNode = {
      kind: "dir",
      path: dirPath,
      name,
      depth: parent ? parent.depth + 1 : 0,
      parent,
      childDirs: 0,
      files: [],
      label: null,
      hue: (hashStr(dirPath.split("/")[0] ?? "") % 360) / 360,
      dying: 0,
      x: (parent?.x ?? 0) + Math.cos(angle) * dist,
      y: (parent?.y ?? 0) + Math.sin(angle) * dist,
    };
    node.label = makeDirLabel(name);
    dirs.set(dirPath, node);
    nodes.push(node);
    if (parent) {
      parent.childDirs++;
      links.push({ source: parent, target: node });
    }
    markSim();
    return node;
  };

  const removeDirIfEmpty = (dir: DirNode) => {
    if (dir.path === "" || dir.files.length > 0 || dir.childDirs > 0 || dir.dying > 0) return;
    dir.dying = 0.001;
  };

  /* ------------------------------- file model ------------------------------- */

  const files = new Map<number, FileNode>();
  const fileLabelBudget = 12;
  let activeFileLabels = 0;

  const touchFile = (pathIdx: number, op: 0 | 1 | 2): FileNode | null => {
    const path = real.paths[pathIdx];
    if (!path) return null;
    let f = files.get(pathIdx);

    if (op === 2) {
      if (f && f.dying === 0) {
        f.dying = 0.001;
        f.deleted = true;
        f.sprite.tint = DELETE_RED;
        f.flash = 1;
      }
      return f ?? null;
    }

    if (!f || f.dying > 0) {
      const slash = path.lastIndexOf("/");
      const dir = ensureDir(slash === -1 ? "" : path.slice(0, slash));
      const sprite = new Sprite(dotTex);
      sprite.anchor.set(0.5);
      const ext = extOf(path);
      const color = hueColor((hashStr(ext) % 360) / 360);
      sprite.tint = color;
      sprite.scale.set(0.06);
      fileLayer.addChild(sprite);
      const jitter = () => (Math.random() - 0.5) * 16;
      f = {
        kind: "file",
        pathIdx,
        dir,
        color,
        sprite,
        flash: 1,
        dying: 0,
        deleted: false,
        lastTouched: simSec,
        labelAge: 99,
        label: null,
        x: (dir.x ?? 0) + jitter(),
        y: (dir.y ?? 0) + jitter(),
      };
      dir.files.push(f);
      files.set(pathIdx, f);
      nodes.push(f);
      links.push({ source: dir, target: f });
      markSim();
    } else {
      f.flash = 1;
      f.lastTouched = simSec;
    }

    // Briefly label touched files (budgeted).
    if (f.label === null && params.fileLabels && activeFileLabels < fileLabelBudget) {
      const t = new Text({
        text: path.slice(path.lastIndexOf("/") + 1),
        style: { fontFamily: "monospace", fontSize: 9, fill: 0xc9d4ff },
      });
      t.anchor.set(0, 0.5);
      labelLayer.addChild(t);
      f.label = t;
      activeFileLabels++;
    }
    f.labelAge = 0;
    return f;
  };

  /* ------------------------------- user model ------------------------------- */

  const users = new Map<number, UserNode>();
  const beams: Beam[] = [];

  const evictIdlest = () => {
    if (users.size <= params.maxUsers) return;
    let idlest: UserNode | null = null;
    for (const u of users.values()) {
      if (!idlest || u.lastSim < idlest.lastSim) idlest = u;
    }
    if (idlest) {
      idlest.glow.destroy();
      idlest.core.destroy();
      idlest.label.destroy();
      users.delete(idlest.author);
    }
  };

  const ensureUser = (author: number): UserNode => {
    let u = users.get(author);
    if (u) return u;
    const name = real.authors[author] ?? "anon";
    const color = hueColor((hashStr(name) % 360) / 360, 0.55, 0.7);
    const glow = new Sprite(glowTex);
    glow.anchor.set(0.5);
    glow.blendMode = "add";
    glow.tint = color;
    glow.scale.set(0.95 * Math.max(0.4, params.glow));
    const core = new Sprite(personTex);
    core.anchor.set(0.5);
    core.tint = hueColor((hashStr(name) % 360) / 360, 0.45, 0.85);
    core.scale.set(0.36);
    userLayer.addChild(glow, core);
    const label = new Text({
      text: name,
      style: { fontFamily: "monospace", fontSize: 11, fontWeight: "bold", fill: INK },
    });
    label.anchor.set(0.5, 0);
    label.alpha = 0.95;
    labelLayer.addChild(label);
    const angle = rng() * Math.PI * 2;
    u = {
      author,
      name,
      color,
      glow,
      core,
      label,
      x: Math.cos(angle) * 260,
      y: Math.sin(angle) * 260,
      tx: 0,
      ty: 0,
      lastSim: 0,
      commits: 0,
    };
    users.set(author, u);
    evictIdlest();
    return u;
  };

  /* ------------------------------ fx (releases) ------------------------------ */

  const pulses: { sprite: Sprite; age: number; active: boolean }[] = [];
  const rootPulse = () => {
    let p = pulses.find((q) => !q.active);
    if (!p) {
      if (pulses.length >= 6) return;
      const sprite = new Sprite(ringTex);
      sprite.anchor.set(0.5);
      sprite.blendMode = "add";
      sprite.tint = 0x8fd0ff;
      fxLayer.addChild(sprite);
      p = { sprite, age: 0, active: false };
      pulses.push(p);
    }
    p.active = true;
    p.age = 0;
    p.sprite.visible = true;
  };

  /* ------------------------------- playback -------------------------------- */

  let simSec = 0;
  let speed = 1;
  let paused = false;
  let labelsOn = true;
  let commitCursor = 0;
  let chromeCursor = 0;
  let tagCursor = 0;

  // Forward scrubs fast-process in place; backward scrubs rebuild the tree.
  function seekTo(frac: number): void {
    const t = clamp01(frac) * real.spanSec;
    if (t >= simSec) {
      simSec = t;
      processUpTo(simSec);
    } else {
      requestRebuildSeek(frac);
    }
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
    finished: () => simSec >= real.spanSec,
    progress: () => clamp01(simSec / real.spanSec),
    seek: seekTo,
    reset: () => requestRebuildSeek(0),
  };

  const pausedBadge = new Text({
    text: "⏸ paused",
    style: { fontFamily: "monospace", fontSize: 14, fill: INK },
  });
  pausedBadge.anchor.set(0.5);
  pausedBadge.visible = false;
  ui.addChild(pausedBadge);

  const resetWorld = () => {
    for (const f of files.values()) {
      f.sprite.destroy();
      f.label?.destroy();
    }
    files.clear();
    activeFileLabels = 0;
    for (const u of users.values()) {
      u.glow.destroy();
      u.core.destroy();
      u.label.destroy();
    }
    users.clear();
    for (const d of dirs.values()) d.label?.destroy();
    dirs.clear();
    nodes.length = 0;
    links.length = 0;
    syncSim();
    beams.length = 0;
    commitCursor = 0;
    chromeCursor = 0;
    tagCursor = 0;
    chrome.reset();
    ensureDir("");
  };
  ensureDir("");

  const processUpTo = (target: number) => {
    // Chrome events (feed, counters, leaderboard).
    const events = real.chromeHistory.events;
    while (chromeCursor < events.length) {
      const e = events[chromeCursor];
      if (!e || e.t > target) break;
      chrome.onEvent(e);
      chromeCursor++;
    }
    // Tags → toasts + root pulse.
    while (tagCursor < real.tags.length) {
      const tag = real.tags[tagCursor];
      if (!tag || tag.t > target) break;
      rootPulse();
      tagCursor++;
    }
    // Real commits → tree + beams.
    let processed = 0;
    while (commitCursor < real.commits.length && processed < 240) {
      const c = real.commits[commitCursor];
      if (!c || c.t > target) break;
      commitCursor++;
      processed++;
      const u = ensureUser(c.author);
      u.commits++;
      u.lastSim = target;
      let cx2 = 0;
      let cy2 = 0;
      let n = 0;
      const beamEvery = Math.max(1, Math.ceil(c.changes.length / (10 * params.beams)));
      for (let ci = 0; ci < c.changes.length; ci++) {
        const change = c.changes[ci];
        if (!change) continue;
        const f = touchFile(change[1], change[0]);
        if (f) {
          cx2 += f.x ?? 0;
          cy2 += f.y ?? 0;
          n++;
          if (ci % beamEvery === 0 && beams.length < 150 * params.beams) {
            beams.push({ user: u, file: f, age: 0 });
          }
        }
      }
      if (n > 0) {
        u.tx = cx2 / n;
        u.ty = cy2 / n;
      }
    }
    if (commitCursor >= real.commits.length && simSec >= real.spanSec) {
      simSec = 0;
      resetWorld();
    }
  };

  /* ------------------------------- interaction ------------------------------- */

  let pointerX = -9999;
  let pointerY = -9999;
  app.stage.eventMode = "static";
  app.stage.hitArea = app.screen;
  app.stage.on("pointermove", (ev: { global: { x: number; y: number } }) => {
    pointerX = ev.global.x;
    pointerY = ev.global.y;
  });
  const onKey = (ev: KeyboardEvent) => {
    if (ev.code === "Space") {
      ev.preventDefault();
      paused = !paused;
    } else if (ev.code === "ArrowUp") {
      speed = Math.min(8, speed * 1.5);
    } else if (ev.code === "ArrowDown") {
      speed = Math.max(0.25, speed / 1.5);
    } else if (ev.code === "KeyT") {
      labelsOn = !labelsOn;
    }
  };
  window.addEventListener("keydown", onKey);

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
      tipBg.roundRect(0, 0, w, h, 6).fill({ color: 0x07091a, alpha: 0.88 });
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

  let zoom = 0.9;
  let camX = 0;
  // A backward scrub rebuilt us, fast-forward to where the user pointed.
  {
    const resume = consumePendingSeek();
    if (resume !== null && resume > 0) {
      simSec = resume * real.spanSec;
      processUpTo(simSec);
    }
  }

  let camY = 0;

  const tick = () => {
    const dtMs = Math.min(app.ticker.deltaMS, 50);
    governor.update(dtMs);

    if (!paused) {
      simSec += (dtMs / 1000) * (real.spanSec / PLAY_SECONDS) * speed;
      processUpTo(simSec);
    }
    const progress = clamp01(simSec / real.spanSec);

    if (simDirty) {
      syncSim();
      simDirty = false;
    }
    simulation.tick();

    /* ----- dirs: edges + labels + decay ----- */
    edgeGfx.clear();
    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;
    for (let i = nodes.length - 1; i >= 0; i--) {
      const d = nodes[i];
      if (!d) continue;
      if (d.kind !== "dir") continue; // files are handled in the file loop
      if (d.dying > 0) {
        d.dying += dtMs / 600;
        if (d.dying >= 1) {
          // remove node + its link
          d.label?.destroy();
          dirs.delete(d.path);
          nodes.splice(i, 1);
          const li = links.findIndex((l) => l.target === d);
          if (li !== -1) links.splice(li, 1);
          if (d.parent) {
            d.parent.childDirs--;
            removeDirIfEmpty(d.parent);
          }
          syncSim();
          continue;
        }
      }
      const x = d.x ?? 0;
      const y = d.y ?? 0;
      minX = Math.min(minX, x);
      maxX = Math.max(maxX, x);
      minY = Math.min(minY, y);
      maxY = Math.max(maxY, y);
      const dirFade = d.dying > 0 ? 1 - d.dying : 1;
      if (d.parent) {
        edgeGfx
          .moveTo(d.parent.x ?? 0, d.parent.y ?? 0)
          .lineTo(x, y)
          .stroke({ color: hueColor(d.hue, 0.4, 0.5), alpha: 0.34 * dirFade, width: 1.2 });
      }
      // Hub: a soft disc whose size grows with the folder's file count.
      const hubR = 2 + Math.sqrt(d.files.length) * 1.7;
      edgeGfx.circle(x, y, hubR).fill({ color: hueColor(d.hue, 0.5, 0.55), alpha: 0.12 * dirFade });
      if (d.label) {
        const show =
          labelsOn && d.depth <= params.dirLabelDepth && (d.files.length > 0 || d.childDirs > 0);
        d.label.alpha += ((show ? 0.75 : 0) - d.label.alpha) * Math.min(1, dtMs / 300);
        d.label.position.set(x, y - 8);
        d.label.scale.set(Math.min(1.2, 1 / zoom) * (d.depth === 0 ? 1.25 : 1));
      }
    }

    /* ----- files ----- */
    const fileTtl = real.spanSec * params.fileLife;
    for (const f of files.values()) {
      f.flash = Math.max(0, f.flash - dtMs / 900);
      const fx = f.x ?? 0;
      const fy = f.y ?? 0;
      // Idle files fade out and get reclaimed (keeps the active tree small,
      // like Gource's file-idle-time — this is the perf + zoom fix).
      if (f.dying === 0 && simSec - f.lastTouched > fileTtl) f.dying = 0.001;
      if (f.dying > 0) {
        // Deletes flash red and vanish fast; idle files fade out gently.
        f.dying += f.deleted ? dtMs / 260 : dtMs / 900;
        if (f.dying >= 1) {
          f.sprite.destroy();
          f.label?.destroy();
          if (f.label) activeFileLabels--;
          const idx = f.dir.files.indexOf(f);
          if (idx !== -1) f.dir.files.splice(idx, 1);
          const ni = nodes.indexOf(f);
          if (ni !== -1) nodes.splice(ni, 1);
          const lfi = links.findIndex((l) => l.target === f);
          if (lfi !== -1) links.splice(lfi, 1);
          files.delete(f.pathIdx);
          markSim();
          removeDirIfEmpty(f.dir);
          continue;
        }
        f.sprite.alpha = 1 - f.dying;
      } else {
        f.sprite.alpha = 0.92;
      }
      const target = 0.18 + Math.min(0.1, f.dir.files.length * 0.001) + f.flash * 0.3;
      f.sprite.scale.set(f.sprite.scale.x + (target - f.sprite.scale.x) * Math.min(1, dtMs / 110));
      f.sprite.position.set(fx, fy);
      f.sprite.tint = f.deleted ? DELETE_RED : f.flash > 0.8 ? 0xffffff : f.color;
      minX = Math.min(minX, fx);
      maxX = Math.max(maxX, fx);
      minY = Math.min(minY, fy);
      maxY = Math.max(maxY, fy);
      // Leaf edge: files dangle off their directory like Gource's leaves.
      const leafFade = f.dying > 0 ? 1 - f.dying : 1;
      edgeGfx
        .moveTo(f.dir.x ?? 0, f.dir.y ?? 0)
        .lineTo(fx, fy)
        .stroke({ color: f.color, alpha: (0.13 + f.flash * 0.25) * leafFade, width: 0.8 });
      if (f.label) {
        f.labelAge += dtMs / 1000;
        if (f.labelAge > 1.0) {
          f.label.destroy();
          f.label = null;
          activeFileLabels--;
        } else {
          f.label.position.set(fx + 6, fy);
          f.label.alpha = (labelsOn ? 0.85 : 0.4) * (1 - f.labelAge / 1.0);
          f.label.scale.set(Math.min(1.4, 1 / zoom));
        }
      }
    }

    /* ----- users ----- */
    for (const u of users.values()) {
      const idle = simSec - u.lastSim;
      const idleFrac = idle / real.spanSec;
      if (idleFrac > 0.025) {
        u.glow.destroy();
        u.core.destroy();
        u.label.destroy();
        users.delete(u.author);
        continue;
      }
      const ease = Math.min(1, dtMs / 280);
      u.x += (u.tx - u.x) * ease;
      u.y += (u.ty - u.y) * ease;
      const fade = idleFrac > 0.008 ? Math.max(0, 1 - (idleFrac - 0.008) / 0.017) : 1;
      u.glow.position.set(u.x, u.y);
      u.glow.alpha = 0.4 * fade * params.glow;
      u.core.position.set(u.x, u.y);
      u.core.alpha = fade;
      u.label.position.set(u.x, u.y + 14);
      u.label.alpha = (labelsOn ? 0.85 : 0) * fade;
      u.label.scale.set(Math.min(1.3, 1 / zoom));
    }

    /* ----- beams ----- */
    beamGfx.clear();
    for (let i = beams.length - 1; i >= 0; i--) {
      const b = beams[i];
      if (!b) continue;
      b.age += dtMs;
      const k = b.age / 380;
      if (k >= 1 || b.file.dying >= 1) {
        beams.splice(i, 1);
        continue;
      }
      const bfx = b.file.x ?? 0;
      const bfy = b.file.y ?? 0;
      beamGfx
        .moveTo(b.user.x, b.user.y)
        .lineTo(bfx, bfy)
        .stroke({
          color: b.user.color,
          alpha: (1 - k) * 0.55 * Math.min(1.5, params.glow),
          width: 2,
        });
      // Spark racing from the contributor to the file.
      const sx = b.user.x + (bfx - b.user.x) * k;
      const sy = b.user.y + (bfy - b.user.y) * k;
      beamGfx
        .circle(sx, sy, 2.6 / Math.max(0.35, zoom))
        .fill({ color: 0xffffff, alpha: (1 - k) * Math.min(1, params.glow) });
    }

    /* ----- release pulses ----- */
    for (const p of pulses) {
      if (!p.active) continue;
      p.age += dtMs;
      const k = p.age / 1200;
      if (k >= 1) {
        p.active = false;
        p.sprite.visible = false;
        continue;
      }
      p.sprite.position.set(0, 0);
      p.sprite.scale.set(0.5 + k * (6 / Math.max(0.2, zoom)) * 0.5);
      p.sprite.alpha = 0.7 * (1 - k);
    }

    /* ----- camera: fit the living tree ----- */
    if (Number.isFinite(minX)) {
      const margin = 70;
      const bw = Math.max(120, maxX - minX + margin * 2);
      const bh = Math.max(120, maxY - minY + margin * 2);
      const cw = chrome.contentWidth(app.screen.width);
      const ch = chrome.contentHeight(app.screen.height);
      const targetZoom = Math.max(0.3, Math.min(1.6, Math.min(cw / bw, ch / bh)));
      const targetX = (minX + maxX) / 2;
      const targetY = (minY + maxY) / 2;
      const ease = Math.min(1, dtMs / 900);
      zoom += (targetZoom - zoom) * ease;
      camX += (targetX - camX) * ease;
      camY += (targetY - camY) * ease;
    }
    world.scale.set(zoom);
    world.position.set(
      chrome.contentWidth(app.screen.width) / 2 - camX * zoom,
      chrome.contentHeight(app.screen.height) / 2 - camY * zoom,
    );

    /* ----- hover ----- */
    let tipMsg: string | null = null;
    if (pointerX > -999 && pointerX < chrome.contentWidth(app.screen.width)) {
      const wx = (pointerX - world.position.x) / zoom;
      const wy = (pointerY - world.position.y) / zoom;
      const r = 9 / zoom;
      for (const u of users.values()) {
        if (Math.hypot(wx - u.x, wy - u.y) < r + 4) {
          tipMsg = `${u.name} · ${u.commits} commits this run`;
          break;
        }
      }
      if (!tipMsg) {
        for (const f of files.values()) {
          if (Math.hypot(wx - (f.x ?? 0), wy - (f.y ?? 0)) < r) {
            tipMsg = real.paths[f.pathIdx] ?? null;
            break;
          }
        }
      }
      if (!tipMsg) {
        for (const d of nodes) {
          if (d.kind !== "dir") continue;
          if (Math.hypot(wx - (d.x ?? 0), wy - (d.y ?? 0)) < r + 3) {
            tipMsg = `${d.path === "" ? "(root)" : `${d.path}/`} · ${d.files.length} files`;
            break;
          }
        }
      }
    }
    setTip(tipMsg);

    /* ----- chrome & hud ----- */
    chrome.update(dtMs, app.screen.width, app.screen.height, progress, [
      ["files", files.size],
      ["dirs", dirs.size],
      ["devs now", users.size],
      ["speed", `${speed.toFixed(2).replace(/\.?0+$/, "")}×`],
    ]);
    toastsTop.update(dtMs, chrome.contentWidth(app.screen.width), app.screen.height);
    pausedBadge.visible = paused;
    pausedBadge.position.set(
      chrome.contentWidth(app.screen.width) / 2,
      chrome.contentHeight(app.screen.height) - 24,
    );

    hud.update(
      dtMs,
      `${files.size} files · ${dirs.size} dirs · ${users.size} devs · ${beams.length} beams`,
    );
  };

  app.ticker.add(tick);

  return {
    destroy() {
      window.removeEventListener("keydown", onKey);
      simulation.stop();
      boot.destroy();
    },
    transport,
    capture: makeCaptureHandle(app, {
      title: real.repo,
      history: real.chromeHistory,
      accent: 0x8fd0ff,
      setChromeHidden: (b) => chrome.setHidden(b),
      setHudVisible: (b) => hud.setVisible(b),
      setLabels: (b) => {
        labelsOn = b;
      },
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
        key: "beams",
        label: "beam density",
        kind: "range",
        min: 0.2,
        max: 2,
        step: 0.1,
        value: 1,
        set: (v) => {
          params.beams = v as number;
        },
      },
      {
        key: "maxUsers",
        label: "contributors on stage",
        kind: "range",
        min: 4,
        max: 30,
        step: 1,
        value: 14,
        set: (v) => {
          params.maxUsers = v as number;
        },
      },
      {
        key: "fileLabels",
        label: "file labels",
        kind: "toggle",
        value: true,
        set: (v) => {
          params.fileLabels = v as boolean;
        },
      },
      {
        key: "dirLabelDepth",
        label: "folder label depth",
        kind: "range",
        min: 0,
        max: 5,
        step: 1,
        value: 2,
        set: (v) => {
          params.dirLabelDepth = v as number;
        },
      },
      {
        key: "fileLife",
        label: "file lifetime",
        kind: "range",
        min: 0.01,
        max: 0.2,
        step: 0.01,
        value: 0.04,
        set: (v) => {
          params.fileLife = v as number;
        },
      },
    ],
  };
}
