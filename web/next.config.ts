import type { NextConfig } from "next";

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
};

export default nextConfig;
