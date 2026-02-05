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

type NormalizedInbound = {
  instance: string;
  conversation: string;
  type: "text" | "audio" | "image";
  text?: string;
  mediaUrl?: string;
  caption?: string;
  duration?: number;
  fromId?: string;
  messageId?: string;
  date?: string;
};

type SessionMsg = ConversationMessage & { ts: number };
type Session = { messages: SessionMsg[] };

const TTL_SECONDS = Number(process.env.SESSION_TTL_SECONDS) || 180;
const MAX_MESSAGES = Number(process.env.SESSION_MAX_MESSAGES) || 12;
const CONTEXT_WINDOW = Number(process.env.SESSION_CONTEXT_WINDOW) || 10;

function sessionKey(instanceId: string, conversationId: string) {
  return `sess:${instanceId}:${conversationId}`;
}

function normalizeConversationIdForOutbound(conversationId: string) {
  return conversationId.replace(/:\d+(?=@)/, "");
}

// -------------------- Utils --------------------

function unescapeSkritString(s: string) {
  return s.replace(/\\"/g, '"').replace(/\\\//g, "/");
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

function extractJsonKeyString(obj: unknown): string | null {
  if (!obj || typeof obj !== "object") return null;
  const keys = Object.keys(obj as Record<string, unknown>);
  const jsonKey = keys.find((k) => typeof k === "string" && k.trim().startsWith("{"));
  return jsonKey || null;
}

function parseJsonKeyObject(obj: unknown): unknown | null {
  const jsonKey = extractJsonKeyString(obj);
  if (!jsonKey) return null;

  try {
    return JSON.parse(jsonKey);
  } catch {
    return unescapeSkritString(jsonKey);
  }
}

function normalizeRaw(reqBody: unknown, app?: FastifyInstance): unknown {
  if (!reqBody) return reqBody;

  if (typeof reqBody === "object") {
    const o = reqBody as Record<string, unknown>;
    if (o.instance && o.conversation && o.message) return reqBody;

    const rootParsed = parseJsonKeyObject(reqBody);
    if (rootParsed) return rootParsed;

    const candidate = o.body ?? reqBody;

    if (typeof candidate === "string") return safeParseJsonString(candidate, app);

    if (candidate && typeof candidate === "object") {
      const c = candidate as Record<string, unknown>;
      if (c.instance && c.conversation && c.message) return candidate;

      const insideParsed = parseJsonKeyObject(candidate);
      if (insideParsed) return insideParsed;

      if (c.body !== undefined) return normalizeRaw(candidate, app);

      return candidate;
    }

    return candidate;
  }

  return safeParseJsonString(reqBody, app);
}

function looksLikeBrokenSkritMedia(raw: string) {
  return (
    raw.includes('"type":"image"') ||
    raw.includes('"type":"audio"') ||
    raw.includes('"mime":"image/') ||
    raw.includes('"mime":"audio/')
  );
}

function buildSignedUrl(baseUrl: string, params: Record<string, string | undefined>) {
  const qp = Object.entries(params)
    .filter(([, v]) => v !== undefined && v !== null && v !== "")
    .map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`)
    .join("&");

  return qp ? `${baseUrl}?${qp}` : baseUrl;
}

function extractAmzParams(rawObjectOrString: unknown): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};

  if (rawObjectOrString && typeof rawObjectOrString === "object") {
    const o = rawObjectOrString as Record<string, unknown>;
    for (const k of [
      "X-Amz-Algorithm",
      "X-Amz-Credential",
      "X-Amz-Date",
      "X-Amz-Expires",
      "X-Amz-SignedHeaders",
      "X-Amz-Signature",
    ]) {
      const v = o[k];
      if (typeof v === "string") out[k] = v;
    }
    return out;
  }

  if (typeof rawObjectOrString === "string") {
    const s = rawObjectOrString;
    const grab = (re: RegExp) => re.exec(s)?.[1];

    out["X-Amz-Algorithm"] = grab(/"X-Amz-Algorithm"\s*:\s*"([^"]+)"/);
    out["X-Amz-Credential"] = grab(/"X-Amz-Credential"\s*:\s*"([^"]+)"/);
    out["X-Amz-Date"] = grab(/"X-Amz-Date"\s*:\s*"([^"]+)"/);
    out["X-Amz-Expires"] = grab(/"X-Amz-Expires"\s*:\s*"([^"]+)"/);
    out["X-Amz-SignedHeaders"] = grab(/"X-Amz-SignedHeaders"\s*:\s*"([^"]+)"/);
    out["X-Amz-Signature"] = grab(/"X-Amz-Signature"\s*:\s*"([^"]+)"/);

    return out;
  }

  return out;
}

function inferType(opts: { type?: string; mime?: string; url?: string; body?: string }) {
  const t = (opts.type || "").toLowerCase();
  const mime = (opts.mime || "").toLowerCase();
  const url = (opts.url || "").toLowerCase();
  const body = (opts.body || "").trim();

  if (t === "image" || mime.startsWith("image/") || url.includes("/imagemessage/")) return "image";
  if (t === "audio" || mime.startsWith("audio/") || url.includes("/audiomessage/")) return "audio";
  if (t === "text" || body) return "text";
  return "text";
}

function normalizeSkritInbound(anyPayload: unknown): NormalizedInbound | null {
  // -------- 1) JSON "bueno" (objeto) --------
  if (anyPayload && typeof anyPayload === "object") {
    const o = anyPayload as any;

    // algunos payloads traen data sin "type", pero sí mime/url
    const instance = o.instance ? String(o.instance) : "";
    const conversation = o.conversation ? String(o.conversation) : "";
    const data = o.message?.data;

    if (instance && conversation && data) {
      const mediaUrl =
        data.mediaUrl || data.url || data.fileUrl || data.file_url;

      const type = inferType({
        type: data.type,
        mime: data.mime,
        url: mediaUrl,
        body: data.body,
      }) as "text" | "audio" | "image";

      return {
        instance,
        conversation,
        type,
        text: type === "text" ? String(data.body || "") : undefined,
        mediaUrl: type !== "text" ? (mediaUrl ? String(mediaUrl) : undefined) : undefined,
        caption: data.caption ?? undefined,
        duration: typeof data.duration === "number" ? data.duration : undefined,
        fromId: o.message?.from?.id ? String(o.message.from.id) : undefined,
        messageId: o.message?.id ? String(o.message.id) : undefined,
        date: o.message?.date ? String(o.message.date) : undefined,
      };
    }

    // JSON como key (caso viejo)
    const jsonKey = extractJsonKeyString(o);
    if (jsonKey) {
      const parsedOrString = parseJsonKeyObject(o);
      return normalizeSkritInbound(parsedOrString);
    }
  }

  // -------- 2) String roto --------
  if (typeof anyPayload === "string") {
    const raw = unescapeSkritString(anyPayload);

    const grab = (re: RegExp) => re.exec(raw)?.[1];

    const instance = grab(/"instance"\s*:\s*"([^"]+)"/) || "";
    const conversation = grab(/"conversation"\s*:\s*"([^"]+)"/) || "";
    if (!instance || !conversation) return null;

    const messageId = grab(/"id"\s*:\s*"([^"]+)"/);
    const fromId = grab(/"from"\s*:\s*\{\s*"id"\s*:\s*"([^"]+)"/);

    // body (si es texto)
    const body = grab(/"body"\s*:\s*"([^"]*)"/) || "";

    // mime (muy útil)
    const mime = grab(/"mime"\s*:\s*"([^"]+)"/) || "";

    // url base
    let baseUrl =
      grab(/"url"\s*:\s*"(https?:\/\/[^"]+?)\?X-Amz-Algorithm"/) ||
      grab(/"url"\s*:\s*"(https?:\/\/[^"]+?\.(?:jpe?g|png|webp|gif|oga|ogg|opus|mp3|wav|m4a))"/) ||
      grab(/(https?:\/\/cdn\.evo\.skrit\.es[^\s"']+\.(?:jpe?g|png|webp|gif|oga|ogg|opus|mp3|wav|m4a))/);

    if (baseUrl) baseUrl = baseUrl.replace(/\\\//g, "/");

    // type (si existe)
    const typeRaw = grab(/"type"\s*:\s*"(text|audio|image)"/) || "";

    // amz params (si vienen separados)
    const amz = extractAmzParams(raw);
    let mediaUrl = baseUrl;

    if (baseUrl && Object.values(amz).some(Boolean)) {
      mediaUrl = buildSignedUrl(baseUrl, {
        "X-Amz-Algorithm": amz["X-Amz-Algorithm"],
        "X-Amz-Credential": amz["X-Amz-Credential"],
        "X-Amz-Date": amz["X-Amz-Date"],
        "X-Amz-Expires": amz["X-Amz-Expires"],
        "X-Amz-SignedHeaders": amz["X-Amz-SignedHeaders"],
        "X-Amz-Signature": amz["X-Amz-Signature"],
      });
    }

    const captionRaw = grab(/"caption"\s*:\s*(null|"[^"]*")/);
    const caption = captionRaw === "null" ? undefined : captionRaw?.replace(/^"|"$/g, "");

    const dur = grab(/"duration"\s*:\s*(\d+)/);
    const duration = dur ? Number(dur) : undefined;
    

    const type = inferType({ type: typeRaw, mime, url: mediaUrl, body }) as
      | "text"
      | "audio"
      | "image";

    return {
      instance,
      conversation,
      type,
      text: type === "text" ? body : undefined,
      mediaUrl: type !== "text" ? (mediaUrl || undefined) : undefined,
      caption,
      duration,
      fromId: fromId || undefined,
      messageId: messageId || undefined,
      date: grab(/"date"\s*:\s*"([^"]+)"/) || undefined,
      
    };
  }
  

  return null;
  
}



// Zod del objeto normalizado (estable)
const NormalizedInboundSchema = z.object({
  instance: z.string().uuid(),
  conversation: z.string().min(8).includes("@"),
  type: z.enum(["text", "audio", "image"]),
  text: z.string().optional(),
  mediaUrl: z.string().optional(),
  caption: z.string().optional(),
  duration: z.number().optional(),
  fromId: z.string().optional(),
  messageId: z.string().optional(),
  date: z.string().optional(),
});

// Session helpers
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

// -------------------- Route --------------------

export async function webhook(app: FastifyInstance) {
  app.post("/webhook/aimotive/inbound", async (req, reply) => {
    const normalizedRaw = normalizeRaw(req.body, app);
    const normalizedInbound = normalizeSkritInbound(normalizedRaw);

    if (!normalizedInbound) {
      app.log.warn({ rawType: typeof req.body }, "Could not normalize inbound");
      return reply.code(200).send({ ok: true, ignored: true });
    }

    const ok = NormalizedInboundSchema.safeParse(normalizedInbound);
    if (!ok.success) {
      app.log.warn({ errors: ok.error.format(), normalizedInbound }, "Invalid normalized inbound");
      return reply.code(200).send({ ok: true, ignored: true });
    }

    const inbound = ok.data;

    app.log.info(
      { type: inbound.type, conversation: inbound.conversation, mediaUrl: inbound.mediaUrl },
      "Inbound normalized"
    );

    const key = sessionKey(inbound.instance, inbound.conversation);
    const session = await loadSession(key, app);

    // user content
    let normalizedUserContent = "";

    if (inbound.type === "text") {
      normalizedUserContent = (inbound.text || "").trim() || "[texto vacío]";
    }

    if (inbound.type === "audio") {
      if (!inbound.mediaUrl) {
        normalizedUserContent = "[audio sin URL disponible para transcripción]";
      } else {
        try {
          const transcript = await transcribeAudioFromUrl(inbound.mediaUrl);
          normalizedUserContent = transcript || "[audio recibido pero sin texto transcrito]";
        } catch (e) {
          app.log.error({ err: e, mediaUrl: inbound.mediaUrl }, "Audio transcription failed");
          normalizedUserContent = "[audio recibido pero falló la transcripción]";
        }
      }
    }

    if (inbound.type === "image") {
      if (!inbound.mediaUrl) {
        normalizedUserContent = "[imagen sin URL disponible para análisis]";
      } else {
        try {
          const description = await describeImageFromUrl(inbound.mediaUrl);
          const caption = inbound.caption ? `\nCaption: ${inbound.caption}` : "";
          normalizedUserContent = `Imagen analizada:${caption}\n${description}`;
        } catch (e) {
          app.log.error({ err: e, mediaUrl: inbound.mediaUrl }, "Image analysis failed");
          normalizedUserContent = "[imagen recibida pero falló el análisis visual]";
        }
      }
    }

    session.messages.push({ role: "user", content: normalizedUserContent, ts: Date.now() });
    session.messages = session.messages.slice(-MAX_MESSAGES);

    // AI
    let responseText = "";
    try {
      const context = session.messages
        .slice(-CONTEXT_WINDOW)
        .map((m) => ({ role: m.role, content: m.content }));

      responseText = await generateReply(context);
      if (!responseText) responseText = "🤖 Me quedé en blanco… ¿me lo repites?";
    } catch (e) {
      app.log.error({ err: e }, "AI generation failed");
      responseText = "🤖 Tuve un problema pensando eso… intenta otra vez.";
    }

    session.messages.push({ role: "assistant", content: responseText, ts: Date.now() });
    session.messages = session.messages.slice(-MAX_MESSAGES);

    await saveSession(key, session, app);

    const outboundConversationId = normalizeConversationIdForOutbound(inbound.conversation);
    try {
      await sendConversationMessage(inbound.instance, outboundConversationId, responseText);
      app.log.info({ outboundConversationId }, "Outbound message sent");
    } catch (err: any) {
      app.log.error(
        {
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
}
