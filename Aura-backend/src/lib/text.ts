export function normalizeText(s: string) {
  return String(s || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
}

export function extractPlate(raw: string): string | null {
  const t = normalizeText(raw);

  const m =
    t.match(/\b\d{4}\s*[a-z]{3}\b/i) ||
    t.match(/\b[a-z]{1,2}\s*\d{4}\s*[a-z]{0,2}\b/i);

  return m ? m[0].toUpperCase().replace(/\s+/g, "") : null;
}
