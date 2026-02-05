import axios from "axios";
import { createReadStream } from "node:fs";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { extname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { openai } from "./ai.client";

export type ConversationRole = "user" | "assistant";

export type ConversationMessage = {
  role: ConversationRole;
  content: string;
};

const SYSTEM_PROMPT = [
  "Eres un asistente por WhatsApp.",
  "Responde claro, directo y útil.",
  "Usa SIEMPRE el contexto real de la conversación, incluyendo lo dicho por el asistente antes.",
  "Si falta información, pregunta solo una cosa concreta.",
  "No inventes datos.",
].join(" ");

// ---------------- utils ----------------

function normalizeContentType(ct?: string) {
  if (!ct) return "";
  return ct.toLowerCase().split(";")[0].trim(); // <- quita "; codecs=opus"
}

function extensionFromContentType(contentType?: string) {
  const ct = normalizeContentType(contentType);
  if (!ct) return "";

  if (ct === "image/jpeg" || ct === "image/jpg") return ".jpg";
  if (ct === "image/png") return ".png";
  if (ct === "image/webp") return ".webp";
  if (ct === "image/gif") return ".gif";

  if (ct === "audio/mpeg" || ct === "audio/mp3") return ".mp3";
  if (ct === "audio/wav") return ".wav";
  if (ct === "audio/ogg" || ct === "application/ogg") return ".ogg";
  if (ct === "audio/mp4" || ct === "audio/m4a" || ct === "video/mp4") return ".m4a";

  return "";
}

function extensionFromUrl(url: string) {
  try {
    const pathname = new URL(url).pathname;
    const ext = extname(pathname);
    return ext && ext.length <= 8 ? ext : "";
  } catch {
    return "";
  }
}

/**
 * Descarga robusta para CDN firmado.
 * - añade User-Agent / Accept
 * - aguanta query enorme
 * - timeout razonable
 */
async function downloadToTempFile(url: string, prefix: "audio" | "image") {
  const resp = await axios.get<ArrayBuffer>(url, {
    responseType: "arraybuffer",
    timeout: 45000,
    maxContentLength: 40 * 1024 * 1024,
    // algunos CDNs se ponen tiquismiquis si no pareces "navegador"
    headers: {
      "User-Agent": "Mozilla/5.0 (compatible; AimotiveBot/1.0)",
      Accept: "*/*",
    },
    // por si axios intenta cosas raras con proxies/redirects:
    maxRedirects: 5,
    validateStatus: (s) => s >= 200 && s < 300,
  });

  const contentType = String(resp.headers["content-type"] || "application/octet-stream");
  const ext =
    extensionFromContentType(contentType) || extensionFromUrl(url) || (prefix === "image" ? ".jpg" : ".bin");

  const tempPath = join(tmpdir(), `aura-${prefix}-${randomUUID()}${ext}`);
  await fs.writeFile(tempPath, Buffer.from(resp.data));

  return {
    path: tempPath,
    mimeType: contentType,
  };
}

// ---------------- OpenAI calls ----------------

export async function generateReply(messages: ConversationMessage[]) {
  const input = [
    { role: "system" as const, content: SYSTEM_PROMPT },
    ...messages.map((m) => ({ role: m.role, content: m.content })),
  ];

  const resp = await openai.responses.create({
    model: "gpt-4o",
    input,
  });

  return (resp.output_text || "").trim();
}

export async function transcribeAudioFromUrl(audioUrl: string) {
  const { path } = await downloadToTempFile(audioUrl, "audio");

  try {
    const transcript = await openai.audio.transcriptions.create({
      model: "gpt-4o-mini-transcribe",
      language: "es",
      file: createReadStream(path),
      response_format: "text",
    });

    return String(transcript || "").trim();
  } finally {
    await fs.unlink(path).catch(() => undefined);
  }
}

export async function describeImageFromUrl(imageUrl: string) {
  const { path, mimeType } = await downloadToTempFile(imageUrl, "image");

  try {
    const bytes = await fs.readFile(path);
    const dataUrl = `data:${normalizeContentType(mimeType) || "image/jpeg"};base64,${bytes.toString("base64")}`;

    const prompt = [
      "Mira la imagen y descríbela con mucho detalle en español.",
      "Incluye objetos, texto visible, contexto, colores, disposición y cualquier detalle relevante.",
      "Si algo es incierto, dilo explícitamente.",
    ].join(" ");

    const resp = await openai.responses.create({
      model: "gpt-4o",
      input: [
        {
          role: "user",
          content: [
            { type: "input_text", text: prompt },
            { type: "input_image", image_url: dataUrl },
          ],
        },
      ] as any,
    });

    return (resp.output_text || "").trim();
  } finally {
    await fs.unlink(path).catch(() => undefined);
  }
}
