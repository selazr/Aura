import { FastifyInstance } from "fastify";
import { z } from "zod";
import { sendConversationMessage } from "../services/aimotive.client";
import { redis } from "../lib/redis";
import { generateReply } from "../services/ai.reply";

const SkritInboundSchema = z.object({
  instance: z.string().uuid(),
  conversation: z.string().min(16).includes("@"),
  message: z.object({
    id: z.string(),
    date: z.string().optional(),
    from: z.object({
      id: z.string(),
      isMine: z.boolean().optional(),
    }),
    data: z.object({
      type: z.enum(["text", "audio", "image"]),
      body: z.string().optional(),
    }),
  }),
});

type SessionMsg = {
  role: "user" | "assistant";
  content: string;
  ts: number;
};

type Session = {
  messages: SessionMsg[];
};

function sessionKey(instanceId: string, conversationId: string) {
  return `sess:${instanceId}:${conversationId}`;
}

const TTL_SECONDS = Number(process.env.SESSION_TTL_SECONDS) || 180; // 3 min
const MAX_MESSAGES = Number(process.env.SESSION_MAX_MESSAGES) || 12;

// --- helpers -------------------------------------------------------------

// Caso n8n mutante: { "{...json...}": "" }  (JSON como KEY)
function parseJsonKeyObject(obj: any): any | null {
  if (!obj || typeof obj !== "object") return null;
  const keys = Object.keys(obj);
  const jsonKey = keys.find((k) => typeof k === "string" && k.trim().startsWith("{"));
  if (!jsonKey) return null;
  try {
    return JSON.parse(jsonKey);
  } catch {
    return null;
  }
}

// Intenta parsear string JSON sin tirar el server (incluye caso n8n: '={...}')
function safeParseJsonString(s: unknown, app?: FastifyInstance): any | unknown {
  if (typeof s !== "string") return s;

  let t = s.trim();
  if (!t) return s;

  // n8n a veces manda '={...}' (ojo al '=')
  if (t.startsWith("=")) t = t.slice(1).trim();

  // solo intentamos si tiene pinta de JSON
  if (!(t.startsWith("{") || t.startsWith("["))) return s;

  try {
    return JSON.parse(t);
  } catch (e) {
    app?.log?.warn?.(
      { err: e, sample: t.slice(0, 200) },
      "String looked like JSON but failed to parse"
    );
    return s;
  }
}

/**
 * Normaliza para soportar:
 * - payload objeto directo
 * - { body: "<json string>" }
 * - { body: { ...payload... } }
 * - form-urlencoded n8n: body: { "{...json...}": "" }
 * - n8n mutante: { "{...json...}": "" } (JSON como KEY)
 */
function normalizeInboundPayload(raw: any, app?: FastifyInstance) {
  if (!raw) return raw;

  // A) ya viene perfecto
  if (raw.instance && raw.conversation && raw.message) return raw;

  // B) n8n mutante en root
  const rootParsed = parseJsonKeyObject(raw);
  if (rootParsed) return rootParsed;

  // C) si viene envuelto en raw.body
  const candidate = raw.body ?? raw;

  // C1) candidate es string -> intentar parsear
  if (typeof candidate === "string") {
    return safeParseJsonString(candidate, app);
  }

  // C2) candidate es object
  if (candidate && typeof candidate === "object") {
    if (candidate.instance && candidate.conversation && candidate.message) return candidate;

    // C2a) n8n mutante dentro de body
    const insideParsed = parseJsonKeyObject(candidate);
    if (insideParsed) return insideParsed;

    // C2b) doble wrapper { body: { body: "..." } } / { body: "..." }
    if (candidate.body !== undefined) {
      return normalizeInboundPayload(candidate, app);
    }

    return candidate;
  }

  return candidate;
}

// Provider outbound: recorta sufijo ':NN' antes de '@' para cumplir límite
function normalizeConversationIdForOutbound(conversationId: string) {
  return conversationId.replace(/:\d+(?=@)/, "");
}

// --- route ---------------------------------------------------------------

export async function webhook(app: FastifyInstance) {
  app.post("/webhook/aimotive/inbound", async (req, reply) => {
    const ct = req.headers["content-type"];

    const normalized = normalizeInboundPayload(req.body, app);

    // Si aún queda string JSON, intentar parsear otra vez
    const finalPayload = safeParseJsonString(normalized, app);

    app.log.info(
      {
        ct,
        rawType: typeof req.body,
        normalizedType: typeof normalized,
        finalType: typeof finalPayload,
        normalizedPreview:
          typeof normalized === "string" ? normalized.slice(0, 200) : normalized,
        finalPreview:
          typeof finalPayload === "string" ? finalPayload.slice(0, 200) : finalPayload,
      },
      "Inbound received"
    );

    const parsed = SkritInboundSchema.safeParse(finalPayload);

    if (!parsed.success) {
      app.log.warn(
        { ct, errors: parsed.error.format(), raw: req.body, normalized, finalPayload },
        "Invalid inbound payload"
      );
      return reply.code(200).send({ ok: true, ignored: true });
    }

    const inbound = parsed.data;

    // Anti-loop
    if (inbound.message.from.isMine === true) {
      app.log.info(
        { instanceId: inbound.instance, conversationId: inbound.conversation },
        "Ignored isMine message"
      );
      return reply.code(200).send({ ok: true, ignored: true });
    }

    const instanceId = inbound.instance;
    const conversationId = inbound.conversation;

    const incomingText =
      inbound.message.data.type === "text" ? inbound.message.data.body ?? "" : "";

    const key = sessionKey(instanceId, conversationId);

    // 1) Cargar sesión
    let session: Session = { messages: [] };
    try {
      const rawSession = await redis.get(key);
      if (rawSession) session = JSON.parse(rawSession) as Session;
    } catch (e) {
      app.log.error({ err: e }, "Redis get/parse failed (continuing without session)");
      session = { messages: [] };
    }

    // 2) Añadir mensaje del usuario a la sesión
    session.messages.push({
      role: "user",
      content: incomingText || `[${inbound.message.data.type}]`,
      ts: Date.now(),
    });

    session.messages = session.messages.slice(-MAX_MESSAGES);

  // 3) Respuesta con IA
    let responseText = "";

    try {
      // Pasamos SOLO texto a la IA (últimos N mensajes)
      const context = session.messages
        .slice(-8) // ajustable
        .map((m) => m.content);

      responseText = await generateReply(context);

      if (!responseText) {
        responseText = "🤖 Me quedé en blanco… ¿me lo repites?";
      }
    } catch (e) {
      app.log.error({ err: e }, "AI generation failed");
      responseText = "🤖 Tuve un problema pensando eso… intenta otra vez.";
    }

    // 4) Añadir respuesta a la sesión
    session.messages.push({
      role: "assistant",
      content: responseText,
      ts: Date.now(),
    });
    session.messages = session.messages.slice(-MAX_MESSAGES);

    // 5) Guardar sesión con TTL
    try {
      await redis.set(key, JSON.stringify(session), { EX: TTL_SECONDS });
      app.log.info({ key, ttl: TTL_SECONDS, size: session.messages.length }, "Session saved to Redis");
    } catch (e) {
      app.log.error({ err: e }, "Redis set failed (continuing)");
    }

    // 6) Enviar a WhatsApp (normalizando conversationId)
    const outboundConversationId = normalizeConversationIdForOutbound(conversationId);

    try {
      const res = await sendConversationMessage(instanceId, outboundConversationId, responseText);

      app.log.info(
        {
          instanceId,
          conversationId,
          outboundConversationId,
          sid: res?.sid,
          responseText,
        },
        "Outbound message sent"
      );
    } catch (err: any) {
      app.log.error(
        {
          instanceId,
          conversationId,
          outboundConversationId,
          responseText,
          status: err?.response?.status,
          data: err?.response?.data,
          message: err?.message,
        },
        "Outbound message FAILED"
      );
    }

    return reply.code(200).send({ ok: true });
  });
}
