"use client";

import { useEffect, useReducer, useRef, useState } from "react";
import DatasetPicker from "@/components/DatasetPicker";
import { TransitionLink } from "@/components/PageTransition";
import { Button } from "@/components/ui/button";
import { Slider } from "@/components/ui/slider";
import { Switch } from "@/components/ui/switch";
import { SimpleTooltip } from "@/components/ui/tooltip";
import { getDatasetId } from "@/lib/realHistory";
import type { SketchControl, SketchInstance, Transport } from "@/sketches/common";

const loaders = {
  planet: () => import("@/sketches/planet"),
  city: () => import("@/sketches/city"),
  gource: () => import("@/sketches/gource"),
  race: () => import("@/sketches/race"),
  civilization: () => import("@/sketches/civilization"),
  layout: () => import("@/sketches/layout-test"),
} as const;

export type SketchKind = keyof typeof loaders;

interface Props {
  kind: SketchKind;
  title: string;
  hint: string;
}

const chipClass =
  "pointer-events-auto rounded-md bg-black/30 px-3 py-1.5 font-mono text-xs text-star/70 backdrop-blur transition-colors hover:text-star";

export default function SketchHost({ kind, title, hint }: Props) {
  const hostRef = useRef<HTMLDivElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [controls, setControls] = useState<SketchControl[] | null>(null);
  const [transport, setTransport] = useState<Transport | null>(null);
  const [panelOpen, setPanelOpen] = useState(false);
  // null until mounted (SSR can't read localStorage); changing it remounts
  // the sketch on the newly selected repo.
  const [dataset, setDataset] = useState<string | null>(null);
  // Bumped by backward seeks/reset, the sketch rebuilds and fast-forwards.
  const [generation, regenerate] = useReducer((x: number) => x + 1, 0);
  const [, rerender] = useReducer((x: number) => x + 1, 0);

  useEffect(() => {
    setDataset(getDatasetId());
    const onRebuild = () => regenerate();
    window.addEventListener("repomentary:rebuild", onRebuild);
    return () => window.removeEventListener("repomentary:rebuild", onRebuild);
  }, []);

  // Keep the transport chips (pause state, speed, ended) fresh.
  useEffect(() => {
    if (!transport) return;
    const id = setInterval(rerender, 400);
    return () => clearInterval(id);
  }, [transport]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: `generation` intentionally forces a rebuild (backward seek / reset)
  useEffect(() => {
    const host = hostRef.current;
    // Boot while the curtain still covers, so the canvas is ready the moment
    // it lifts (seamless reveal, no flash of empty page).
    if (!host || dataset === null) return;

    // StrictMode/HMR mount-unmount races: the first instance must stop
    // building the moment it's been cancelled, or it touches destroyed
    // Pixi containers ("reading 'push'", texture 'source' errors).
    const controller = new AbortController();
    let instance: SketchInstance | null = null;

    setError(null);
    loaders[kind]()
      .then(async (mod) => {
        const created = await mod.createSketch(host, controller.signal);
        if (controller.signal.aborted) {
          created.destroy();
          return;
        }
        instance = created;
        setControls(created.controls ?? null);
        setTransport(created.transport ?? null);
      })
      .catch((err: unknown) => {
        if (controller.signal.aborted) return; // cancelled, not a real error
        if (err instanceof DOMException && err.name === "AbortError") return;
        setError(err instanceof Error ? err.message : "Failed to start the sketch.");
      });

    return () => {
      controller.abort();
      try {
        instance?.destroy();
      } catch {
        // already torn down
      }
      instance = null;
      setControls(null);
      setTransport(null);
    };
  }, [kind, dataset, generation]);

  const ended = transport?.finished() ?? false;

  return (
    <div className="relative h-dvh w-full overflow-hidden">
      <div ref={hostRef} className="absolute inset-0" />

      <header className="pointer-events-none absolute inset-x-0 top-0 z-10 flex items-start justify-between p-4">
        <div className="flex items-center gap-2">
          <TransitionLink href="/" direction="back" className={chipClass}>
            ← repomentary
          </TransitionLink>
          <DatasetPicker onPick={(id) => setDataset(id)} />
        </div>
        <div className="mr-[252px] rounded-md bg-black/30 px-3 py-1.5 text-right backdrop-blur">
          <p className="font-mono text-xs font-semibold text-star/90">{title}</p>
          <p className="font-mono text-[10px] text-star/50">{hint}</p>
        </div>
      </header>

      {transport && (
        <div className="pointer-events-none absolute right-[268px] bottom-20 z-20 flex items-center gap-1.5">
          {ended && (
            <span className="rounded-md bg-black/30 px-2.5 py-1.5 font-mono text-[10px] text-ember backdrop-blur">
              the end
            </span>
          )}
          <SimpleTooltip content={ended ? "replay from the start" : "play / pause"}>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={ended}
              onClick={() => {
                transport.toggle();
                rerender();
              }}
              className="pointer-events-auto h-8 bg-black/30 px-3 font-mono text-xs text-star/70 shadow-none backdrop-blur hover:bg-black/40 hover:text-star disabled:opacity-40"
            >
              {ended ? "⏹" : transport.paused() ? "▶" : "⏸"}
            </Button>
          </SimpleTooltip>
          <SimpleTooltip content="fast-forward (1x, 2x, 4x, 8x)">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={ended}
              onClick={() => {
                transport.cycleSpeed();
                rerender();
              }}
              className={`pointer-events-auto h-8 bg-black/30 px-3 font-mono text-xs text-star/70 shadow-none backdrop-blur hover:bg-black/40 hover:text-star disabled:opacity-40 ${transport.speed() > 1 ? "text-ember hover:text-ember" : ""}`}
            >
              {transport.speed()}×
            </Button>
          </SimpleTooltip>
          <SimpleTooltip content="restart the film">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => transport.reset()}
              className={`pointer-events-auto h-8 bg-black/30 px-3 font-mono text-xs text-star/70 shadow-none backdrop-blur hover:bg-black/40 hover:text-star ${ended ? "text-ember hover:text-ember" : ""}`}
            >
              ⟲
            </Button>
          </SimpleTooltip>
        </div>
      )}

      {controls && controls.length > 0 && (
        <div className="absolute bottom-20 left-4 z-20 flex flex-col items-start gap-2">
          {panelOpen && (
            <div className="w-64 space-y-2.5 rounded-xl border border-star/15 bg-deep/85 p-3 backdrop-blur">
              {controls.map((c) => (
                <div key={c.key}>
                  {c.kind === "range" ? (
                    <label className="block">
                      <span className="flex justify-between font-mono text-[11px] text-star/70">
                        <span>{c.label}</span>
                        <span className="text-star/45">
                          {typeof c.value === "number"
                            ? c.value.toFixed(2).replace(/\.?0+$/, "")
                            : ""}
                        </span>
                      </span>
                      <Slider
                        min={c.min ?? 0}
                        max={c.max ?? 1}
                        step={c.step ?? 0.05}
                        value={[typeof c.value === "number" ? c.value : 0]}
                        onValueChange={(vals) => {
                          const v = vals[0] ?? 0;
                          c.value = v;
                          c.set(v);
                          rerender();
                        }}
                        className="mt-2 [&_[data-slot=slider-track]]:bg-star/15"
                      />
                    </label>
                  ) : (
                    <label className="flex items-center justify-between font-mono text-[11px] text-star/70">
                      <span>{c.label}</span>
                      <Switch
                        checked={c.value === true}
                        onCheckedChange={(checked) => {
                          c.value = checked;
                          c.set(checked);
                          rerender();
                        }}
                      />
                    </label>
                  )}
                </div>
              ))}
            </div>
          )}
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => setPanelOpen((open) => !open)}
            className="pointer-events-auto h-8 bg-black/30 px-3 font-mono text-xs text-star/70 shadow-none backdrop-blur hover:bg-black/40 hover:text-star"
          >
            {panelOpen ? "✕ tuning" : "⚙ tuning"}
          </Button>
        </div>
      )}

      {error && (
        <div className="absolute inset-0 z-20 flex items-center justify-center p-8">
          <div className="max-w-md rounded-xl border border-star/15 bg-deep p-6 text-center">
            <p className="font-semibold text-star">Couldn&apos;t start the renderer</p>
            <p className="mt-2 text-sm text-star/60">{error}</p>
            <p className="mt-2 text-xs text-star/40">
              This sketch needs WebGPU or WebGL. Try a recent Chrome, Edge, Firefox, or Safari.
            </p>
          </div>
        </div>
      )}
    </div>
  );
}
