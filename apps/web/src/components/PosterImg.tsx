"use client";

import Image from "next/image";
import { useState } from "react";

interface Props {
  id: string;
  name: string;
}

/** Poster still with a quiet fallback while the real capture is missing. */
export default function PosterImg({ id, name }: Props) {
  const [missing, setMissing] = useState(false);

  if (missing) {
    return (
      <div className="flex h-full w-full items-center justify-center bg-deep">
        <span className="font-mono text-xs tracking-[0.3em] text-faint uppercase">{name}</span>
      </div>
    );
  }
  return (
    <Image
      src={`/posters/${id}.png`}
      alt={`${name} film style preview`}
      fill
      unoptimized
      sizes="(min-width: 640px) 50vw, 100vw"
      onError={() => setMissing(true)}
      className="object-cover transition-transform duration-[6000ms] ease-out group-hover:scale-[1.04] motion-reduce:transition-none motion-reduce:group-hover:scale-100"
    />
  );
}
