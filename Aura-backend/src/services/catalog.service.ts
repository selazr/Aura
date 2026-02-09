import { mysqlPool } from "../lib/mysql";
import { embedText } from "./embeddings.service";
import type { RowDataPacket } from "mysql2";

type CatalogRow = {
  id: number;
  canonical_name: string;
  emb: number[];
};

type DbRow = RowDataPacket & {
  id: number | string;
  canonical_name: string;
  embedding_json: unknown;
};

let cache: { rows: CatalogRow[]; loadedAt: number } | null = null;

function dot(a: number[], b: number[]) {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}
function norm(a: number[]) {
  return Math.sqrt(dot(a, a));
}
function cosineSim(a: number[], b: number[]) {
  const denom = norm(a) * norm(b);
  return denom ? dot(a, b) / denom : 0;
}

function parseEmbedding(value: unknown): number[] {
  if (value == null) throw new Error("embedding_json is null");

  // mysql2 puede devolver: number[] | Buffer | string | object(JSON)
  if (Array.isArray(value)) return value.map(Number);

  if (Buffer.isBuffer(value)) {
    const s = value.toString("utf8").trim();
    const arr = JSON.parse(s);
    if (!Array.isArray(arr)) throw new Error("embedding_json (buffer) parsed but not array");
    return arr.map(Number);
  }

  if (typeof value === "string") {
    const s = value.trim();
    const arr = JSON.parse(s);
    if (!Array.isArray(arr)) throw new Error("embedding_json (string) parsed but not array");
    return arr.map(Number);
  }

  if (typeof value === "object") {
    // si ya es array por el driver
    if (Array.isArray(value as any)) return (value as any[]).map(Number);

    // si es objeto JSON, stringify+parse
    const s = JSON.stringify(value);
    const arr = JSON.parse(s);
    if (!Array.isArray(arr)) throw new Error("embedding_json (object) parsed but not array");
    return arr.map(Number);
  }

  // último fallback
  const s = String(value).trim();
  const arr = JSON.parse(s);
  if (!Array.isArray(arr)) throw new Error("embedding_json (fallback) parsed but not array");
  return arr.map(Number);
}

export async function loadCatalogEmbeddings(force = false) {
  const ttlMs = 10 * 60 * 1000; // recarga cada 10 min
  if (!force && cache && Date.now() - cache.loadedAt < ttlMs) return cache.rows;

  const [rows] = await mysqlPool.query<DbRow[]>(
    `SELECT f.id, f.canonical_name, e.embedding_json
     FROM flattenTree f
     JOIN flattenTree_embeddings e ON e.id = f.id`
  );

  const parsed: CatalogRow[] = rows.map((r) => ({
    id: Number(r.id),
    canonical_name: String(r.canonical_name),
    emb: parseEmbedding(r.embedding_json),
  }));

  cache = { rows: parsed, loadedAt: Date.now() };
  return parsed;
}

export async function matchCanonicalByEmbedding(userText: string, topK = 5) {
  const [catalog, qEmb] = await Promise.all([loadCatalogEmbeddings(false), embedText(userText)]);

  return catalog
    .map((r) => ({
      id: r.id,
      canonical_name: r.canonical_name,
      score: cosineSim(qEmb, r.emb),
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, topK);
}
