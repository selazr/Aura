import "dotenv/config";
import { initRedis } from "./lib/redis";
import { buildApp } from "./app";

const PORT = Number(process.env.PORT) || 3000;

async function start() {
  try {
    await initRedis();

    const app = await buildApp();
    await app.listen({ port: PORT, host: "0.0.0.0" });
  } catch (err) {
    // aquí no tenemos app.log si buildApp falla antes
    console.error(err);
    process.exit(1);
  }
}

start();
