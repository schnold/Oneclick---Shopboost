// Shares the worker's env preflight: some of these modules reach
// shopify.server, which validates its configuration at module scope.
import "./bootstrap";
import { Queue, QueueEvents } from "bullmq";
import { createRedisConnection } from "../app/lib/redis.server";

/**
 * Phase 0 acceptance check: enqueue a job, wait for the worker to return a
 * result, confirm both processes reached Redis and Postgres.
 *
 *   npm run worker      # in one terminal
 *   npx tsx worker/smoke-test.ts
 *
 * BullMQ does not close connections it was handed rather than created, so the
 * two below are closed explicitly or the process would never exit.
 */
const queueConnection = createRedisConnection();
const eventsConnection = createRedisConnection();

const queue = new Queue("ping", { connection: queueConnection });
const events = new QueueEvents("ping", { connection: eventsConnection });

await events.waitUntilReady();

const job = await queue.add(
  "ping",
  { at: new Date().toISOString(), note: "smoke test" },
  { attempts: 1, removeOnComplete: false, removeOnFail: false },
);

console.log(`→ enqueued job ${job.id}, waiting for worker…`);

try {
  const result = await job.waitUntilFinished(events, 15_000);
  console.log("✓ worker returned:", result);
  process.exitCode = 0;
} catch (error) {
  console.error("✗ round-trip failed:", (error as Error).message);
  console.error("  Is `npm run worker` running?");
  process.exitCode = 1;
} finally {
  await job.remove().catch(() => {});
  await events.close();
  await queue.close();
  queueConnection.disconnect();
  eventsConnection.disconnect();
}
