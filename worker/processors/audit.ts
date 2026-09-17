import type { Job } from "bullmq";
import { Prisma } from "@prisma/client";
import prisma from "../../app/db.server";
import type { JobPayloads } from "../../app/lib/queue.server";
import { getSettings } from "../../app/lib/settings.server";
import { shopifyGraphql, assertNoUserErrors } from "../../app/lib/shopify-admin.server";
import {
  AUDIT_PRODUCTS_QUERY,
  START_BULK_AUDIT,
  POLL_BULK_OPERATION,
  RUNNING_BULK_OPERATIONS,
  type BulkOperationNode,
} from "../../app/lib/graphql/audit";
import { parseBulkAudit } from "../../app/lib/audit/parse.server";
import {
  scoreCatalog,
  compositeScore,
  applyGeoEmbedPenalty,
} from "../../app/lib/audit/score.server";

/**
 * Catalog audit: runs a bulk export, waits for it, scores the result, and
 * writes an AuditSnapshot.
 *
 * The bulk_operations/finish webhook is the fast path, but Shopify does not
 * guarantee webhook delivery, so this job polls as well. Polling is cheap —
 * a status query costs a single point.
 */

const POLL_INTERVAL_MS = 3_000;
const POLL_TIMEOUT_MS = 15 * 60 * 1_000;

/** Shopify's error when this app already has a bulk query running for the shop. */
const ALREADY_RUNNING = /already in progress|operation is already running/i;

export async function audit(job: Job<JobPayloads["audit"]>) {
  const { shopDomain, kind, boostId } = job.data;

  const settings = await getSettings(shopDomain);
  await job.updateProgress(5);

  const operation = await startOrAdopt(shopDomain);
  await job.log(`bulk operation ${operation.id} (${operation.status})`);
  await job.updateProgress(10);

  const finished = await waitForCompletion(shopDomain, operation.id, job);

  if (finished.status !== "COMPLETED") {
    throw new Error(
      `Bulk audit ${finished.status}${finished.errorCode ? `: ${finished.errorCode}` : ""}`,
    );
  }

  await job.updateProgress(60);

  // A completed operation with no url means the shop has no products at all.
  if (!finished.url) {
    return saveSnapshot(shopDomain, kind, boostId, {
      products: [],
      skippedLines: 0,
      settings,
    });
  }

  const { products, skippedLines } = await parseBulkAudit(finished.url);
  await job.log(`parsed ${products.length} products (${skippedLines} lines skipped)`);
  await job.updateProgress(85);

  return saveSnapshot(shopDomain, kind, boostId, { products, skippedLines, settings });
}

/**
 * Starts a bulk export, or adopts the one already running.
 *
 * Only one bulk query per app per shop may run at a time before API version
 * 2026-01. Racing with our own earlier job is normal — a webhook re-audit can
 * land while an install audit is still going — so rather than fail, we attach
 * to the in-flight operation and wait on its results, which are the same data.
 */
async function startOrAdopt(shopDomain: string): Promise<BulkOperationNode> {
  const { data } = await shopifyGraphql<{
    bulkOperationRunQuery: {
      bulkOperation: BulkOperationNode | null;
      userErrors: Array<{ field?: string[] | null; message: string }>;
    };
  }>(
    shopDomain,
    START_BULK_AUDIT,
    { query: AUDIT_PRODUCTS_QUERY },
    "bulkOperationRunQuery",
  );

  const payload = data.bulkOperationRunQuery;

  if (payload.bulkOperation && !payload.userErrors?.length) {
    return payload.bulkOperation;
  }

  const alreadyRunning = payload.userErrors?.some((e) => ALREADY_RUNNING.test(e.message));
  if (!alreadyRunning) {
    assertNoUserErrors(payload.userErrors, "bulkOperationRunQuery");
    throw new Error("bulkOperationRunQuery returned no operation");
  }

  const running = await findRunningOperation(shopDomain);
  if (!running) {
    // It finished in the gap between the two calls; a retry will start cleanly.
    throw new Error("A bulk export was in progress but is no longer available — retrying.");
  }
  return running;
}

/**
 * Finds this app's in-flight bulk query for the shop.
 *
 * From 2026-01 an app may run several bulk queries concurrently, so this takes
 * the most recent still-running one rather than assuming there is exactly one.
 */
async function findRunningOperation(
  shopDomain: string,
): Promise<BulkOperationNode | null> {
  const { data } = await shopifyGraphql<{
    bulkOperations: { nodes: BulkOperationNode[] };
  }>(shopDomain, RUNNING_BULK_OPERATIONS, undefined, "bulkOperations");

  const running = data.bulkOperations?.nodes?.find(
    (node) => node.status === "CREATED" || node.status === "RUNNING",
  );
  return running ?? null;
}

async function pollOperation(
  shopDomain: string,
  id: string,
): Promise<BulkOperationNode> {
  const { data } = await shopifyGraphql<{ node: BulkOperationNode | null }>(
    shopDomain,
    POLL_BULK_OPERATION,
    { id },
    "bulkOperation",
  );
  if (!data.node) throw new Error(`Bulk operation ${id} not found`);
  return data.node;
}

async function waitForCompletion(
  shopDomain: string,
  id: string,
  job: Job,
): Promise<BulkOperationNode> {
  const deadline = Date.now() + POLL_TIMEOUT_MS;
  let lastCount = "";

  while (Date.now() < deadline) {
    const node = await pollOperation(shopDomain, id);

    if (node.status !== "CREATED" && node.status !== "RUNNING") return node;

    if (node.objectCount && node.objectCount !== lastCount) {
      lastCount = node.objectCount;
      // 10–60% of the job maps to the export; the real ceiling is unknown, so
      // this approaches it asymptotically rather than faking a percentage.
      const counted = Number(node.objectCount);
      await job.updateProgress(Math.min(55, 10 + Math.log10(counted + 1) * 12));
    }

    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }

  throw new Error(`Bulk audit did not finish within ${POLL_TIMEOUT_MS / 60_000} minutes`);
}

async function saveSnapshot(
  shopDomain: string,
  kind: JobPayloads["audit"]["kind"],
  boostId: string | undefined,
  input: {
    products: Awaited<ReturnType<typeof parseBulkAudit>>["products"];
    skippedLines: number;
    settings: Awaited<ReturnType<typeof getSettings>>;
  },
) {
  const { totals, scores } = scoreCatalog(
    input.products,
    input.settings,
    input.skippedLines,
  );

  // Phase 3 reports real embed state; until then assume inactive, which is
  // true on a fresh install and keeps the GEO number honest.
  const embedActive = false;
  const geoScore = applyGeoEmbedPenalty(scores.geoScore, embedActive);

  // Phase 4 replaces this with a PageSpeed Insights measurement. Until then
  // speed is reported as unmeasured rather than guessed — see the dashboard,
  // which renders it as "Not measured" instead of a number.
  const speedScore = 0;

  const boostScore = compositeScore({
    imageScore: scores.imageScore,
    seoScore: scores.seoScore,
    geoScore,
    speedScore,
  });

  const snapshot = await prisma.auditSnapshot.create({
    data: {
      shopDomain,
      kind,
      boostId: boostId ?? null,
      boostScore,
      imageScore: scores.imageScore,
      seoScore: scores.seoScore,
      geoScore,
      speedScore,
      totals: totals as unknown as Prisma.InputJsonValue,
    },
  });

  console.log(
    `[audit] ${shopDomain} ${kind}: score ${boostScore} · ${totals.productCount} products · ` +
      `${totals.imagesOverweight} images to compress · ${totals.productsWithSeoIssues} SEO issues`,
  );

  return {
    snapshotId: snapshot.id,
    boostScore,
    productCount: totals.productCount,
    findings: {
      images: totals.findings.images.length,
      seo: totals.findings.seo.length,
      alt: totals.findings.alt.length,
    },
  };
}
