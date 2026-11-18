const hostOrigin = "http://127.0.0.1:43181";
const widgetOrigin = "http://127.0.0.1:43182";
const artifact = Bun.file(new URL("../../web/public/widgets/v1.js", import.meta.url));

Bun.serve({
  hostname: "127.0.0.1",
  port: 43181,
  fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/playground") {
      return new Response(Bun.file(new URL("../playground/index.html", import.meta.url)), {
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    }
    if (url.pathname === "/attacker") {
      return new Response(`<!doctype html><meta charset="utf-8"><script>parent.postMessage({
        source:"trainertwin-widget",version:1,type:"close",marker:"origin-check"
      },${JSON.stringify(hostOrigin)});</script>`, { headers: { "content-type": "text/html; charset=utf-8" } });
    }
    const mode = url.searchParams.get("mode") ?? "floating";
    const target = url.searchParams.has("target") ? 'data-target="twin-slot"' : "";
    const second = url.searchParams.has("multiple")
      ? `<script async src="${widgetOrigin}/widgets/v1.js" data-twin-id="second" data-mode="floating"></script>` : "";
    return new Response(`<!doctype html><html><head><title>Customer website</title>
      <style>button,iframe { display:none !important; } body { margin:0; }</style></head>
      <body><h1>Customer website</h1><div id="twin-slot"></div>
      <script id="install" async src="${widgetOrigin}/widgets/v1.js" data-twin-id="demo" data-mode="${mode}" ${target}></script>
      ${second}</body></html>`, { headers: { "content-type": "text/html; charset=utf-8" } });
  },
});

Bun.serve({
  hostname: "127.0.0.1",
  port: 43182,
  fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/widgets/v1.js") {
      return new Response(artifact, { headers: { "content-type": "application/javascript; charset=utf-8" } });
    }
    return new Response(`<!doctype html><html><head><title>Hosted twin fixture</title></head><body>
      <button id="close">Minimise</button><button id="start">Start fixture call</button><div id="state">Waiting</div>
      <script>
      const expected = new URL(location.href).searchParams.get('parentOrigin');
      window.received = [];
      const send = (type, extra = {}) => parent.postMessage({ source:'trainertwin-widget', version:1, type, ...extra }, expected);
      addEventListener('message', event => {
        if (event.source !== parent || event.origin !== expected) return;
        if (event.data?.source !== 'trainertwin-host' || event.data?.version !== 1) return;
        window.received.push(event.data);
        if (event.data.type === 'init') document.querySelector('#state').textContent = 'Ready';
        if (event.data.type === 'destroy') document.querySelector('#state').textContent = 'Destroyed';
      });
      document.querySelector('#close').onclick = () => send('close');
      document.querySelector('#start').onclick = () => { window.active = true; send('status', {active:true}); };
      addEventListener('keydown', event => { if(event.key === 'Escape') send('close'); });
      send('ready');
      </script></body></html>`, {
      headers: {
        "content-type": "text/html; charset=utf-8",
        "content-security-policy": `frame-ancestors ${hostOrigin}`,
      },
    });
  },
});
