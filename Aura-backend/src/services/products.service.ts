// src/services/products.service.ts
import type { Product } from "./types/products";
import { productsByVehicle } from "./aimotive.client";

function asNumber(v: unknown): number | undefined {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : undefined;
}

function asBoolean(v: unknown): boolean | undefined {
  return typeof v === "boolean" ? v : undefined;
}

export async function getProductsForVehicleAndFamily(args: {
  vehicleId: number;
  familyId: number;
}): Promise<Product[]> {
  const { vehicleId, familyId } = args;

  const raw = await productsByVehicle(vehicleId, familyId);

  if (!Array.isArray(raw)) {
    throw new Error("productsByVehicle: respuesta inesperada (no array)");
  }

  const products: Product[] = raw.map((p: any) => ({
    ref: String(p?.ref ?? ""),
    commercialRef: p?.commercialRef != null ? String(p.commercialRef) : undefined,
    name: String(p?.name ?? ""),

    brandCode: p?.brandCode != null ? String(p.brandCode) : undefined,
    brandName: p?.brandName != null ? String(p.brandName) : undefined,

    // NO conviertas undefined -> false
    isAvailable: asBoolean(p?.isAvailable),

    price: asNumber(p?.price),
    taxes: asNumber(p?.taxes),
    discount: asNumber(p?.discount),
    vat: asNumber(p?.vat),
    turnover: asNumber(p?.turnover),

    warehouses: Array.isArray(p?.warehouses)
      ? p.warehouses.map((w: any) => ({
          code: String(w?.code ?? ""),
          name: String(w?.name ?? ""),
          stock: asNumber(w?.stock) ?? 0,
          isExternal: asBoolean(w?.isExternal),
        }))
      : undefined,
  }));

  // filtra basura: ref y name obligatorios
  return products.filter((p) => p.ref.length > 0 && p.name.length > 0);
}
