import OpenAI from "openai";

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

export async function embedText(input: string): Promise<number[]> {
  const r = await openai.embeddings.create({
    model: process.env.EMBEDDINGS_MODEL || "text-embedding-3-small",
    input,
  });
  return r.data[0].embedding as number[];
}
