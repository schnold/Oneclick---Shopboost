// Must be first: validates env and fills the worker-only defaults that
// shopify.server.ts reads at module scope.
import "./bootstrap";
import { Worker, type Job } from "bullmq";
import { createRedisConnection } from "../app/lib/redis.server";
import { DEFAULT_JOB_OPTIONS, QUEUE_PREFIX } from "../app/lib/queue.server";
import { ping } from "./processors/ping";
import { audit } from "./processors/audit";
import { images } from "./processors/images";
import { seo } from "./processors/seo";
import { geo } from "./processors/geo";
import { speed } from "./processors/speed";
import { checkBoostComplete } from "../app/lib/boost-orchestrator.server";

/**
 * Shopboost background worker.
 *
 * Runs as its own process (`npm run worker`). Concurrency is set per queue:
 * image work is CPU- and bandwidth-heavy, while the Shopify write queues are
 * limited by the Admin API cost budget rather than by local resources.
 */

type Registration = {
  name: string;
  processor: (job: Job) => Promise<unknown>;
  concurrency: number;
  /** Token-bucket ceiling shared across this queue's workers. */
  limiter?: { max: number; duration: number };
};

const registrations: Registration[] = [
  { name: "ping", processor: ping, concurrency: 1 },
  // Audits are long-lived (they wait on a Shopify bulk export) but cheap while
  // waiting. Concurrency 2 lets a second shop start without queueing behind a
  // large catalog; a single shop is serialized by Shopify anyway.
  { name: "audit", processor: audit, concurrency: 2 },
  // Image work is CPU-bound (sharp) and bandwidth-bound, and each job spends
  // several Admin API calls. The limiter keeps a large catalog from exhausting
  // the shop's cost budget; concurrency keeps the CPU busy while jobs wait on
  // Shopify to finish processing.
  {
    name: "images",
    processor: images,
    concurrency: 4,
    limiter: { max: 2, duration: 1_000 },
  },
  // SEO and GEO are paced by the Admin API cost budget and, when a key is
  // configured, by AI generation latency — not by local CPU. Concurrency is
  // modest and the limiter is what actually protects the shop's quota.
  {
    name: "seo",
    processor: seo,
    concurrency: 3,
    limiter: { max: 2, duration: 1_000 },
  },
  {
    name: "geo",
    processor: geo,
    concurrency: 2,
    limiter: { max: 2, duration: 1_000 },
  },
  // One speed job per boost, and PageSpeed Insights rate-limits hard.
  { name: "speed", processor: speed, concurrency: 1 },
];

const workers: Worker[] = [];

for (const reg of registrations) {
  const worker = new Worker(reg.name, reg.processor, {
    connection: createRedisConnection(),
    prefix: QUEUE_PREFIX,
    concurrency: reg.concurrency,
    limiter: reg.limiter,
    // Keep worker-side defaults aligned with the producer's.
    ...(DEFAULT_JOB_OPTIONS.removeOnComplete
      ? { removeOnComplete: DEFAULT_JOB_OPTIONS.removeOnComplete }
      : {}),
  });

  worker.on("completed", async (job) => {
    console.log(`[${reg.name}] ✓ ${job.id}`);
    await settleBoost(job.data?.shopDomain, job.data?.boostId);
  });

  worker.on("failed", async (job, err) => {
    const attempt = job ? `${job.attemptsMade}/${job.opts.attempts ?? 1}` : "?";
    console.error(`[${reg.name}] ✗ ${job?.id} (attempt ${attempt}): ${err.message}`);

    // Only settle once retries are exhausted — a job that will run again is
    // still outstanding work.
    const exhausted = job ? job.attemptsMade >= (job.opts.attempts ?? 1) : false;
    if (exhausted) await settleBoost(job?.data?.shopDomain, job?.data?.boostId);
  });

  worker.on("error", (err) => {
    // Connection-level problems surface here, not on a job.
    console.error(`[${reg.name}] worker error:`, err.message);
  });

  workers.push(worker);
}

/**
 * Closes out a boost once its last job settles. Safe to call for jobs that
 * belong to no boost, and safe to call repeatedly — the check is a database
 * read, and completion is idempotent.
 */
async function settleBoost(shopDomain?: string, boostId?: string) {
  if (!shopDomain || !boostId) return;
  try {
    await checkBoostComplete(shopDomain, boostId);
  } catch (error) {
    console.error(`[boost] could not settle ${boostId}:`, (error as Error).message);
  }
}

console.log(
  `Shopboost worker up — queues: ${registrations.map((r) => r.name).join(", ")}`,
);

/**
 * Close workers before exiting so in-flight jobs finish and are not left
 * stalled in Redis for another worker to reclaim.
 */
async function shutdown(signal: string) {
  console.log(`\n${signal} received — draining workers…`);
  await Promise.all(workers.map((w) => w.close()));
  console.log("Workers closed.");
  process.exit(0);
}

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
