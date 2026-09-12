import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

const RUNWAY_BASE = "https://api.dev.runwayml.com/v1";
const RUNWAY_VERSION = "2024-11-06";

const StartInput = z.object({
  image: z.string().startsWith("data:image/"),
  prompt: z.string().max(1000).default(""),
});

const TaskInput = z.object({ id: z.string().min(1).max(200) });

function apiKey(): string {
  const key = process.env["RUNWAYML_API_SECRET"];
  if (!key) throw new Error("RUNWAYML_API_SECRET não está configurada no servidor.");
  return key;
}

/** Inicia a geração de um clipe vertical de 5s a partir de uma imagem. */
export const startClip = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) => StartInput.parse(input))
  .handler(async ({ data }) => {
    const res = await fetch(`${RUNWAY_BASE}/image_to_video`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey()}`,
        "X-Runway-Version": RUNWAY_VERSION,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "gen4_turbo",
        promptImage: data.image,
        promptText: data.prompt || undefined,
        ratio: "720:1280",
        duration: 5,
      }),
    });

    const payload = (await res.json().catch(() => null)) as
      | { id?: string; error?: string; message?: string }
      | null;

    if (!res.ok || !payload?.id) {
      const detail = payload?.error ?? payload?.message ?? `HTTP ${res.status}`;
      console.error("Runway image_to_video failed:", res.status, detail);
      return { ok: false as const, error: String(detail) };
    }

    return { ok: true as const, id: payload.id };
  });

/** Consulta o andamento de um clipe. */
export const checkClip = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) => TaskInput.parse(input))
  .handler(async ({ data }) => {
    const res = await fetch(`${RUNWAY_BASE}/tasks/${encodeURIComponent(data.id)}`, {
      headers: {
        Authorization: `Bearer ${apiKey()}`,
        "X-Runway-Version": RUNWAY_VERSION,
      },
    });

    const payload = (await res.json().catch(() => null)) as {
      status?: string;
      progress?: number;
      output?: string[];
      failure?: string;
      failureCode?: string;
      error?: string;
      message?: string;
    } | null;

    if (!res.ok || !payload) {
      const detail = payload?.error ?? payload?.message ?? `HTTP ${res.status}`;
      console.error("Runway task lookup failed:", res.status, detail);
      return { ok: false as const, error: String(detail) };
    }

    return {
      ok: true as const,
      status: payload.status ?? "PENDING",
      progress: typeof payload.progress === "number" ? payload.progress : 0,
      url: payload.output?.[0] ?? null,
      failure: payload.failure ?? payload.failureCode ?? null,
    };
  });
