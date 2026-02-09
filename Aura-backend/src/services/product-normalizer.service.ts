// src/services/product-normalizer.service.ts
import type { Product } from "./types/products";

const SPECIAL_FAMILIES = new Set<number>([
  100391, 100121, 100199, 104391, 100415, 100579,
]);

export function normalizeByFamily(
  familyId: number | null,
  products: Product[],
  _userText: string
) {
  // MVP: passthrough (no rompe nada)
  if (!familyId || !SPECIAL_FAMILIES.has(familyId)) {
    return { primary: products, related: [] as Product[] };
  }

  // Cuando quieras: aquí metes tus normalizadores por familia.
  // Por ahora, devolvemos igual para no frenar.
  return { primary: products, related: [] as Product[] };
}

export function selectWinner(products: Product[]) {
  const parts = [...products];

  parts.sort((a, b) => {
    const ta = Number(a.turnover || 0);
    const tb = Number(b.turnover || 0);
    if (ta !== tb) return tb - ta;

    const pa = Number.isFinite(Number(a.price)) ? Number(a.price) : Number.POSITIVE_INFINITY;
    const pb = Number.isFinite(Number(b.price)) ? Number(b.price) : Number.POSITIVE_INFINITY;
    return pa - pb;
  });

  const inStock = parts.filter((p) => p.isAvailable === true);
  const selectedPart = inStock.length > 0 ? inStock[0] : (parts[0] ?? null);

  return { selectedPart, partsSorted: parts };
}
