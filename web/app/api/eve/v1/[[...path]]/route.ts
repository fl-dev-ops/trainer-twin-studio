export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type Params = { params: Promise<{ path?: string[] }> };

async function proxy(request: Request, { params }: Params) {
  const origin = process.env.EVE_ORIGIN;
  const secret = process.env.COPILOT_SERVICE_SECRET;
  if (!origin || !secret) return Response.json({ error: "Copilot is not configured" }, { status: 503 });

  const path = (await params).path?.map(encodeURIComponent).join("/") ?? "";
  const target = new URL(`/eve/v1/${path}`, origin);
  target.search = new URL(request.url).search;

  const headers = new Headers(request.headers);
  // ponytail: one service principal while Studio is single-user; forward verified user JWTs when multi-tenant auth lands.
  headers.set("authorization", `Basic ${Buffer.from(`studio:${secret}`).toString("base64")}`);
  for (const name of ["cookie", "host", "content-length", "accept-encoding"]) headers.delete(name);

  try {
    const response = await fetch(target, {
      method: request.method,
      headers,
      body: request.method === "GET" || request.method === "HEAD" ? undefined : await request.arrayBuffer(),
      cache: "no-store",
      redirect: "manual",
      signal: request.signal,
    });
    const responseHeaders = new Headers(response.headers);
    for (const name of ["content-encoding", "content-length", "set-cookie", "transfer-encoding"]) responseHeaders.delete(name);
    return new Response(response.body, { status: response.status, headers: responseHeaders });
  } catch {
    return Response.json({ error: "Copilot is unavailable" }, { status: 502 });
  }
}

export function GET(request: Request, context: Params) {
  return proxy(request, context);
}

export function POST(request: Request, context: Params) {
  return proxy(request, context);
}
