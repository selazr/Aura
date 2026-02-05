import { openai } from "./ai.client";

export async function generateReply(messages: string[]) {
  const prompt = [
    "Eres un asistente por WhatsApp.",
    "Responde claro, directo y útil.",
    "Sé breve, pero no ambiguo.",
    "Si falta información, pregunta solo una cosa concreta.",
    "No inventes datos.",
    "",
    "Conversación:",
    ...messages.map((m, i) => `Usuario ${i + 1}: ${m}`),
  ].join("\n");

  const resp = await openai.responses.create({
    model: "gpt-4o", // fijo por ahora
    input: prompt,   // ✅ STRING, no objeto
  });

  return (resp.output_text || "").trim();
}
