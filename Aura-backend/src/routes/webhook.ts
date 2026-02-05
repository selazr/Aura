import { FastifyInstance } from "fastify";
import { z } from "zod";
import { redis } from "../lib/redis";
import { sendConversationMessage } from "../services/aimotive.client";
import {
  describeImageFromUrl,
  generateReply,
  transcribeAudioFromUrl,
  type ConversationMessage,
} from "../services/ai.reply";

const InboundSchema = z.object({
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
      caption: z.string().optional(),
      url: z.string().url().optional(),
      mediaUrl: z.string().url().optional(),
      fileUrl: z.string().url().optional(),
      file_url: z.string().url().optional(),
    }),
  }),
});

const OutboundEventSchema = z.object({
  instance: z.string().uuid().optional(),
  conversation: z.string().optional(),
  event: z.string().optional(),
  status: z.string().optional(),
  message: z.unknown().optional(),
});

type SessionMsg = ConversationMessage & { ts: number };
type Session = { messages: SessionMsg[] };

const TTL_SECONDS = Number(process.env.SESSION_TTL_SECONDS) || 180;
const MAX_MESSAGES = Number(process.env.SESSION_MAX_MESSAGES) || 12;
const CONTEXT_WINDOW = Number(process.env.SESSION_CONTEXT_WINDOW) || 10;

function sessionKey(instanceId: string, conversationId: string) {
  return `sess:${instanceId}:${conversationId}`;
}

function parseJsonKeyObject(obj: unknown): unknown | null {
  if (!obj || typeof obj !== "object") return null;
  const keys = Object.keys(obj as Record<string, unknown>);
  const jsonKey = keys.find((k) => k.trim().startsWith("{"));
  if (!jsonKey) return null;
  try {
    return JSON.parse(jsonKey);
  } catch {
    return null;
  }
}

function safeParseJsonString(s: unknown, app?: FastifyInstance): unknown {
  if (typeof s !== "string") return s;

  let t = s.trim();
  if (!t) return s;
  if (t.startsWith("=")) t = t.slice(1).trim();
  if (!(t.startsWith("{") || t.startsWith("["))) return s;

  try {
    return JSON.parse(t);
  } catch (e) {
    app?.log.warn({ err: e, sample: t.slice(0, 200) }, "Could not parse JSON-like string");
    return s;
  }
}

function normalizeInboundPayload(raw: unknown, app?: FastifyInstance): unknown {
  if (!raw) return raw;

  if (typeof raw === "object") {
    const obj = raw as Record<string, unknown>;
    if (obj.instance && obj.conversation && obj.message) return raw;

    const rootParsed = parseJsonKeyObject(raw);
    if (rootParsed) return rootParsed;

    const candidate = obj.body ?? raw;

    if (typeof candidate === "string") return safeParseJsonString(candidate, app);

    if (candidate && typeof candidate === "object") {
      const c = candidate as Record<string, unknown>;
      if (c.instance && c.conversation && c.message) return candidate;

      const insideParsed = parseJsonKeyObject(candidate);
      if (insideParsed) return insideParsed;

      if (c.body !== undefined) return normalizeInboundPayload(candidate, app);

      return candidate;
    }

    return candidate;
  }

  return raw;
}

function normalizeConversationIdForOutbound(conversationId: string) {
  return conversationId.replace(/:\d+(?=@)/, "");
}

function extractMediaUrl(data: z.infer<typeof InboundSchema>["message"]["data"]) {
  return data.mediaUrl || data.url || data.fileUrl || data.file_url;
}

async function loadSession(key: string, app: FastifyInstance): Promise<Session> {
  try {
    const raw = await redis.get(key);
    if (!raw) return { messages: [] };
    return JSON.parse(raw) as Session;
  } catch (e) {
    app.log.error({ err: e }, "Redis get/parse failed");
    return { messages: [] };
  }
}

async function saveSession(key: string, session: Session, app: FastifyInstance) {
  try {
    await redis.set(key, JSON.stringify(session), { EX: TTL_SECONDS });
    app.log.info({ key, ttl: TTL_SECONDS, size: session.messages.length }, "Session saved");
  } catch (e) {
    app.log.error({ err: e }, "Redis set failed");
  }
}

export async function webhook(app: FastifyInstance) {
  app.post("/webhook/aimotive/inbound", async (req, reply) => {
    const normalized = normalizeInboundPayload(req.body, app);
    const finalPayload = safeParseJsonString(normalized, app);

    const parsed = InboundSchema.safeParse(finalPayload);
    if (!parsed.success) {
      app.log.warn({ errors: parsed.error.format(), raw: req.body }, "Invalid inbound payload");
      return reply.code(200).send({ ok: true, ignored: true });
    }

    const inbound = parsed.data;

    if (inbound.message.from.isMine === true) {
      return reply.code(200).send({ ok: true, ignored: true });
    }

    const instanceId = inbound.instance;
    const conversationId = inbound.conversation;
    const messageType = inbound.message.data.type;

    const key = sessionKey(instanceId, conversationId);
    const session = await loadSession(key, app);

    let normalizedUserContent = "";

    if (messageType === "text") {
      normalizedUserContent = (inbound.message.data.body || "").trim();
    }

    if (messageType === "audio") {
      const mediaUrl = extractMediaUrl(inbound.message.data);
      if (!mediaUrl) {
        normalizedUserContent = "[audio sin URL disponible para transcripción]";
      } else {
        try {
          const transcript = await transcribeAudioFromUrl(mediaUrl);
          normalizedUserContent = transcript || "[audio recibido pero sin texto transcrito]";
        } catch (e) {
          app.log.error({ err: e, conversationId }, "Audio transcription failed");
          normalizedUserContent = "[audio recibido pero falló la transcripción]";
        }
      }
    }

    if (messageType === "image") {
      const mediaUrl = extractMediaUrl(inbound.message.data);
      if (!mediaUrl) {
        normalizedUserContent = "[imagen sin URL disponible para análisis]";
      } else {
        try {
          const description = await describeImageFromUrl(mediaUrl);
          const caption = inbound.message.data.caption ? `\nCaption: ${inbound.message.data.caption}` : "";
          normalizedUserContent = `Imagen analizada:${caption}\n${description}`;
        } catch (e) {
          app.log.error({ err: e, conversationId }, "Image analysis failed");
          normalizedUserContent = "[imagen recibida pero falló el análisis visual]";
        }
      }
    }

    if (!normalizedUserContent) {
      normalizedUserContent = `[${messageType}]`;
    }

    session.messages.push({ role: "user", content: normalizedUserContent, ts: Date.now() });
    session.messages = session.messages.slice(-MAX_MESSAGES);

    let responseText = "";
    try {
      const context = session.messages.slice(-CONTEXT_WINDOW).map((m) => ({
        role: m.role,
        content: m.content,
      }));

      responseText = await generateReply(context);
      if (!responseText) responseText = "🤖 Me quedé en blanco… ¿me lo repites?";
    } catch (e) {
      app.log.error({ err: e }, "AI generation failed");
      responseText = "🤖 Tuve un problema pensando eso… intenta otra vez.";
    }

    session.messages.push({ role: "assistant", content: responseText, ts: Date.now() });
    session.messages = session.messages.slice(-MAX_MESSAGES);

    await saveSession(key, session, app);

    const outboundConversationId = normalizeConversationIdForOutbound(conversationId);
    try {
      await sendConversationMessage(instanceId, outboundConversationId, responseText);
      app.log.info({ instanceId, conversationId, outboundConversationId }, "Outbound message sent");
    } catch (err: any) {
      app.log.error(
        {
          instanceId,
          conversationId,
          outboundConversationId,
          status: err?.response?.status,
          data: err?.response?.data,
          message: err?.message,
        },
        "Outbound message FAILED"
      );
    }

    return reply.code(200).send({ ok: true });
  });

  app.post("/webhook/aimotive/outbound", async (req, reply) => {
    const normalized = normalizeInboundPayload(req.body, app);
    const finalPayload = safeParseJsonString(normalized, app);

    const parsed = OutboundEventSchema.safeParse(finalPayload);
    if (!parsed.success) {
      app.log.warn({ errors: parsed.error.format(), raw: req.body }, "Invalid outbound webhook payload");
      return reply.code(200).send({ ok: true, ignored: true });
    }

    app.log.info({ outboundEvent: parsed.data }, "Outbound webhook event received");
    return reply.code(200).send({ ok: true });
  });
}
