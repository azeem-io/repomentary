import Link from "next/link";
import DatasetPicker from "@/components/DatasetPicker";

const sketches = [
  {
    href: "/sketches/civilization",
    name: "Civilization",
    blurb:
      "Top-level folders are cities on a night map. Commits add buildings and merges send caravans down the roads between them. The top contributor wears a crown, and folders that go quiet slowly fall apart.",
  },
  {
    href: "/sketches/race",
    name: "Race",
    blurb:
      "No metaphor here, just a bar chart race of contributors with a streamgraph of directory activity underneath.",
  },
  {
    href: "/sketches/gource",
    name: "Gource",
    blurb:
      "A remake of Gource (the Andrew Caudwell classic) running in the browser. Contributors fly around the file tree and zap every file they touch.",
  },
  {
    href: "/sketches/city",
    name: "City",
    blurb:
      "The repo as a growing skyline. Files are buildings, branches are construction cranes, and a day/night cycle tracks the years. Releases get fireworks.",
  },
  {
    href: "/sketches/rain",
    name: "Rain",
    blurb:
      "Commits fall as drops into a pool that fills up over the repo's life. Big merges hit in slow motion. Made with screen recording in mind.",
  },
  {
    href: "/sketches/planet",
    name: "Planet",
    blurb:
      "A flat planet where directories hold territory. Branches orbit until they merge back in, and releases leave permanent rings.",
  },
  {
    href: "/sketches/layout-test",
    name: "Layout stress test",
    blurb: "A 10,000 node force layout to check the frame budget. Not pretty on purpose.",
  },
] as const;

export default function Home() {
  return (
    <main className="mx-auto flex min-h-dvh max-w-3xl flex-col justify-center gap-12 px-6 py-16">
      <header className="space-y-4">
        <h1 className="text-5xl font-bold tracking-tight">repomentary</h1>
        <p className="max-w-xl text-lg text-star/70">
          Repomentary plays a GitHub repo&apos;s history back as a film you can scrub through in the
          browser. None of this is final. The sketches below are different attempts at how that film
          could look, running on real history from repos like vite and react.
        </p>
      </header>

      <section className="space-y-3">
        <div className="flex items-end justify-between">
          <h2 className="font-mono text-xs tracking-widest text-star/50 uppercase">
            Motion sketches
          </h2>
          <DatasetPicker />
        </div>
        <ul className="grid gap-3">
          {sketches.map((s) => (
            <li key={s.href}>
              <Link
                href={s.href}
                className="group block rounded-xl border border-star/10 bg-deep/60 p-5 transition-colors hover:border-star/40"
              >
                <span className="text-lg font-semibold text-star/90">{s.name}</span>
                <span className="mt-1 block text-sm text-star/60 group-hover:text-star/80">
                  {s.blurb}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      </section>
    </main>
  );
}
