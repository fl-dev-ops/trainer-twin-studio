import { resolve } from "node:path";

const output = process.argv[2];
if (!output) throw new Error("Pass the hosted widget test bundle output path.");
const result = await Bun.build({
  entrypoints: [resolve(import.meta.dir, "../src/widget.ts")],
  target: "browser",
  format: "iife",
  define: { "process.env.NODE_ENV": '"production"' },
  plugins: [{
    name: "external-livekit-boundary",
    setup(builder) {
      builder.onResolve({ filter: /^livekit-client$/ }, () => ({
        path: resolve(import.meta.dir, "../../web/e2e/widget-fixtures/fake-livekit.ts"),
      }));
    },
  }],
});
if (!result.success) throw new AggregateError(result.logs, "Hosted widget test bundle failed");
const javascript = result.outputs.find((artifact) => artifact.path.endsWith(".js"));
if (!javascript) throw new Error("Hosted widget test build did not produce JavaScript.");
await Bun.write(output, javascript);
