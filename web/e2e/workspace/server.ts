import { build } from "esbuild";
import { resolve, join } from "node:path";
import { mkdtempSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { strToU8, zipSync } from "fflate";

const out = mkdtempSync(join(tmpdir(), "tt-workspace-browser-"));
await build({ entryPoints: ["e2e/workspace/fixture.tsx"], outdir: out, bundle: true, splitting: true, format: "esm", platform: "browser", jsx: "automatic",
  alias: { "next/dynamic": resolve("e2e/workspace/dynamic.tsx") },
  conditions: ["development"],
  define: { "process.env.NODE_ENV": '"development"', "process.env": "{}" },
  loader: { ".woff2": "file", ".woff": "file", ".ttf": "file", ".wasm": "file", ".svg": "file", ".png": "file" },
});
const pdf = await PDFDocument.create();
const font = await pdf.embedFont(StandardFonts.Helvetica);
pdf.addPage().drawText("Built reliable distributed systems and reduced latency by forty percent.", { x: 30, y: 700, size: 12, font });
const pdfBytes = await pdf.save();
const contentTypes = `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/>${[1, 2].map(n => `<Override PartName="/ppt/slides/slide${n}.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>`).join("")}</Types>`;
const rel = (id: string, type: string, target: string) => `<Relationship Id="${id}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/${type}" Target="${target}"/>`;
const rels = (body: string) => `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${body}</Relationships>`;
const slide = (name: string) => `<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><p:cSld name="${name}"><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/><p:sp><p:nvSpPr><p:cNvPr id="2" name="Title"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm><a:off x="100000" y="100000"/><a:ext cx="6000000" cy="1000000"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr><p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:rPr lang="en-US" sz="2400"/><a:t>${name}</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sld>`;
const presentation = zipSync(Object.fromEntries(Object.entries({
  "[Content_Types].xml": contentTypes,
  "_rels/.rels": rels(rel("rId1", "officeDocument", "ppt/presentation.xml")),
  "ppt/presentation.xml": `<p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><p:sldIdLst><p:sldId id="256" r:id="rId1"/><p:sldId id="257" r:id="rId2"/></p:sldIdLst><p:sldSz cx="9144000" cy="6858000"/><p:notesSz cx="6858000" cy="9144000"/></p:presentation>`,
  "ppt/_rels/presentation.xml.rels": rels(rel("rId1", "slide", "slides/slide1.xml") + rel("rId2", "slide", "slides/slide2.xml")),
  "ppt/slides/slide1.xml": slide("First slide"),
  "ppt/slides/slide2.xml": slide("Second slide"),
}).map(([key, value]) => [key, strToU8(value)])));

const html = `<!doctype html><html><head><link rel="stylesheet" href="/fixture.css"><style>html,body,#root{height:100%;margin:0}body{font:14px system-ui}.flex{display:flex}.flex-col{flex-direction:column}.flex-1{flex:1;min-height:0}.h-full{height:100%}.min-h-0{min-height:0}.overflow-hidden{overflow:hidden}.hidden{display:none}.relative{position:relative}.absolute{position:absolute}.inset-0{inset:0}button{padding:6px}main{border:1px solid #999}canvas{max-width:100%}</style></head><body><div id="root"></div><script>window.EXCALIDRAW_ASSET_PATH='/excalidraw/';</script><script type="module" src="/fixture.js"></script></body></html>`;
async function handleRequest(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname;
  if (path === "/") return new Response(html, { headers: { "content-type": "text/html" } });
  if (path === "/fixture.pdf") return new Response(new Uint8Array(pdfBytes), { headers: { "content-type": "application/pdf" } });
  if (path === "/fixture.pptx") return new Response(new Uint8Array(presentation), { headers: { "content-type": "application/vnd.openxmlformats-officedocument.presentationml.presentation" } });
  if (path === "/fixture.png") return new Response(Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jB8kAAAAASUVORK5CYII=", "base64"), { headers: { "content-type": "image/png" } });
  if (path === "/api/code/run") return Response.json({ outcome: "completed", stdout: "2\n", stderr: "", details: null, previewUrl: null, compilationTimeMs: 0, executionTimeMs: 1, memoryKb: 0, consoleChannel: null });
  if (path.startsWith("/api/")) {
    const headers = new Headers(request.headers);
    headers.delete("host");
    return fetch(`http://localhost:3999${path}${url.search}`, { method: request.method, headers, body: ["GET", "HEAD"].includes(request.method) ? undefined : await request.arrayBuffer() });
  }
  if (["/native-parser-worker.js", "/pptx_wasm_bg.wasm"].includes(path)) {
    return new Response(new Uint8Array(readFileSync(resolve("node_modules/@extend-ai/react-pptx/dist", path.slice(1)))), {
      headers: { "content-type": path.endsWith(".wasm") ? "application/wasm" : "application/javascript" },
    });
  }
  const base = path.startsWith("/monaco/") ? resolve("node_modules/monaco-editor/min")
    : path.startsWith("/excalidraw/") ? resolve("node_modules/@excalidraw/excalidraw/dist/prod") : out;
  const relative = path.replace(/^\/(monaco|excalidraw)\//, "").replace(/^\//, "");
  const file = resolve(base, relative);
  if (!file.startsWith(`${base}/`)) return new Response(null, { status: 404 });
  try {
    const mime: Record<string, string> = { js: "application/javascript", css: "text/css", svg: "image/svg+xml", woff2: "font/woff2", ttf: "font/ttf", png: "image/png" };
    return new Response(new Uint8Array(readFileSync(file)), { headers: { "content-type": mime[file.split(".").pop()!] ?? "application/octet-stream" } });
  } catch { return new Response(null, { status: 404 }); }
}
createServer(async (incoming, outgoing) => {
  try {
    const headers = Object.fromEntries(Object.entries(incoming.headers).filter(([, value]) => value !== undefined).map(([key, value]) => [key, String(value)]));
    const chunks: Buffer[] = [];
    for await (const chunk of incoming) chunks.push(Buffer.from(chunk));
    const request = new Request(`http://127.0.0.1:4174${incoming.url}`, { method: incoming.method, headers,
      body: ["GET", "HEAD"].includes(incoming.method!) ? undefined : new Uint8Array(Buffer.concat(chunks)) });
    const response = await handleRequest(request);
    const responseHeaders = new Headers(response.headers);
    responseHeaders.delete("content-encoding");
    responseHeaders.delete("content-length");
    outgoing.writeHead(response.status, Object.fromEntries(responseHeaders));
    outgoing.end(Buffer.from(await response.arrayBuffer()));
  } catch (error) { outgoing.writeHead(500); outgoing.end(String(error)); }
}).listen(4174, "127.0.0.1");
console.log("Workspace component harness listening on http://127.0.0.1:4174");
