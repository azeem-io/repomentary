"use client";

import CodeInsights from "@/components/CodeInsights";
import CommitPatterns from "@/components/CommitPatterns";
import ContributorBoard from "@/components/ContributorBoard";
import { TransitionLink } from "@/components/PageTransition";
import RepoStats from "@/components/RepoStats";
import { REPO_DATASETS } from "@/lib/realHistory";

const chipClass =
  "rounded-md border border-star/15 px-3 py-1.5 font-mono text-[11px] tracking-[0.14em] uppercase transition-colors";

export default function InsightsView({ id }: { id: string }) {
  const ds = REPO_DATASETS.find((d) => d.id === id);

  return (
    <div className="min-h-dvh">
      <nav className="sticky top-0 z-20 border-b border-star/10 bg-void/80 backdrop-blur">
        <div className="mx-auto flex max-w-5xl items-center justify-between gap-4 px-6 py-3">
          <TransitionLink
            href="/"
            direction="back"
            className="font-mono text-[11px] tracking-[0.14em] text-dim uppercase transition-colors hover:text-star"
          >
            ← repomentary
          </TransitionLink>
          <div className="flex flex-wrap items-center justify-end gap-1.5">
            {REPO_DATASETS.map((d) => (
              <TransitionLink
                key={d.id}
                href={`/insights/${d.id}`}
                direction="forward"
                className={`${chipClass} ${
                  d.id === id
                    ? "border-amber/60 text-amber"
                    : "text-dim hover:border-star/40 hover:text-star"
                }`}
              >
                {d.id}
              </TransitionLink>
            ))}
          </div>
        </div>
      </nav>

      <main className="mx-auto max-w-5xl px-6">
        <header className="py-12">
          <p className="font-mono text-[11px] tracking-[0.2em] text-faint uppercase">insights</p>
          <h1 className="mt-2 font-display text-4xl font-extrabold tracking-tight sm:text-5xl">
            {ds?.label ?? id}
          </h1>
          <p className="mt-2 font-mono text-xs tracking-[0.14em] text-dim uppercase">
            {ds?.hint ?? ""}
          </p>
        </header>

        <RepoStats datasetId={id} />
        <CommitPatterns datasetId={id} />
        <ContributorBoard datasetId={id} />
        <CodeInsights datasetId={id} />
      </main>

      <footer className="mt-6 border-t border-star/10">
        <div className="mx-auto flex max-w-5xl items-center justify-between px-6 py-5">
          <TransitionLink
            href="/"
            direction="back"
            className="font-mono text-[11px] tracking-[0.14em] text-dim uppercase transition-colors hover:text-star"
          >
            ← back to films
          </TransitionLink>
          <p className="font-mono text-[10px] tracking-[0.16em] text-faint uppercase">
            derived from git history · no api
          </p>
        </div>
      </footer>
    </div>
  );
}
