/**
 * Shared in-canvas chrome for the sketches: date block and month tape up
 * top, an activity timeline with release/delete markers at the bottom, and
 * a right sidebar with stats, top contributors, and an event feed. Drawn
 * in-canvas so screen recordings capture it. Optionally clips a container
 * to the content area and reports timeline scrubs through onSeek.
 */
import type { RepoEvent, SyntheticHistory } from "@repomentary/artifact";
import { Container, Graphics, Text } from "pixi.js";

const MONTHS = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];
const PANEL_BG = 0x0a0d22;
const INK = 0xe8ecff;
const DIM = 0x8c93b8;

export interface ChromeOptions {
  repoName: string;
  accent: number;
  reducedMotion: boolean;
  /** Timeline scrubbing: called with the target fraction on click/drag-end. */
  onSeek?: (frac: number) => void;
  /** Container to clip to the content area (so the viz never bleeds under
   *  the sidebar or timeline). Usually the sketch's `world`. */
  clip?: Container;
}

interface FeedItem {
  text: Text;
  age: number;
  slide: number;
}

/** Positional leaderboard row, rank i; occupants swap in/out as counts change. */
interface BoardRow {
  authorIdx: number;
  name: Text;
  value: Text;
  bar: number;
}

interface Marker {
  p: number;
  kind: "release" | "delete";
  label?: string;
  text?: Text;
}

function mix(a: number, b: number, k: number): number {
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

export class FilmChrome {
  readonly sidebarWidth = 252;
  readonly timelineHeight = 56;

  private root = new Container();
  private gfx = new Graphics();

  // date block
  private yearText: Text;
  private dayText: Text;
  private ageText: Text;
  private tapeGfx = new Graphics();
  private tapeLabels: Text[] = [];
  private monthSlide = 0;
  private yearPop = 0;
  private lastMonth = -1;
  private lastYear = -1;

  // sidebar
  private title: Text;
  private hero: Text;
  private heroSub: Text;
  private statTexts: Text[] = [];
  private counts = new Map<number, number>();
  private rowPool: BoardRow[] = [];
  private boardTitle: Text;
  private feedTitle: Text;
  private feed: FeedItem[] = [];

  // timeline
  private markers: Marker[] = [];
  private histogram: number[] = [];

  // release card (big, bold, center stage)
  private releaseCard: Text | null = null;
  private releaseCardAge = 99999;

  // scrub + clip
  private contentMask: Graphics | null = null;
  private scrubHit: Graphics | null = null;
  private scrubFrac: number | null = null;
  private scrubText: Text | null = null;
  private lastContentW = 1;

  // counters
  private commitCount = 0;
  private heroShown = 0;
  private branchNames = new Map<number, string>();

  constructor(
    ui: Container,
    private history: SyntheticHistory,
    private opts: ChromeOptions,
  ) {
    ui.addChild(this.root);
    this.root.addChild(this.gfx, this.tapeGfx);

    // clip the viz to the content area so it can't bleed under the chrome
    if (opts.clip) {
      this.contentMask = new Graphics();
      this.root.addChild(this.contentMask);
      opts.clip.mask = this.contentMask;
    }

    // The timeline doubles as a scrub slider.
    if (opts.onSeek) {
      this.scrubHit = new Graphics();
      this.scrubHit.eventMode = "static";
      this.scrubHit.cursor = "pointer";
      this.root.addChild(this.scrubHit);
      const fracAt = (gx: number): number =>
        Math.max(0, Math.min(1, (gx - 18) / Math.max(1, this.lastContentW - 36)));
      this.scrubHit.on("pointerdown", (e) => {
        e.stopPropagation(); // keep timeline clicks out of the world handlers
        this.scrubFrac = fracAt(e.global.x);
      });
      this.scrubHit.on("pointermove", (e) => {
        if (this.scrubFrac === null) return;
        e.stopPropagation();
        this.scrubFrac = fracAt(e.global.x);
      });
      const commit = (e: { global: { x: number }; stopPropagation(): void }) => {
        if (this.scrubFrac === null) return;
        e.stopPropagation();
        this.opts.onSeek?.(fracAt(e.global.x));
        this.scrubFrac = null;
      };
      this.scrubHit.on("pointerup", commit);
      this.scrubHit.on("pointerupoutside", commit);
    }

    const mono = (size: number, fill: number, anchorX = 0, anchorY = 0): Text => {
      const t = new Text({
        text: "",
        style: { fontFamily: "monospace", fontSize: size, fill, align: "left" },
      });
      t.anchor.set(anchorX, anchorY);
      this.root.addChild(t);
      return t;
    };

    this.yearText = mono(34, INK, 0.5);
    this.dayText = mono(13, this.opts.accent, 0.5);
    this.ageText = mono(10, DIM, 0.5);
    this.title = mono(13, INK);
    this.hero = mono(30, INK, 1, 0);
    this.heroSub = mono(10, DIM, 1, 0);
    this.boardTitle = mono(10, DIM);
    this.boardTitle.text = "TOP CONTRIBUTORS";
    this.feedTitle = mono(10, DIM);
    this.feedTitle.text = "EVENTS";
    this.title.text = this.opts.repoName;

    // Activity histogram (commits weighted 1, merges 2.5) in 64 buckets.
    const buckets = new Array<number>(64).fill(0);
    for (const e of this.history.events) {
      const w = e.kind === "commit" ? 1 : e.kind === "merge" ? 2.5 : 0;
      if (w === 0) continue;
      const i = Math.min(63, Math.floor((e.t / this.history.duration) * 64));
      buckets[i] = (buckets[i] ?? 0) + w;
    }
    const peak = Math.max(1, ...buckets);
    this.histogram = buckets.map((b) => b / peak);

    // Timeline markers.
    for (const e of this.history.events) {
      if (e.kind === "release") {
        this.markers.push({ p: e.t / this.history.duration, kind: "release", label: e.label });
      } else if (e.kind === "massDelete") {
        this.markers.push({ p: e.t / this.history.duration, kind: "delete" });
      }
    }
    // Skip label text that would overlap the previous label; repos often
    // ship several releases close together. Diamonds still mark every one.
    let lastLabelP = -1;
    const minGap = 0.035;
    for (const m of this.markers) {
      if (m.kind !== "release" || !m.label) continue;
      if (m.p - lastLabelP < minGap) continue;
      lastLabelP = m.p;
      m.text = mono(9, this.opts.accent, 0.5, 1);
      m.text.text = m.label;
    }
  }

  /** Feed + counters + leaderboard. Call for every history event. */
  onEvent(e: RepoEvent): void {
    switch (e.kind) {
      case "commit":
        this.commitCount++;
        this.bumpAuthor(e.author, 1);
        return; // plain commits stay out of the feed (too chatty)
      case "branchStart":
        if (e.branch && e.label) this.branchNames.set(e.branch, e.label);
        this.pushFeed(`+ ${e.label ?? "branch"} opened`);
        return;
      case "merge": {
        this.bumpAuthor(e.author, 2);
        const name = e.label ?? (e.branch ? this.branchNames.get(e.branch) : undefined);
        this.pushFeed(`⊕ ${name ?? "branch"} merged`);
        return;
      }
      case "release":
        this.pushFeed(`⟡ ${e.label ?? "release"} shipped`);
        this.announceRelease(e.label ?? "release");
        return;
      case "massDelete":
        this.pushFeed(`⌫ big cleanup (${Math.round(e.magnitude * 100)}%)`);
        return;
      case "newContributor":
        this.pushFeed(`✦ ${e.label ?? "someone"} joined`);
        return;
    }
  }

  /** A release takes center stage: big, bold, brief. */
  private announceRelease(label: string): void {
    if (!this.releaseCard) {
      this.releaseCard = new Text({
        text: "",
        style: {
          fontFamily: "monospace",
          fontSize: 52,
          fontWeight: "bold",
          fill: this.opts.accent,
          align: "center",
        },
      });
      this.releaseCard.anchor.set(0.5);
      this.releaseCard.alpha = 0;
      this.root.addChild(this.releaseCard);
    }
    this.releaseCard.text = `⟡ ${label}`;
    this.releaseCardAge = 0;
  }

  /** Clears counters, the leaderboard, and the feed (era restarts). */
  reset(): void {
    this.commitCount = 0;
    this.heroShown = 0;
    this.branchNames.clear();
    this.counts.clear();
    for (const f of this.feed) f.text.destroy();
    this.feed = [];
  }

  contentWidth(screenW: number): number {
    return screenW - this.sidebarWidth;
  }

  contentHeight(screenH: number): number {
    return screenH - this.timelineHeight;
  }

  private bumpAuthor(author: number, amount: number): void {
    // Counts for everyone (scales to thousands of authors); Text objects
    // exist only for the five displayed rows.
    this.counts.set(author, (this.counts.get(author) ?? 0) + amount);
  }

  private shortName(author: number): string {
    const full = this.history.authors[author] ?? "anon";
    const parts = full.split(" ");
    return parts.length > 1 ? `${parts[0]} ${(parts[1] ?? " ").charAt(0)}.` : full.slice(0, 14);
  }

  private pushFeed(message: string): void {
    const text = new Text({
      text: message,
      style: { fontFamily: "monospace", fontSize: 11, fill: INK },
    });
    text.alpha = 0;
    this.root.addChild(text);
    this.feed.unshift({ text, age: 0, slide: 1 });
    while (this.feed.length > 6) {
      const dead = this.feed.pop();
      dead?.text.destroy();
    }
  }

  /** Call once per frame after the sketch's own update. */
  update(
    dtMs: number,
    screenW: number,
    screenH: number,
    progress: number,
    stats: [string, string | number][],
  ): void {
    const accent = this.opts.accent;
    const sbX = screenW - this.sidebarWidth;
    const contentW = sbX;
    const tlY = screenH - this.timelineHeight;

    this.gfx.clear();

    /* ---------------- date block + tape (top-center of content) ---------------- */

    const dateMs = this.history.startDateMs + progress * this.history.spanMs;
    const date = new Date(dateMs);
    const month = date.getUTCMonth();
    const year = date.getUTCFullYear();

    if (this.lastMonth !== -1 && month !== this.lastMonth) this.monthSlide = 1;
    if (this.lastYear !== -1 && year !== this.lastYear) this.yearPop = 1;
    this.lastMonth = month;
    this.lastYear = year;
    const decay = this.opts.reducedMotion ? 1 : Math.min(1, dtMs / 320);
    this.monthSlide = Math.max(0, this.monthSlide - decay);
    this.yearPop = Math.max(0, this.yearPop - Math.min(1, dtMs / 480));

    const dcx = contentW / 2;
    this.yearText.text = String(year);
    this.yearText.position.set(dcx, 18 - this.yearPop * 3);
    this.yearText.scale.set(1 + this.yearPop * 0.18);
    this.yearText.tint = mix(INK, accent, this.yearPop);

    this.dayText.text = `${MONTHS[month]} ${String(date.getUTCDate()).padStart(2, "0")}`;
    this.dayText.position.set(dcx, 54 + this.monthSlide * 8);
    this.dayText.alpha = 1 - this.monthSlide * 0.8;

    const ageMs = dateMs - this.history.startDateMs;
    const ageY = Math.floor(ageMs / (365.25 * 24 * 3600e3));
    const ageM = Math.floor((ageMs % (365.25 * 24 * 3600e3)) / (30.44 * 24 * 3600e3));
    this.ageText.text = `repo age ${ageY}y ${ageM}m`;
    this.ageText.position.set(dcx, 72);

    // Timeline tape: months stream past a fixed caret.
    const tape = this.tapeGfx;
    tape.clear();
    const tapeW = 230;
    const tapeY = 112;
    const spacing = 16;
    const monthsTotal = this.history.spanMs / (30.44 * 24 * 3600e3);
    const cursor = progress * monthsTotal;
    const startMonthAbs = new Date(this.history.startDateMs).getUTCMonth();
    let li = 0;
    for (let m = Math.floor(cursor - tapeW / 2 / spacing); m <= cursor + tapeW / 2 / spacing; m++) {
      if (m < 0) continue;
      const x = dcx + (m - cursor) * spacing;
      const edge = 1 - Math.min(1, Math.abs(x - dcx) / (tapeW / 2));
      if (edge <= 0.02) continue;
      const isYear = (startMonthAbs + m) % 12 === 0;
      const h = isYear ? 13 : 6;
      tape.moveTo(x, tapeY - h).lineTo(x, tapeY);
      tape.stroke({ color: isYear ? INK : DIM, alpha: edge * (isYear ? 0.9 : 0.45), width: 1 });
      if (isYear) {
        let label = this.tapeLabels[li];
        if (!label) {
          label = new Text({
            text: "",
            style: { fontFamily: "monospace", fontSize: 9, fill: DIM },
          });
          label.anchor.set(0.5, 0);
          this.root.addChild(label);
          this.tapeLabels.push(label);
        }
        label.visible = true;
        label.text = String(
          new Date(this.history.startDateMs).getUTCFullYear() +
            Math.round((startMonthAbs + m) / 12),
        );
        label.position.set(x, tapeY + 3);
        label.alpha = edge * 0.8;
        li++;
      }
    }
    for (let i = li; i < this.tapeLabels.length; i++) {
      const label = this.tapeLabels[i];
      if (label) label.visible = false;
    }
    // Fixed caret marking "now".
    tape.moveTo(dcx, tapeY - 18).lineTo(dcx, tapeY + 2);
    tape.stroke({ color: accent, alpha: 0.95, width: 2 });

    /* ----------------------------- release card ----------------------------- */

    if (this.releaseCard) {
      this.releaseCardAge += dtMs;
      const k = Math.min(1, this.releaseCardAge / 3000);
      const fadeIn = Math.min(1, this.releaseCardAge / 260);
      const fadeOut = k > 0.78 ? Math.max(0, (1 - k) / 0.22) : 1;
      this.releaseCard.alpha = fadeIn * fadeOut * 0.95;
      const pop = 0.92 + 0.08 * Math.min(1, this.releaseCardAge / 420);
      this.releaseCard.scale.set(pop);
      this.releaseCard.position.set(contentW / 2, screenH * 0.4);
      this.releaseCard.tint = mix(this.opts.accent, 0xffffff, 0.25);
    }

    /* ------------------------------- sidebar ------------------------------- */

    this.gfx.rect(sbX, 0, this.sidebarWidth, screenH).fill({ color: PANEL_BG, alpha: 0.82 });
    this.gfx.moveTo(sbX, 0).lineTo(sbX, screenH).stroke({ color: accent, alpha: 0.25, width: 1 });

    const pad = sbX + 18;
    this.title.position.set(pad, 16);

    // Hero counter (rolling).
    this.heroShown += (this.commitCount - this.heroShown) * Math.min(1, dtMs / 260);
    this.hero.text = Math.round(this.heroShown).toLocaleString("en-US");
    this.hero.position.set(screenW - 18, 38);
    this.heroSub.text = "commits this era";
    this.heroSub.position.set(screenW - 18, 74);

    // Stats grid.
    let sy = 100;
    stats.forEach(([label, value], i) => {
      let t = this.statTexts[i];
      if (!t) {
        t = new Text({
          text: "",
          style: { fontFamily: "monospace", fontSize: 11, fill: DIM },
        });
        this.root.addChild(t);
        this.statTexts.push(t);
      }
      t.visible = true;
      t.text = `${label.padEnd(10, " ")} ${String(value)}`;
      t.position.set(pad, sy);
      sy += 17;
    });
    for (let i = stats.length; i < this.statTexts.length; i++) {
      const t = this.statTexts[i];
      if (t) t.visible = false;
    }

    /* --------------------------- leaderboard --------------------------- */

    const boardY = sy + 14;
    this.boardTitle.position.set(pad, boardY);
    const top = [...this.counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5);
    const maxCount = Math.max(1, top[0]?.[1] ?? 1);
    const rowH = 21;
    for (let rank = 0; rank < 5; rank++) {
      let row = this.rowPool[rank];
      if (!row) {
        const name = new Text({
          text: "",
          style: { fontFamily: "monospace", fontSize: 11, fill: INK },
        });
        const value = new Text({
          text: "",
          style: { fontFamily: "monospace", fontSize: 11, fill: DIM },
        });
        value.anchor.set(1, 0);
        this.root.addChild(name, value);
        row = { authorIdx: -1, name, value, bar: 0 };
        this.rowPool.push(row);
      }
      const entry = top[rank];
      const show = entry !== undefined && entry[1] > 0;
      row.name.visible = show;
      row.value.visible = show;
      if (!show || !entry) continue;
      const [authorIdx, count] = entry;
      if (row.authorIdx !== authorIdx) {
        row.authorIdx = authorIdx;
        row.name.text = this.shortName(authorIdx);
      }
      const y = boardY + 16 + rank * rowH;
      row.bar += (count / maxCount - row.bar) * Math.min(1, dtMs / 300);
      this.gfx
        .roundRect(pad, y + 1, Math.max(2, row.bar * (this.sidebarWidth - 36)), 13, 3)
        .fill({ color: accent, alpha: 0.16 + 0.1 * row.bar });
      row.name.position.set(pad + 4, y);
      row.value.text = count.toLocaleString("en-US");
      row.value.position.set(screenW - 18, y);
    }

    /* ------------------------------ event feed ------------------------------ */

    const feedY = boardY + 16 + 5 * rowH + 16;
    this.feedTitle.position.set(pad, feedY);
    let fy = feedY + 16;
    for (const item of this.feed) {
      item.age += dtMs;
      item.slide = Math.max(0, item.slide - Math.min(1, dtMs / 280));
      const fade = item.age > 6000 ? Math.max(0, 1 - (item.age - 6000) / 1500) : 1;
      item.text.alpha = (1 - item.slide) * fade * 0.92;
      item.text.position.set(pad + item.slide * 14, fy);
      fy += 18;
    }

    /* ------------------------------- timeline ------------------------------- */

    const tlX0 = 18;
    const tlX1 = contentW - 18;
    const tlW = tlX1 - tlX0;
    const tlMid = tlY + 34;
    const sparkH = 20;

    this.gfx.rect(0, tlY, contentW, this.timelineHeight).fill({ color: PANEL_BG, alpha: 0.92 });
    this.gfx.moveTo(0, tlY).lineTo(contentW, tlY).stroke({ color: accent, alpha: 0.18, width: 1 });

    // Content clip + scrub hit area track the live layout.
    this.lastContentW = contentW;
    if (this.contentMask) {
      this.contentMask.clear().rect(0, 0, contentW, tlY).fill(0xffffff);
    }
    if (this.scrubHit) {
      this.scrubHit
        .clear()
        .rect(0, tlY, contentW, this.timelineHeight)
        .fill({ color: 0xffffff, alpha: 0.0001 });
    }

    // Activity sparkline: played part bright, future part dim.
    const buckets = this.histogram.length;
    for (const part of [0, 1] as const) {
      this.gfx.moveTo(tlX0, tlMid);
      for (let i = 0; i < buckets; i++) {
        const p = i / (buckets - 1);
        const x = tlX0 + p * tlW;
        const v = this.histogram[i] ?? 0;
        this.gfx.lineTo(x, tlMid - v * sparkH);
      }
      this.gfx.lineTo(tlX1, tlMid);
      this.gfx.closePath();
      if (part === 0) {
        this.gfx.fill({ color: DIM, alpha: 0.14 });
      } else {
        // Clip the bright fill to played progress via a simple overdraw trick:
        // draw the bright path only up to the playhead bucket.
        this.gfx.fill({ color: 0x000000, alpha: 0 });
      }
    }
    const playedBuckets = Math.max(1, Math.round(progress * (buckets - 1)));
    this.gfx.moveTo(tlX0, tlMid);
    for (let i = 0; i <= playedBuckets; i++) {
      const p = i / (buckets - 1);
      const x = tlX0 + p * tlW;
      const v = this.histogram[i] ?? 0;
      this.gfx.lineTo(x, tlMid - v * sparkH);
    }
    this.gfx.lineTo(tlX0 + progress * tlW, tlMid);
    this.gfx.closePath();
    this.gfx.fill({ color: accent, alpha: 0.38 });

    // Track base line.
    this.gfx.moveTo(tlX0, tlMid).lineTo(tlX1, tlMid).stroke({ color: INK, alpha: 0.25, width: 1 });

    // Markers.
    for (const m of this.markers) {
      const x = tlX0 + m.p * tlW;
      const near = Math.abs(m.p - progress) < 0.035;
      if (m.kind === "release") {
        const s = near ? 5 : 3.6;
        this.gfx
          .poly([x, tlMid - s, x + s, tlMid, x, tlMid + s, x - s, tlMid])
          .fill({ color: accent, alpha: m.p <= progress ? 0.95 : 0.45 });
        if (m.text) {
          m.text.position.set(x, tlMid - 8);
          m.text.alpha = near ? 1 : m.p <= progress ? 0.5 : 0.25;
        }
      } else {
        this.gfx
          .moveTo(x, tlMid - 4)
          .lineTo(x, tlMid + 4)
          .stroke({ color: 0xff5d3a, alpha: m.p <= progress ? 0.8 : 0.35, width: 2 });
      }
    }

    // Playhead.
    const px = tlX0 + progress * tlW;
    this.gfx
      .moveTo(px, tlY + 8)
      .lineTo(px, tlY + this.timelineHeight - 8)
      .stroke({ color: INK, alpha: 0.8, width: 1.5 });
    this.gfx.circle(px, tlMid, 3.4).fill({ color: INK, alpha: 1 });
    this.gfx.circle(px, tlMid, 7).stroke({ color: accent, alpha: 0.6, width: 1.5 });

    // ghost playhead while scrubbing, with the target date
    this.scrubText ??= (() => {
      const t = new Text({
        text: "",
        style: { fontFamily: "monospace", fontSize: 10, fill: INK },
      });
      t.anchor.set(0.5, 1);
      this.root.addChild(t);
      return t;
    })();
    if (this.scrubFrac !== null) {
      const gx = tlX0 + this.scrubFrac * tlW;
      this.gfx
        .moveTo(gx, tlY + 6)
        .lineTo(gx, tlY + this.timelineHeight - 6)
        .stroke({ color: accent, alpha: 0.9, width: 1.5 });
      this.gfx.circle(gx, tlMid, 5).stroke({ color: INK, alpha: 0.9, width: 1.5 });
      const when = new Date(this.history.startDateMs + this.scrubFrac * this.history.spanMs);
      this.scrubText.text = `${when.toLocaleString("en", { month: "short" })} ${when.getFullYear()}`;
      this.scrubText.position.set(Math.max(tlX0 + 24, Math.min(tlX1 - 24, gx)), tlY - 4);
      this.scrubText.alpha = 1;
    } else {
      this.scrubText.alpha = 0;
    }

    // Percentage bug under the playhead, clamped to the track.
    const pct = `${Math.round(progress * 100)}%`;
    this.dayTextShadow ??= (() => {
      const t = new Text({
        text: "",
        style: { fontFamily: "monospace", fontSize: 9, fill: DIM },
      });
      t.anchor.set(0.5, 0);
      this.root.addChild(t);
      return t;
    })();
    this.dayTextShadow.text = pct;
    this.dayTextShadow.position.set(Math.max(tlX0 + 12, Math.min(tlX1 - 12, px)), tlMid + 9);
  }

  private dayTextShadow: Text | undefined;
}
