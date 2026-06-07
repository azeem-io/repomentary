# repomentary

Turn any GitHub repository's history into an animated film you can watch,
scrub, and share in the browser.

Paste a repo URL, get back its whole life: directories growing, contributors
arriving and leaving, releases landing, dead code rotting away. That's the
goal. The name is a working title.

> **Status: early development.** The rendering experiments work on real data
> from a handful of bundled repos. The pipeline that ingests an arbitrary
> GitHub URL comes next, so this is not usable as a product yet. Watch the
> repo if you want to follow along.

## Motion sketches

Before committing to one visual style, I'm building several competing ones as
standalone "sketches". Each is a full renderer over the same event stream,
with a shared chrome: sidebar with live stats and a contributor leaderboard,
date display, and a timeline you can scrub. Playback supports pause, fast
forward, and jumping anywhere in history. There is a dropdown to switch
between the bundled repos (vite, react, svelte, express, chrono).

| Sketch | The repo as... |
|---|---|
| `/sketches/civilization` | a top-down empire. Folders are cities, commits raise rooftops, merges send caravans, the top contributor wears a crown |
| `/sketches/city` | a skyline in time-lapse, with construction cranes for branches and a day/night cycle per repo-year |
| `/sketches/gource` | a force-directed file tree, after Andrew Caudwell's Gource |
| `/sketches/race` | a contributor bar chart race over a directory streamgraph. No metaphors, just charts |
| `/sketches/rain` | drops falling into rising water, with real spring-wave physics |
| `/sketches/planet` | a living world whose territories are directories |
| `/sketches/layout-test` | a 10k-node force layout stress test |

Most things respond to hovering and clicking, and a tuning panel exposes each
sketch's parameters.

## How it works

Ingestion is designed to happen once per repo version, not per viewer. A
worker does a bare, blob-less clone (`git clone --bare --filter=blob:none`)
and walks `git log --raw`, which compares tree entries by hash and never
downloads file contents. For vitejs/vite that means 9,308 commits fetched in
about 30 seconds and 16 MB, compiled into a 1.3 MB JSON artifact.

The artifact is the contract between the data side and the visual side:
sketches and films only ever consume events (commit, merge, release, mass
delete, new contributor), never raw git data. Artifacts get cached in object
storage and served with zero egress fees, so a repo going viral costs about
as much as a popular static file.

Rendering happens entirely client-side with PixiJS v8, targeting 60fps on
mid-range hardware. WebGPU where available, WebGL otherwise, and
reduced-motion preferences are respected.

## Running locally

You need Node 22+ and pnpm (the exact version is pinned in `package.json`).

```bash
git clone <this repo>
cd repomentary
pnpm install
pnpm dev        # http://localhost:3000
```

Other commands:

```bash
pnpm check      # lint + format (Biome)
pnpm typecheck
pnpm build
pnpm preview    # production build in the Workers runtime
pnpm deploy     # deploy to Cloudflare Workers
```

To extract a new repo's history for the sketches:

```bash
git clone --bare --filter=blob:none https://github.com/OWNER/NAME.git /tmp/name.git
node apps/worker/scripts/extract-history.mjs /tmp/name.git OWNER/NAME apps/web/public/data/name.json
```

then register it in `apps/web/src/lib/realHistory.ts`.

## Project structure

| Path | Contents |
|---|---|
| `apps/web` | Next.js app: site, sketches, and eventually the player |
| `apps/worker` | ingestion worker (placeholder) and the extraction script |
| `packages/artifact` | event/artifact types plus a synthetic history generator |

## Roadmap

1. Foundation and visual identity (where things are now)
2. Ingestion pipeline for arbitrary GitHub URLs
3. The film itself: one polished visual direction with cinematic pacing
4. Sharing and launch
5. Accounts and saved repos
6. Embeds and themes
7. Video export

## Contributing

Everything is still in flux, so large PRs will probably collide with ongoing
rewrites. Issues and ideas are welcome. If you want to build something bigger, open an
issue first so we can talk.

## Credits

The gource sketch is a from-scratch homage to [Gource](https://gource.io) by
Andrew Caudwell. Bundled sample histories come from the public repos of vite,
react, svelte, express, and chrono.

## License

[MIT](LICENSE)
