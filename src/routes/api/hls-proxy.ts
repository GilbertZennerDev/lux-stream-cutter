import { createFileRoute } from "@tanstack/react-router";

// Allow-list of host suffixes we're willing to proxy. Keep tight to avoid
// turning this endpoint into an open relay.
const ALLOWED_HOST_SUFFIXES = [
  "webtvlive.eu",
  "chd.lu",
  "chambre.lu",
  "gouvernement.lu",
];

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Max-Age": "86400",
} as const;

function isAllowed(hostname: string): boolean {
  return ALLOWED_HOST_SUFFIXES.some(
    (suf) => hostname === suf || hostname.endsWith(`.${suf}`),
  );
}

function errJson(msg: string, status: number): Response {
  return new Response(JSON.stringify({ error: msg }), {
    status,
    headers: { "Content-Type": "application/json", ...CORS_HEADERS },
  });
}

export const Route = createFileRoute("/api/hls-proxy")({
  server: {
    handlers: {
      OPTIONS: async () => new Response(null, { status: 204, headers: CORS_HEADERS }),
      GET: async ({ request }: { request: Request }) => {
        try {
          const u = new URL(request.url);
          const target = u.searchParams.get("url");
          if (!target) return errJson("Missing url", 400);
          let parsed: URL;
          try {
            parsed = new URL(target);
          } catch {
            return errJson("Invalid url", 400);
          }
          if (parsed.protocol !== "https:" && parsed.protocol !== "http:")
            return errJson("Unsupported protocol", 400);
          if (!isAllowed(parsed.hostname))
            return errJson(`Host not allowed: ${parsed.hostname}`, 403);

          const upstream = await fetch(parsed.toString(), {
            method: "GET",
            headers: { "User-Agent": "LuxStreamRecorder/1.0" },
          });
          const headers = new Headers();
          const ct = upstream.headers.get("content-type");
          if (ct) headers.set("content-type", ct);
          const cl = upstream.headers.get("content-length");
          if (cl) headers.set("content-length", cl);
          for (const [k, v] of Object.entries(CORS_HEADERS)) headers.set(k, v);
          return new Response(upstream.body, { status: upstream.status, headers });
        } catch (err) {
          return errJson((err as Error).message || "Proxy error", 502);
        }
      },
    },
  },
} as any);
