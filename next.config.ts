import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  poweredByHeader: false,
  cacheComponents: true,
  partialPrefetching: true,
  // The resizer fetches whatever local path it is asked for; only the samples and the Reddit bills are pictures.
  images: {
    localPatterns: [{ pathname: "/samples/**", search: "" }, { pathname: "/api/real-image/**", search: "" }],
    // Every resized picture is a thumbnail of 112 or 129 CSS pixels, so 3x screens need at most 384. Next's defaults
    // listed 15 widths up to 3840 in each one's srcSet: 150 KB of the real-bills page's HTML.
    deviceSizes: [384],
    imageSizes: [128, 256],
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
