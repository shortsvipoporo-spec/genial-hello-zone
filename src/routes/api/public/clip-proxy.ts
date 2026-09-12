import { createFileRoute } from "@tanstack/react-router";

// Os clipes prontos ficam em URLs assinadas da Runway. O navegador precisa
// baixar os bytes para montar o vídeo final, então servimos por este proxy
// (somente hosts da Runway, somente leitura).
const ALLOWED_HOST_SUFFIXES = [".runwayml.com", ".runway.team", ".amazonaws.com"];

function isAllowed(raw: string): URL | null {
  try {
    const url = new URL(raw);
    if (url.protocol !== "https:") return null;
    if (!ALLOWED_HOST_SUFFIXES.some((suffix) => url.hostname.endsWith(suffix))) return null;
    return url;
  } catch {
    return null;
  }
}

export const Route = createFileRoute("/api/public/clip-proxy")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const target = new URL(request.url).searchParams.get("url");
        const allowed = target ? isAllowed(target) : null;
        if (!allowed) return new Response("URL inválida", { status: 400 });

        const upstream = await fetch(allowed.toString());
        if (!upstream.ok || !upstream.body) {
          return new Response("Falha ao baixar o clipe", { status: 502 });
        }

        return new Response(upstream.body, {
          status: 200,
          headers: {
            "content-type": upstream.headers.get("content-type") ?? "video/mp4",
            "cache-control": "private, max-age=3600",
          },
        });
      },
    },
  },
});
