import DatasetPicker from "@/components/DatasetPicker";
import HomeHero from "@/components/HomeHero";
import InsightsLink from "@/components/InsightsLink";
import { TransitionLink } from "@/components/PageTransition";
import PosterImg from "@/components/PosterImg";
import RepoStats from "@/components/RepoStats";

const GITHUB_URL = "https://github.com/azeem-io/repomentary";

const styles = [
  {
    id: "civilization",
    name: "Civilization",
    blurb:
      "Folders are cities on a night map. Merges send caravans, and the top contributor wears a crown.",
  },
  {
    id: "city",
    name: "City",
    blurb:
      "A skyline in time-lapse. Files are buildings, branches are cranes, releases get fireworks.",
  },
  {
    id: "gource",
    name: "Gource",
    blurb:
      "A browser remake of Gource. Contributors fly the file tree and zap every file they touch.",
  },
  {
    id: "race",
    name: "Race",
    blurb:
      "A contributor bar-chart race over a streamgraph of activity. No metaphors, just charts.",
  },
  {
    id: "planet",
    name: "Planet",
    blurb: "A flat planet whose territories are directories. Branches orbit until they merge home.",
  },
] as const;

function Wordmark({ size }: { size: "nav" | "hero" }) {
  return (
    <span
      className={
        size === "nav"
          ? "font-display text-lg font-bold tracking-tight"
          : "font-display text-6xl font-extrabold tracking-tight sm:text-7xl md:text-8xl"
      }
    >
      repomentary<span className="text-amber">.</span>
    </span>
  );
}

export default function Home() {
  return (
    <div className="min-h-dvh">
      <nav className="animate-fade sticky top-0 z-20 border-b border-star/10 bg-void/80 backdrop-blur">
        <div className="mx-auto flex max-w-5xl items-center justify-between px-6 py-3">
          <Wordmark size="nav" />
          <div className="flex items-center gap-2">
            <a
              href="#styles"
              className="hidden px-3 py-1.5 font-mono text-[11px] tracking-[0.18em] text-dim uppercase transition-colors hover:text-star sm:block"
            >
              styles
            </a>
            <div className="hidden sm:block">
              <DatasetPicker />
            </div>
            <a
              href={GITHUB_URL}
              className="rounded-md border border-star/15 px-3 py-1.5 font-mono text-[11px] tracking-[0.18em] text-dim uppercase transition-colors hover:border-star/40 hover:text-star"
            >
              github
            </a>
          </div>
        </div>
      </nav>

      <main className="mx-auto max-w-5xl px-6">
        <header className="flex flex-col items-center pt-20 pb-14 text-center sm:pt-28">
          <h1 className="animate-rise">
            <Wordmark size="hero" />
          </h1>
          <p className="mt-6 max-w-md animate-rise font-serif text-2xl leading-snug text-cream [animation-delay:90ms] sm:text-3xl">
            Git history, played back as a film you can scrub.
          </p>
          <div className="mt-10 w-full animate-rise [animation-delay:180ms]">
            <HomeHero />
          </div>
        </header>

        <RepoStats />
        <InsightsLink />

        <section id="styles" className="scroll-mt-20 pt-16 pb-20">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <h2 className="font-display text-3xl font-bold">Now Showing</h2>
            <p className="font-mono text-[11px] tracking-[0.2em] text-faint uppercase">
              five styles, one history · select one to screen
            </p>
          </div>

          <ul className="mt-8 grid gap-x-8 gap-y-12 sm:grid-cols-2">
            {styles.map((s, i) => (
              <li key={s.id}>
                <TransitionLink
                  href={`/sketches/${s.id}`}
                  direction="forward"
                  className="group block"
                >
                  <div className="relative aspect-video overflow-hidden rounded-lg border border-star/10 bg-deep transition-colors group-hover:border-star/25">
                    <PosterImg id={s.id} name={s.name} />
                    <span className="absolute top-3 left-3 rounded border border-amber/50 bg-void/60 px-2 py-0.5 font-mono text-[10px] tracking-[0.15em] text-amber">
                      {String(i + 1).padStart(2, "0")} / {styles.length}
                    </span>
                  </div>
                  <div className="mt-4 flex items-baseline justify-between gap-4">
                    <h3 className="font-display text-xl font-semibold">
                      <span className="bg-gradient-to-r from-amber to-amber bg-[length:0%_1px] bg-left-bottom bg-no-repeat pb-0.5 transition-[background-size] duration-300 group-hover:bg-[length:100%_1px]">
                        {s.name}
                      </span>
                    </h3>
                    <span className="shrink-0 font-mono text-[11px] tracking-[0.18em] text-amber uppercase opacity-80 transition-opacity group-hover:opacity-100">
                      ▶ press play
                    </span>
                  </div>
                  <p className="mt-2 max-w-md font-mono text-[13px] leading-relaxed text-dim">
                    {s.blurb}
                  </p>
                </TransitionLink>
              </li>
            ))}
          </ul>
        </section>
      </main>

      <footer className="border-t border-star/10">
        <div className="mx-auto flex max-w-5xl flex-wrap items-center justify-between gap-3 px-6 py-5">
          <p className="font-mono text-[10px] tracking-[0.18em] text-faint uppercase">
            repomentary · early development · MIT · src: git log --raw · pixijs · webgpu
          </p>
          <a
            href={GITHUB_URL}
            className="rounded-md border border-star/15 px-3 py-1.5 font-mono text-[10px] tracking-wide text-dim whitespace-nowrap transition-colors hover:border-star/40 hover:text-star"
          >
            ★ github.com/azeem-io/repomentary
          </a>
        </div>
      </footer>
    </div>
  );
}
