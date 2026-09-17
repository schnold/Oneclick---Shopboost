import { Prisma } from "@prisma/client";
import prisma from "../db.server";
import { enqueue, jobId, getQueue } from "./queue.server";
import { getSettings, type ShopSettings } from "./settings.server";
import { queueJobs } from "./jobs.server";
import { latestSnapshot } from "./boost.server";
import type { AuditTotals } from "./audit/types";
import { getEntitlement, type Entitlement } from "./billing.server";

/**
 * Turns a press of the Boost button into queued work.
 *
 * The findings recorded by the audit are the work list — nothing is discovered
 * here. That is what keeps the "what a boost would change" panel and what the
 * boost actually does from drifting apart.
 */

export class NoAuditError extends Error {
  constructor() {
    super("Scan your shop before boosting.");
    this.name = "NoAuditError";
  }
}

export class BoostInProgressError extends Error {
  constructor() {
    super("A boost is already running.");
    this.name = "BoostInProgressError";
  }
}

/** The shop's plan does not allow writing changes right now. */
export class NotEntitledError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = "NotEntitledError";
  }
}

export type BoostPlan = {
  boostId: string;
  queued: { images: number; seo: number; geo: number; speed: number };
  total: number;
};

/**
 * `entitlement` is injectable so tests can exercise the fan-out without a real
 * subscription. Production never passes it — the plan is always read from
 * Shopify, so there is no flag an operator could set to bypass billing.
 */
export async function startBoost(
  shopDomain: string,
  options: { entitlement?: Entitlement } = {},
): Promise<BoostPlan> {
  const shop = await prisma.shop.findUnique({ where: { domain: shopDomain } });
  if (shop?.activeBoostId) {
    const active = await prisma.boost.findUnique({ where: { id: shop.activeBoostId } });
    if (active?.status === "running") throw new BoostInProgressError();
  }

  const snapshot = await latestSnapshot(shopDomain);
  if (!snapshot) throw new NoAuditError();

  // Checked here rather than only in the UI: this is the boundary where the
  // shop actually gets modified, and it is reachable from a form post.
  const entitlement = options.entitlement ?? (await getEntitlement(shopDomain));
  if (!entitlement.canBoost) throw new NotEntitledError(entitlement.blockedReason!);

  const settings = await getSettings(shopDomain);
  const totals = snapshot.totals as unknown as AuditTotals;

  const boost = await prisma.boost.create({
    data: {
      shopDomain,
      status: "running",
      settings: settings as unknown as Prisma.InputJsonValue,
    },
  });

  // Freeze the current scores as this boost's "before". Copied rather than
  // relabelled so the snapshot history stays immutable and the dashboard's
  // own latest-scan pointer is unaffected.
  await prisma.auditSnapshot.create({
    data: {
      shopDomain,
      kind: "before",
      boostId: boost.id,
      boostScore: snapshot.boostScore,
      imageScore: snapshot.imageScore,
      seoScore: snapshot.seoScore,
      geoScore: snapshot.geoScore,
      speedScore: snapshot.speedScore,
      totals: snapshot.totals as Prisma.InputJsonValue,
    },
  });

  await prisma.shop.update({
    where: { domain: shopDomain },
    data: { activeBoostId: boost.id },
  });

  const queued = { images: 0, seo: 0, geo: 0, speed: 0 };

  if (settings.modules.images) {
    queued.images = await queueImageJobs(
      shopDomain,
      boost.id,
      totals,
      settings,
      entitlement.imagesRemaining,
    );
  }

  if (settings.modules.seo) {
    queued.seo = await queueSeoJobs(shopDomain, boost.id, totals, settings);
  }

  if (settings.modules.geo) {
    queued.geo = await queueGeoJobs(shopDomain, boost.id, totals, settings);
  }

  if (settings.modules.speed) {
    queued.speed = await queueSpeedJob(shopDomain, boost.id, settings);
  }

  const total = queued.images + queued.seo + queued.geo + queued.speed;

  if (total === 0) {
    // Nothing to do is a successful boost, not a stuck one.
    await completeBoost(shopDomain, boost.id, "done");
  }

  return { boostId: boost.id, queued, total };
}

async function queueImageJobs(
  shopDomain: string,
  boostId: string,
  totals: AuditTotals,
  settings: ShopSettings,
  remainingQuota: number,
): Promise<number> {
  const all = totals.findings?.images ?? [];
  if (all.length === 0) return 0;

  // Largest savings first, so a quota-limited plan spends its allowance where
  // it buys the most. Truncation is reported rather than silent — see the
  // return value, which the dashboard compares against the finding count.
  const findings = Number.isFinite(remainingQuota)
    ? [...all].sort((a, b) => b.estimatedSavings - a.estimatedSavings).slice(0, remainingQuota)
    : all;

  if (findings.length < all.length) {
    console.log(
      `[boost] ${shopDomain}: capping image work at ${findings.length} of ${all.length} (plan limit)`,
    );
  }
  if (findings.length === 0) return 0;

  // Scoped to the boost. Without the boostId, a later boost would collide with
  // the completed jobs of an earlier one: BullMQ would drop the duplicates and
  // `skipDuplicates` would leave the rows pointing at the old boost, so the new
  // one would have nothing to wait for and would never settle.
  //
  // Re-running against an image that is already optimized is safe and cheap —
  // the compressor measures the real saving and skips anything under the
  // merchant's threshold.
  const jobs = findings.map((finding) => ({
    id: jobId([shopDomain, "images", boostId, finding.mediaId]),
    finding,
  }));

  await queueJobs(
    jobs.map(({ id, finding }) => ({
      id,
      shopDomain,
      boostId,
      module: "images",
      label: finding.productTitle,
    })),
  );

  for (const { id, finding } of jobs) {
    await enqueue(
      "images",
      {
        shopDomain,
        boostId,
        productId: finding.productId,
        mediaId: finding.mediaId,
        sourceUrl: finding.sourceUrl,
        originalBytes: finding.bytes,
        settings: settings.images,
      },
      { jobId: id },
    );
  }

  return jobs.length;
}

/**
 * SEO work is per product. Products needing metas and products needing alt text
 * are merged into one job each, because both come from a single generation call
 * and a single product fetch.
 */
async function queueSeoJobs(
  shopDomain: string,
  boostId: string,
  totals: AuditTotals,
  settings: ShopSettings,
): Promise<number> {
  const byProduct = new Map<string, string>();

  for (const finding of totals.findings?.seo ?? []) {
    byProduct.set(finding.productId, finding.productTitle);
  }
  if (settings.seo.writeAltText) {
    for (const finding of totals.findings?.alt ?? []) {
      byProduct.set(finding.productId, finding.productTitle);
    }
  }

  if (byProduct.size === 0) return 0;

  const jobs = [...byProduct.entries()].map(([productId, title]) => ({
    id: jobId([shopDomain, "seo", boostId, productId]),
    productId,
    title,
  }));

  await queueJobs(
    jobs.map(({ id, title }) => ({
      id,
      shopDomain,
      boostId,
      module: "seo",
      label: title,
    })),
  );

  for (const { id, productId } of jobs) {
    await enqueue(
      "seo",
      {
        shopDomain,
        boostId,
        resourceId: productId,
        resourceType: "product" as const,
        settings: settings.seo,
      },
      { jobId: id },
    );
  }

  return jobs.length;
}

/**
 * GEO work is per product too, but only where there is something to write:
 * a FAQ, or a description thin enough to benefit from a specification block.
 */
async function queueGeoJobs(
  shopDomain: string,
  boostId: string,
  totals: AuditTotals,
  settings: ShopSettings,
): Promise<number> {
  if (!settings.geo.generateFaq && !settings.geo.entityRichDescriptions) return 0;

  const findings = (totals.findings?.geo ?? []).filter((finding) => {
    const wantsFaq = settings.geo.generateFaq && finding.issues.includes("no-faq");
    const wantsDescription =
      settings.geo.entityRichDescriptions && finding.issues.includes("thin-description");
    return wantsFaq || wantsDescription;
  });

  if (findings.length === 0) return 0;

  const jobs = findings.map((finding) => ({
    id: jobId([shopDomain, "geo", boostId, finding.productId]),
    finding,
  }));

  await queueJobs(
    jobs.map(({ id, finding }) => ({
      id,
      shopDomain,
      boostId,
      module: "geo",
      label: finding.productTitle,
    })),
  );

  for (const { id, finding } of jobs) {
    await enqueue(
      "geo",
      {
        shopDomain,
        boostId,
        productId: finding.productId,
        settings: settings.geo,
      },
      { jobId: id },
    );
  }

  return jobs.length;
}

/** One speed job per boost — it measures the storefront, not a resource. */
async function queueSpeedJob(
  shopDomain: string,
  boostId: string,
  settings: ShopSettings,
): Promise<number> {
  if (!settings.speed.runPageSpeed && !settings.speed.scanStorefront) return 0;

  const id = jobId([shopDomain, "speed", boostId]);

  await queueJobs([
    { id, shopDomain, boostId, module: "speed", label: "Storefront speed" },
  ]);

  await enqueue("speed", { shopDomain, boostId }, { jobId: id });
  return 1;
}

/**
 * Marks a boost finished and triggers the "after" audit that completes the
 * before/after pair.
 */
export async function completeBoost(
  shopDomain: string,
  boostId: string,
  status: "done" | "failed" | "cancelled",
) {
  await prisma.boost.update({
    where: { id: boostId },
    data: { status, finishedAt: new Date() },
  });

  await prisma.shop.updateMany({
    where: { domain: shopDomain, activeBoostId: boostId },
    data: { activeBoostId: null },
  });

  if (status === "done") {
    const { enqueueAudit } = await import("./boost.server");
    await enqueueAudit(shopDomain, "after", boostId);
  }
}

/**
 * Has every job in this boost settled?
 *
 * Called after each job finishes. Reading the database rather than the queue
 * keeps this correct across worker restarts, when Redis may have already
 * trimmed the completed jobs.
 */
export async function checkBoostComplete(shopDomain: string, boostId: string) {
  const outstanding = await prisma.optimizationJob.count({
    where: { boostId, status: { in: ["queued", "running"] } },
  });
  if (outstanding > 0) return false;

  const boost = await prisma.boost.findUnique({ where: { id: boostId } });
  if (!boost || boost.status !== "running") return false;

  const failed = await prisma.optimizationJob.count({
    where: { boostId, status: "failed" },
  });
  const total = await prisma.optimizationJob.count({ where: { boostId } });

  // A boost is only "failed" if nothing succeeded. Partial failure is normal —
  // one unreadable image should not invalidate 200 good compressions.
  await completeBoost(shopDomain, boostId, failed === total ? "failed" : "done");
  return true;
}

/** Cancels queued work and marks the boost cancelled. */
export async function cancelBoost(shopDomain: string, boostId: string) {
  const pending = await prisma.optimizationJob.findMany({
    where: { boostId, status: "queued" },
    select: { id: true, module: true },
  });

  for (const row of pending) {
    try {
      const queue = getQueue(row.module as "images");
      const job = await queue.getJob(row.id);
      await job?.remove();
    } catch {
      // Already gone from Redis; the database row below is what matters.
    }
  }

  await prisma.optimizationJob.updateMany({
    where: { boostId, status: "queued" },
    data: { status: "skipped", error: "Cancelled", finishedAt: new Date() },
  });

  await completeBoost(shopDomain, boostId, "cancelled");
}
