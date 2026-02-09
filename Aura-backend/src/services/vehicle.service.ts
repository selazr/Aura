// src/services/vehicle.service.ts
import { searchVehicleByPlate } from "./aimotive.client";

const PLATE_RE =
  /\b(\d{4}\s*[A-Z]{3}|[A-Z]{1,2}\s*\d{4}\s*[A-Z]{0,2})\b/i;

function cleanPlate(p: string) {
  return p.toUpperCase().replace(/\s+/g, "");
}

export async function maybeCacheVehicleFromText(args: {
  text: string;
  session: any;
  log: any;
}) {
  const { text, session, log } = args;
  const m = text.match(PLATE_RE);
  if (!m) return;

  const plate = cleanPlate(m[0]);

  // si ya tenemos ese mismo, no repitas
  if (session.vehicle?.plate === plate) return;

  try {
    const data = await searchVehicleByPlate(plate);

    // 🔥 clave: saca un vehicleId usable
    // (depende de tu swagger real)
    const vehicleId =
      data?.vehicles?.[0]?.id ??
      data?.vehicles?.[0]?.vehicleId ??
      null;

    session.vehicle = {
      plate: data?.plate ?? plate,
      vin: data?.vin ?? null,
      brand: data?.brand ?? null,
      model: data?.model ?? null,
      fuel: data?.fuel ?? null,
      registrationDate: data?.registrationDate ?? null,
      vehicles: data?.vehicles ?? [],
      vehicleId,
      _cachedAt: Date.now(),
    };

    log.info({ plate, vehicleId }, "Vehicle cached in session");
  } catch (e: any) {
    log.error({ err: e?.message || e, plate }, "Vehicle lookup failed");
  }
}
