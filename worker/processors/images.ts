import type { Job } from "bullmq";
import { Prisma } from "@prisma/client";
import prisma from "../../app/db.server";
import type { JobPayloads } from "../../app/lib/queue.server";
import {
  downloadImage,
  compressImage,
  outputFilename,
} from "../../app/lib/images/compress.server";
import {
  createStagedTarget,
  uploadToStagedTarget,
  replaceMediaImage,
  waitForFileReady,
  freshOriginalSourceUrl,
} from "../../app/lib/images/upload.server";
import { startJob, finishJob, failJob, skipJob } from "../../app/lib/jobs.server";

/**
 * Compresses one product image and replaces it in place.
 *
 * The contract for every write path in this app: capture a `before` that is
 * sufficient to undo the change, and only then make it. `before.url` here is
 * the original untransformed upload, which `fileUpdate` can restore verbatim.
 */
export async function images(job: Job<JobPayloads["images"]>) {
  const { shopDomain, boostId, productId, mediaId, originalBytes, settings } = job.data;

  await startJob(job.id!, { shopDomain, boostId, module: "images", label: job.name });

  try {
    // Not `job.data.sourceUrl`: that URL was minted during the audit and is
    // signed for five minutes, so by the time this job runs it is expired.
    // The one on the payload is kept only as a record of what was scanned.
    const sourceUrl = await freshOriginalSourceUrl(shopDomain, mediaId);

    const input = await downloadImage(sourceUrl);
    await job.updateProgress(25);

    const result = await compressImage(input, settings);

    if (!result.ok) {
      // Not a failure: the image was already fine, or is one we deliberately
      // leave alone. Recorded so the merchant can see we looked at it.
      await skipJob(job.id!, result.reason);
      await prisma.optimizationItem.create({
        data: {
          jobId: job.id!,
          resourceId: mediaId,
          field: "image",
          before: { url: sourceUrl, bytes: originalBytes } as Prisma.InputJsonValue,
          after: Prisma.JsonNull,
          status: "skipped",
          reason: result.reason,
        },
      });
      return { skipped: true, reason: result.reason };
    }

    await job.updateProgress(45);

    const filename = outputFilename(sourceUrl, result.extension);
    const target = await createStagedTarget(
      shopDomain,
      filename,
      result.mimeType,
      result.bytes,
    );

    await uploadToStagedTarget(target, result.buffer, filename, result.mimeType);
    await job.updateProgress(70);

    // The swap. Same media id, so every product and variant reference survives.
    await replaceMediaImage(shopDomain, mediaId, target.resourceUrl);
    await job.updateProgress(85);

    // Not done until Shopify has processed it — a FAILED status here means the
    // original is still live and nothing was lost.
    const ready = await waitForFileReady(shopDomain, mediaId);

    await prisma.optimizationItem.create({
      data: {
        jobId: job.id!,
        resourceId: mediaId,
        field: "image",
        before: {
          url: sourceUrl,
          bytes: originalBytes,
          productId,
        } as Prisma.InputJsonValue,
        after: {
          url: ready.originalSource?.url ?? ready.image?.url ?? null,
          bytes: result.bytes,
          width: result.width,
          height: result.height,
          format: result.mimeType,
        } as Prisma.InputJsonValue,
        status: "done",
        savedBytes: result.savedBytes,
      },
    });

    await finishJob(job.id!);

    console.log(
      `[images] ${mediaId}: ${(originalBytes / 1024).toFixed(0)}KB → ` +
        `${(result.bytes / 1024).toFixed(0)}KB (−${result.savedPercent.toFixed(0)}%)`,
    );

    return {
      savedBytes: result.savedBytes,
      savedPercent: Math.round(result.savedPercent),
    };
  } catch (error) {
    // Record the failure, then rethrow so BullMQ can retry with backoff. The
    // original image is untouched in every failure path above.
    await failJob(job.id!, (error as Error).message);
    throw error;
  }
}
