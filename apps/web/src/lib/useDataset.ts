"use client";

import { useEffect, useState } from "react";
import { getDatasetId } from "./realHistory";

/** The selected repo id, kept in sync across the page. null until mounted
 *  (the server can't read localStorage). Subscribes to dataset switches. */
export function useDatasetId(): string | null {
  const [id, setId] = useState<string | null>(null);
  useEffect(() => {
    setId(getDatasetId());
    const on = (e: Event) => setId((e as CustomEvent<string>).detail);
    window.addEventListener("repomentary:dataset", on);
    return () => window.removeEventListener("repomentary:dataset", on);
  }, []);
  return id;
}
