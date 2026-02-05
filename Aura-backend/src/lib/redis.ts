import { createClient } from "redis";

export const redis = createClient({
  url: process.env.REDIS_URL || "redis://127.0.0.1:6379",
});

redis.on("error", (err) => {
  console.error("❌ Redis error", err);
});

export async function initRedis() {
  if (!redis.isOpen) {
    await redis.connect();
    console.log("✅ Redis connected");
  }
}
