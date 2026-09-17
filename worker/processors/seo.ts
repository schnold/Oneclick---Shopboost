import type { Job } from "bullmq";
import { Prisma } from "@prisma/client";
import prisma from "../../app/db.server";
import type { JobPayloads } from "../../app/lib/queue.server";
import {
  shopifyGraphql,
  assertNoUserErrors,
  type UserError,
} from "../../app/lib/shopify-admin.server";
import {
  PRODUCT_FOR_SEO,
  UPDATE_PRODUCT_SEO,
  UPDATE_ALT_TEXT,
  type ProductForSeo,
} from "../../app/lib/graphql/seo";
import {
  generateCopy,
  plainText,
  templateAltText,
  type ProductContext,
} from "../../app/lib/seo/copy.server";
import { SEO_TITLE_MAX, SEO_DESC_MIN, SEO_DESC_MAX } from "../../app/lib/audit/score.server";
import { startJob, finishJob, failJob, skipJob } from "../../app/lib/jobs.server";
import { getShopName } from "../../app/lib/shop-info.server";

/**
 * Writes the search listing for one product: meta title, meta description, and
 * alt text for images that have none.
 *
 * The merchant's own copy is never overwritten unless they turned
 * `onlyFillBlanks` off. That default is deliberate — silently rewriting hand-
 * written product copy is the single most destructive thing an app like this
 * could do.
 */
export async function seo(job: Job<JobPayloads["seo"]>) {
  const { shopDomain, boostId, resourceId, settings } = job.data;

  await startJob(job.id!, { shopDomain, boostId, module: "seo", label: job.name });

  try {
    const { data } = await shopifyGraphql<{ product: ProductForSeo | null }>(
      shopDomain,
      PRODUCT_FOR_SEO,
      { id: resourceId },
      "product",
    );

    const product = data.product;
    if (!product) {
      // Deleted between the audit and now. Not an error.
      await skipJob(job.id!, "Product no longer exists");
      return { skipped: true, reason: "Product no longer exists" };
    }

    await job.updateProgress(20);

    const existingTitle = product.seo.title?.trim() ?? "";
    const existingDescription = product.seo.description?.trim() ?? "";

    const titleNeedsWork = settings.onlyFillBlanks
      ? !existingTitle
      : !existingTitle || existingTitle.length > SEO_TITLE_MAX;
    const descriptionNeedsWork = settings.onlyFillBlanks
      ? !existingDescription
      : !existingDescription ||
        existingDescription.length < SEO_DESC_MIN ||
        existingDescription.length > SEO_DESC_MAX;

    const images = product.media.nodes.filter(
      (m) => !m.mediaContentType || m.mediaContentType === "IMAGE",
    );
    const missingAlt = settings.writeAltText
      ? images.filter((m) => !m.alt || !m.alt.trim())
      : [];

    if (!titleNeedsWork && !descriptionNeedsWork && missingAlt.length === 0) {
      await skipJob(job.id!, "Already has complete search copy");
      return { skipped: true, reason: "Already has complete search copy" };
    }

    const context: ProductContext = {
      title: product.title,
      vendor: product.vendor,
      productType: product.productType,
      tags: product.tags ?? [],
      description: plainText(product.descriptionHtml),
      shopName: await getShopName(shopDomain),
    };

    const copy = await generateCopy(
      context,
      settings,
      missingAlt.map((m) => m.id),
    );
    await job.updateProgress(50);

    const items: Prisma.OptimizationItemCreateManyInput[] = [];

    // ── Meta title and description ──────────────────────────────────────
    if (titleNeedsWork || descriptionNeedsWork) {
      const seoInput: { title?: string; description?: string } = {};
      if (titleNeedsWork) seoInput.title = copy.title;
      if (descriptionNeedsWork) seoInput.description = copy.description;

      const { data: updated } = await shopifyGraphql<{
        productUpdate: {
          product: { id: string; seo: { title: string | null; description: string | null } } | null;
          userErrors: UserError[];
        };
      }>(
        shopDomain,
        UPDATE_PRODUCT_SEO,
        { product: { id: product.id, seo: seoInput } },
        "productUpdate",
      );

      assertNoUserErrors(updated.productUpdate.userErrors, "productUpdate");

      if (titleNeedsWork) {
        items.push({
          jobId: job.id!,
          resourceId: product.id,
          field: "seo.title",
          before: { value: existingTitle || null } as Prisma.InputJsonValue,
          after: { value: copy.title, source: copy.source } as Prisma.InputJsonValue,
          status: "done",
        });
      }
      if (descriptionNeedsWork) {
        items.push({
          jobId: job.id!,
          resourceId: product.id,
          field: "seo.description",
          before: { value: existingDescription || null } as Prisma.InputJsonValue,
          after: { value: copy.description, source: copy.source } as Prisma.InputJsonValue,
          status: "done",
        });
      }
    }

    await job.updateProgress(75);

    // ── Alt text ────────────────────────────────────────────────────────
    if (missingAlt.length > 0) {
      const files = missingAlt.map((media, index) => ({
        id: media.id,
        alt: copy.altTexts[media.id] ?? templateAltText(context, index),
      }));

      const { data: altResult } = await shopifyGraphql<{
        fileUpdate: { files: Array<{ id: string; alt: string | null }> | null; userErrors: UserError[] };
      }>(shopDomain, UPDATE_ALT_TEXT, { files }, "fileUpdate");

      assertNoUserErrors(altResult.fileUpdate.userErrors, "fileUpdate");

      for (const file of files) {
        items.push({
          jobId: job.id!,
          resourceId: file.id,
          field: "alt",
          before: { value: null } as Prisma.InputJsonValue,
          after: { value: file.alt, source: copy.source } as Prisma.InputJsonValue,
          status: "done",
        });
      }
    }

    if (items.length > 0) {
      await prisma.optimizationItem.createMany({ data: items });
    }

    await finishJob(job.id!);

    console.log(
      `[seo] ${product.title}: ${items.length} change(s) via ${copy.source}`,
    );

    return { changes: items.length, source: copy.source };
  } catch (error) {
    await failJob(job.id!, (error as Error).message);
    throw error;
  }
}
