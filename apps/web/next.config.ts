import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  transpilePackages: ["@repomentary/artifact"],
  images: {
    // No image optimization binding configured yet (no images so far).
    unoptimized: true,
  },
};

export default nextConfig;

// Enables Cloudflare bindings access during `next dev`.
import { initOpenNextCloudflareForDev } from "@opennextjs/cloudflare";

initOpenNextCloudflareForDev();
