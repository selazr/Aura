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
  const prompt = [
    "Transcribe este audio de WhatsApp a texto en español.",
    "No resumas ni inventes; devuelve solo la transcripción.",
  ].join(" ");

  const resp = await openai.responses.create({
    model: "gpt-4o-mini",
    input: [
      {
        role: "user",
        content: [
          { type: "input_text", text: prompt },
          { type: "input_audio", audio_url: audioUrl },
        ],
      },
    ] as any,
  });

  return (resp.output_text || "").trim();
}

export async function describeImageFromUrl(imageUrl: string) {
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
          { type: "input_image", image_url: imageUrl },
        ],
      },
    ] as any,
  });

  return (resp.output_text || "").trim();
}
