"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Slider } from "@/components/ui/slider";
import { Switch } from "@/components/ui/switch";
import { recordVideo, type VideoFormat, type VideoOpts } from "@/lib/exportVideo";
import type { CaptureHandle, SketchControl, Transport } from "@/sketches/common";
import { requestRebuildSeek } from "@/sketches/common";

type Aspect = "16:9" | "1:1";
type Tab = "image" | "video";
type Bg = "view" | "black" | "transparent";

// Persisted across the dialog remount caused by a backward-seek rebuild
// (event-driven views rebuild when seeking back) so settings aren't lost.
interface SavedState {
  tab: Tab;
  aspect: Aspect;
  shortEdge: number;
  bg: Bg;
  ui: { hud: boolean; labels: boolean };
  badge: {
    show: boolean;
    date: boolean;
    title: boolean;
    wordmark: boolean;
    permalink: boolean;
    progress: boolean;
  };
  vFormat: VideoFormat;
  vFps: number;
  vStart: number;
  vEnd: number;
  vQuality: "low" | "medium" | "high";
}
let saved: Partial<SavedState> = {};

interface Props {
  open: boolean;
  onClose: () => void;
  capture: CaptureHandle;
  transport: Transport;
  controls: SketchControl[];
  viewName: string;
  viewId: string;
}

// The renderer is sized to the export ASPECT (a moderate logical size — good
// text proportion + perf) so each view re-lays out to FILL the frame. The PNG
// extract then supersamples this up to the chosen resolution.
const PREVIEW_LOGICAL: Record<Aspect, [number, number]> = {
  "16:9": [1600, 900],
  "1:1": [1040, 1040],
};

function exportDims(aspect: Aspect, shortEdge: number): [number, number] {
  return aspect === "16:9" ? [Math.round((shortEdge * 16) / 9), shortEdge] : [shortEdge, shortEdge];
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="space-y-2.5 border-t border-star/10 pt-3.5 first:border-0 first:pt-0">
      <p className="font-mono text-[10px] tracking-[0.2em] text-faint uppercase">{title}</p>
      {children}
    </div>
  );
}

function Segmented<T extends string>({
  value,
  options,
  onChange,
}: {
  value: T;
  options: { id: T; label: string; disabled?: boolean }[];
  onChange: (v: T) => void;
}) {
  return (
    <div className="flex gap-1 rounded-lg border border-star/15 bg-void/40 p-1">
      {options.map((o) => (
        <button
          key={o.id}
          type="button"
          disabled={o.disabled}
          onClick={() => onChange(o.id)}
          className={`flex-1 rounded-md px-2 py-1.5 font-mono text-[11px] transition-colors disabled:opacity-30 ${
            value === o.id ? "bg-amber/20 text-amber" : "text-dim hover:bg-star/10 hover:text-star"
          }`}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

function ToggleRow({
  label,
  checked,
  onChange,
  disabled,
}: {
  label: string;
  checked: boolean;
  onChange: (v: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <div
      className={`flex items-center justify-between font-mono text-[12px] ${
        disabled ? "text-faint" : "text-star/80"
      }`}
    >
      <span>{label}</span>
      <Switch checked={checked} onCheckedChange={onChange} disabled={disabled} />
    </div>
  );
}

function ViewControl({ control }: { control: SketchControl }) {
  const [value, setValue] = useState(control.value);
  if (control.kind === "toggle") {
    return (
      <ToggleRow
        label={control.label}
        checked={value === true}
        onChange={(v) => {
          control.value = v;
          control.set(v);
          setValue(v);
        }}
      />
    );
  }
  if (control.kind === "enum") {
    return (
      <div className="space-y-1.5">
        <span className="font-mono text-[12px] text-star/80">{control.label}</span>
        <Segmented<string>
          value={String(value)}
          onChange={(v) => {
            const n = Number(v);
            control.value = n;
            control.set(n);
            setValue(n);
          }}
          options={(control.options ?? []).map((o) => ({ id: String(o.value), label: o.label }))}
        />
      </div>
    );
  }
  const num = typeof value === "number" ? value : 0;
  return (
    <div className="space-y-1.5">
      <span className="flex justify-between font-mono text-[12px] text-star/80">
        <span>{control.label}</span>
        <span className="text-faint">{num.toFixed(2).replace(/\.?0+$/, "")}</span>
      </span>
      <Slider
        min={control.min ?? 0}
        max={control.max ?? 1}
        step={control.step ?? 0.05}
        value={[num]}
        onValueChange={(vals) => {
          const v = vals[0] ?? 0;
          control.value = v;
          control.set(v);
          setValue(v);
        }}
        className="[&_[data-slot=slider-track]]:bg-star/15"
      />
    </div>
  );
}

export default function ExportDialog({
  open,
  onClose,
  capture,
  transport,
  controls,
  viewName,
  viewId,
}: Props) {
  const previewRef = useRef<HTMLDivElement>(null);
  const [tab, setTab] = useState<Tab>(() => saved.tab ?? "image");
  const [aspect, setAspect] = useState<Aspect>(() => saved.aspect ?? "16:9");
  const [shortEdge, setShortEdge] = useState(() => saved.shortEdge ?? 1080);
  const [bg, setBg] = useState<Bg>(() => saved.bg ?? "view");
  const [ui, setUi] = useState(() => saved.ui ?? { hud: false, labels: true });
  const [badge, setBadge] = useState(
    () =>
      saved.badge ?? {
        show: false,
        date: true,
        title: true,
        wordmark: true,
        permalink: false,
        progress: true,
      },
  );
  const [paused, setPaused] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{
    url: string;
    name: string;
    kind: "image" | "video";
    blob: Blob;
  } | null>(null);
  const [, force] = useState(0);

  // Video tab (UI only — encoding lands in a later slice).
  const [vFormat, setVFormat] = useState<VideoFormat>(() => saved.vFormat ?? "mp4");
  const [vFps, setVFps] = useState(() => saved.vFps ?? 30);
  const [vStart, setVStart] = useState(() => saved.vStart ?? 0);
  const [vEnd, setVEnd] = useState(() => saved.vEnd ?? 1);
  const [vQuality, setVQuality] = useState<"low" | "medium" | "high">(
    () => saved.vQuality ?? "high",
  );
  const [vBusy, setVBusy] = useState(false);
  const [vProgress, setVProgress] = useState(0);
  const [err, setErr] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  // A backward range export rebuilds the view to the range start (event-driven
  // views can only seek back by rebuilding). The encode must run on the FRESH
  // instance, so renderVideo parks the job here and an effect picks it up once
  // the new capture/transport arrive.
  const pendingExportRef = useRef<VideoOpts | null>(null);
  // Latest vBusy, read by the capture-phase key lock (its listener closes over
  // the value at mount, so it reads the ref instead).
  const vBusyRef = useRef(vBusy);
  vBusyRef.current = vBusy;

  const permalink = `repomentary.app/r/${viewId}`;

  const runExport = useCallback(
    async (cap: CaptureHandle, tr: Transport, opts: VideoOpts) => {
      const ac = new AbortController();
      abortRef.current = ac;
      try {
        // Let the re-parent + aspect effects re-attach the (possibly rebuilt)
        // canvas before seizing the ticker for offline encoding.
        await new Promise<void>((r) =>
          requestAnimationFrame(() => requestAnimationFrame(() => r())),
        );
        if (ac.signal.aborted) throw new DOMException("cancelled", "AbortError");
        const { blob, ext } = await recordVideo(cap, tr, {
          ...opts,
          onProgress: setVProgress,
          signal: ac.signal,
        });
        setResult({
          url: URL.createObjectURL(blob),
          name: `repomentary-${viewId}.${ext}`,
          kind: "video",
          blob,
        });
      } catch (e) {
        if (!(e instanceof DOMException && e.name === "AbortError")) {
          setErr(e instanceof Error ? e.message : "Video export failed.");
        }
      } finally {
        setVBusy(false);
        abortRef.current = null;
      }
    },
    [viewId],
  );

  // Persist settings so a backward-seek rebuild (which remounts this dialog)
  // restores them instead of resetting to defaults.
  useEffect(() => {
    saved = { tab, aspect, shortEdge, bg, ui, badge, vFormat, vFps, vStart, vEnd, vQuality };
  });

  // Re-parent the live canvas into the preview pane; drive the badge per frame.
  useEffect(() => {
    if (!open) return;
    const app = capture.app;
    const canvas = app.canvas as HTMLCanvasElement;
    const box = previewRef.current;
    const prevParent = canvas.parentElement;
    const prevNext = canvas.nextSibling;
    const prevW = app.screen.width;
    const prevH = app.screen.height;
    const prevRes = app.renderer.resolution;
    // Stop Pixi auto-resizing to the (full-window) host while we drive a fixed
    // export aspect; otherwise a window resize snaps the view back.
    const sizer = app as unknown as { resizeTo: Window | HTMLElement | null };
    const prevResizeTo = sizer.resizeTo;
    sizer.resizeTo = null;
    if (box) {
      box.appendChild(canvas);
      canvas.style.width = "100%";
      canvas.style.height = "100%";
      canvas.style.objectFit = "contain";
      canvas.style.display = "block";
    }
    const tick = () => {
      capture.tickBadge(transport.progress());
      // Pixi's autoDensity rewrites the canvas CSS size to fixed pixels on any
      // renderer resize (e.g. a window resize), which blows out the preview and
      // shoves the options panel off-screen. Re-pin it to fill the box.
      if (canvas.style.width !== "100%") {
        canvas.style.width = "100%";
        canvas.style.height = "100%";
        canvas.style.objectFit = "contain";
      }
    };
    app.ticker.add(tick);
    return () => {
      // A rebuild (backward scrub / range export) destroys this instance before
      // cleanup runs — restoring a torn-down app throws, so guard it. The fresh
      // instance handles its own setup.
      try {
        app.ticker.remove(tick);
        canvas.style.width = "";
        canvas.style.height = "";
        canvas.style.objectFit = "";
        canvas.style.display = "";
        if (prevParent) prevParent.insertBefore(canvas, prevNext);
        sizer.resizeTo = prevResizeTo;
        app.renderer.resolution = prevRes;
        app.renderer.resize(prevW, prevH);
        app.renderer.background.alpha = 1;
        capture.applyUi({ chrome: true, hud: true, labels: true });
        capture.configureBadge({ show: false });
      } catch {
        // instance was torn down; nothing to restore
      }
    };
  }, [open, capture, transport]);

  // Size the renderer to the chosen aspect so the view fills the frame, and
  // raise its resolution so text/vectors export crisp (most monitors are 1x).
  useEffect(() => {
    if (!open) return;
    const [w, h] = PREVIEW_LOGICAL[aspect];
    const r = capture.app.renderer;
    if (r.resolution < 2) r.resolution = 2;
    r.resize(w, h);
    const c = capture.app.canvas as HTMLCanvasElement;
    c.style.width = "100%";
    c.style.height = "100%";
    c.style.objectFit = "contain";
  }, [open, aspect, capture]);

  useEffect(() => {
    if (open) capture.applyUi({ chrome: false, hud: ui.hud, labels: ui.labels });
  }, [open, ui, capture]);

  useEffect(() => {
    if (!open) return;
    capture.configureBadge({ ...badge, permalinkText: permalink, accent: 0xffffff });
  }, [open, badge, capture, permalink]);

  useEffect(() => {
    if (!open) return;
    const r = capture.app.renderer;
    r.background.alpha = bg === "transparent" ? 0 : 1;
    if (bg === "black") r.background.color = 0x05060f;
  }, [open, bg, capture]);

  // A backward range export rebuilt the view to vStart; capture/transport here
  // are the fresh instance, so run the queued encode on them.
  useEffect(() => {
    const opts = pendingExportRef.current;
    if (!open || !opts) return;
    pendingExportRef.current = null;
    void runExport(capture, transport, opts);
  }, [open, capture, transport, runExport]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !vBusyRef.current) onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  // While a video is rendering, swallow every keystroke at the capture phase so
  // the view's own hotkeys (T labels, speed arrows, etc.) and Escape can't
  // change the frame or close the dialog. Only the Cancel button stays live.
  useEffect(() => {
    if (!open) return;
    // Keys the underlying views listen for (labels/split/speed/pause). The
    // dialog owns the view while open, so swallow these to stop hotkeys from
    // desyncing it; while rendering, swallow everything (only Cancel stays).
    const viewHotkeys = new Set(["KeyT", "KeyG", "KeyL", "Space", "ArrowUp", "ArrowDown"]);
    const lock = (e: KeyboardEvent) => {
      if (vBusyRef.current || viewHotkeys.has(e.code)) {
        e.stopImmediatePropagation();
        e.preventDefault();
      }
    };
    window.addEventListener("keydown", lock, true);
    return () => window.removeEventListener("keydown", lock, true);
  }, [open]);

  useEffect(() => {
    return () => {
      if (result) URL.revokeObjectURL(result.url);
    };
  }, [result]);

  if (!open) return null;

  const togglePlay = () => {
    if (vBusy) return;
    transport.toggle();
    setPaused(transport.paused());
  };

  const scrubTo = (frac: number) => {
    if (vBusy) return; // the export is driving the clock; don't fight it
    // Backward seeks rebuild event-driven views; the re-parent effect re-attaches
    // to the fresh instance, so scrubbing both directions works.
    transport.seek(frac);
    force((n) => n + 1);
  };

  const download = async () => {
    setBusy(true);
    setErr(null);
    try {
      const [w, h] = exportDims(aspect, shortEdge);
      const blob = await capture.capturePng(w, h, bg === "view" ? "scene" : bg);
      const name = `repomentary-${viewId}-${Math.round(transport.progress() * 100)}pct.png`;
      setResult({ url: URL.createObjectURL(blob), name, kind: "image", blob });
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Export failed.");
    } finally {
      setBusy(false);
    }
  };

  const renderVideo = () => {
    setErr(null);
    setVProgress(0);
    setVBusy(true);
    const [w, h] = exportDims(aspect, shortEdge);
    const opts: VideoOpts = {
      format: vFormat,
      width: w,
      height: h,
      fps: vFps,
      startFrac: vStart,
      endFrac: vEnd,
      quality: vQuality,
      bg: bg === "view" ? "scene" : bg,
    };
    // The export must cover [vStart, vEnd] regardless of where the preview sits.
    // Forward / in place: seek and encode on the current instance now. Backward:
    // rebuild to vStart (event-driven views can only seek back by rebuilding);
    // the queued job runs on the fresh instance via the effect below.
    if (vStart >= transport.progress()) {
      transport.seek(vStart);
      void runExport(capture, transport, opts);
    } else {
      pendingExportRef.current = opts;
      requestRebuildSeek(vStart);
    }
  };

  const saveBlob = (r: { url: string; name: string }) => {
    const a = document.createElement("a");
    a.href = r.url;
    a.download = r.name;
    a.click();
  };

  const shareResult = async (r: { url: string; name: string; blob: Blob }) => {
    const file = new File([r.blob], r.name, { type: r.blob.type });
    const nav = navigator as Navigator & {
      canShare?: (data: { files: File[] }) => boolean;
      share?: (data: { files: File[] }) => Promise<void>;
    };
    if (nav.canShare?.({ files: [file] }) && nav.share) {
      try {
        await nav.share({ files: [file] });
      } catch {
        /* share cancelled */
      }
    } else {
      saveBlob(r);
    }
  };

  const clearResult = () => {
    if (result) URL.revokeObjectURL(result.url);
    setResult(null);
  };

  const progressPct = Math.round(transport.progress() * 100);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 sm:p-8">
      <div aria-hidden="true" className="absolute inset-0 bg-void/80 backdrop-blur-sm" />
      <div className="relative flex h-full max-h-[860px] w-full max-w-6xl flex-col overflow-hidden rounded-2xl border border-star/15 bg-deep shadow-2xl lg:flex-row">
        {/* ---------------- preview ---------------- */}
        <div className="flex min-h-0 flex-1 flex-col bg-void/60 p-4 sm:p-6">
          <div className="mb-3 flex items-center justify-between">
            <p className="font-display text-sm font-semibold text-star">{viewName}</p>
            <p className="font-mono text-[10px] tracking-[0.18em] text-faint uppercase">
              live preview
            </p>
          </div>
          <div className="flex min-h-0 flex-1 items-center justify-center">
            <div
              ref={previewRef}
              style={{
                aspectRatio: aspect === "16:9" ? "16 / 9" : "1 / 1",
                backgroundColor:
                  bg === "transparent"
                    ? undefined
                    : bg === "black"
                      ? "#000000"
                      : capture.backgroundHex,
              }}
              className={`flex max-h-full w-full max-w-full items-center justify-center overflow-hidden rounded-lg border border-star/10 ${bg === "transparent" ? "bg-[repeating-conic-gradient(#1a1d2e_0%_25%,#141622_0%_50%)] bg-[length:24px_24px]" : ""}`}
            />
          </div>
          {/* transport */}
          <div className="mt-4 flex items-center gap-3">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={vBusy}
              onClick={togglePlay}
              className="h-8 bg-black/30 px-3 font-mono text-xs text-star/80 hover:text-star disabled:opacity-40"
            >
              {paused ? "▶ play" : "⏸ pause"}
            </Button>
            <div className="flex-1">
              <Slider
                min={0}
                max={1}
                step={0.005}
                value={[transport.progress()]}
                disabled={vBusy}
                onValueChange={(vals) => scrubTo(vals[0] ?? 0)}
                className="[&_[data-slot=slider-track]]:bg-star/15"
              />
            </div>
            <span className="w-10 text-right font-mono text-[11px] text-dim">{progressPct}%</span>
          </div>
          <p className="mt-1.5 font-mono text-[10px] text-faint">
            scrub the timeline to pick a frame · exports the frame on screen
          </p>
        </div>

        {/* ---------------- options ---------------- */}
        <div className="flex w-full shrink-0 flex-col border-t border-star/15 lg:w-[360px] lg:border-t-0 lg:border-l">
          <div
            inert={vBusy}
            className={`flex items-center justify-between gap-2 border-b border-star/10 p-3 ${vBusy ? "pointer-events-none opacity-40" : ""}`}
          >
            <Segmented<Tab>
              value={tab}
              onChange={setTab}
              options={[
                { id: "image", label: "Image" },
                { id: "video", label: "Video" },
              ]}
            />
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={onClose}
              className="h-8 px-2 font-mono text-xs text-dim hover:text-star"
            >
              ✕
            </Button>
          </div>

          <div
            inert={vBusy}
            className={`min-h-0 flex-1 space-y-4 overflow-y-auto p-4 ${vBusy ? "pointer-events-none opacity-40" : ""}`}
          >
            {err && (
              <div className="rounded-lg border border-ember/40 bg-ember/10 p-2.5 font-mono text-[11px] text-ember">
                {err}
              </div>
            )}
            {tab === "image" ? (
              <>
                <Section title="Canvas">
                  <Segmented<Aspect>
                    value={aspect}
                    onChange={setAspect}
                    options={[
                      { id: "16:9", label: "16:9" },
                      { id: "1:1", label: "1:1" },
                    ]}
                  />
                  <Segmented<string>
                    value={String(shortEdge)}
                    onChange={(v) => setShortEdge(Number(v))}
                    options={[
                      { id: "1080", label: "1080p" },
                      { id: "1440", label: "1440p" },
                    ]}
                  />
                  <Segmented<Bg>
                    value={bg}
                    onChange={setBg}
                    options={[
                      { id: "view", label: "Scene" },
                      { id: "black", label: "Black" },
                      { id: "transparent", label: "None" },
                    ]}
                  />
                </Section>

                <Section title="Hide UI">
                  <ToggleRow
                    label="in-view labels"
                    checked={ui.labels}
                    onChange={(v) => setUi((s) => ({ ...s, labels: v }))}
                  />
                  <ToggleRow
                    label="fps readout"
                    checked={ui.hud}
                    onChange={(v) => setUi((s) => ({ ...s, hud: v }))}
                  />
                </Section>

                <Section title="Caption overlay">
                  <ToggleRow
                    label="show overlay"
                    checked={badge.show}
                    onChange={(v) => setBadge((s) => ({ ...s, show: v }))}
                  />
                  <ToggleRow
                    label="date"
                    checked={badge.date}
                    onChange={(v) => setBadge((s) => ({ ...s, date: v }))}
                    disabled={!badge.show}
                  />
                  <ToggleRow
                    label="repo title"
                    checked={badge.title}
                    onChange={(v) => setBadge((s) => ({ ...s, title: v }))}
                    disabled={!badge.show}
                  />
                  <ToggleRow
                    label="progress bar"
                    checked={badge.progress}
                    onChange={(v) => setBadge((s) => ({ ...s, progress: v }))}
                    disabled={!badge.show}
                  />
                  <ToggleRow
                    label="wordmark"
                    checked={badge.wordmark}
                    onChange={(v) => setBadge((s) => ({ ...s, wordmark: v }))}
                    disabled={!badge.show}
                  />
                  <ToggleRow
                    label={`permalink (${permalink})`}
                    checked={badge.permalink}
                    onChange={(v) => setBadge((s) => ({ ...s, permalink: v }))}
                    disabled={!badge.show}
                  />
                </Section>

                {controls.length > 0 && (
                  <Section title="View look">
                    {controls.map((c) => (
                      <ViewControl key={c.key} control={c} />
                    ))}
                  </Section>
                )}
              </>
            ) : (
              <>
                <div className="rounded-lg border border-star/15 bg-void/40 p-2.5 font-mono text-[11px] text-dim">
                  Rendered offline in your browser, no upload — frames are encoded as fast as your
                  machine allows, across the chosen range.
                </div>
                <Section title="Format">
                  <Segmented<VideoFormat>
                    value={vFormat}
                    onChange={setVFormat}
                    options={[
                      { id: "mp4", label: "MP4" },
                      { id: "gif", label: "GIF" },
                      { id: "webm", label: "WebM" },
                    ]}
                  />
                </Section>
                <Section title="Canvas">
                  <Segmented<Aspect>
                    value={aspect}
                    onChange={setAspect}
                    options={[
                      { id: "16:9", label: "16:9" },
                      { id: "1:1", label: "1:1" },
                    ]}
                  />
                  <Segmented<string>
                    value={String(shortEdge)}
                    onChange={(v) => setShortEdge(Number(v))}
                    options={[
                      { id: "1080", label: "1080p" },
                      { id: "1440", label: "1440p" },
                    ]}
                  />
                </Section>
                <Section title="Range">
                  <Slider
                    min={0}
                    max={1}
                    step={0.01}
                    value={[vStart, vEnd]}
                    onValueChange={(vals) => {
                      const MIN = 0.05;
                      let a = Math.min(vals[0] ?? 0, vals[1] ?? 1);
                      let b = Math.max(vals[0] ?? 0, vals[1] ?? 1);
                      if (b - a < MIN) {
                        if (a !== vStart) a = Math.max(0, b - MIN);
                        else b = Math.min(1, a + MIN);
                      }
                      setVStart(a);
                      setVEnd(b);
                    }}
                    className="[&_[data-slot=slider-track]]:bg-star/15"
                  />
                  <p className="font-mono text-[10px] text-faint">
                    records {Math.round(vStart * 100)}% → {Math.round(vEnd * 100)}% of history
                  </p>
                </Section>
                <Section title="Quality">
                  <Segmented<"low" | "medium" | "high">
                    value={vQuality}
                    onChange={setVQuality}
                    options={[
                      { id: "low", label: "Low" },
                      { id: "medium", label: "Med" },
                      { id: "high", label: "High" },
                    ]}
                  />
                  <Segmented<string>
                    value={String(vFps)}
                    onChange={(v) => setVFps(Number(v))}
                    options={[
                      { id: "30", label: "30 fps" },
                      { id: "60", label: "60 fps" },
                    ]}
                  />
                </Section>
              </>
            )}
          </div>

          {/* footer action */}
          <div className="border-t border-star/10 p-3">
            {tab === "image" ? (
              <Button
                type="button"
                onClick={download}
                disabled={busy}
                className="w-full bg-amber font-mono text-xs font-semibold text-void hover:bg-amber/90"
              >
                {busy ? "rendering…" : `Download PNG · ${exportDims(aspect, shortEdge).join("×")}`}
              </Button>
            ) : vBusy ? (
              <div className="space-y-2">
                <div className="h-1.5 overflow-hidden rounded-full bg-star/15">
                  <div
                    className="h-full bg-amber"
                    style={{ width: `${Math.round(vProgress * 100)}%` }}
                  />
                </div>
                <Button
                  type="button"
                  onClick={() => abortRef.current?.abort()}
                  className="w-full bg-star/10 font-mono text-xs font-semibold text-star hover:bg-star/20"
                >
                  Cancel · {Math.round(vProgress * 100)}%
                </Button>
              </div>
            ) : (
              <Button
                type="button"
                onClick={renderVideo}
                className="w-full bg-amber font-mono text-xs font-semibold text-void hover:bg-amber/90"
              >
                Render {vFormat.toUpperCase()} · {exportDims(aspect, shortEdge).join("×")}
              </Button>
            )}
          </div>
        </div>

        {result && (
          <div className="absolute inset-0 z-10 flex flex-col bg-deep/95 p-5 backdrop-blur sm:p-6">
            <div className="mb-3 flex items-center gap-2">
              <span className="font-display text-sm font-semibold text-star">Export ready</span>
              <span className="rounded border border-amber/40 px-1.5 py-0.5 font-mono text-[10px] tracking-[0.15em] text-amber uppercase">
                {result.kind === "image" ? "PNG" : result.name.endsWith(".gif") ? "GIF" : "video"}
              </span>
            </div>
            <div className="flex min-h-0 flex-1 items-center justify-center overflow-hidden rounded-lg border border-star/10 bg-void/60">
              {result.kind === "image" || result.name.endsWith(".gif") ? (
                // GIFs are encoded as kind "video" but a <video> can't play
                // them, so preview any image OR .gif in an <img>.
                <img
                  src={result.url}
                  alt="export preview"
                  className="max-h-full max-w-full object-contain"
                />
              ) : (
                <video
                  src={result.url}
                  className="max-h-full max-w-full object-contain"
                  controls
                  autoPlay
                  loop
                  muted
                />
              )}
            </div>
            <p className="mt-2 truncate font-mono text-[11px] text-dim">{result.name}</p>
            <div className="mt-3 grid grid-cols-2 gap-2">
              <Button
                type="button"
                onClick={() => saveBlob(result)}
                className="bg-amber font-mono text-xs font-semibold text-void hover:bg-amber/90"
              >
                Save file
              </Button>
              <Button
                type="button"
                onClick={() => shareResult(result)}
                className="bg-star/10 font-mono text-xs font-semibold text-star hover:bg-star/20"
              >
                Share
              </Button>
              <Button
                type="button"
                onClick={clearResult}
                className="bg-star/10 font-mono text-xs text-star hover:bg-star/20"
              >
                Export another
              </Button>
              <Button
                type="button"
                onClick={onClose}
                className="bg-star/10 font-mono text-xs text-star hover:bg-star/20"
              >
                Done
              </Button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
