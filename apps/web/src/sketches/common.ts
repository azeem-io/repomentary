import type { RepoEvent, Rng, SyntheticHistory } from "@repomentary/artifact";
import { Application, Color, Container, Graphics, Rectangle, Text, Texture } from "pixi.js";

/** A live-tunable parameter a sketch exposes to the host's control panel. */
export interface SketchControl {
  key: string;
  label: string;
  kind: "range" | "toggle" | "enum";
  min?: number;
  max?: number;
  step?: number;
  /** For kind "enum": selectable options, rendered as segmented buttons. */
  options?: { label: string; value: number }[];
  value: number | boolean;
  set: (v: number | boolean) => void;
}

/** Contract every sketch module fulfils. */
export interface SketchInstance {
  destroy(): void;
  /** Optional fine-tuning knobs, rendered by SketchHost. */
  controls?: SketchControl[];
  /** Optional playback transport (pause / fast-forward / scrub / reset). */
  transport?: Transport;
  /** Optional export hook: render frames at any size, toggle chrome, badge. */
  capture?: CaptureHandle;
}

export interface SketchBoot {
  app: Application;
  /** Camera-transformed scene content. */
  world: Container;
  /** Screen-space overlay (HUD, labels). */
  ui: Container;
  hud: Hud;
  reducedMotion: boolean;
  rendererName: string;
  /** Tear down app + listeners. Safe to call twice. */
  destroy(): void;
}

/** Boots a Pixi v8 application into `host` with sensible defaults. */
export async function bootPixi(host: HTMLElement, background: string): Promise<SketchBoot> {
  const app = new Application();
  await app.init({
    resizeTo: host,
    background,
    antialias: true,
    preference: "webgpu", // falls back to WebGL automatically
    resolution: Math.min(globalThis.devicePixelRatio ?? 1, 2),
    autoDensity: true,
  });
  host.appendChild(app.canvas);

  const world = new Container();
  const ui = new Container();
  app.stage.addChild(world, ui);

  const reducedMotion =
    globalThis.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;

  const rendererName = (app.renderer as unknown as { name?: string }).name ?? "webgl";
  const hud = new Hud(ui, rendererName, reducedMotion);

  let destroyed = false;
  const destroy = () => {
    if (destroyed) return;
    destroyed = true;
    app.destroy(true, { children: true });
  };

  return { app, world, ui, hud, reducedMotion, rendererName, destroy };
}

/* ------------------------------ textures ------------------------------ */

/** Soft radial glow (white → transparent). Tint per-sprite for color. */
export function makeGlowTexture(size = 64): Texture {
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d");
  if (ctx) {
    const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
    g.addColorStop(0, "rgba(255,255,255,1)");
    g.addColorStop(0.35, "rgba(255,255,255,0.55)");
    g.addColorStop(1, "rgba(255,255,255,0)");
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, size, size);
  }
  return Texture.from(canvas);
}

/** Thin luminous ring, shockwaves, halos. Tint per-sprite. */
export function makeRingTexture(size = 128): Texture {
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d");
  if (ctx) {
    const r = size / 2 - 4;
    const grad = ctx.createRadialGradient(size / 2, size / 2, r * 0.82, size / 2, size / 2, r);
    grad.addColorStop(0, "rgba(255,255,255,0)");
    grad.addColorStop(0.75, "rgba(255,255,255,0.9)");
    grad.addColorStop(1, "rgba(255,255,255,0)");
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.arc(size / 2, size / 2, r, 0, Math.PI * 2);
    ctx.fill();
  }
  return Texture.from(canvas);
}

/** Hard-ish dot with a feathered edge, ink droplets, star cores. */
export function makeDotTexture(size = 32): Texture {
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d");
  if (ctx) {
    const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
    g.addColorStop(0, "rgba(255,255,255,1)");
    g.addColorStop(0.8, "rgba(255,255,255,1)");
    g.addColorStop(1, "rgba(255,255,255,0)");
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, size, size);
  }
  return Texture.from(canvas);
}

/* -------------------------------- HUD --------------------------------- */

export class Hud {
  private text: Text;
  private frames = 0;
  private elapsed = 0;
  private fps = 0;
  private extra = "";
  private base: string;

  constructor(ui: Container, rendererName: string, reducedMotion: boolean) {
    this.text = new Text({
      text: "",
      style: {
        fontFamily: "monospace",
        fontSize: 12,
        fill: 0xffffff,
        align: "left",
      },
    });
    this.text.alpha = 0.55;
    // Below the page-header chips so nothing overlaps it.
    this.text.position.set(12, 56);
    ui.addChild(this.text);
    this.base = `${rendererName}${reducedMotion ? " · reduced motion" : ""}`;
  }

  /** Hide/show the readout (export-clean frames). */
  setVisible(v: boolean): void {
    this.text.visible = v;
  }

  /** Call once per frame. */
  update(dtMs: number, extra?: string): void {
    this.frames++;
    this.elapsed += dtMs;
    if (extra !== undefined) this.extra = extra;
    if (this.elapsed >= 250) {
      this.fps = (this.frames / this.elapsed) * 1000;
      this.frames = 0;
      this.elapsed = 0;
      this.text.text = `${this.fps.toFixed(0)} fps · ${this.base}${this.extra ? ` · ${this.extra}` : ""}`;
    }
  }
}

/* --------------------------- frame governor ---------------------------- */

/**
 * Auto-degrades quality when sustained fps dips below target.
 * Only steps down (never up) to avoid oscillation. Sketches read `scale`
 * to size particle budgets.
 */
export class FrameGovernor {
  scale = 1;
  private window: number[] = [];
  private cooldown = 0;
  private readonly levels = [1, 0.7, 0.5, 0.35];
  private level = 0;

  update(dtMs: number): boolean {
    this.cooldown = Math.max(0, this.cooldown - dtMs);
    this.window.push(dtMs);
    if (this.window.length > 120) this.window.shift();
    if (this.window.length < 120 || this.cooldown > 0) return false;
    const avg = this.window.reduce((a, b) => a + b, 0) / this.window.length;
    const fps = 1000 / avg;
    if (fps < 45 && this.level < this.levels.length - 1) {
      this.level++;
      this.scale = this.levels[this.level] ?? 0.35;
      this.cooldown = 4000;
      this.window = [];
      return true;
    }
    return false;
  }
}

/* ------------------------------ camera --------------------------------- */

export class CameraShake {
  x = 0;
  y = 0;
  private energy = 0;

  kick(strength: number): void {
    this.energy = Math.min(1.5, this.energy + strength);
  }

  update(dtMs: number, rng: Rng): void {
    if (this.energy <= 0.001) {
      this.energy = 0;
      this.x = 0;
      this.y = 0;
      return;
    }
    const amplitude = this.energy * 14;
    this.x = (rng() * 2 - 1) * amplitude;
    this.y = (rng() * 2 - 1) * amplitude;
    this.energy *= Math.exp(-dtMs / 180);
  }
}

/* --------------------------- event playback ---------------------------- */

/**
 * Walks a SyntheticHistory in real time (speed = history units per second),
 * looping forever. Calls `onLoop` when the timeline wraps so scenes can
 * soft-reset their accumulated state.
 */
/** Playback controls every film exposes to the host UI. */
export interface Transport {
  paused(): boolean;
  toggle(): void;
  /** Current fast-forward multiplier. */
  speed(): number;
  /** 1× → 2× → 4× → 8× → 1×. Returns the new multiplier. */
  cycleSpeed(): number;
  /** True once the history has fully played; playback stops until reset. */
  finished(): boolean;
  progress(): number;
  /** Jump anywhere on the timeline (0..1). Backward jumps rebuild. */
  seek(frac: number): void;
  reset(): void;
}

// Backward seeks tear the sketch down; the replacement instance reads this
// to fast-forward to the requested spot. Kept (not cleared) for a short
// window because StrictMode constructs the sketch twice in dev.
let pendingSeek: { frac: number; at: number } | null = null;

export const requestRebuildSeek = (frac: number): void => {
  pendingSeek = { frac: clamp01(frac), at: performance.now() };
  window.dispatchEvent(new CustomEvent("repomentary:rebuild"));
};

export const consumePendingSeek = (): number | null => {
  if (!pendingSeek) return null;
  if (performance.now() - pendingSeek.at > 4000) {
    pendingSeek = null;
    return null;
  }
  return pendingSeek.frac;
};

export class EventPlayer {
  private clock = 0;
  private cursor = 0;
  private mul = 1;
  private isPaused = false;
  private done = false;
  /** Events queued by a seek, drained on the next update (even while paused). */
  private burst: RepoEvent[] = [];

  constructor(
    private history: SyntheticHistory,
    private speed: number,
  ) {
    const resume = consumePendingSeek();
    if (resume !== null) this.jumpTo(resume);
  }

  /** Fast-forward to a fraction of the timeline, queueing skipped events. */
  private jumpTo(frac: number): void {
    const t = clamp01(frac) * this.history.duration;
    if (t < this.clock) return; // backward jumps go through requestRebuildSeek
    while (this.cursor < this.history.events.length) {
      const e = this.history.events[this.cursor];
      if (!e || e.t > t) break;
      this.burst.push(e);
      this.cursor++;
    }
    this.clock = t;
    if (this.clock >= this.history.duration) this.done = true;
  }

  /** Advances time and returns events that fired this frame. */
  update(dtMs: number): RepoEvent[] {
    const fired: RepoEvent[] = this.burst.length > 0 ? this.burst.splice(0) : [];
    if (this.isPaused || this.done) return fired;
    this.clock += (dtMs / 1000) * this.speed * this.mul;
    if (this.clock >= this.history.duration) {
      // end of history: flush the tail and stop
      this.clock = this.history.duration;
      this.done = true;
    }
    while (this.cursor < this.history.events.length) {
      const e = this.history.events[this.cursor];
      if (!e || e.t > this.clock) break;
      fired.push(e);
      this.cursor++;
    }
    return fired;
  }

  get progress(): number {
    return this.clock / this.history.duration;
  }

  /** Host-facing playback controls for this player. */
  transport(): Transport {
    return {
      paused: () => this.isPaused,
      toggle: () => {
        this.isPaused = !this.isPaused;
      },
      speed: () => this.mul,
      cycleSpeed: () => {
        this.mul = this.mul >= 8 ? 1 : this.mul * 2;
        return this.mul;
      },
      finished: () => this.done,
      progress: () => this.progress,
      seek: (frac: number) => {
        if (clamp01(frac) * this.history.duration >= this.clock) this.jumpTo(frac);
        else requestRebuildSeek(frac);
      },
      reset: () => requestRebuildSeek(0),
    };
  }
}

/* ------------------------------- toasts -------------------------------- */

interface Toast {
  text: Text;
  age: number;
  dur: number;
  slot: number;
  active: boolean;
}

/**
 * Slot-stacked fading messages so simultaneous announcements never overlap.
 * `anchor: "top"` stacks downward from baseY; `"bottom"` stacks upward.
 */
export class Toasts {
  private pool: Toast[] = [];
  private readonly lineHeight = 26;

  constructor(
    private ui: Container,
    private anchor: "top" | "bottom",
    private opts: { fill?: number; fontSize?: number; max?: number } = {},
  ) {}

  announce(message: string, dur = 2400): void {
    const max = this.opts.max ?? 5;
    let toast = this.pool.find((t) => !t.active);
    if (!toast) {
      if (this.pool.length >= max) return;
      const text = new Text({
        text: "",
        style: {
          fontFamily: "monospace",
          fontSize: this.opts.fontSize ?? 15,
          fill: this.opts.fill ?? 0xffffff,
          align: "center",
        },
      });
      text.anchor.set(0.5, 0);
      text.visible = false;
      this.ui.addChild(text);
      toast = { text, age: 0, dur, slot: 0, active: false };
      this.pool.push(toast);
    }
    // Lowest free slot → stable stacking.
    const used = new Set(this.pool.filter((t) => t.active).map((t) => t.slot));
    let slot = 0;
    while (used.has(slot)) slot++;
    toast.slot = slot;
    toast.active = true;
    toast.age = 0;
    toast.dur = dur;
    toast.text.text = message;
    toast.text.visible = true;
    toast.text.alpha = 0;
  }

  /** Call once per frame with the current screen size. */
  update(dtMs: number, screenW: number, screenH: number): void {
    const baseY = this.anchor === "top" ? 56 : screenH - 56;
    for (const t of this.pool) {
      if (!t.active) continue;
      t.age += dtMs;
      const k = clamp01(t.age / t.dur);
      if (k >= 1) {
        t.active = false;
        t.text.visible = false;
        continue;
      }
      const dir = this.anchor === "top" ? 1 : -1;
      t.text.position.set(screenW / 2, baseY + dir * t.slot * this.lineHeight);
      t.text.alpha = k < 0.15 ? k / 0.15 : k > 0.7 ? (1 - k) / 0.3 : 1;
    }
  }
}

/* ------------------------------- easing -------------------------------- */

export const easeOutCubic = (x: number): number => 1 - (1 - x) ** 3;
export const easeOutBack = (x: number): number => {
  const c1 = 1.70158;
  const c3 = c1 + 1;
  return 1 + c3 * (x - 1) ** 3 + c1 * (x - 1) ** 2;
};
export const clamp01 = (x: number): number => Math.min(1, Math.max(0, x));

/* ------------------------------ export -------------------------------- */

/** In-canvas elements the export dialog can hide for a clean frame. */
export interface ExportUi {
  /** FilmChrome: sidebar, timeline, date tape. */
  chrome: boolean;
  /** fps / renderer readout. */
  hud: boolean;
  /** In-view labels. */
  labels: boolean;
}

/** A minimal, cinematic caption layer drawn only for exports. */
export interface BadgeOptions {
  show: boolean;
  date: boolean;
  title: boolean;
  wordmark: boolean;
  permalink: boolean;
  progress: boolean;
  permalinkText: string;
  accent: number;
}

const DEFAULT_BADGE: BadgeOptions = {
  show: false,
  date: true,
  title: true,
  wordmark: true,
  permalink: false,
  progress: true,
  permalinkText: "",
  accent: 0xffffff,
};

/**
 * Optional caption layer for exports: date, repo title, a progress bar, and
 * a small wordmark / permalink. Lives above the scene so `extract` captures
 * it. Hidden until the export dialog turns parts on.
 */
export class ExportBadge extends Container {
  private gfx = new Graphics();
  private dateText: Text;
  private titleText: Text;
  private markText: Text;
  private linkText: Text;
  private opts: BadgeOptions;

  constructor(accent: number, title: string) {
    super();
    this.opts = { ...DEFAULT_BADGE, accent };
    const mono = (size: number, fill: number, weight: "normal" | "bold" = "normal"): Text => {
      const t = new Text({
        text: "",
        style: { fontFamily: "monospace", fontSize: size, fill, fontWeight: weight },
      });
      this.addChild(t);
      return t;
    };
    this.addChild(this.gfx);
    this.dateText = mono(26, 0xffffff, "bold");
    this.titleText = mono(15, 0xffffff);
    this.markText = mono(15, accent, "bold");
    this.markText.text = "repomentary";
    this.linkText = mono(12, 0xb9c0e6);
    this.titleText.text = title;
    this.visible = false;
  }

  configure(o: Partial<BadgeOptions>): void {
    this.opts = { ...this.opts, ...o };
    this.markText.tint = this.opts.accent;
    if (o.permalinkText !== undefined) this.linkText.text = o.permalinkText;
  }

  /** Call once per frame with the current progress, date, and screen size. */
  update(progress: number, dateStr: string, w: number, h: number): void {
    const o = this.opts;
    this.visible = o.show;
    if (!o.show) return;
    const pad = Math.round(Math.min(w, h) * 0.045);

    this.gfx.clear();

    this.dateText.visible = o.date && dateStr !== "";
    if (this.dateText.visible) {
      this.dateText.text = dateStr;
      this.dateText.position.set(pad, pad);
    }

    this.titleText.visible = o.title;
    if (o.title) this.titleText.position.set(pad, o.date ? pad + 32 : pad);

    this.markText.visible = o.wordmark;
    if (o.wordmark) this.markText.position.set(w - this.markText.width - pad, pad);

    this.linkText.visible = o.permalink && this.linkText.text !== "";
    if (this.linkText.visible) this.linkText.position.set(pad, h - this.linkText.height - pad);

    if (o.progress) {
      const barY = h - pad;
      const barW = w - pad * 2;
      this.gfx.roundRect(pad, barY - 3, barW, 3, 1.5).fill({ color: 0xffffff, alpha: 0.18 });
      this.gfx
        .roundRect(pad, barY - 3, Math.max(2, barW * clamp01(progress)), 3, 1.5)
        .fill({ color: o.accent, alpha: 0.95 });
    }
  }
}

/** What the export dialog drives: framing, UI toggles, badge, and PNG grab. */
export interface CaptureHandle {
  readonly app: Application;
  readonly title: string;
  /** The view's background colour as a hex string (for letterbox fill). */
  readonly backgroundHex: string;
  /** Show/hide in-canvas chrome, hud, labels. */
  applyUi(ui: Partial<ExportUi>): void;
  /** Configure the cinematic badge layer. */
  configureBadge(o: Partial<BadgeOptions>): void;
  /** Update the badge for the current frame (call each rAF while previewing). */
  tickBadge(progress: number): void;
  /** Human date at a timeline fraction (empty if no history wired). */
  dateAt(progress: number): string;
  /** Render the current frame at exact pixel size and return a PNG blob. */
  capturePng(width: number, height: number, bg: "scene" | "black" | "transparent"): Promise<Blob>;
}

function canvasToBlob(canvas: HTMLCanvasElement, type: string): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("toBlob failed"))), type);
  });
}

/**
 * Draws `src` centred inside a `width`x`height` frame, scaled to fit entirely
 * (contain): always fills the width/height it can and pads the rest with the
 * fill colour (letterbox) — never crops. `fill: null` keeps it transparent.
 */
export function compositeContain(
  src: CanvasImageSource & { width: number; height: number },
  width: number,
  height: number,
  fill: string | null,
): HTMLCanvasElement {
  const out = document.createElement("canvas");
  out.width = width;
  out.height = height;
  const ctx = out.getContext("2d");
  if (!ctx) throw new Error("2D canvas unavailable");
  if (fill) {
    ctx.fillStyle = fill;
    ctx.fillRect(0, 0, width, height);
  }
  const scale = Math.min(width / src.width, height / src.height);
  const dw = src.width * scale;
  const dh = src.height * scale;
  ctx.drawImage(src, (width - dw) / 2, (height - dh) / 2, dw, dh);
  return out;
}

/**
 * Builds the export handle for a sketch. Views wire their chrome/hud/labels
 * setters and (optionally) a history for the date readout; everything else
 * (framing, extract, badge) is generic.
 */
export function makeCaptureHandle(
  app: Application,
  opts: {
    title: string;
    history?: { startDateMs: number; spanMs: number };
    accent?: number;
    setChromeHidden?: (b: boolean) => void;
    setHudVisible?: (b: boolean) => void;
    setLabels?: (b: boolean) => void;
  },
): CaptureHandle {
  const badge = new ExportBadge(opts.accent ?? 0xffffff, opts.title);
  app.stage.addChild(badge);
  const backgroundHex = new Color(app.renderer.background.color).toHex();
  let lastProgress = 0;

  const dateAt = (p: number): string => {
    if (!opts.history) return "";
    const d = new Date(opts.history.startDateMs + clamp01(p) * opts.history.spanMs);
    return d.toLocaleDateString("en-US", { year: "numeric", month: "short", day: "2-digit" });
  };

  return {
    app,
    title: opts.title,
    backgroundHex,
    applyUi(ui) {
      if (ui.chrome !== undefined) opts.setChromeHidden?.(!ui.chrome);
      if (ui.hud !== undefined) opts.setHudVisible?.(ui.hud);
      if (ui.labels !== undefined) opts.setLabels?.(ui.labels);
    },
    configureBadge(o) {
      badge.configure(o);
    },
    tickBadge(progress) {
      lastProgress = progress;
      badge.update(progress, dateAt(progress), app.screen.width, app.screen.height);
    },
    dateAt,
    async capturePng(width, height, bg) {
      const r = app.renderer;
      const sw = app.screen.width;
      const sh = app.screen.height;
      app.stage.setChildIndex(badge, app.stage.children.length - 1);
      badge.update(lastProgress, dateAt(lastProgress), sw, sh);
      r.render(app.stage);
      // The renderer is already at export resolution (the dialog raises it on
      // open); extract at 2x and letterbox-fit into the frame.
      const src = r.extract.canvas({
        target: app.stage,
        frame: new Rectangle(0, 0, sw, sh),
        resolution: 2,
      }) as HTMLCanvasElement;
      const fill = bg === "transparent" ? null : bg === "black" ? "#000000" : backgroundHex;
      return await canvasToBlob(compositeContain(src, width, height, fill), "image/png");
    },
  };
}
