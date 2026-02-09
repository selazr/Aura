// src/routes/webhook.ts
import { FastifyInstance } from "fastify";
import { z } from "zod";
import { redis } from "../lib/redis";
import { sendConversationMessage } from "../services/aimotive.client";
import {
  describeImageFromUrl,
  generateReplyWithDecision,
  transcribeAudioFromUrl,
  type ConversationMessage,
  type DecisionContext,
} from "../services/ai.reply";

// ✅ servicios “limpios”
import { maybeCacheVehicleFromText } from "../services/vehicle.service";
import { matchCanonicalByEmbedding } from "../services/catalog.service";

// ✅ productos + normalizador + winner
import { getProductsForVehicleAndFamily as getProductsByVehicle } from "../services/products.service";
import { normalizeByFamily, selectWinner } from "../services/product-normalizer.service";

type NormalizedInbound = {
  instance: string;
  conversation: string;
  type: "text" | "audio" | "image";
  text?: string;
  mediaUrl?: string;
  caption?: string;
  duration?: number;
  debug?: Record<string, any>;
};

// ✅ Redis SOLO user/assistant
type SessionRole = "user" | "assistant";
type SessionMsg = { role: SessionRole; content: string; ts: number };

type VehicleCache = {
  plate?: string;
  vin?: string;
  brand?: string;
  model?: string;
  fuel?: string;
  registrationDate?: string;

  // ⚠️ ajusta según tu vehicle.service
  vehicleId?: string | number;

  vehicles?: any[];
  _cachedAt?: number;
};

type PartMatch = { id: number; canonical_name: string; score: number };

type SelectedProduct = DecisionContext["selectedProduct"];
type ProductAlt = NonNullable<DecisionContext["alternatives"]>[number];

type Session = {
  messages: SessionMsg[];

  vehicle?: VehicleCache;

  partMatches?: {
    matches: PartMatch[];
    _cachedAt: number;
    source: "embedding";
    textSample: string;
  };

  selectedProduct?: SelectedProduct | null;
  productAlternatives?: ProductAlt[];
};

const TTL_SECONDS = Number(process.env.SESSION_TTL_SECONDS) || 180;
const MAX_MESSAGES = Number(process.env.SESSION_MAX_MESSAGES) || 12;
const CONTEXT_WINDOW = Number(process.env.SESSION_CONTEXT_WINDOW) || 10;

const MATCH_THRESHOLD = Number(process.env.CATALOG_MATCH_THRESHOLD) || 0.82;
const MATCH_TOPK = Number(process.env.CATALOG_MATCH_TOPK) || 5;


const NormalizedInboundSchema = z.object({
  instance: z.string().uuid(),
  conversation: z.string().min(8).includes("@"),
  type: z.enum(["text", "audio", "image"]),
  text: z.string().optional(),
  mediaUrl: z.string().optional(),
  caption: z.string().optional(),
  duration: z.number().optional(),
});

function normalizeConversationIdForOutbound(conversationId: string) {
  return conversationId.replace(/:\d+(?=@)/, "");
}
function sessionKey(instanceId: string, conversationId: string) {
  return `sess:${instanceId}:${normalizeConversationIdForOutbound(conversationId)}`;
}

// -------------------- Redis --------------------

async function loadSession(key: string, app: FastifyInstance): Promise<Session> {
  try {
    const raw = await redis.get(key);
    if (!raw) return { messages: [] };
    const parsed = JSON.parse(raw) as Session;

    if (!parsed?.messages) parsed.messages = [];
    parsed.messages = parsed.messages
      .filter((m: any) => m && (m.role === "user" || m.role === "assistant"))
      .map((m: any) => ({
        role: m.role as SessionRole,
        content: String(m.content ?? ""),
        ts: Number(m.ts ?? Date.now()),
      }));

    return parsed;
  } catch (e) {
    app.log.error({ err: e }, "Redis get/parse failed");
    return { messages: [] };
  }
}

async function saveSession(key: string, session: Session, app: FastifyInstance) {
  try {
    await redis.set(key, JSON.stringify(session), { EX: TTL_SECONDS });
    app.log.info(
      {
        key,
        ttl: TTL_SECONDS,
        size: session.messages.length,
        hasVehicle: Boolean(session.vehicle),
        hasMatches: Boolean(session.partMatches?.matches?.length),
        hasSelected: Boolean(session.selectedProduct),
      },
      "Session saved"
    );
  } catch (e) {
    app.log.error({ err: e }, "Redis set failed");
  }
}

// -------------------- Normalizer (n8n-style) --------------------

const unescapeSkrit = (s: string) => s.replace(/\\"/g, '"').replace(/\\\//g, "/");
const normalizeMime = (m?: string) => (m || "").toLowerCase().split(";")[0].trim();
const grab = (re: RegExp, s: string) => (re.exec(String(s || "")) || [])[1] || "";

function buildSignedUrl(baseUrl: string, params: Record<string, string>) {
  const qp = Object.entries(params)
    .filter(([, v]) => v)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join("&");

  if (!qp) return baseUrl;
  return `${baseUrl}${baseUrl.includes("?") ? "&" : "?"}${qp}`;
}

function normalizeInbound(reqBody: any, app: FastifyInstance): NormalizedInbound | null {
  const b = (reqBody && (reqBody.body ?? reqBody)) || {};
  if (!b || typeof b !== "object") return null;

  const keys = Object.keys(b);
  const preKey = keys.find((k) => k.startsWith("{")) || "";
  const hasAmz = keys.some((k) => k.startsWith("X-Amz-"));

  // 1) TEXT
  if (preKey && !hasAmz) {
    try {
      const root = JSON.parse(preKey);
      const instance = String(root.instance || "");
      const conversation = String(root.conversation || "");
      const text = String(root?.message?.data?.body || "");
      if (!instance || !conversation) return null;

      return { instance, conversation, type: "text", text, debug: { route: "text" } };
    } catch (e) {
      app.log.error({ err: e }, "normalizeInbound: failed parsing text preKey");
      return null;
    }
  }

  // 2) MEDIA
  if (preKey && hasAmz) {
    const instance = grab(/"instance"\s*:\s*"([^"]+)"/, preKey);
    const conversation = grab(/"conversation"\s*:\s*"([^"]+)"/, preKey);
    const from_full = grab(/"from"\s*:\s*{\s*"id"\s*:\s*"([^"]+)"/, preKey);
    const messageId =
      grab(/"message"\s*:\s*{\s*"id"\s*:\s*"([^"]+)"/, preKey) || grab(/"id"\s*:\s*"([^"]+)"/, preKey);

    const mime = normalizeMime(grab(/"mime"\s*:\s*"([^"]+?)"/, preKey));

    const alg = String(b["X-Amz-Algorithm"] || "AWS4-HMAC-SHA256");
    const cred = String(b["X-Amz-Credential"] || "");
    const amzDate = String(b["X-Amz-Date"] || "");
    const expires = String(b["X-Amz-Expires"] || "");
    const signedHdrs = String(b["X-Amz-SignedHeaders"] || "");
    const sigRaw = String(b["X-Amz-Signature"] || "");
    const tail = String(sigRaw);

    const typeInText = grab(/"type"\s*:\s*"([^"]+)"/, preKey + tail);

    const looksAudio =
      /audioMessage\//.test(preKey) ||
      mime.startsWith("audio/") ||
      mime.includes("opus") ||
      ["audio", "ptt", "voice"].includes(typeInText);

    const looksImage =
      /imageMessage\//.test(preKey) || mime.startsWith("image/") || typeInText === "image";

    let signature = (sigRaw.match(/[0-9a-fA-F]{32,}/) || [])[0] || "";
    if (!signature && sigRaw) signature = sigRaw.split('","')[0];

    if (!instance || !conversation) return null;

    // AUDIO
    if (looksAudio) {
      const corpusParts: string[] = [preKey];
      if (b[preKey] !== undefined) corpusParts.push(String(b[preKey]));
      for (const [k, v] of Object.entries(b)) {
        if (typeof k === "string") corpusParts.push(k);
        if (typeof v === "string") corpusParts.push(v);
      }
      const corpus = corpusParts.join(" ");

      let url =
        /"url"\s*:\s*"(https?:\/\/[^"]+)"/i.exec(corpus)?.[1] ||
        /(https?:\/\/cdn\.evo\.skrit\.es[^\s"']+)/i.exec(corpus)?.[1] ||
        "";

      url = unescapeSkrit(url);

      if (url && !url.includes("X-Amz-Algorithm=") && signature) {
        url = buildSignedUrl(url, {
          "X-Amz-Algorithm": alg,
          "X-Amz-Credential": cred,
          "X-Amz-Date": amzDate,
          "X-Amz-Expires": expires,
          "X-Amz-SignedHeaders": signedHdrs,
          "X-Amz-Signature": signature,
        });
      }

      if (!url && instance && from_full && messageId) {
        const ext = (corpus.match(/\.(oga|ogg|opus|mp3|wav|m4a)\b/i) || [, "oga"])[1].toLowerCase();
        const base = `https://cdn.evo.skrit.es/evolution/evolution-api/${instance}/${from_full}/audioMessage/${messageId}.${ext}`;
        url = signature
          ? buildSignedUrl(base, {
              "X-Amz-Algorithm": alg,
              "X-Amz-Credential": cred,
              "X-Amz-Date": amzDate,
              "X-Amz-Expires": expires,
              "X-Amz-SignedHeaders": signedHdrs,
              "X-Amz-Signature": signature,
            })
          : base;
      }

      const durStr = (/"duration"\s*:\s*(\d+)/i.exec(corpus) || [])[1] || "";
      const duration = durStr ? parseInt(durStr, 10) : undefined;

      return { instance, conversation, type: "audio", mediaUrl: url || undefined, duration, debug: { route: "media/audio", typeInText, mime, urlLen: url?.length || 0 } };
    }

    // IMAGE
    if (looksImage) {
      let urlBase =
        /"url"\s*:\s*"(https?:\/\/[^"]+imageMessage\/[A-Za-z0-9._-]+?\.(?:jpe?g|png|webp))/i.exec(preKey)?.[1] ||
        /"url"\s*:\s*"(https?:\/\/[^"]+?)\?X-Amz-Algorithm/i.exec(preKey)?.[1] ||
        "";

      urlBase = unescapeSkrit(urlBase);

      const url = urlBase
        ? buildSignedUrl(urlBase, {
            "X-Amz-Algorithm": alg,
            "X-Amz-Credential": cred,
            "X-Amz-Date": amzDate,
            "X-Amz-Expires": expires,
            "X-Amz-SignedHeaders": signedHdrs,
            "X-Amz-Signature": signature,
          })
        : "";

      const caption = grab(/"caption"\s*:\s*"([^"]*)"/, preKey + tail);

      return { instance, conversation, type: "image", mediaUrl: url || undefined, caption: caption || undefined, debug: { route: "media/image", typeInText, mime, urlLen: url?.length || 0 } };
    }

    app.log.warn({ instance, conversation, typeInText, mime }, "normalizeInbound: media but not audio/image");
    return null;
  }

  return null;
}

// -------------------- Build user content --------------------

async function buildUserContent(inbound: z.infer<typeof NormalizedInboundSchema>, app: FastifyInstance) {
  if (inbound.type === "text") {
    const t = (inbound.text || "").trim();
    return t ? `[texto] ${t}` : "[texto] [vacío]";
  }

  if (inbound.type === "image") {
    if (!inbound.mediaUrl) return "[imagen] [sin URL]";
    try {
      app.log.info({ url: inbound.mediaUrl.slice(0, 160) }, "Image: describing");
      const desc = await describeImageFromUrl(inbound.mediaUrl);
      return inbound.caption ? `Imagen analizada:\nCaption: ${inbound.caption}\n${desc}` : `Imagen analizada:\n${desc}`;
    } catch (e: any) {
      app.log.error({ err: e?.message || e }, "Image analysis failed");
      return "[imagen] [falló análisis]";
    }
  }

  if (!inbound.mediaUrl) return "[audio] [sin URL]";
  try {
    app.log.info({ url: inbound.mediaUrl.slice(0, 160), len: inbound.mediaUrl.length, duration: inbound.duration }, "Audio: transcribing");
    const tr = await transcribeAudioFromUrl(inbound.mediaUrl);
    app.log.info({ chars: tr?.length || 0, sample: tr?.slice(0, 80) || "" }, "Audio: transcript OK");
    return tr ? `[audio transcrito] ${tr}` : "[audio] [sin texto transcrito]";
  } catch (e: any) {
    app.log.error({ err: e?.message || e, stack: e?.stack }, "Audio transcription failed");
    return "[audio] [falló transcripción]";
  }
}

// -------------------- Route --------------------

export async function webhook(app: FastifyInstance) {
  app.post("/webhook/aimotive/inbound", async (req, reply) => {
    app.log.info({ rawTopType: typeof req.body }, "Inbound raw received");

    const normalized = normalizeInbound(req.body, app);
    if (!normalized) {
      app.log.warn({ rawType: typeof req.body }, "Could not normalize inbound");
      return reply.code(200).send({ ok: true, ignored: true });
    }

    const parsed = NormalizedInboundSchema.safeParse(normalized);
    if (!parsed.success) {
      app.log.warn({ errors: parsed.error.format(), normalized }, "Invalid normalized inbound");
      return reply.code(200).send({ ok: true, ignored: true });
    }

    const inbound = parsed.data;

    app.log.info(
      {
        type: inbound.type,
        conversation: inbound.conversation,
        mediaUrl: inbound.mediaUrl ? inbound.mediaUrl.slice(0, 160) : null,
        debug: normalized.debug,
      },
      "Inbound normalized"
    );

    const key = sessionKey(inbound.instance, inbound.conversation);
    const session = await loadSession(key, app);

    const userContent = await buildUserContent(inbound, app);

    // 1) vehículo
    await maybeCacheVehicleFromText({ text: userContent, session, log: app.log });

    // 2) embeddings catálogo
    try {
      const matches = await matchCanonicalByEmbedding(userContent, MATCH_TOPK);
      session.partMatches = {
        matches,
        _cachedAt: Date.now(),
        source: "embedding",
        textSample: userContent.slice(0, 200),
      };
      app.log.info({ top: matches?.[0], count: matches?.length || 0 }, "Catalog embedding matches computed");
    } catch (e: any) {
      app.log.error({ err: e?.message || e, stack: e?.stack }, "Catalog embedding match failed");
    }

    // 2.5) products/by-vehicle + normalize + winner
    try {
      const best = session.partMatches?.matches?.[0] ?? null;

      const vehicleId =
        session.vehicle?.vehicleId ??
        session.vehicle?.vehicles?.[0]?.id ??
        session.vehicle?.vehicles?.[0]?.vehicleId ??
        null;

      const familyId = best?.id ?? null;

      if (vehicleId && familyId && best) {
        const products = await getProductsByVehicle({
          vehicleId: Number(vehicleId),
          familyId: Number(familyId),
        });

        const { primary } = normalizeByFamily(Number(familyId), products, userContent);

        const pickBase = primary.length ? primary : products;
        const { selectedPart, partsSorted } = selectWinner(pickBase);

        session.selectedProduct = (selectedPart as any) ?? null;
        session.productAlternatives = (partsSorted as any[])
          .filter((p) => (selectedPart ? p.ref !== (selectedPart as any).ref || p.brandCode !== (selectedPart as any).brandCode : true))
          .slice(0, 4);

        // ✅ LOG EXTRA (ganador + 3 alts)
        const winner = selectedPart
          ? {
              ref: (selectedPart as any).ref,
              name: (selectedPart as any).name,
              brand: (selectedPart as any).brandName || (selectedPart as any).brandCode,
              price: (selectedPart as any).price,
              avail: (selectedPart as any).isAvailable,
              stockTop: Array.isArray((selectedPart as any).warehouses)
                ? (selectedPart as any).warehouses
                    .slice()
                    .sort((a: any, b: any) => Number(b.stock || 0) - Number(a.stock || 0))
                    .slice(0, 3)
                    .map((w: any) => `${w.name || w.code}:${Number(w.stock || 0)}`)
                    .join(" | ")
                : null,
            }
          : null;

        const alts = (session.productAlternatives || []).slice(0, 3).map((a: any) => ({
          ref: a.ref,
          brand: a.brandName || a.brandCode,
          price: a.price,
          avail: a.isAvailable,
        }));

        app.log.info(
          {
            vehicleId,
            familyId,
            bestScore: best.score,
            got: products.length,
            primary: primary.length,
            winner,
            alts,
          },
          "Products selected (decision cached)"
        );
      } else {
        session.selectedProduct = null;
        session.productAlternatives = [];
        app.log.info({ vehicleId, familyId }, "Products selection skipped (missing vehicleId/familyId)");
      }
    } catch (e: any) {
      app.log.error({ err: e?.message || e, stack: e?.stack }, "Products selection failed");
      session.selectedProduct = null;
      session.productAlternatives = [];
    }

    // guarda user msg
    session.messages.push({ role: "user", content: userContent, ts: Date.now() });
    session.messages = session.messages.slice(-MAX_MESSAGES);

    // AI reply
    let responseText = "";
    try {
      const recent: ConversationMessage[] = session.messages
        .slice(-CONTEXT_WINDOW)
        .map((m) => ({ role: m.role, content: m.content }));

      const best = session.partMatches?.matches?.[0];

      const hasSelected = Boolean(session.selectedProduct);

      const decision: DecisionContext = {
        part: best ? { id: best.id, canonical_name: best.canonical_name, score: best.score } : undefined,
        vehicle: session.vehicle
          ? {
              plate: session.vehicle.plate,
              brand: session.vehicle.brand,
              model: session.vehicle.model,
              fuel: session.vehicle.fuel,
              vin: session.vehicle.vin,
            }
          : undefined,

        selectedProduct: session.selectedProduct ?? undefined,
        alternatives: session.productAlternatives?.length ? session.productAlternatives : undefined,

        // ✅ CLAVE: si ya tengo producto, NO pregunto “para confirmar”
        askOneClarifyingQuestion: !hasSelected && Boolean(best && best.score < MATCH_THRESHOLD),
      };

      app.log.info(
        {
          ctx: recent.length,
          lastUser: userContent.slice(0, 120),
          best: best ? { id: best.id, score: best.score } : null,
          hasVehicle: Boolean(session.vehicle?.plate),
          hasSelected,
        },
        "AI: generating reply (decision-aware)"
      );

      responseText = await generateReplyWithDecision(recent, decision);
      if (!responseText) responseText = "🤖 Me quedé en blanco… ¿me lo repites?";
    } catch (e: any) {
      app.log.error({ err: e?.message || e, stack: e?.stack }, "AI generation failed");
      responseText = "🤖 Tuve un problema pensando eso… intenta otra vez.";
    }

    // guarda assistant msg
    session.messages.push({ role: "assistant", content: responseText, ts: Date.now() });
    session.messages = session.messages.slice(-MAX_MESSAGES);

    await saveSession(key, session, app);

    // send WhatsApp
    const outboundConversationId = normalizeConversationIdForOutbound(inbound.conversation);
    try {
      app.log.info({ outboundConversationId }, "Outbound: sending message");
      await sendConversationMessage(inbound.instance, outboundConversationId, responseText);
      app.log.info({ outboundConversationId }, "Outbound: sent");
    } catch (err: any) {
      app.log.error(
        { outboundConversationId, status: err?.response?.status, data: err?.response?.data, message: err?.message },
        "Outbound message FAILED"
      );
    }

    return reply.code(200).send({ ok: true });
  });
}
