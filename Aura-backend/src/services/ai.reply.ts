import axios from "axios";
import { createReadStream } from "node:fs";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { extname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { openai } from "./ai.client";

export type ConversationRole = "system" | "user" | "assistant";

export type ConversationMessage = {
  role: ConversationRole;
  content: string;
};

const SYSTEM_PROMPT = [
  "Eres un asistente de recambios por WhatsApp.",
  "Responde en español claro, directo y útil.",
  "Usa SIEMPRE el contexto real de la conversación, incluyendo lo dicho por el asistente antes.",
  "Prioriza exactitud técnica sobre creatividad.",
  "Si falta información, pregunta solo una cosa concreta.",
  "No inventes datos.",
].join(" ");

// ---------------- utils ----------------

function normalizeContentType(ct?: string) {
  if (!ct) return "";
  return ct.toLowerCase().split(";")[0].trim();
}

function extensionFromContentType(contentType?: string) {
  const ct = normalizeContentType(contentType);
  if (!ct) return "";

  // images
  if (ct === "image/jpeg" || ct === "image/jpg") return ".jpg";
  if (ct === "image/png") return ".png";
  if (ct === "image/webp") return ".webp";
  if (ct === "image/gif") return ".gif";

  // audio
  if (ct === "audio/mpeg" || ct === "audio/mp3") return ".mp3";
  if (ct === "audio/wav") return ".wav";
  if (ct === "audio/ogg" || ct === "application/ogg") return ".ogg";
  if (ct === "audio/mp4" || ct === "audio/m4a" || ct === "video/mp4") return ".m4a";
  if (ct === "audio/opus") return ".opus";

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

function safePreviewUrl(url: string, max = 160) {
  if (!url) return "";
  const [base] = url.split("?");
  return base.length > max ? base.slice(0, max) + "…" : base;
}

/**
 * Descarga robusta para CDN firmado.
 * - logs útiles
 * - valida size
 * - fallback de ext para audio a .ogg si no se sabe
 */
async function downloadToTempFile(url: string, prefix: "audio" | "image") {
  console.log(`[download] start prefix=${prefix} url=${safePreviewUrl(url)}`);

  let resp: { data: ArrayBuffer; headers: any };
  try {
    resp = await axios.get<ArrayBuffer>(url, {
      responseType: "arraybuffer",
      timeout: 45000,
      maxContentLength: 40 * 1024 * 1024,
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; AimotiveBot/1.0)",
        Accept: "*/*",
      },
      maxRedirects: 5,
      validateStatus: (s) => s >= 200 && s < 300,
    });
  } catch (e: any) {
    console.error(
      `[download] FAIL prefix=${prefix} url=${safePreviewUrl(url)} status=${e?.response?.status} msg=${e?.message}`
    );
    throw e;
  }

  const contentType = String(resp.headers?.["content-type"] || "application/octet-stream");
  const bytes = Buffer.from(resp.data);
  const size = bytes.length;

  console.log(`[download] OK prefix=${prefix} ct=${contentType} bytes=${size}`);

  if (size === 0) {
    throw new Error(`Downloaded 0 bytes (prefix=${prefix}, ct=${contentType})`);
  }

  const ext =
    extensionFromContentType(contentType) ||
    extensionFromUrl(url) ||
    (prefix === "image" ? ".jpg" : ".ogg");

  const tempPath = join(tmpdir(), `aura-${prefix}-${randomUUID()}${ext}`);
  await fs.writeFile(tempPath, bytes);

  console.log(`[download] saved prefix=${prefix} path=${tempPath}`);
  return { path: tempPath, mimeType: contentType };
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

// ---------------- Decision-aware reply (NEW) ----------------

export type DecisionContext = {
  part?: { id: number; canonical_name: string; score: number };

  vehicle?: {
    plate?: string;
    brand?: string;
    model?: string;
    fuel?: string;
    vin?: string;
  };

  selectedProduct?: {
    ref: string;
    commercialRef?: string;
    name: string;
    brandName?: string;
    brandCode?: string;
    price?: number;
    vat?: number;
    discount?: number;
    isAvailable?: boolean;
    warehouses?: Array<{ code: string; name: string; stock: number; isExternal?: boolean }>;
  };

  alternatives?: Array<{
    ref: string;
    name: string;
    brandName?: string;
    price?: number;
    isAvailable?: boolean;
  }>;

  askOneClarifyingQuestion?: boolean;
};



function buildAssistantRules(decision?: DecisionContext) {
  const lines = [
    "REGLAS DE RESPUESTA:",
    "- Mensajes cortos (3-6 líneas), tono profesional y cercano.",
    "- Si hay producto seleccionado, proponlo directamente con marca/ref/precio si existe.",
    "- Si no hay producto fiable, pide SOLO 1 dato de aclaración.",
    "- Nunca inventes compatibilidades, stock ni precios.",
  ];

  if (decision?.selectedProduct) {
    lines.push("- Ya existe una selección técnica previa: no vuelvas a preguntar lo mismo.");
  }

  if (decision?.askOneClarifyingQuestion) {
    lines.push("- Debes hacer 1 pregunta cerrada para confirmar la familia correcta.");
  }

  return lines.join("\n");
}

function fmtMoneyEUR(v?: number) {
  if (typeof v !== "number" || !Number.isFinite(v)) return null;
  return `${v.toFixed(2)}€`;
}

function summarizeWarehouses(w?: any[]) {
  if (!Array.isArray(w) || w.length === 0) return null;
  const sorted = [...w].sort((a, b) => Number(b.stock || 0) - Number(a.stock || 0));
  const top = sorted
    .slice(0, 3)
    .map((x) => `${x.name || x.code}: ${Number(x.stock || 0)}`)
    .join(" | ");
  return top || null;
}

function buildDecisionPrompt(decision?: DecisionContext) {
  if (!decision) return "";

  const lines: string[] = [];
  lines.push("CONTEXTO TÉCNICO (fiable, úsalo como verdad):");

  if (decision.vehicle?.plate) {
    lines.push(
      `- Vehículo: matrícula=${decision.vehicle.plate}` +
        ` marca=${decision.vehicle.brand || "?"} modelo=${decision.vehicle.model || "?"}` +
        ` combustible=${decision.vehicle.fuel || "?"} vin=${decision.vehicle.vin || "?"}`
    );
  }

  if (decision.part) {
    lines.push(
      `- Pieza detectada (embedding): "${decision.part.canonical_name}" (id=${decision.part.id}, score=${decision.part.score.toFixed(
        3
      )})`
    );
  }

  if (decision.selectedProduct) {
    const p = decision.selectedProduct;
    const price = fmtMoneyEUR(p.price);
    const wh = summarizeWarehouses(p.warehouses as any);

    lines.push("- Producto seleccionado (usar para responder):");
    lines.push(
      `  ref=${p.ref}` +
        (p.commercialRef ? ` commercialRef=${p.commercialRef}` : "") +
        ` nombre="${p.name}"` +
        (p.brandName || p.brandCode ? ` marca=${p.brandName || p.brandCode}` : "") +
        (price ? ` precio=${price}` : "") +
        (typeof p.isAvailable === "boolean" ? ` disponible=${p.isAvailable ? "sí" : "no"}` : "")
    );
    if (wh) lines.push(`  stockTop=${wh}`);

    if (p.isAvailable === false) {
      lines.push("INSTRUCCIÓN: No hay stock. Ofrece alternativas disponibles o pregunta si lo quiere bajo pedido.");
    }
  }

  if (decision.alternatives?.length) {
    lines.push("- Alternativas relevantes (si el usuario pide opciones):");
    for (const a of decision.alternatives.slice(0, 3)) {
      lines.push(
        `  - ${a.ref}: "${a.name}"` +
          (a.brandName ? ` (${a.brandName})` : "") +
          (fmtMoneyEUR(a.price) ? ` ${fmtMoneyEUR(a.price)}` : "") +
          (typeof a.isAvailable === "boolean" ? ` disponible=${a.isAvailable ? "sí" : "no"}` : "")
      );
    }
  }

  if (decision.askOneClarifyingQuestion) {
    lines.push(
      "INSTRUCCIÓN: La confianza no es total. Haz SOLO 1 pregunta concreta para confirmar la pieza (ej. eje/posición/lado/medida)."
    );
  } else {
    lines.push(
      "INSTRUCCIÓN: Responde directo usando el producto seleccionado. No inventes stock/precio. Si falta un dato imprescindible, pregunta SOLO 1 cosa."
    );
  }

  return lines.join("\n");
}

export async function generateReplyWithDecision(messages: ConversationMessage[], decision?: DecisionContext) {
  const decisionBlock = buildDecisionPrompt(decision);

  const input = [
    { role: "system" as const, content: SYSTEM_PROMPT },
    { role: "system" as const, content: buildAssistantRules(decision) },
    ...(decisionBlock ? [{ role: "system" as const, content: decisionBlock }] : []),
    ...messages.map((m) => ({ role: m.role, content: m.content })),
  ];

  const resp = await openai.responses.create({
    model: "gpt-4o",
    input,
  });

  return (resp.output_text || "").trim();
}

// ---------------- Media helpers ----------------

export async function transcribeAudioFromUrl(audioUrl: string) {
  console.log(`[transcribe] start url=${safePreviewUrl(audioUrl)}`);

  const { path, mimeType } = await downloadToTempFile(audioUrl, "audio");

  try {
    console.log(`[transcribe] file=${path} ct=${mimeType}`);

    const transcript = await openai.audio.transcriptions.create({
      model: "gpt-4o-mini-transcribe",
      language: "es",
      file: createReadStream(path),
      response_format: "text",
    });

    const text = String(transcript || "").trim();
    console.log(`[transcribe] OK chars=${text.length}`);
    return text;
  } catch (e: any) {
    console.error(`[transcribe] FAIL msg=${e?.message}`);
    throw e;
  } finally {
    await fs.unlink(path).catch(() => undefined);
    console.log(`[transcribe] cleaned`);
  }
}

export async function describeImageFromUrl(imageUrl: string) {
  console.log(`[describeImage] start url=${safePreviewUrl(imageUrl)}`);

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

    const text = (resp.output_text || "").trim();
    console.log(`[describeImage] OK chars=${text.length}`);
    return text;
  } catch (e: any) {
    console.error(`[describeImage] FAIL msg=${e?.message}`);
    throw e;
  } finally {
    await fs.unlink(path).catch(() => undefined);
    console.log(`[describeImage] cleaned`);
  }
}
