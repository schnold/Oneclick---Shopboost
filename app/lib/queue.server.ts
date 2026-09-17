import { Queue, type JobsOptions } from "bullmq";
import { getRedis } from "./redis.server";
import type { ShopSettings } from "./settings.server";

export const QUEUE_NAMES = [
  "audit",
  "images",
  "seo",
  "geo",
  "speed",
  "orchestrator",
] as const;

export type QueueName = (typeof QUEUE_NAMES)[number];

/** Payloads are the contract between the web process and the worker. */
export type JobPayloads = {
  audit: {
    shopDomain: string;
    kind: "initial" | "before" | "after" | "scheduled";
    boostId?: string;
  };
  images: {
    shopDomain: string;
    boostId: string;
    productId: string;
    mediaId: string;
    /** Untransformed upload URL — the source of truth for recompression. */
    sourceUrl: string;
    originalBytes: number;
    settings: ShopSettings["images"];
  };
  seo: {
    shopDomain: string;
    boostId: string;
    resourceId: string;
    resourceType: "product" | "collection" | "page";
    settings: ShopSettings["seo"];
  };
  geo: {
    shopDomain: string;
    boostId: string;
    productId: string;
    settings: ShopSettings["geo"];
  };
  speed: {
    shopDomain: string;
    boostId: string;
    /** Storefront URLs to measure; empty means "discover them". */
    urls?: string[];
  };
  orchestrator: {
    shopDomain: string;
    boostId: string;
  };
  /** Infrastructure smoke test — see `npm run worker` and /app/health. */
  ping: { at: string; note?: string };
};

/**
 * Redis key namespace for the queues.
 *
 * Overridable so a test run can be invisible to a worker started with
 * `npm run worker`. Without it, running the boost test while the app is up
 * hands the test's fake jobs to the real worker, which then tries to call
 * Shopify for a shop that does not exist.
 */
export const QUEUE_PREFIX = process.env.BULLMQ_PREFIX || "bull";

declare global {
  // eslint-disable-next-line no-var
  var __shopboostQueues: Map<string, Queue> | undefined;
}

function queueRegistry(): Map<string, Queue> {
  if (!global.__shopboostQueues) global.__shopboostQueues = new Map();
  return global.__shopboostQueues;
}

/**
 * Defaults every job inherits. Five attempts with exponential backoff covers
 * Shopify's THROTTLED responses and transient 5xx; completed/failed jobs are
 * trimmed because Postgres — not Redis — is our durable record.
 */
export const DEFAULT_JOB_OPTIONS = {
  attempts: 5,
  backoff: { type: "exponential" as const, delay: 2_000 },
  removeOnComplete: { age: 3_600, count: 1_000 },
  removeOnFail: { age: 24 * 3_600 },
};

export function getQueue<N extends keyof JobPayloads>(name: N): Queue {
  const registry = queueRegistry();
  let queue = registry.get(name);
  if (!queue) {
    queue = new Queue(name, {
      connection: getRedis(),
      prefix: QUEUE_PREFIX,
      defaultJobOptions: DEFAULT_JOB_OPTIONS,
    });
    registry.set(name, queue);
  }
  return queue;
}

/**
 * Deterministic job id. Re-pressing Boost with unchanged settings produces the
 * same id, and BullMQ silently drops the duplicate — that is the whole
 * idempotency story, so never put a timestamp or random value in here.
 *
 * BullMQ rejects a custom id containing ":" (it namespaces its own Redis keys
 * with colons), which rules out both the obvious separator and raw Shopify
 * gids. Parts are joined with "__" and any remaining colon is stripped.
 */
export function jobId(parts: (string | number | undefined)[]): string {
  return parts
    .filter((p) => p !== undefined && p !== "")
    .join("__")
    .replace(/gid:\/\/shopify\//g, "")
    .replace(/:/g, "-");
}

export async function enqueue<N extends keyof JobPayloads>(
  name: N,
  payload: JobPayloads[N],
  opts: JobsOptions = {},
) {
  return getQueue(name).add(name, payload, opts);
}
