import path from "node:path";
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Shared ingestion modules live beside the web application.
  turbopack: { root: path.join(__dirname, "..") },
  // Allow dev assets (HMR etc.) on the portless subdomains
  allowedDevOrigins: ["trainertwin.localhost", "*.trainertwin.localhost"],
  // OAuth callbacks carry short-lived authorization codes; do not print their URLs.
  logging: { incomingRequests: { ignore: [/\/api\/youtube\/oauth\/callback(?:\?|$)/] } },
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
