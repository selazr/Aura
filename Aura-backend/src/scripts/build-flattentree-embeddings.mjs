import "dotenv/config";
import mysql from "mysql2/promise";
import OpenAI from "openai";

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const MODEL = process.env.EMBEDDINGS_MODEL || "text-embedding-3-small";
const BATCH = Number(process.env.EMBEDDINGS_BATCH || 64);

async function main() {
  const db = await mysql.createConnection({
    host: process.env.MYSQL_HOST || "127.0.0.1",
    user: process.env.MYSQL_USER || "aura",
    password: process.env.MYSQL_PASS || "",
    database: process.env.MYSQL_DB || "aimotive",
  });

  const [rows] = await db.query(
    `SELECT id, canonical_name
     FROM flattenTree
     WHERE canonical_name IS NOT NULL AND canonical_name <> ''`
  );

  console.log(`Loaded ${rows.length} canonical_name rows`);

  for (let i = 0; i < rows.length; i += BATCH) {
    const chunk = rows.slice(i, i + BATCH);

    const inputs = chunk.map((r) => String(r.canonical_name));
    const embResp = await openai.embeddings.create({
      model: MODEL,
      input: inputs,
    });

    for (let j = 0; j < chunk.length; j++) {
      const id = Number(chunk[j].id);
      const embedding = embResp.data[j].embedding;
      const dims = embedding.length;

      await db.execute(
        `INSERT INTO flattenTree_embeddings (id, model, dims, embedding_json)
         VALUES (?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE
           model=VALUES(model),
           dims=VALUES(dims),
           embedding_json=VALUES(embedding_json)`,
        [id, MODEL, dims, JSON.stringify(embedding)]
      );
    }

    console.log(`Upserted ${Math.min(i + BATCH, rows.length)} / ${rows.length}`);
  }

  await db.end();
  console.log("Done ✅");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
