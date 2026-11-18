import { createServer, type Server } from "node:http";

export const CUSTOMER_ORIGIN = "http://customer.localhost:43191";
export const DISALLOWED_ORIGIN = "http://unlisted.localhost:43191";

export async function customerServer(widgetOrigin: string, agentId: string): Promise<Server> {
  const loader = `${widgetOrigin}/widgets/v1.js`;
  const frame = `${widgetOrigin}/embed/${encodeURIComponent(agentId)}?parentOrigin=${encodeURIComponent(CUSTOMER_ORIGIN)}`;
  const server = createServer((request, response) => {
    const path = new URL(request.url ?? "/", CUSTOMER_ORIGIN);
    if (path.pathname === "/message-source") {
      response.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
      response.end("<!doctype html><title>Message source fixture</title>");
      return;
    }
    const manual = path.pathname === "/manual";
    const mode = path.searchParams.get("mode") === "inline" ? "inline" : "floating";
    response.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store",
      ...(path.searchParams.has("blockMicrophone") ? { "Permissions-Policy": "microphone=()" } : {}),
    });
    response.end(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
      <title>Customer website fixture</title><style>body{margin:0;padding:24px;background:#f1f2ed;font:16px system-ui}iframe{border:0;width:360px;height:680px}h1{font-size:24px}</style></head>
      <body><h1>Independent customer website</h1><p>The assistant below is hosted on a different origin.</p>
      <script>window.__widgetMessages=[];window.addEventListener("message",function(event){if(event.origin===${JSON.stringify(widgetOrigin)})window.__widgetMessages.push(event.data)});</script>
      ${manual ? `<iframe title="Manual widget handshake" allow="microphone ${widgetOrigin}" sandbox="allow-scripts allow-same-origin allow-forms" src="${frame}"></iframe>`
        : `<script id="widget-install" src="${loader}" data-twin-id="${agentId}" data-mode="${mode}"></script>`}
      </body></html>`);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
      server.listen(43191, "127.0.0.1", () => {
      server.removeListener("error", reject);
      resolve();
    });
  });
  return server;
}
