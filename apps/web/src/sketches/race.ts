/**
 * Race sketch: no metaphors, just charts. A contributor bar chart race with
 * eased rank swaps and a self-rescaling axis.
 *
 * Hover bars for details. Tuning panel controls bar count and snappiness.
 */
import type { RepoEvent } from "@repomentary/artifact";
import { Container, Graphics, Text } from "pixi.js";
import { loadSharedHistory } from "@/lib/realHistory";
import { FilmChrome } from "./chrome";
import {
  bootPixi,
  EventPlayer,
  FrameGovernor,
  makeCaptureHandle,
  type SketchInstance,
} from "./common";

const INK = 0xe8ecff;
const DIM = 0x8c93b8;
const ACCENT = 0x4ecdc4;

interface Bar {
  author: number;
  name: Text;
  value: Text;
  y: number;
  targetY: number;
  width: number;
  alpha: number;
  rank: number;
  flash: number;
  color: number;
}

/** hue [0,1) → rgb (matches gource's contributor colors). */
function hueColor(h: number, s = 0.6, l = 0.6): number {
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
  return (
    (Math.round(f(h + 1 / 3) * 255) << 16) |
    (Math.round(f(h) * 255) << 8) |
    Math.round(f(h - 1 / 3) * 255)
  );
}

function hashStr(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** Round up to a friendly axis number (1/2/5 × 10^k). */
function niceCeil(v: number): number {
  if (v <= 10) return 10;
  const mag = 10 ** Math.floor(Math.log10(v));
  const unit = v / mag;
  const nice = unit <= 1 ? 1 : unit <= 2 ? 2 : unit <= 5 ? 5 : 10;
  return nice * mag;
}

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

  const { history, repoName } = await loadSharedHistory();
  if (signal?.aborted) {
    boot.destroy();
    throw new DOMException("cancelled", "AbortError");
  }

  const params = { bars: 12, snappiness: 1 };
  const governor = new FrameGovernor();
  const chrome = new FilmChrome(ui, history, {
    repoName,
    accent: ACCENT,
    reducedMotion,
    clip: world,
    onSeek: (f) => transport.seek(f),
  });

  /* ------------------------------ layer stack ------------------------------ */

  const gridGfx = new Graphics();
  const barGfx = new Graphics();
  const labelLayer = new Container();
  world.addChild(gridGfx, barGfx, labelLayer);

  const gridLabels: Text[] = [];

  /* --------------------------------- race state -------------------------------- */

  const counts = new Map<number, number>();
  const bars = new Map<number, Bar>();
  let axisMax = 10;

  const makeBarTexts = (author: number): Bar => {
    const fullName = history.authors[author] ?? "anon";
    const color = hueColor((hashStr(fullName) % 360) / 360);
    const name = new Text({
      text: fullName.length > 20 ? `${fullName.slice(0, 19)}…` : fullName,
      style: { fontFamily: "monospace", fontSize: 13, fontWeight: "bold", fill: 0x07091a },
    });
    name.anchor.set(0, 0.5);
    const value = new Text({
      text: "0",
      style: { fontFamily: "monospace", fontSize: 13, fill: INK },
    });
    value.anchor.set(0, 0.5);
    labelLayer.addChild(name, value);
    return {
      author,
      name,
      value,
      y: -40,
      targetY: -40,
      width: 0,
      alpha: 0,
      rank: 99,
      flash: 0,
      color,
    };
  };

  const onEvent = (e: RepoEvent) => {
    chrome.onEvent(e);
    if (e.kind === "commit" || e.kind === "merge") {
      counts.set(e.author, (counts.get(e.author) ?? 0) + 1);
    }
  };

  const player = new EventPlayer(history, history.duration / 150);
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

  const tick = () => {
    const dtMs = Math.min(app.ticker.deltaMS, 50);
    governor.update(dtMs);
    for (const e of player.update(dtMs)) onEvent(e);

    const contentW = chrome.contentWidth(app.screen.width);
    const contentH = chrome.contentHeight(app.screen.height);

    // Chart frame.
    const chartTop = 120;
    const chartLeft = 24;
    const chartRight = contentW - 96;
    const chartBottom = contentH - 28;
    const chartW = Math.max(120, chartRight - chartLeft);

    /* ----- standings ----- */
    const top = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, Math.round(params.bars));
    const leader = top[0]?.[1] ?? 1;
    axisMax += (niceCeil(leader) - axisMax) * Math.min(1, dtMs / 900);

    // Fill the chart height: rows divide the available space (no fixed cap),
    // so bars span tall/square export frames instead of clustering at the top.
    const rowH = (chartBottom - chartTop) / Math.max(4, top.length);
    const barH = rowH * 0.72;

    // Ensure bar objects exist for everyone on the podium.
    const onStage = new Set<number>();
    top.forEach(([author, count], rank) => {
      onStage.add(author);
      let bar = bars.get(author);
      if (!bar) {
        bar = makeBarTexts(author);
        bar.y = chartTop + rank * rowH + rowH * 3; // enter from below
        bars.set(author, bar);
      }
      if (bar.rank !== rank) {
        if (bar.rank > rank) bar.flash = 1; // overtake!
        bar.rank = rank;
      }
      bar.targetY = chartTop + rank * rowH;
      const targetW = Math.max(4, (count / Math.max(1, axisMax)) * chartW);
      const ease = Math.min(1, (dtMs / 420) * params.snappiness);
      bar.width += (targetW - bar.width) * ease;
      bar.y += (bar.targetY - bar.y) * ease;
      bar.alpha += (1 - bar.alpha) * ease;
      bar.flash = Math.max(0, bar.flash - dtMs / 700);
      bar.value.text = count.toLocaleString("en-US");
    });
    // Exit those who fell off.
    for (const [author, bar] of bars) {
      if (onStage.has(author)) continue;
      bar.alpha -= dtMs / 400;
      bar.y += dtMs * 0.05;
      if (bar.alpha <= 0) {
        bar.name.destroy();
        bar.value.destroy();
        bars.delete(author);
      }
    }

    /* ----- draw: grid ----- */
    gridGfx.clear();
    const gridLines = 4;
    for (let i = 0; i <= gridLines; i++) {
      const gx = chartLeft + (i / gridLines) * chartW;
      gridGfx
        .moveTo(gx, chartTop - 14)
        .lineTo(gx, chartBottom)
        .stroke({ color: INK, alpha: i === 0 ? 0.25 : 0.07, width: 1 });
      let label = gridLabels[i];
      if (!label) {
        label = new Text({
          text: "",
          style: { fontFamily: "monospace", fontSize: 10, fill: DIM },
        });
        label.anchor.set(0.5, 1);
        labelLayer.addChild(label);
        gridLabels.push(label);
      }
      label.text = Math.round((i / gridLines) * axisMax).toLocaleString("en-US");
      label.position.set(gx, chartTop - 18);
    }

    /* ----- draw: bars ----- */
    barGfx.clear();
    for (const bar of bars.values()) {
      if (bar.alpha <= 0.01) {
        bar.name.visible = false;
        bar.value.visible = false;
        continue;
      }
      const flashColor =
        bar.flash > 0
          ? (() => {
              const k = bar.flash * 0.55;
              const r = Math.min(255, (((bar.color >> 16) & 0xff) * (1 - k) + 255 * k) | 0);
              const g = Math.min(255, (((bar.color >> 8) & 0xff) * (1 - k) + 255 * k) | 0);
              const b2 = Math.min(255, ((bar.color & 0xff) * (1 - k) + 255 * k) | 0);
              return (r << 16) | (g << 8) | b2;
            })()
          : bar.color;
      barGfx
        .roundRect(chartLeft, bar.y, bar.width, barH, 4)
        .fill({ color: flashColor, alpha: 0.92 * bar.alpha });
      const showNameInside = bar.width > bar.name.width + 22;
      bar.name.visible = true;
      bar.name.alpha = bar.alpha * (showNameInside ? 0.95 : 0.8);
      bar.name.style.fill = showNameInside ? 0x07091a : INK;
      bar.name.position.set(
        showNameInside ? chartLeft + 10 : chartLeft + bar.width + 8,
        bar.y + barH / 2,
      );
      bar.value.visible = true;
      bar.value.alpha = bar.alpha;
      bar.value.position.set(
        chartLeft + bar.width + (showNameInside ? 8 : bar.name.width + 16),
        bar.y + barH / 2,
      );
    }

    /* ----- hover ----- */
    let tipMsg: string | null = null;
    if (pointerX > -999 && pointerX < contentW) {
      for (const bar of bars.values()) {
        if (
          pointerY >= bar.y &&
          pointerY <= bar.y + barH &&
          pointerX >= chartLeft &&
          pointerX <= chartLeft + Math.max(60, bar.width)
        ) {
          const fullName = history.authors[bar.author] ?? "anon";
          tipMsg = `${fullName} · ${(counts.get(bar.author) ?? 0).toLocaleString("en-US")} commits · #${bar.rank + 1}`;
          break;
        }
      }
    }
    setTip(tipMsg);

    /* ----- chrome ----- */
    chrome.update(dtMs, app.screen.width, app.screen.height, player.progress, [
      ["racers", counts.size],
      ["on chart", bars.size],
      ["axis max", Math.round(axisMax)],
    ]);

    hud.update(dtMs, `${counts.size} contributors tracked · top ${Math.round(params.bars)} racing`);
  };

  app.ticker.add(tick);

  return {
    destroy() {
      boot.destroy();
    },
    transport,
    capture: makeCaptureHandle(app, {
      title: repoName,
      history: history,
      accent: ACCENT,
      setChromeHidden: (b) => chrome.setHidden(b),
      setHudVisible: (b) => hud.setVisible(b),
    }),
    controls: [
      {
        key: "bars",
        label: "bars on chart",
        kind: "range",
        min: 6,
        max: 20,
        step: 1,
        value: 12,
        set: (v) => {
          params.bars = v as number;
        },
      },
      {
        key: "snappiness",
        label: "race snappiness",
        kind: "range",
        min: 0.3,
        max: 3,
        step: 0.1,
        value: 1,
        set: (v) => {
          params.snappiness = v as number;
        },
      },
    ],
  };
}
