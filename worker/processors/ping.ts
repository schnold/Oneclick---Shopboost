import type { Job } from "bullmq";
import prisma from "../../app/db.server";
import type { JobPayloads } from "../../app/lib/queue.server";

/**
 * Infrastructure smoke test: proves the web process can enqueue, the worker can
 * pick up, and both can reach Postgres. Enqueued by GET /health?ping=1.
 */
export async function ping(job: Job<JobPayloads["ping"]>) {
  const queuedAt = new Date(job.data.at);
  const latencyMs = Date.now() - queuedAt.getTime();

  // Round-trip the database too, so a green ping means the whole chain is up.
  const shopCount = await prisma.shop.count();

  await job.updateProgress(100);

  const result = {
    ok: true,
    note: job.data.note ?? null,
    latencyMs,
    shopCount,
    processedAt: new Date().toISOString(),
  };

  console.log(
    `[ping] round-trip ${latencyMs}ms · ${shopCount} shop(s) in database`,
  );
  return result;
}
