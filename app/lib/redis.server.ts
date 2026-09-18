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

/**
 * Upstash's hosting integrations inject REST credentials, but BullMQ speaks the
 * Redis wire protocol — `@upstash/redis` over HTTP cannot back a queue, because
 * a Worker holds a blocking command open for its entire lifetime. Upstash
 * accepts the REST token as the TCP password on the same host, so a `rediss://`
 * URL derived from the pair is a working connection string.
 *
 * `rediss` (two s) is not a typo: Upstash requires TLS.
 */
export function upstashRedisUrl(): string | null {
  const rest = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!rest || !token) return null;

  const host = new URL(rest).hostname;
  return `rediss://default:${encodeURIComponent(token)}@${host}:6379`;
}

export function redisUrl(): string {
  const url = process.env.REDIS_URL || upstashRedisUrl();
  if (!url) {
    throw new Error(
      "No Redis connection configured. Set REDIS_URL, or UPSTASH_REDIS_REST_URL " +
        "and UPSTASH_REDIS_REST_TOKEN together. Copy .env.example to .env.",
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
