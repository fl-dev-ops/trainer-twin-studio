import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // No static basePath: the app mounts at root / for every tenant. The
  // host-delegated subpath (/interview) is stripped by the host proxy and
  // re-added client-side via lib/tenant-link.
  // All JS/CSS chunks are emitted under /_twin_assets/_next/... so they
  // never collide with a host app's own /_next/* assets.
  assetPrefix: process.env.ASSET_PREFIX || "/_twin_assets",
  experimental: {
    serverActions: {
      // Server Actions POST back to the page URL; under host delegation the
      // browser origin is the host's, not this app's.
      allowedOrigins: [
        "careerwithvasanth.com",
        "*.careerwithvasanth.com",
        "localhost:3000",
        "localhost:3002",
      ],
    },
  },
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
};

export default nextConfig;
