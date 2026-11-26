import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  poweredByHeader: false,
  cacheComponents: true,
  partialPrefetching: true,
  // The resizer fetches whatever local path it is asked for; only the samples and the Reddit bills are pictures.
  images: {
    localPatterns: [{ pathname: "/samples/**", search: "" }, { pathname: "/api/real-image/**", search: "" }],
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
