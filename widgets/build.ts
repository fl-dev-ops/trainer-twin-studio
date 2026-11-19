import { resolve } from "node:path";

export async function buildLoader() {
  const result = await Bun.build({
    entrypoints: [resolve(import.meta.dir, "src/loader.ts")],
    target: "browser",
    format: "iife",
    minify: true,
  });
  if (!result.success) throw new AggregateError(result.logs, "Widget loader build failed");
  return result.outputs[0].text();
}

export async function buildHostedWidget() {
  const result = await Bun.build({
    entrypoints: [resolve(import.meta.dir, "src/widget.ts")],
    target: "browser",
    format: "iife",
    minify: true,
    define: { "process.env.NODE_ENV": '"production"' },
  });
  if (!result.success) throw new AggregateError(result.logs, "Hosted widget build failed");
  return result.outputs[0].text();
}

if (import.meta.main) {
  await Bun.write(resolve(import.meta.dir, "../web/public/widgets/v1.js"), await buildLoader());
  await Bun.write(resolve(import.meta.dir, "../web/public/widgets/voice-v1.js"), await buildHostedWidget());
  await Bun.write(resolve(import.meta.dir, "../web/public/widgets/voice-v1.css"), Bun.file(resolve(import.meta.dir, "src/widget.css")));
}
