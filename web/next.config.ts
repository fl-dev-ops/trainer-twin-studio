import type { NextConfig } from "next";
import { withWorkflow } from "workflow/next";

import "./env"; // Fail fast at build/dev startup if required env keys are missing

import path from "path";

const nextConfig: NextConfig = {
  // Allow dev assets (HMR etc.) on the portless subdomains
  allowedDevOrigins: ["trainertwin.localhost", "*.trainertwin.localhost"],
  experimental: {
    // Pages render in the browser and load their data through /api/trpc (lib/api.ts), so a page's router payload holds
    // no data: reuse it for 5 minutes and repeat navigations make no server request. useRefresh() clears it on a change.
    staleTimes: { dynamic: 300 },
  },
  // native/wasm binaries must not be bundled into ESM chunks
  serverExternalPackages: [
    "@firecrawl/anydoc",
    "@aws-sdk/client-s3",
    "@aws-sdk/s3-request-presigner",
    "chromadb",
    "@chroma-core/default-embed",
    "@chroma-core/ai-embeddings-common",
    "@embedpdf/pdfium",
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

// Workflow SDK: compiles "use workflow" / "use step" (twin session reports) and serves /.well-known/workflow/*.
export default withWorkflow(nextConfig);
