/**
 * Client-side video export. Renders the sketch OFFLINE, frame by frame: the
 * live ticker is stopped and the view is advanced a fixed step (1/fps of
 * view-time) per output frame, then encoded — as fast as the machine allows,
 * decoupled from real-time playback and from the preview scrubber.
 *
 * WebCodecs + Mediabunny for MP4 (H.264) / WebM (VP9); gifenc for GIF. No
 * upload — the user's GPU does the encoding.
 */
import type { CaptureHandle, Transport } from "@/sketches/common";

export type VideoFormat = "mp4" | "webm" | "gif";

export interface VideoOpts {
  format: VideoFormat;
  width: number;
  height: number;
  fps: number;
  /** Begin encoding once the timeline reaches this fraction (0..1). */
  startFrac: number;
  /** Stop once the timeline reaches this fraction (0..1). */
  endFrac: number;
  quality: "low" | "medium" | "high";
  bg: "scene" | "black" | "transparent";
  onProgress?: (frac: number) => void;
  signal?: AbortSignal;
}

const raf = (): Promise<number> => new Promise((r) => requestAnimationFrame(r));
const clamp01 = (x: number): number => Math.min(1, Math.max(0, x));
const BITRATE: Record<VideoOpts["quality"], number> = {
  low: 3_000_000,
  medium: 6_000_000,
  high: 12_000_000,
};

export function videoSupported(): boolean {
  return typeof (globalThis as { VideoEncoder?: unknown }).VideoEncoder !== "undefined";
}

/** Letterbox-fit the source canvas into ctx (w x h), filling the rest. */
function drawFrame(
  ctx: CanvasRenderingContext2D,
  src: HTMLCanvasElement,
  w: number,
  h: number,
  fill: string,
): void {
  ctx.fillStyle = fill;
  ctx.fillRect(0, 0, w, h);
  const sw = src.width;
  const sh = src.height;
  if (sw === 0 || sh === 0) return;
  const scale = Math.min(w / sw, h / sh);
  const dw = sw * scale;
  const dh = sh * scale;
  ctx.drawImage(src, (w - dw) / 2, (h - dh) / 2, dw, dh);
}

/** Drives the sketch forward one output frame deterministically + renders it. */
function makeStepper(capture: CaptureHandle, fps: number): () => void {
  const app = capture.app;
  const dt = 1000 / fps;
  let vnow = performance.now();
  return () => {
    vnow += dt;
    app.ticker.update(vnow); // advances every ticker listener by dt, then renders
    app.renderer.render(app.stage); // guarantee a fresh frame before capture
  };
}

export async function recordVideo(
  capture: CaptureHandle,
  transport: Transport,
  opts: VideoOpts,
): Promise<{ blob: Blob; ext: string }> {
  const app = capture.app;
  const ticker = app.ticker;
  const r = app.renderer;
  const liveRes = r.resolution;
  const sw = app.screen.width;
  const sh = app.screen.height;
  // Take manual control of the clock so playback speed no longer gates export.
  ticker.stop();
  // The dialog raises resolution to 2x for crisp stills; video re-renders every
  // frame, so 2x would quadruple per-frame cost and stall the frame-step. Drop
  // to 1x for throughput (the output size is still controlled by drawFrame).
  if (r.resolution !== 1) {
    r.resolution = 1;
    r.resize(sw, sh);
  }
  if (transport.paused()) transport.toggle();
  const fill = opts.bg === "black" || opts.bg === "transparent" ? "#000000" : capture.backgroundHex;
  try {
    return opts.format === "gif"
      ? await recordGif(capture, transport, opts, fill)
      : await recordCodecs(capture, transport, opts, fill);
  } finally {
    if (r.resolution !== liveRes) {
      r.resolution = liveRes;
      r.resize(sw, sh);
    }
    ticker.start(); // resume live playback
  }
}

function done(transport: Transport, endFrac: number): boolean {
  return transport.finished() || transport.progress() >= endFrac;
}

async function recordCodecs(
  capture: CaptureHandle,
  transport: Transport,
  opts: VideoOpts,
  fill: string,
): Promise<{ blob: Blob; ext: string }> {
  if (!videoSupported()) {
    throw new Error(
      "This browser can't encode video here (needs WebCodecs). Try Chrome, Edge, or a recent Firefox/Safari — or export a GIF.",
    );
  }
  const { Output, Mp4OutputFormat, WebMOutputFormat, BufferTarget, CanvasSource } = await import(
    "mediabunny"
  );
  const mp4 = opts.format === "mp4";

  const frame = document.createElement("canvas");
  frame.width = opts.width;
  frame.height = opts.height;
  const ctx = frame.getContext("2d", { alpha: false });
  if (!ctx) throw new Error("Couldn't open a 2D canvas for encoding.");

  const output = new Output({
    format: mp4 ? new Mp4OutputFormat() : new WebMOutputFormat(),
    target: new BufferTarget(),
  });
  const source = new CanvasSource(frame, {
    codec: mp4 ? "avc" : "vp9",
    bitrate: BITRATE[opts.quality],
  });
  output.addVideoTrack(source);
  await output.start();

  const step = makeStepper(capture, opts.fps);
  const span = Math.max(1e-3, opts.endFrac - opts.startFrac);
  const dur = 1 / opts.fps;
  const hardCap = Math.ceil(240 * opts.fps);
  let enc = 0;
  for (let i = 0; i < hardCap; i++) {
    if (opts.signal?.aborted) throw new DOMException("cancelled", "AbortError");
    step();
    const p = transport.progress();
    if (p >= opts.startFrac) {
      drawFrame(ctx, capture.app.canvas as HTMLCanvasElement, opts.width, opts.height, fill);
      await source.add(enc * dur, dur);
      enc++;
      opts.onProgress?.(clamp01((p - opts.startFrac) / span));
    }
    if (done(transport, opts.endFrac)) break;
    if ((i & 7) === 0) await raf(); // keep the page responsive + Cancel live
  }
  if (enc === 0) throw new Error("Nothing to record — widen the range.");
  await output.finalize();

  const buffer = (output.target as { buffer: ArrayBuffer | null }).buffer;
  if (!buffer) throw new Error("Encoding produced no data.");
  return {
    blob: new Blob([buffer], { type: mp4 ? "video/mp4" : "video/webm" }),
    ext: mp4 ? "mp4" : "webm",
  };
}

async function recordGif(
  capture: CaptureHandle,
  transport: Transport,
  opts: VideoOpts,
  fill: string,
): Promise<{ blob: Blob; ext: string }> {
  const { GIFEncoder, quantize, applyPalette } = await import("gifenc");
  const scale = Math.min(1, 640 / Math.max(opts.width, opts.height));
  const gw = Math.max(2, Math.round(opts.width * scale));
  const gh = Math.max(2, Math.round(opts.height * scale));
  const small = document.createElement("canvas");
  small.width = gw;
  small.height = gh;
  const ctx = small.getContext("2d", { willReadFrequently: true, alpha: false });
  if (!ctx) throw new Error("Couldn't open a 2D canvas for GIF encoding.");

  const gfps = Math.min(opts.fps, 20);
  const delay = Math.round(1000 / gfps);
  const gif = GIFEncoder();
  const step = makeStepper(capture, gfps);
  const span = Math.max(1e-3, opts.endFrac - opts.startFrac);
  const hardCap = Math.ceil(120 * gfps);
  let enc = 0;
  for (let i = 0; i < hardCap; i++) {
    if (opts.signal?.aborted) throw new DOMException("cancelled", "AbortError");
    step();
    const p = transport.progress();
    if (p >= opts.startFrac) {
      drawFrame(ctx, capture.app.canvas as HTMLCanvasElement, gw, gh, fill);
      const { data } = ctx.getImageData(0, 0, gw, gh);
      const palette = quantize(data, 256);
      const index = applyPalette(data, palette);
      gif.writeFrame(index, gw, gh, { palette, delay });
      enc++;
      opts.onProgress?.(clamp01((p - opts.startFrac) / span));
    }
    if (done(transport, opts.endFrac)) break;
    if ((i & 7) === 0) await raf();
  }
  if (enc === 0) throw new Error("Nothing to record — widen the range.");
  gif.finish();
  return { blob: new Blob([gif.bytes() as BlobPart], { type: "image/gif" }), ext: "gif" };
}
