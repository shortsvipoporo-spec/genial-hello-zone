import { createFileRoute } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Download, Film, ImagePlus, Loader2, Mic, Play, Trash2, X } from "lucide-react";

import { checkClip, startClip } from "@/lib/runway.functions";
import { mergeClips, prepareImage } from "@/lib/video-builder";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "Gerador de Vídeos IA — 25 imagens em um vídeo vertical" },
      {
        name: "description",
        content:
          "Envie até 25 imagens, gere clipes de 5 segundos em 9:16 com IA, junte tudo com sua narração e baixe o vídeo final.",
      },
      { property: "og:title", content: "Gerador de Vídeos IA — 25 imagens em um vídeo vertical" },
      {
        property: "og:description",
        content:
          "Clipes de 5 segundos em formato vertical gerados por IA, na ordem das suas imagens, com narração.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: Index,
});

const MAX_IMAGES = 25;
const CONCURRENCY = 3;

type ItemStatus = "idle" | "queued" | "running" | "done" | "error";

type Item = {
  id: string;
  file: File;
  preview: string;
  status: ItemStatus;
  progress: number;
  clipUrl: string | null;
  error: string | null;
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function Index() {
  const [items, setItems] = useState<Item[]>([]);
  const [prompt, setPrompt] = useState("");
  const [narration, setNarration] = useState<File | null>(null);
  const [generating, setGenerating] = useState(false);
  const [merging, setMerging] = useState(false);
  const [mergeStage, setMergeStage] = useState<{ stage: string; percent: number } | null>(null);
  const [finalUrl, setFinalUrl] = useState<string | null>(null);
  const [globalError, setGlobalError] = useState<string | null>(null);

  const start = useServerFn(startClip);
  const check = useServerFn(checkClip);
  const itemsRef = useRef<Item[]>(items);
  itemsRef.current = items;

  useEffect(() => {
    return () => {
      itemsRef.current.forEach((item) => URL.revokeObjectURL(item.preview));
    };
  }, []);

  const update = useCallback((id: string, patch: Partial<Item>) => {
    setItems((prev) => prev.map((item) => (item.id === id ? { ...item, ...patch } : item)));
  }, []);

  const addFiles = (files: FileList | null) => {
    if (!files) return;
    setGlobalError(null);
    const incoming = Array.from(files).filter((f) => f.type.startsWith("image/"));
    setItems((prev) => {
      const room = MAX_IMAGES - prev.length;
      return [
        ...prev,
        ...incoming.slice(0, Math.max(0, room)).map((file, i) => ({
          id: `${Date.now()}-${i}-${file.name}`,
          file,
          preview: URL.createObjectURL(file),
          status: "idle" as ItemStatus,
          progress: 0,
          clipUrl: null,
          error: null,
        })),
      ];
    });
  };

  const removeItem = (id: string) => {
    setItems((prev) => {
      const target = prev.find((item) => item.id === id);
      if (target) URL.revokeObjectURL(target.preview);
      return prev.filter((item) => item.id !== id);
    });
  };

  const resetAll = () => {
    items.forEach((item) => URL.revokeObjectURL(item.preview));
    if (finalUrl) URL.revokeObjectURL(finalUrl);
    setItems([]);
    setNarration(null);
    setFinalUrl(null);
    setMergeStage(null);
    setGlobalError(null);
  };

  const generateOne = useCallback(
    async (item: Item) => {
      update(item.id, { status: "running", progress: 2, error: null });
      try {
        const image = await prepareImage(item.file);
        const created = await start({ data: { image, prompt } });
        if (!created.ok) {
          update(item.id, { status: "error", error: created.error });
          return;
        }

        for (let attempt = 0; attempt < 180; attempt++) {
          await sleep(5000);
          const task = await check({ data: { id: created.id } });
          if (!task.ok) {
            update(item.id, { status: "error", error: task.error });
            return;
          }
          if (task.status === "SUCCEEDED" && task.url) {
            update(item.id, { status: "done", progress: 100, clipUrl: task.url });
            return;
          }
          if (task.status === "FAILED" || task.status === "CANCELLED") {
            update(item.id, {
              status: "error",
              error: task.failure ?? "A geração falhou.",
            });
            return;
          }
          update(item.id, { progress: Math.max(5, Math.round(task.progress * 100)) });
        }
        update(item.id, { status: "error", error: "Tempo esgotado." });
      } catch (error) {
        update(item.id, {
          status: "error",
          error: error instanceof Error ? error.message : "Erro inesperado.",
        });
      }
    },
    [check, prompt, start, update],
  );

  const generateAll = async () => {
    const pending = itemsRef.current.filter((item) => item.status !== "done");
    if (pending.length === 0) return;
    setGenerating(true);
    setGlobalError(null);
    setFinalUrl(null);
    pending.forEach((item) => update(item.id, { status: "queued", progress: 0, error: null }));

    const queue = [...pending];
    const workers = Array.from({ length: Math.min(CONCURRENCY, queue.length) }, async () => {
      while (queue.length > 0) {
        const next = queue.shift();
        if (next) await generateOne(next);
      }
    });
    await Promise.all(workers);
    setGenerating(false);
  };

  const buildFinal = async () => {
    const clips = itemsRef.current
      .filter((item) => item.status === "done" && item.clipUrl)
      .map((item) => item.clipUrl!);
    if (clips.length === 0) return;

    setMerging(true);
    setGlobalError(null);
    setMergeStage({ stage: "Preparando", percent: 0 });
    try {
      const blob = await mergeClips(clips, narration, setMergeStage);
      if (finalUrl) URL.revokeObjectURL(finalUrl);
      setFinalUrl(URL.createObjectURL(blob));
    } catch (error) {
      setGlobalError(
        error instanceof Error ? error.message : "Não foi possível montar o vídeo final.",
      );
    } finally {
      setMerging(false);
    }
  };

  const doneCount = useMemo(() => items.filter((i) => i.status === "done").length, [items]);
  const errorCount = useMemo(() => items.filter((i) => i.status === "error").length, [items]);
  const overall = items.length
    ? Math.round(items.reduce((sum, i) => sum + (i.status === "done" ? 100 : i.progress), 0) / items.length)
    : 0;

  return (
    <main className="min-h-screen bg-background text-foreground">
      <div className="mx-auto w-full max-w-5xl px-5 py-10">
        <header className="mb-10">
          <p className="text-xs uppercase tracking-[0.3em] text-primary">Estúdio de vídeo IA</p>
          <h1 className="mt-3 text-4xl font-semibold leading-tight sm:text-5xl">
            25 imagens viram um vídeo vertical
          </h1>
          <p className="mt-3 max-w-2xl text-muted-foreground">
            Cada imagem vira um clipe animado de 5 segundos em 9:16, na ordem que você escolher.
            No final, tudo é juntado com a sua narração.
          </p>
        </header>

        <section className="rounded-2xl border border-border bg-card p-6">
          <div className="flex flex-wrap items-center justify-between gap-4">
            <div>
              <h2 className="text-lg font-medium">1. Suas imagens</h2>
              <p className="text-sm text-muted-foreground">
                {items.length} de {MAX_IMAGES} selecionadas
              </p>
            </div>
            <div className="flex gap-2">
              <label className="inline-flex cursor-pointer items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:opacity-90">
                <ImagePlus className="size-4" /> Adicionar imagens
                <input
                  type="file"
                  accept="image/*"
                  multiple
                  className="hidden"
                  disabled={generating || merging}
                  onChange={(e) => {
                    addFiles(e.target.files);
                    e.target.value = "";
                  }}
                />
              </label>
              {items.length > 0 && (
                <button
                  onClick={resetAll}
                  disabled={generating || merging}
                  className="inline-flex items-center gap-2 rounded-lg border border-border px-4 py-2 text-sm hover:bg-secondary disabled:opacity-50"
                >
                  <Trash2 className="size-4" /> Limpar
                </button>
              )}
            </div>
          </div>

          {items.length > 0 && (
            <ul className="mt-6 grid grid-cols-3 gap-3 sm:grid-cols-5">
              {items.map((item, index) => (
                <li
                  key={item.id}
                  className="group relative aspect-[9/16] overflow-hidden rounded-lg border border-border bg-secondary"
                >
                  <img
                    src={item.preview}
                    alt={`Imagem ${index + 1} da sequência`}
                    className="size-full object-cover"
                  />
                  <span className="absolute left-1.5 top-1.5 rounded bg-background/80 px-1.5 py-0.5 text-[11px] font-medium">
                    {index + 1}
                  </span>
                  {!generating && !merging && (
                    <button
                      onClick={() => removeItem(item.id)}
                      aria-label={`Remover imagem ${index + 1}`}
                      className="absolute right-1.5 top-1.5 rounded bg-background/80 p-1 opacity-0 transition group-hover:opacity-100"
                    >
                      <X className="size-3" />
                    </button>
                  )}
                  <div className="absolute inset-x-0 bottom-0 bg-background/85 px-1.5 py-1">
                    {item.status === "done" ? (
                      <span className="text-[11px] text-primary">Clipe pronto</span>
                    ) : item.status === "error" ? (
                      <span className="text-[11px] text-destructive">Falhou</span>
                    ) : item.status === "idle" ? (
                      <span className="text-[11px] text-muted-foreground">Aguardando</span>
                    ) : (
                      <>
                        <span className="text-[11px] text-muted-foreground">
                          {item.status === "queued" ? "Na fila" : `Gerando ${item.progress}%`}
                        </span>
                        <div className="mt-1 h-1 rounded bg-secondary">
                          <div
                            className="h-1 rounded bg-primary transition-all"
                            style={{ width: `${item.status === "queued" ? 0 : item.progress}%` }}
                          />
                        </div>
                      </>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="mt-6 grid gap-6 md:grid-cols-2">
          <div className="rounded-2xl border border-border bg-card p-6">
            <h2 className="text-lg font-medium">2. Estilo do movimento</h2>
            <p className="mt-1 text-sm text-muted-foreground">
              Opcional: descreva como as imagens devem se mover.
            </p>
            <textarea
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              disabled={generating}
              rows={3}
              placeholder="Ex.: aproximação lenta da câmera, movimento suave, luz cinematográfica"
              className="mt-4 w-full resize-none rounded-lg border border-input bg-background px-3 py-2 text-sm outline-none focus:border-primary"
            />
          </div>

          <div className="rounded-2xl border border-border bg-card p-6">
            <h2 className="text-lg font-medium">3. Narração</h2>
            <p className="mt-1 text-sm text-muted-foreground">
              O áudio toca por cima dos clipes, do início ao fim.
            </p>
            <label className="mt-4 inline-flex cursor-pointer items-center gap-2 rounded-lg border border-border px-4 py-2 text-sm hover:bg-secondary">
              <Mic className="size-4" />
              {narration ? "Trocar áudio" : "Enviar áudio"}
              <input
                type="file"
                accept="audio/*"
                className="hidden"
                disabled={merging}
                onChange={(e) => setNarration(e.target.files?.[0] ?? null)}
              />
            </label>
            {narration && (
              <p className="mt-3 truncate text-sm text-muted-foreground">{narration.name}</p>
            )}
          </div>
        </section>

        <section className="mt-6 rounded-2xl border border-border bg-card p-6">
          <div className="flex flex-wrap items-center justify-between gap-4">
            <div>
              <h2 className="text-lg font-medium">4. Gerar e montar</h2>
              <p className="text-sm text-muted-foreground">
                {doneCount} clipe(s) prontos{errorCount > 0 ? ` · ${errorCount} com erro` : ""}
                {items.length > 0 ? ` · duração final ${doneCount * 5}s` : ""}
              </p>
            </div>
            <div className="flex flex-wrap gap-2">
              <button
                onClick={generateAll}
                disabled={items.length === 0 || generating || merging}
                className="inline-flex items-center gap-2 rounded-lg bg-primary px-5 py-2.5 text-sm font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50"
              >
                {generating ? <Loader2 className="size-4 animate-spin" /> : <Film className="size-4" />}
                {generating ? "Gerando clipes…" : "Gerar clipes"}
              </button>
              <button
                onClick={buildFinal}
                disabled={doneCount === 0 || generating || merging}
                className="inline-flex items-center gap-2 rounded-lg border border-primary px-5 py-2.5 text-sm font-medium text-primary hover:bg-primary/10 disabled:opacity-50"
              >
                {merging ? <Loader2 className="size-4 animate-spin" /> : <Play className="size-4" />}
                {merging ? "Montando…" : "Montar vídeo final"}
              </button>
            </div>
          </div>

          {(generating || doneCount > 0) && (
            <div className="mt-5">
              <div className="flex justify-between text-xs text-muted-foreground">
                <span>Progresso da geração</span>
                <span>{overall}%</span>
              </div>
              <div className="mt-2 h-2 rounded-full bg-secondary">
                <div
                  className="h-2 rounded-full bg-primary transition-all"
                  style={{ width: `${overall}%` }}
                />
              </div>
            </div>
          )}

          {mergeStage && merging && (
            <div className="mt-5">
              <div className="flex justify-between text-xs text-muted-foreground">
                <span>{mergeStage.stage}</span>
                <span>{mergeStage.percent}%</span>
              </div>
              <div className="mt-2 h-2 rounded-full bg-secondary">
                <div
                  className="h-2 rounded-full bg-accent transition-all"
                  style={{ width: `${mergeStage.percent}%` }}
                />
              </div>
            </div>
          )}

          {globalError && <p className="mt-4 text-sm text-destructive">{globalError}</p>}
          {errorCount > 0 && !generating && (
            <p className="mt-3 text-sm text-muted-foreground">
              Alguns clipes falharam. Toque em “Gerar clipes” para tentar novamente apenas os que
              faltam.
            </p>
          )}
        </section>

        {finalUrl && (
          <section className="mt-6 rounded-2xl border border-border bg-card p-6">
            <h2 className="text-lg font-medium">Seu vídeo final</h2>
            <div className="mt-4 flex flex-col items-center gap-4">
              <video
                src={finalUrl}
                controls
                playsInline
                className="aspect-[9/16] w-full max-w-xs rounded-xl border border-border bg-black"
              />
              <a
                href={finalUrl}
                download="video-final.mp4"
                className="inline-flex items-center gap-2 rounded-lg bg-primary px-5 py-2.5 text-sm font-medium text-primary-foreground hover:opacity-90"
              >
                <Download className="size-4" /> Baixar vídeo
              </a>
            </div>
          </section>
        )}
      </div>
    </main>
  );
}
