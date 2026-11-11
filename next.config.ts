import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  cacheComponents: true,
  devIndicators: false,
  partialPrefetching: true,
  // The generate route and the renderer read these at runtime.
  outputFileTracingIncludes: {
    "/api/generate": ["./ds-docs/**/*", "./branch.config.json"],
    "/render": ["./branch.config.json"],
  },
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default nextConfig;
