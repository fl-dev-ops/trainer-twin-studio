const page = Bun.file(new URL("./index.html", import.meta.url));
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 43190,
  fetch(request) {
    if (new URL(request.url).pathname !== "/") return new Response("Not found", { status: 404 });
    return new Response(page, {
      headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" },
    });
  },
});
console.log(`Twin embed test listening on ${server.url}`);
