import prisma from "../db.server";

/**
 * Mirrors BullMQ job state into Postgres.
 *
 * Redis is the scheduler; Postgres is the record. The queue trims completed
 * jobs, so anything the merchant needs to see later — what ran, what changed,
 * what failed and why — has to live here.
 *
 * Every helper is upsert-based: a retried job re-enters `startJob` with a row
 * already present, and that must update rather than collide.
 */

export async function startJob(
  jobId: string,
  init: { shopDomain: string; boostId?: string; module: string; label?: string },
) {
  return prisma.optimizationJob.upsert({
    where: { id: jobId },
    create: {
      id: jobId,
      shopDomain: init.shopDomain,
      boostId: init.boostId ?? null,
      module: init.module,
      label: init.label ?? null,
      status: "running",
      attempts: 1,
      startedAt: new Date(),
    },
    update: {
      status: "running",
      startedAt: new Date(),
      error: null,
      attempts: { increment: 1 },
    },
  });
}

export async function finishJob(jobId: string) {
  return prisma.optimizationJob.update({
    where: { id: jobId },
    data: { status: "done", finishedAt: new Date(), error: null },
  });
}

export async function skipJob(jobId: string, reason: string) {
  return prisma.optimizationJob.update({
    where: { id: jobId },
    data: { status: "skipped", finishedAt: new Date(), error: reason },
  });
}

export async function failJob(jobId: string, error: string) {
  return prisma.optimizationJob.update({
    where: { id: jobId },
    data: { status: "failed", finishedAt: new Date(), error: error.slice(0, 1_000) },
  });
}

/** Queued rows are written up front so the queue page can show pending work. */
export async function queueJobs(
  rows: Array<{
    id: string;
    shopDomain: string;
    boostId: string;
    module: string;
    label?: string;
  }>,
) {
  if (rows.length === 0) return;
  await prisma.optimizationJob.createMany({
    data: rows.map((r) => ({
      id: r.id,
      shopDomain: r.shopDomain,
      boostId: r.boostId,
      module: r.module,
      label: r.label ?? null,
      status: "queued",
    })),
    // A re-pressed boost reuses deterministic ids; the existing row is correct.
    skipDuplicates: true,
  });
}
