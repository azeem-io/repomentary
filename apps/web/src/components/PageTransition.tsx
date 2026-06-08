"use client";

import { useRouter } from "next/navigation";
import {
  createContext,
  type MouseEvent,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";

type Direction = "forward" | "back";

const NavigateContext = createContext<(href: string, dir: Direction) => void>(() => {});
const EnteringContext = createContext<boolean>(false);

/** True while the curtain covers the screen; entrance animations wait on it. */
export const useIsEntering = () => useContext(EnteringContext);

// Timing of the 920ms shutter: cover ~40%, a wider hold, then reveal.
const COVER_MS = 400; // swap the route during the hold
const TOTAL_MS = 920; // release the gate once the sweep finishes

function reducedMotion(): boolean {
  return (
    typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

/** Curtain wipe between internal pages: cover, swap the route at center, reveal.
 *  Forward goes left-to-right, back mirrors it. */
export function PageTransitionProvider({ children }: { children: ReactNode }) {
  const router = useRouter();
  const [running, setRunning] = useState(false);
  const [dir, setDir] = useState<Direction>("forward");
  const pending = useRef<string | null>(null);

  const navigate = useCallback(
    (href: string, d: Direction) => {
      if (running) return; // ignore rapid double-clicks
      if (reducedMotion()) {
        router.push(href);
        return;
      }
      pending.current = href;
      setDir(d);
      setRunning(true);
    },
    [running, router],
  );

  useEffect(() => {
    document.body.classList.toggle("rm-entering", running);
    if (!running) return;
    const swap = setTimeout(() => {
      if (pending.current) router.push(pending.current);
    }, COVER_MS);
    const reset = setTimeout(() => {
      setRunning(false);
      pending.current = null;
    }, TOTAL_MS);
    return () => {
      clearTimeout(swap);
      clearTimeout(reset);
    };
  }, [running, router]);

  return (
    <NavigateContext.Provider value={navigate}>
      <EnteringContext.Provider value={running}>
        {children}
        {running && (
          <div
            aria-hidden
            className={`fixed inset-0 z-[9700] flex items-center justify-center bg-void ${
              dir === "forward" ? "curtain-fwd" : "curtain-back"
            }`}
          >
            <span className="curtain-logo font-display text-3xl font-extrabold tracking-tight text-star">
              repomentary<span className="text-amber">.</span>
            </span>
          </div>
        )}
      </EnteringContext.Provider>
    </NavigateContext.Provider>
  );
}

interface LinkProps {
  href: string;
  direction: Direction;
  className?: string;
  children: ReactNode;
}

/** Drop-in link that plays the wipe. Modified clicks (cmd/ctrl/new-tab) and
 *  any non-primary button fall through to the browser. */
export function TransitionLink({ href, direction, className, children }: LinkProps) {
  const navigate = useContext(NavigateContext);
  const onClick = (e: MouseEvent<HTMLAnchorElement>) => {
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return;
    e.preventDefault();
    navigate(href, direction);
  };
  return (
    <a href={href} onClick={onClick} className={className}>
      {children}
    </a>
  );
}
