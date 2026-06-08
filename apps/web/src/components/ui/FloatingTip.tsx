/** One cursor-following tooltip for dense grids (heatmaps), instead of a Radix
 *  instance per cell. Styled to match TooltipContent. */
export function FloatingTip({ x, y, label }: { x: number; y: number; label: string }) {
  return (
    <div
      style={{ left: x, top: y }}
      className="rm-tip pointer-events-none absolute z-30 -translate-x-1/2 -translate-y-[calc(100%+8px)] rounded-md border border-border bg-popover px-2.5 py-1.5 text-center font-mono text-[11px] whitespace-nowrap text-popover-foreground shadow-lg"
    >
      {label}
    </div>
  );
}
