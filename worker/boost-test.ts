// Must be first — redirects the queues to a test-only Redis namespace so a
// running `npm run worker` cannot pick up this test's fixture jobs.
import "./test-prefix";
// Shares the worker's env preflight: some of these modules reach
// shopify.server, which validates its configuration at module scope.
import "./bootstrap";
import prisma from "../app/db.server";
import { getRedis } from "../app/lib/redis.server";
import { getQueue } from "../app/lib/queue.server";
import {
  startBoost,
  checkBoostComplete,
  cancelBoost,
  NoAuditError,
  BoostInProgressError,
  NotEntitledError,
} from "../app/lib/boost-orchestrator.server";
import type { Entitlement } from "../app/lib/billing.server";
import { getBoostProgress } from "../app/lib/boost.server";
import { DEFAULT_SETTINGS } from "../app/lib/settings.server";
import { scoreCatalog } from "../app/lib/audit/score.server";
import type { AuditProduct } from "../app/lib/audit/parse.server";
import { Prisma } from "@prisma/client";

/**
 * Exercises the boost orchestrator against real Postgres and Redis.
 *
 * Covers what the merchant would actually hit: boosting without a scan, the
 * fan-out from findings, refusing a concurrent boost, cancelling, and settling
 * once every job reports back.
 *
 * Requires Postgres and Redis. Cleans up after itself.
 *
 *   npx tsx worker/boost-test.ts
 */

const SHOP = "boost-test.myshopify.com";

/** A paid plan, injected so the fan-out can be tested without Shopify. */
const PAID: Entitlement = {
  plan: "growth",
  planName: "Growth",
  canBoost: true,
  imagesUsed: 0,
  imageLimit: 500,
  imagesRemaining: 500,
  blockedReason: null,
  subscription: null,
};

let failures = 0;
function check(label: string, ok: boolean, detail = "") {
  if (!ok) failures++;
  console.log(`${ok ? "✓" : "✗"} ${label}${detail ? `: ${detail}` : ""}`);
}

function product(n: number, imageBytes: number): AuditProduct {
  return {
    id: `gid://shopify/Product/${n}`,
    title: `Test Product ${n}`,
    handle: `test-${n}`,
    status: "ACTIVE",
    onlineStoreUrl: null,
    descriptionHtml: "<p>short</p>",
    seoTitle: null,
    seoDescription: null,
    featuredMediaId: `gid://shopify/MediaImage/${n}0`,
    media: [
      {
        id: `gid://shopify/MediaImage/${n}0`,
        alt: null,
        mediaContentType: "IMAGE",
        url: `https://cdn.example/p${n}.png`,
        width: 4000,
        height: 3000,
        fileSize: imageBytes,
        sourceUrl: `https://cdn.example/p${n}.png`,
      },
    ],
  };
}

async function cleanup() {
  await prisma.boost.deleteMany({ where: { shopDomain: SHOP } });
  await prisma.optimizationJob.deleteMany({ where: { shopDomain: SHOP } });
  await prisma.auditSnapshot.deleteMany({ where: { shopDomain: SHOP } });
  await prisma.shop.deleteMany({ where: { domain: SHOP } });

  // Drop any jobs this test pushed, so a rerun starts clean.
  for (const name of ["images", "seo", "geo", "speed", "audit"] as const) {
    const queue = getQueue(name);
    for (const job of await queue.getJobs(["waiting", "delayed", "active", "failed"])) {
      if ((job.data as { shopDomain?: string })?.shopDomain === SHOP) {
        // A running worker may hold a lock on the job; leaving it is harmless
        // because the database rows are deleted either way.
        await job.remove().catch(() => {});
      }
    }
  }
}

try {
  await cleanup();

  console.log("── Boosting without a scan ──");
  await prisma.shop.create({
    data: { domain: SHOP, settings: DEFAULT_SETTINGS as unknown as Prisma.InputJsonValue },
  });

  let refused = false;
  try {
    await startBoost(SHOP, { entitlement: PAID });
  } catch (error) {
    refused = error instanceof NoAuditError;
  }
  check("refused with a clear reason", refused, "“Scan your shop before boosting.”");

  console.log("\n── Fan-out from findings ──");
  const products = [product(1, 6_000_000), product(2, 5_000_000), product(3, 4_000_000)];
  const { totals, scores } = scoreCatalog(products, DEFAULT_SETTINGS, 0);
  check("audit found work", totals.findings.images.length === 3,
    `${totals.findings.images.length} image findings`);

  await prisma.auditSnapshot.create({
    data: {
      shopDomain: SHOP,
      kind: "initial",
      boostScore: 30,
      imageScore: scores.imageScore,
      seoScore: scores.seoScore,
      geoScore: scores.geoScore,
      speedScore: 0,
      totals: totals as unknown as Prisma.InputJsonValue,
    },
  });

  const plan = await startBoost(SHOP, { entitlement: PAID });
  check("queued one image job per finding", plan.queued.images === 3, `${plan.queued.images} jobs`);
  check("queued one SEO job per product", plan.queued.seo === 3, `${plan.queued.seo} jobs`);
  check("queued GEO jobs", plan.queued.geo === 3, `${plan.queued.geo} jobs`);
  check("queued a single speed job", plan.queued.speed === 1, `${plan.queued.speed} job`);
  check(
    "total matches the sum of the modules",
    plan.total === plan.queued.images + plan.queued.seo + plan.queued.geo + plan.queued.speed,
    `${plan.total} total`,
  );

  const rows = await prisma.optimizationJob.findMany({ where: { boostId: plan.boostId } });
  check("wrote queued rows for the UI", rows.length === plan.total, `${rows.length} rows`);
  check("rows start queued", rows.every((r) => r.status === "queued"));
  check(
    "every module is represented",
    new Set(rows.map((r) => r.module)).size === 4,
    [...new Set(rows.map((r) => r.module))].join(", "),
  );

  const queued = await getQueue("images").getJobs(["waiting", "delayed"]);
  const mine = queued.filter(
    (j) => (j.data as { shopDomain?: string })?.shopDomain === SHOP,
  );
  check("jobs really reached Redis", mine.length === 3, `${mine.length} in queue`);
  check(
    "payload carries the recompression source",
    mine.every((j) => (j.data as { sourceUrl?: string }).sourceUrl?.startsWith("https://")),
  );

  const before = await prisma.auditSnapshot.findFirst({
    where: { boostId: plan.boostId, kind: "before" },
  });
  check("froze a before snapshot", before !== null, `score ${before?.boostScore}`);

  console.log("\n── A second boost is refused while one runs ──");
  let blocked = false;
  try {
    await startBoost(SHOP, { entitlement: PAID });
  } catch (error) {
    blocked = error instanceof BoostInProgressError;
  }
  check("refused", blocked, "“A boost is already running.”");

  console.log("\n── Progress reporting ──");
  let progress = await getBoostProgress(SHOP);
  check("reports running", progress.running);
  check("counts outstanding work", progress.total === plan.total && progress.settled === 0,
    `${progress.settled}/${progress.total}`);

  console.log("\n── Settling ──");
  // Simulate the worker finishing everything but one job, which fails.
  const live = await prisma.optimizationJob.findMany({ where: { boostId: plan.boostId } });
  await prisma.optimizationJob.update({
    where: { id: live[0].id },
    data: { status: "done", finishedAt: new Date() },
  });
  await prisma.optimizationItem.create({
    data: {
      jobId: live[0].id,
      resourceId: "gid://shopify/MediaImage/10",
      field: "image",
      before: { url: "https://cdn.example/p1.png", bytes: 6_000_000 },
      after: { url: "https://cdn.example/p1.webp", bytes: 1_200_000 },
      status: "done",
      savedBytes: 4_800_000,
    },
  });

  check("not settled while work remains", (await checkBoostComplete(SHOP, plan.boostId)) === false);

  await prisma.optimizationJob.updateMany({
    where: { id: { in: live.slice(1, -1).map((j) => j.id) } },
    data: { status: "done", finishedAt: new Date() },
  });
  await prisma.optimizationJob.update({
    where: { id: live[live.length - 1].id },
    data: { status: "failed", error: "unreadable image", finishedAt: new Date() },
  });

  check("settles once every job reports", await checkBoostComplete(SHOP, plan.boostId));

  const settled = await prisma.boost.findUnique({ where: { id: plan.boostId } });
  check(
    "partial failure still counts as done",
    settled?.status === "done",
    `status ${settled?.status} — one bad image must not invalidate the rest`,
  );

  progress = await getBoostProgress(SHOP);
  check("savings come from measured items", progress.savedBytes === 4_800_000,
    `${progress.savedBytes} bytes`);
  check("failures are surfaced", progress.failed === 1);

  const shopRow = await prisma.shop.findUnique({ where: { domain: SHOP } });
  check("shop is unlocked for the next boost", shopRow?.activeBoostId === null);

  const afterAudit = await getQueue("audit").getJobs(["waiting", "delayed", "active"]);
  check(
    "an after-scan was queued to close the before/after pair",
    afterAudit.some((j) => (j.data as { shopDomain?: string })?.shopDomain === SHOP),
  );

  console.log("\n── A second boost gets its own jobs ──");
  // The regression that hung boosts: with job ids keyed only on settings, the
  // second boost inherited the first boost's rows, had nothing to wait for,
  // and never settled.
  const plan2 = await startBoost(SHOP, { entitlement: PAID });
  const rows2 = await prisma.optimizationJob.findMany({ where: { boostId: plan2.boostId } });
  check("queued its own jobs", rows2.length === plan2.total, `${rows2.length} rows`);
  check(
    "job ids are distinct from the first boost",
    rows2.every((r) => !rows.some((old) => old.id === r.id)),
  );
  const progress2 = await getBoostProgress(SHOP);
  check("progress tracks the new boost", progress2.total === plan2.total, `${progress2.total} jobs`);

  console.log("\n── The plan gates writing, not scanning ──");
  {
    let denied: string | null = null;
    try {
      await prisma.shop.update({ where: { domain: SHOP }, data: { activeBoostId: null } });
      await prisma.boost.updateMany({ where: { shopDomain: SHOP }, data: { status: "done" } });
      // The real free-plan entitlement, exactly as billing.server builds it.
      await startBoost(SHOP, {
        entitlement: {
          ...PAID,
          plan: "free",
          planName: "Free",
          canBoost: false,
          imageLimit: 0,
          imagesRemaining: 0,
          blockedReason:
            "The free plan includes the full scan. Choose a plan to start optimizing.",
        },
      });
    } catch (error) {
      if (error instanceof NotEntitledError) denied = error.message;
    }
    check("a free plan cannot write changes", denied !== null, denied ?? "was allowed");

    const stray = await prisma.boost.count({ where: { shopDomain: SHOP, status: "running" } });
    check("and no half-started boost is left behind", stray === 0, `${stray} running`);
  }

  console.log("\n── Quota caps image work ──");
  {
    await prisma.shop.update({ where: { domain: SHOP }, data: { activeBoostId: null } });
    await prisma.boost.updateMany({ where: { shopDomain: SHOP }, data: { status: "done" } });
    const capped = await startBoost(SHOP, {
      entitlement: { ...PAID, imageLimit: 2, imagesRemaining: 2 },
    });
    check("image jobs capped to the remaining quota", capped.queued.images === 2,
      `${capped.queued.images} of 3 findings`);
    await cancelBoost(SHOP, capped.boostId);
  }

  console.log("\n── Cancelling ──");
  await cancelBoost(SHOP, plan2.boostId);
  await prisma.shop.update({ where: { domain: SHOP }, data: { activeBoostId: null } });
  const plan3 = await startBoost(SHOP, { entitlement: PAID });
  await cancelBoost(SHOP, plan3.boostId);

  const cancelled = await prisma.boost.findUnique({ where: { id: plan3.boostId } });
  check("boost marked cancelled", cancelled?.status === "cancelled");
  const leftover = await prisma.optimizationJob.count({
    where: { boostId: plan3.boostId, status: "queued" },
  });
  check("no queued jobs left behind", leftover === 0);

  console.log(
    failures === 0 ? "\n✓ boost orchestrator verified" : `\n✗ ${failures} check(s) failed`,
  );
  process.exitCode = failures === 0 ? 0 : 1;
} finally {
  await cleanup();
  await prisma.$disconnect();
  getRedis().disconnect();
  for (const name of ["images", "seo", "geo", "speed", "audit"] as const) {
    await getQueue(name).close();
  }
}
