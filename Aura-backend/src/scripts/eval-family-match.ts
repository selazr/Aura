// src/scripts/eval-family-match.ts
import "dotenv/config";
import * as XLSX from "xlsx";
import path from "node:path";
import fs from "node:fs";
import { matchCanonicalByEmbedding } from "../services/catalog.service";

type Row = {
  testId: string;
  input: string;
  expectedFamilyId: number | null;
};

function asString(v: unknown) {
  return String(v ?? "").trim();
}

function asNumber(v: unknown): number | null {
  const n = typeof v === "number" ? v : Number(String(v ?? "").trim());
  return Number.isFinite(n) ? n : null;
}

function loadRowsFromXlsx(filePath: string, sheetName = "Full 2"): Row[] {
  const wb = XLSX.readFile(filePath);
  const ws = wb.Sheets[sheetName];
  if (!ws) throw new Error(`No existe la hoja "${sheetName}" en ${filePath}`);

  const json = XLSX.utils.sheet_to_json<Record<string, unknown>>(ws, { defval: "" });

  // Ojo: en tu Excel el expected está en "Lo que debe responder Aura"
  // y el texto a evaluar en "Input"
  const rows: Row[] = json
    .map((r) => {
      const testId = asString(r["Test ID"]);
      const input = asString(r["Input"]);
      const expectedFamilyId = asNumber(r["Lo que debe responder Aura"]);
      return { testId, input, expectedFamilyId };
    })
    .filter((r) => r.testId && r.input && r.expectedFamilyId != null);

  return rows;
}

async function main() {
  const xlsxPath = process.argv[2] || path.resolve(process.cwd(), "Test Evals Aura Originales.xlsx");
  const sheetName = process.argv[3] || "Full 2";
  const topk = Number(process.argv[4] || 5);

  if (!fs.existsSync(xlsxPath)) {
    throw new Error(`No existe el archivo: ${xlsxPath}`);
  }

  const rows = loadRowsFromXlsx(xlsxPath, sheetName);
  console.log(`[eval] loaded rows=${rows.length} sheet="${sheetName}" topk=${topk}`);

  let ok = 0;
  let total = 0;
  let topkOk = 0;

  const report: Array<{
    testId: string;
    expected: number;
    predicted: number | null;
    score: number | null;
    topkHit: boolean;
    ok: boolean;
    input: string;
  }> = [];

  for (const r of rows) {
    total++;

    const matches = await matchCanonicalByEmbedding(r.input, topk);
    const best = matches?.[0] ?? null;

    const predicted = best?.id ?? null;
    const score = typeof best?.score === "number" ? best.score : null;

    const ok1 = predicted === r.expectedFamilyId;
    if (ok1) ok++;

    const hit = Array.isArray(matches) && matches.some((m) => m?.id === r.expectedFamilyId);
    if (hit) topkOk++;

    report.push({
      testId: r.testId,
      expected: r.expectedFamilyId!,
      predicted,
      score,
      topkHit: hit,
      ok: ok1,
      input: r.input,
    });

    // log corto por test (útil para depurar)
    console.log(
      `[${r.testId}] expected=${r.expectedFamilyId} predicted=${predicted} score=${score?.toFixed?.(3) ?? "?"} ok=${ok1}`
    );
  }

  const acc = total ? ok / total : 0;
  const accTopk = total ? topkOk / total : 0;

  console.log(`\n[eval] total=${total}`);
  console.log(`[eval] top1_acc=${(acc * 100).toFixed(1)}%`);
  console.log(`[eval] top${topk}_hit=${(accTopk * 100).toFixed(1)}%`);

  // guarda reporte csv para mirarlo en Excel/Sheets
  const outCsv = path.resolve(process.cwd(), `eval-family-match.report.top${topk}.csv`);
  const header = "testId,expected,predicted,score,topkHit,ok,input\n";
  const lines = report.map((x) =>
    [
      x.testId,
      x.expected,
      x.predicted ?? "",
      x.score ?? "",
      x.topkHit ? "1" : "0",
      x.ok ? "1" : "0",
      `"${x.input.replace(/"/g, '""')}"`,
    ].join(",")
  );
  fs.writeFileSync(outCsv, header + lines.join("\n"), "utf8");
  console.log(`[eval] report written: ${outCsv}`);
}

main().catch((e) => {
  console.error("[eval] FAIL", e);
  process.exit(1);
});
