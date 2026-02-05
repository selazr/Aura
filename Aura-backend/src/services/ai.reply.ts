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

function extensionFromContentType(contentType?: string) {
  if (!contentType) return "";
  const normalized = contentType.toLowerCase();
  if (normalized.includes("jpeg")) return ".jpg";
  if (normalized.includes("png")) return ".png";
  if (normalized.includes("webp")) return ".webp";
  if (normalized.includes("gif")) return ".gif";
  if (normalized.includes("mp3") || normalized.includes("mpeg")) return ".mp3";
  if (normalized.includes("wav")) return ".wav";
  if (normalized.includes("ogg")) return ".ogg";
  if (normalized.includes("m4a") || normalized.includes("mp4")) return ".m4a";
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

async function downloadToTempFile(url: string, prefix: "audio" | "image") {
  const resp = await axios.get<ArrayBuffer>(url, {
    responseType: "arraybuffer",
    timeout: 30000,
    maxContentLength: 40 * 1024 * 1024,
  });

  const ext =
    extensionFromContentType(String(resp.headers["content-type"] || "")) || extensionFromUrl(url) || ".bin";
  const tempPath = join(tmpdir(), `aura-${prefix}-${randomUUID()}${ext}`);

  await fs.writeFile(tempPath, Buffer.from(resp.data));

  return {
    path: tempPath,
    mimeType: String(resp.headers["content-type"] || "application/octet-stream"),
  };
}

export async function generateReply(messages: ConversationMessage[]) {
  const input = [
    { role: "system" as const, content: SYSTEM_PROMPT },
    ...messages.map((m) => ({
      role: m.role,
      content: m.content,
    })),
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
    const dataUrl = `data:${mimeType};base64,${bytes.toString("base64")}`;

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
