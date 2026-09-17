import IORedis from "ioredis";

/**
 * BullMQ requires `maxRetriesPerRequest: null` on connections used by Workers
 * and QueueEvents — with the ioredis default, a blocking command that outlives
 * the retry budget throws and kills the worker instead of reconnecting.
 *
 * Connections are cached on `globalThis` so Vite's dev-server HMR doesn't leak
 * a new TCP connection on every reload.
 */
declare global {
  // eslint-disable-next-line no-var
  var __shopboostRedis: IORedis | undefined;
}

export function redisUrl(): string {
  const url = process.env.REDIS_URL;
  if (!url) {
    throw new Error(
      "REDIS_URL is not set. Copy .env.example to .env and fill it in.",
    );
  }
  return url;
}

export function createRedisConnection(): IORedis {
  return new IORedis(redisUrl(), { maxRetriesPerRequest: null });
}

/** Shared connection for queue producers (the web process). */
export function getRedis(): IORedis {
  if (!global.__shopboostRedis) {
    global.__shopboostRedis = createRedisConnection();
  }
  return global.__shopboostRedis;
}
