import type { LoaderFunctionArgs } from "react-router";
import { Job } from "bullmq";
import prisma from "../db.server";
import { getRedis } from "../lib/redis.server";
import { getQueue } from "../lib/queue.server";

/**
 * Unauthenticated health check — safe to expose because it reports only
 * liveness, never shop data.
 *
 *   GET /health          → is Postgres and Redis reachable?
 *   GET /health?ping=1   → also enqueue a job and wait for the worker to
 *                          finish it, proving the full round-trip.
 */
export const loader = async ({ request }: LoaderFunctionArgs) => {
  const url = new URL(request.url);
  const wantsPing = url.searchParams.get("ping") === "1";

  const checks: Record<string, unknown> = {};
  let healthy = true;

  try {
    await prisma.$queryRaw`SELECT 1`;
    checks.postgres = "ok";
  } catch (error) {
    healthy = false;
    checks.postgres = `error: ${(error as Error).message}`;
  }

  try {
    const pong = await getRedis().ping();
    checks.redis = pong === "PONG" ? "ok" : `unexpected: ${pong}`;
  } catch (error) {
    healthy = false;
    checks.redis = `error: ${(error as Error).message}`;
  }

  if (wantsPing && healthy) {
    try {
      checks.roundTrip = await runPingRoundTrip();
    } catch (error) {
      healthy = false;
      checks.roundTrip = `error: ${(error as Error).message}`;
    }
  }

  return Response.json(
    { status: healthy ? "ok" : "degraded", checks },
    { status: healthy ? 200 : 503 },
  );
};

/**
 * Enqueues a ping and polls until the worker finishes it. Polling rather than
 * QueueEvents keeps this route from opening a second long-lived Redis
 * subscriber connection on every hit.
 */
async function runPingRoundTrip(timeoutMs = 10_000) {
  const queue = getQueue("ping");
  const startedAt = Date.now();

  const job = await queue.add(
    "ping",
    { at: new Date().toISOString(), note: "health check" },
    { attempts: 1, removeOnComplete: true, removeOnFail: true },
  );

  while (Date.now() - startedAt < timeoutMs) {
    const current = await Job.fromId(queue, job.id!);

    // BullMQ drops the job the moment it completes (removeOnComplete), so a
    // vanished job is a success, not a failure.
    if (!current) {
      return { ok: true, note: "completed and removed", ms: Date.now() - startedAt };
    }

    const state = await current.getState();
    if (state === "completed") {
      return { ok: true, result: current.returnvalue, ms: Date.now() - startedAt };
    }
    if (state === "failed") {
      throw new Error(current.failedReason ?? "job failed");
    }

    await new Promise((resolve) => setTimeout(resolve, 150));
  }

  throw new Error(
    `no worker picked up the job within ${timeoutMs}ms — is \`npm run worker\` running?`,
  );
}
