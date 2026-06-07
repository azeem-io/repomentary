/**
 * Layout stress test: a synthetic file tree (10k nodes by default) under
 * d3-force, rendered as Pixi sprites. Measures simulation tick cost against
 * render cost, since layout is the likely bottleneck later on.
 *
 * Click applies a radial impulse. L toggles links. ?n=20000 changes count.
 */
import { mulberry32, type Rng } from "@repomentary/artifact";
import {
  forceLink,
  forceManyBody,
  forceSimulation,
  forceX,
  forceY,
  type SimulationLinkDatum,
  type SimulationNodeDatum,
} from "d3-force";
import { Container, Graphics, Sprite } from "pixi.js";
import { bootPixi, makeDotTexture, type SketchInstance } from "./common";

const VOID = "#07091a";
const DEPTH_TINTS = [0xffffff, 0x9a8cff, 0x6d5dfc, 0x8fd0ff, 0xc9d4ff, 0xe8ecff];

interface TreeNode extends SimulationNodeDatum {
  depth: number;
  sprite?: Sprite;
}
type TreeLink = SimulationLinkDatum<TreeNode>;

export async function createSketch(
  host: HTMLElement,
  signal?: AbortSignal,
): Promise<SketchInstance> {
  const boot = await bootPixi(host, VOID);
  if (signal?.aborted) {
    boot.destroy();
    throw new DOMException("cancelled", "AbortError");
  }
  const { app, world, hud, reducedMotion } = boot;

  const params = new URLSearchParams(globalThis.location?.search ?? "");
  const requested = Number.parseInt(params.get("n") ?? "10000", 10);
  const nodeCount = Math.max(100, Math.min(Number.isNaN(requested) ? 10000 : requested, 30000));

  const rng: Rng = mulberry32(99);
  const dotTex = makeDotTexture(16);

  /* --------------------------- synthetic file tree --------------------------- */

  const nodes: TreeNode[] = [{ depth: 0, x: 0, y: 0 }];
  const links: TreeLink[] = [];
  for (let i = 1; i < nodeCount; i++) {
    // Bias toward attaching to recent nodes → organic, deep directory shapes.
    const parentIndex =
      rng() < 0.6 ? Math.max(0, i - 1 - Math.floor(rng() * 50)) : Math.floor(rng() * i);
    const parent = nodes[parentIndex];
    const depth = (parent?.depth ?? 0) + 1;
    const angle = rng() * Math.PI * 2;
    const radius = 30 + depth * 18 + rng() * 40;
    nodes.push({
      depth,
      x: (parent?.x ?? 0) + Math.cos(angle) * radius * 0.2,
      y: (parent?.y ?? 0) + Math.sin(angle) * radius * 0.2,
    });
    links.push({ source: parentIndex, target: i });
  }

  /* ------------------------------- simulation -------------------------------- */

  const simulation = forceSimulation<TreeNode>(nodes)
    .force(
      "link",
      forceLink<TreeNode, TreeLink>(links)
        .distance(
          (l) => 10 + 26 / Math.sqrt(1 + (typeof l.target === "object" ? l.target.depth : 1)),
        )
        .strength(0.5),
    )
    .force("charge", forceManyBody<TreeNode>().strength(-7).theta(0.95).distanceMax(320))
    .force("x", forceX<TreeNode>(0).strength(0.015))
    .force("y", forceY<TreeNode>(0).strength(0.015))
    .alphaDecay(reducedMotion ? 0.04 : 0.005)
    .alphaTarget(reducedMotion ? 0 : 0.05)
    .stop(); // we tick manually inside the render loop

  /* --------------------------------- render ---------------------------------- */

  const linkGfx = new Graphics();
  const nodeLayer = new Container();
  world.addChild(linkGfx, nodeLayer);

  for (const node of nodes) {
    const sprite = new Sprite(dotTex);
    sprite.anchor.set(0.5);
    const depthTint = DEPTH_TINTS[Math.min(node.depth, DEPTH_TINTS.length - 1)] ?? 0xffffff;
    sprite.tint = depthTint;
    const size = node.depth === 0 ? 0.9 : Math.max(0.12, 0.42 - node.depth * 0.05);
    sprite.scale.set(size);
    sprite.alpha = node.depth === 0 ? 1 : 0.85;
    nodeLayer.addChild(sprite);
    node.sprite = sprite;
  }

  let showLinks = nodeCount <= 6000;
  const onKey = (ev: KeyboardEvent) => {
    if (ev.code === "KeyL") {
      showLinks = !showLinks;
      if (!showLinks) linkGfx.clear();
    }
  };
  window.addEventListener("keydown", onKey);

  app.stage.eventMode = "static";
  app.stage.hitArea = app.screen;
  const onTap = (event: { global: { x: number; y: number } }) => {
    // Convert to world space (world is centered) and shove nearby nodes.
    const wx = event.global.x - app.screen.width / 2;
    const wy = event.global.y - app.screen.height / 2;
    const radius = 220;
    for (const node of nodes) {
      const dx = (node.x ?? 0) - wx;
      const dy = (node.y ?? 0) - wy;
      const d = Math.hypot(dx, dy);
      if (d < radius && d > 0.01) {
        const force = (1 - d / radius) * 18;
        node.vx = (node.vx ?? 0) + (dx / d) * force;
        node.vy = (node.vy ?? 0) + (dy / d) * force;
      }
    }
    simulation.alpha(Math.max(simulation.alpha(), 0.5));
  };
  app.stage.on("pointertap", onTap);

  /* -------------------------------- frame loop -------------------------------- */

  const tickTimes: number[] = [];

  const tick = () => {
    const dtMs = Math.min(app.ticker.deltaMS, 50);

    const t0 = performance.now();
    simulation.tick();
    const tickMs = performance.now() - t0;
    tickTimes.push(tickMs);
    if (tickTimes.length > 30) tickTimes.shift();
    const avgTick = tickTimes.reduce((a, b) => a + b, 0) / tickTimes.length;

    for (const node of nodes) {
      node.sprite?.position.set(node.x ?? 0, node.y ?? 0);
    }

    if (showLinks) {
      linkGfx.clear();
      for (const link of links) {
        const s = link.source as TreeNode;
        const t = link.target as TreeNode;
        linkGfx.moveTo(s.x ?? 0, s.y ?? 0).lineTo(t.x ?? 0, t.y ?? 0);
      }
      linkGfx.stroke({ color: 0x6d5dfc, alpha: 0.16, width: 1 });
    }

    // Keep the tree centered.
    world.position.set(app.screen.width / 2, app.screen.height / 2);

    hud.update(
      dtMs,
      `${nodeCount} nodes · sim ${avgTick.toFixed(1)}ms/tick · links ${showLinks ? "on" : "off"} (L)`,
    );
  };

  app.ticker.add(tick);

  return {
    destroy() {
      window.removeEventListener("keydown", onKey);
      simulation.stop();
      boot.destroy();
    },
  };
}
