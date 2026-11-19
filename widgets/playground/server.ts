import { watch } from "node:fs";
import { resolve } from "node:path";
import { buildLoader } from "../build";

const page = Bun.file(new URL("./index.html", import.meta.url));
const headers = { "Cache-Control": "no-store", "Referrer-Policy": "no-referrer", "X-Content-Type-Options": "nosniff" };
const boot = Date.now();
let revision = 0;
let bundle: Promise<string> | undefined;
let loader: Promise<string> | undefined;

for (const path of [".", "../src", "../../shared"]) {
  watch(resolve(import.meta.dir, path), { persistent: false }, () => {
    revision++;
    bundle = undefined;
    loader = undefined;
  });
}

async function buildPreview() {
  const result = await Bun.build({ entrypoints: [resolve(import.meta.dir, "preview.ts")], target: "browser" });
  if (!result.success) throw new AggregateError(result.logs, "Widget preview build failed");
  return result.outputs[0].text();
}

export async function playgroundResponse(url: URL): Promise<Response | undefined> {
  switch (url.pathname) {
    case "/":
      return new Response(page, { headers: { ...headers, "Content-Type": "text/html; charset=utf-8" } });
    case "/preview/version":
      return Response.json(`${boot}-${revision}`, { headers });
    case "/preview/frame":
    case "/embed/preview": {
      const launcher = url.pathname === "/preview/frame" && url.searchParams.get("state") === "launcher";
      return new Response(`<!doctype html><html lang="en"><head><meta charset="utf-8">
        <meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="dark">
        <title>Widget state preview</title>
        ${launcher ? '<style>html { background: transparent; }</style>' : '<link rel="stylesheet" href="/preview/widget.css"><script type="module" src="/preview/widget.js"></script>'}
        </head><body>${launcher ? '<script src="/preview/loader.js" data-twin-id="preview"></script>' : '<main id="preview-widget">Loading widget preview…</main>'}</body></html>`, {
        headers: {
          ...headers, "Content-Type": "text/html; charset=utf-8", "Permissions-Policy": "microphone=(), camera=()",
          "Content-Security-Policy": "default-src 'self'; connect-src 'none'; style-src 'self' 'unsafe-inline'; frame-ancestors 'self'; form-action 'none'",
        },
      });
    }
    case "/preview/loader.js":
      return new Response(await (loader ??= buildLoader()), { headers: { ...headers, "Content-Type": "text/javascript; charset=utf-8" } });
    case "/preview/widget.css":
      return new Response(Bun.file(new URL("../src/widget.css", import.meta.url)), { headers: { ...headers, "Content-Type": "text/css; charset=utf-8" } });
    case "/preview/portrait":
      return new Response(Bun.file(new URL("../../web/public/vasanth.png", import.meta.url)), { headers: { ...headers, "Content-Type": "image/png" } });
    case "/preview/widget.js":
      try {
        return new Response(await (bundle ??= buildPreview()), { headers: { ...headers, "Content-Type": "text/javascript; charset=utf-8" } });
      } catch (failure) {
        console.error(failure);
        return new Response('document.querySelector("main").textContent = "Widget build failed. Check the widgets server log.";', {
          headers: { ...headers, "Content-Type": "text/javascript; charset=utf-8" },
        });
      }
  }
}

if (import.meta.main) {
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 43190,
    async fetch(request) {
      return await playgroundResponse(new URL(request.url)) ?? new Response("Not found", { status: 404 });
    },
  });
  console.log(`Widget playground listening on ${server.url}`);
}
