import { FFmpeg } from "@ffmpeg/ffmpeg";
import { fetchFile, toBlobURL } from "@ffmpeg/util";

const CORE_BASE = "https://unpkg.com/@ffmpeg/core@0.12.6/dist/umd";

let ffmpegPromise: Promise<FFmpeg> | null = null;

async function getFFmpeg(): Promise<FFmpeg> {
  if (!ffmpegPromise) {
    ffmpegPromise = (async () => {
      const ffmpeg = new FFmpeg();
      await ffmpeg.load({
        coreURL: await toBlobURL(`${CORE_BASE}/ffmpeg-core.js`, "text/javascript"),
        wasmURL: await toBlobURL(`${CORE_BASE}/ffmpeg-core.wasm`, "application/wasm"),
      });
      return ffmpeg;
    })();
  }
  return ffmpegPromise;
}

export type MergeProgress = { stage: string; percent: number };

/**
 * Baixa os clipes na ordem, junta tudo e aplica a narração por cima.
 * Roda inteiramente no navegador (ffmpeg.wasm).
 */
export async function mergeClips(
  clipUrls: string[],
  narration: File | null,
  onProgress: (p: MergeProgress) => void,
): Promise<Blob> {
  const ffmpeg = await getFFmpeg();
  onProgress({ stage: "Baixando os clipes", percent: 0 });

  const names: string[] = [];
  for (let i = 0; i < clipUrls.length; i++) {
    const name = `clip${String(i).padStart(2, "0")}.mp4`;
    const proxied = `/api/public/clip-proxy?url=${encodeURIComponent(clipUrls[i]!)}`;
    await ffmpeg.writeFile(name, await fetchFile(proxied));
    names.push(name);
    onProgress({
      stage: "Baixando os clipes",
      percent: Math.round(((i + 1) / clipUrls.length) * 100),
    });
  }

  await ffmpeg.writeFile(
    "list.txt",
    new TextEncoder().encode(names.map((n) => `file '${n}'`).join("\n")),
  );

  let audioName: string | null = null;
  if (narration) {
    audioName = `narration.${narration.name.split(".").pop()?.toLowerCase() || "mp3"}`;
    await ffmpeg.writeFile(audioName, await fetchFile(narration));
  }

  const handleProgress = ({ progress }: { progress: number }) => {
    onProgress({
      stage: "Montando o vídeo final",
      percent: Math.min(100, Math.max(0, Math.round(progress * 100))),
    });
  };
  ffmpeg.on("progress", handleProgress);
  onProgress({ stage: "Montando o vídeo final", percent: 0 });

  const base = ["-fflags", "+genpts", "-f", "concat", "-safe", "0", "-i", "list.txt"];
  const audioIn = audioName ? ["-i", audioName] : [];
  const audioOut = audioName ? ["-c:a", "aac", "-b:a", "192k", "-shortest"] : ["-an"];

  try {
    await ffmpeg.exec([
      ...base,
      ...audioIn,
      "-c:v",
      "copy",
      ...audioOut,
      "-movflags",
      "+faststart",
      "output.mp4",
    ]);
  } catch {
    // Clipes com parâmetros diferentes: recodifica (mais lento, sempre funciona).
    onProgress({ stage: "Recodificando os clipes", percent: 0 });
    await ffmpeg.exec([
      ...base,
      ...audioIn,
      "-c:v",
      "libx264",
      "-preset",
      "ultrafast",
      "-crf",
      "26",
      "-pix_fmt",
      "yuv420p",
      ...audioOut,
      "-movflags",
      "+faststart",
      "output.mp4",
    ]);
  } finally {
    ffmpeg.off("progress", handleProgress);
  }

  const data = (await ffmpeg.readFile("output.mp4")) as Uint8Array;
  const buffer = new ArrayBuffer(data.byteLength);
  new Uint8Array(buffer).set(data);

  for (const name of [...names, "list.txt", "output.mp4", ...(audioName ? [audioName] : [])]) {
    await ffmpeg.deleteFile(name).catch(() => undefined);
  }

  onProgress({ stage: "Pronto", percent: 100 });
  return new Blob([buffer], { type: "video/mp4" });
}

/** Reduz e comprime a imagem para caber no envio à Runway (9:16). */
export async function prepareImage(file: File): Promise<string> {
  const bitmap = await createImageBitmap(file);
  const targetW = 720;
  const targetH = 1280;
  const canvas = document.createElement("canvas");
  canvas.width = targetW;
  canvas.height = targetH;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Não foi possível preparar a imagem.");

  // Preenche o quadro vertical recortando o excedente (cover).
  const scale = Math.max(targetW / bitmap.width, targetH / bitmap.height);
  const w = bitmap.width * scale;
  const h = bitmap.height * scale;
  ctx.drawImage(bitmap, (targetW - w) / 2, (targetH - h) / 2, w, h);
  bitmap.close();

  return canvas.toDataURL("image/jpeg", 0.85);
}
