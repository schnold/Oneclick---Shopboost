import prisma from "../db.server";
import { enqueue, jobId } from "./queue.server";
import { getSettings, settingsHash } from "./settings.server";
import type { AuditTotals, AuditScores } from "./audit/types";
import { potentialScores } from "./audit/score.server";

/**
 * Enqueues a catalog audit.
 *
 * `dedupe` collapses a burst into one run, which is what the products/update
 * webhook wants — a merchant editing twenty products should trigger one
 * re-scan, not twenty.
 *
 * It is deliberately **off** by default. BullMQ keeps completed jobs for an
 * hour, and it drops a new job whose custom id matches one still present, so a
 * deduped id would make the Rescan button silently do nothing for an hour
 * after a scan. User-initiated scans therefore take a generated id and always
 * run.
 */
export async function enqueueAudit(
  shopDomain: string,
  kind: "initial" | "before" | "after" | "scheduled" = "initial",
  boostId?: string,
  opts: { dedupe?: boolean; delayMs?: number } = {},
) {
  const settings = await getSettings(shopDomain);

  return enqueue(
    "audit",
    { shopDomain, kind, boostId },
    {
      ...(opts.dedupe
        ? { jobId: jobId([shopDomain, "audit", kind, boostId, settingsHash(settings)]) }
        : {}),
      ...(opts.delayMs ? { delay: opts.delayMs } : {}),
      // Bulk exports are single-flight per shop, so a job that loses the race
      // needs a long, patient backoff rather than the default quick retries.
      attempts: 8,
      backoff: { type: "exponential", delay: 15_000 },
    },
  );
}

/** Most recent snapshot, or null before the first audit completes. */
export async function latestSnapshot(shopDomain: string) {
  return prisma.auditSnapshot.findFirst({
    where: { shopDomain },
    orderBy: { createdAt: "desc" },
  });
}

export type BoostProgress = {
  running: boolean;
  boostId: string | null;
  total: number;
  settled: number;
  failed: number;
  savedBytes: number;
  /** Populated once the "after" audit lands, which is what closes the loop. */
  before: { boostScore: number; imageScore: number } | null;
  after: { boostScore: number; imageScore: number } | null;
};

/**
 * Progress of the boost the merchant is currently watching: the running one if
 * there is one, otherwise the most recent, so the before/after panel persists
 * after the work finishes.
 */
export async function getBoostProgress(shopDomain: string): Promise<BoostProgress> {
  const boost = await prisma.boost.findFirst({
    where: { shopDomain },
    orderBy: { createdAt: "desc" },
  });

  const empty: BoostProgress = {
    running: false,
    boostId: null,
    total: 0,
    settled: 0,
    failed: 0,
    savedBytes: 0,
    before: null,
    after: null,
  };

  if (!boost) return empty;

  const [counts, saved, snapshots] = await Promise.all([
    prisma.optimizationJob.groupBy({
      by: ["status"],
      where: { boostId: boost.id },
      _count: true,
    }),
    prisma.optimizationItem.aggregate({
      where: { job: { boostId: boost.id }, status: "done" },
      _sum: { savedBytes: true },
    }),
    prisma.auditSnapshot.findMany({
      where: { boostId: boost.id },
      orderBy: { createdAt: "asc" },
    }),
  ]);

  const byStatus = Object.fromEntries(counts.map((c) => [c.status, c._count]));
  const total = Object.values(byStatus).reduce((a, b) => a + b, 0);
  const outstanding = (byStatus.queued ?? 0) + (byStatus.running ?? 0);

  const pick = (kind: string) => {
    const s = snapshots.find((row) => row.kind === kind);
    return s ? { boostScore: s.boostScore, imageScore: s.imageScore } : null;
  };

  return {
    running: boost.status === "running",
    boostId: boost.id,
    total,
    settled: total - outstanding,
    failed: byStatus.failed ?? 0,
    savedBytes: saved._sum.savedBytes ?? 0,
    before: pick("before"),
    after: pick("after"),
  };
}

export type DashboardData = {
  hasAudit: boolean;
  auditRunning: boolean;
  current: AuditScores | null;
  potential: AuditScores | null;
  totals: AuditTotals | null;
  measuredAt: string | null;
  /** Set once the speed module runs; until then speed is "not measured". */
  speedMeasured: boolean;
};

export async function getDashboardData(shopDomain: string): Promise<DashboardData> {
  const snapshot = await latestSnapshot(shopDomain);

  if (!snapshot) {
    const running = await prisma.optimizationJob.count({
      where: { shopDomain, module: "audit", status: { in: ["queued", "running"] } },
    });
    return {
      hasAudit: false,
      auditRunning: running > 0,
      current: null,
      potential: null,
      totals: null,
      measuredAt: null,
      speedMeasured: false,
    };
  }

  const current: AuditScores = {
    boostScore: snapshot.boostScore,
    imageScore: snapshot.imageScore,
    seoScore: snapshot.seoScore,
    geoScore: snapshot.geoScore,
    speedScore: snapshot.speedScore,
  };

  const totals = snapshot.totals as unknown as AuditTotals;

  return {
    hasAudit: true,
    auditRunning: false,
    current,
    potential: potentialScores(current, false),
    totals,
    measuredAt: snapshot.createdAt.toISOString(),
    speedMeasured: Boolean(totals?.psi),
  };
}
