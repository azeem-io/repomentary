/**
 * Race sketch: no metaphors, just charts. A contributor bar chart race with
 * eased rank swaps and a self-rescaling axis, plus a directory streamgraph
 * revealed up to the playhead underneath.
 *
 * Hover bars or bands for details. Tuning panel controls bar count and the
 * streamgraph.
 */
import type { RepoEvent } from "@repomentary/artifact";
import { Container, Graphics, Text } from "pixi.js";
import { loadSharedHistory } from "@/lib/realHistory";
import { FilmChrome } from "./chrome";
import { bootPixi, EventPlayer, FrameGovernor, type SketchInstance } from "./common";

const INK = 0xe8ecff;
const DIM = 0x8c93b8;
const ACCENT = 0x4ecdc4;
const STREAM_COLORS = [
  0x6d5dfc, 0x4ecdc4, 0xffa3c2, 0xffd28f, 0x8fd0ff, 0xa5ffd0, 0xc2a8ff, 0xff8f70, 0xb8e986,
  0x7ea6ff,
];

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

  const params = { bars: 12, snappiness: 1, stream: true };
  const governor = new FrameGovernor();
  const chrome = new FilmChrome(ui, history, {
    repoName,
    accent: ACCENT,
    reducedMotion,
    clip: world,
    onSeek: (f) => transport.seek(f),
  });

  /* ------------------------------ layer stack ------------------------------ */

  const streamGfx = new Graphics();
  const gridGfx = new Graphics();
  const barGfx = new Graphics();
  const labelLayer = new Container();
  world.addChild(streamGfx, gridGfx, barGfx, labelLayer);

  const gridLabels: Text[] = [];
  const streamLabels: Text[] = [];

  /* ------------------------- precomputed streamgraph ------------------------- */

  // Per-cluster activity in 72 time buckets (commit=1, merge=2.5).
  const BUCKETS = 72;
  const clusterCount = history.clusters;
  const streamData: number[][] = Array.from({ length: clusterCount }, () =>
    new Array<number>(BUCKETS).fill(0),
  );
  for (const e of history.events) {
    if (e.kind !== "commit" && e.kind !== "merge") continue;
    const b = Math.min(BUCKETS - 1, Math.floor((e.t / history.duration) * BUCKETS));
    const row = streamData[e.cluster % clusterCount];
    if (row) row[b] = (row[b] ?? 0) + (e.kind === "merge" ? 2.5 : 1);
  }
  // Smooth each row slightly (moving average of 3) and find column maxima.
  for (const row of streamData) {
    for (let i = 1; i < BUCKETS - 1; i++) {
      row[i] = ((row[i - 1] ?? 0) + (row[i] ?? 0) * 2 + (row[i + 1] ?? 0)) / 4;
    }
  }
  const columnTotal: number[] = new Array(BUCKETS).fill(0);
  for (let b = 0; b < BUCKETS; b++) {
    for (const row of streamData) columnTotal[b] = (columnTotal[b] ?? 0) + (row[b] ?? 0);
  }
  const maxColumn = Math.max(1, ...columnTotal);

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
    const streamH = params.stream ? Math.min(150, contentH * 0.22) : 0;

    // Chart frame.
    const chartTop = 120;
    const chartLeft = 24;
    const chartRight = contentW - 96;
    const chartBottom = contentH - streamH - 28;
    const chartW = Math.max(120, chartRight - chartLeft);

    /* ----- standings ----- */
    const top = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, Math.round(params.bars));
    const leader = top[0]?.[1] ?? 1;
    axisMax += (niceCeil(leader) - axisMax) * Math.min(1, dtMs / 900);

    const rowH = Math.min(46, (chartBottom - chartTop) / Math.max(4, top.length));
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

    /* ----- draw: streamgraph (revealed to the playhead) ----- */
    streamGfx.clear();
    let si = 0;
    if (params.stream && streamH > 0) {
      const streamTop = contentH - streamH - 8;
      const playedBuckets = Math.max(1, Math.floor(player.progress * BUCKETS));
      const bw = contentW / BUCKETS;
      // Stacked bands, bottom-up.
      const baseline = new Array<number>(playedBuckets).fill(contentH - 8);
      for (let c = 0; c < clusterCount; c++) {
        const row = streamData[c];
        if (!row) continue;
        const color = STREAM_COLORS[c % STREAM_COLORS.length] ?? ACCENT;
        const tops: number[] = [];
        for (let b = 0; b < playedBuckets; b++) {
          const h = ((row[b] ?? 0) / maxColumn) * streamH;
          tops.push((baseline[b] ?? 0) - h);
        }
        streamGfx.moveTo(0, baseline[0] ?? 0);
        for (let b = 0; b < playedBuckets; b++) {
          streamGfx.lineTo(b * bw + bw / 2, tops[b] ?? 0);
        }
        streamGfx.lineTo((playedBuckets - 1) * bw + bw / 2, baseline[playedBuckets - 1] ?? 0);
        for (let b = playedBuckets - 1; b >= 0; b--) {
          streamGfx.lineTo(b * bw + bw / 2, baseline[b] ?? 0);
        }
        streamGfx.closePath();
        streamGfx.fill({ color, alpha: 0.55 });
        for (let b = 0; b < playedBuckets; b++) baseline[b] = tops[b] ?? 0;

        // Label the band at the playhead if it's thick enough there.
        const lastTop = tops[playedBuckets - 1] ?? 0;
        const lastBase = c === 0 ? contentH - 8 : (baseline[playedBuckets - 1] ?? 0) + 0; // baseline already updated
        const thickness = Math.abs((c === 0 ? contentH - 8 : lastBase) - lastTop);
        if (thickness > 14 && si < 6) {
          let label = streamLabels[si];
          if (!label) {
            label = new Text({
              text: "",
              style: { fontFamily: "monospace", fontSize: 10, fill: INK },
            });
            label.anchor.set(1, 0.5);
            labelLayer.addChild(label);
            streamLabels.push(label);
          }
          label.visible = true;
          label.alpha = 0.8;
          label.text = `${history.clusterNames[c] ?? "?"}/`;
          label.position.set(
            Math.min((playedBuckets - 1) * bw + bw / 2 - 4, contentW - 8),
            lastTop + thickness / 2,
          );
          si++;
        }
      }
      // Divider.
      streamGfx
        .moveTo(0, streamTop - 2)
        .lineTo(contentW, streamTop - 2)
        .stroke({ color: INK, alpha: 0.1, width: 1 });
    }
    for (let i = si; i < streamLabels.length; i++) {
      const label = streamLabels[i];
      if (label) label.visible = false;
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
      {
        key: "stream",
        label: "directory streamgraph",
        kind: "toggle",
        value: true,
        set: (v) => {
          params.stream = v as boolean;
        },
      },
    ],
  };
}
