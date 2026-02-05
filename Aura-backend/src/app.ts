import Fastify from "fastify";
import formbody from "@fastify/formbody";
import { webhook } from "./routes/webhook"; // <-- ajusta el path si tu archivo está en otro sitio

export async function buildApp() {
  const app = Fastify({ logger: true });

  // Parsers / plugins ANTES de registrar rutas
  await app.register(formbody);

  // Rutas
  await webhook(app);

  return app;
}
