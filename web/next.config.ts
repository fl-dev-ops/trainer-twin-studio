import type { NextConfig } from "next";

import path from "path";

const nextConfig: NextConfig = {
  // Allow dev assets (HMR etc.) on the portless subdomains
  allowedDevOrigins: ["trainertwin.localhost", "*.trainertwin.localhost"],
  // native/wasm binaries must not be bundled into ESM chunks
  serverExternalPackages: [
    "@firecrawl/anydoc",
    "@aws-sdk/client-s3",
    "@aws-sdk/s3-request-presigner",
    "chromadb",
    "@chroma-core/default-embed",
    "@chroma-core/ai-embeddings-common",
  ],
  webpack: (config) => {
    config.resolve.alias = {
      ...config.resolve.alias,
      "@shared": path.resolve(__dirname, "../shared"),
    };
    return config;
  },
  turbopack: {
    root: path.resolve(__dirname, ".."),
    resolveAlias: {
      "@shared": path.resolve(__dirname, "../shared"),
    },
  },
};

export default nextConfig;
