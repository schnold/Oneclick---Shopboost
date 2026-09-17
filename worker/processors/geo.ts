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
  SET_METAFIELDS,
  UPDATE_PRODUCT_SEO,
  type ProductForSeo,
} from "../../app/lib/graphql/seo";
import { plainText, type ProductContext } from "../../app/lib/seo/copy.server";
import { generateFaq, specificationBlock } from "../../app/lib/geo/faq.server";
import { startJob, finishJob, failJob, skipJob } from "../../app/lib/jobs.server";
import { getShopName } from "../../app/lib/shop-info.server";
import { ensureFaqDefinition } from "../../app/lib/geo/metafields.server";

/**
 * Generative engine optimization for one product: a grounded FAQ stored in a
 * metafield, and optionally a specification block appended to a thin
 * description.
 *
 * The FAQ is written to `shopboost.faq`, which the theme app extension renders
 * as FAQPage structured data. When `reviewBeforePublish` is on, the entries are
 * stored in our own database for approval instead of being pushed live.
 */
export async function geo(job: Job<JobPayloads["geo"]>) {
  const { shopDomain, boostId, productId, settings } = job.data;

  await startJob(job.id!, { shopDomain, boostId, module: "geo", label: job.name });

  try {
    const { data } = await shopifyGraphql<{ product: ProductForSeo | null }>(
      shopDomain,
      PRODUCT_FOR_SEO,
      { id: productId },
      "product",
    );

    const product = data.product;
    if (!product) {
      await skipJob(job.id!, "Product no longer exists");
      return { skipped: true, reason: "Product no longer exists" };
    }

    const description = plainText(product.descriptionHtml);
    const context: ProductContext = {
      title: product.title,
      vendor: product.vendor,
      productType: product.productType,
      tags: product.tags ?? [],
      description,
      shopName: await getShopName(shopDomain),
    };

    await job.updateProgress(25);

    const items: Prisma.OptimizationItemCreateManyInput[] = [];
    const notes: string[] = [];

    // ── FAQ ─────────────────────────────────────────────────────────────
    if (settings.generateFaq && !product.metafield) {
      const result = await generateFaq(context);

      if (result === null) {
        notes.push("FAQ needs an Anthropic API key");
      } else if (result.entries.length === 0) {
        notes.push(
          result.rejected > 0
            ? `no FAQ: ${result.rejected} draft answer(s) were not supported by the product details`
            : "no FAQ: not enough product detail to answer anything factually",
        );
      } else {
        const value = JSON.stringify(result.entries);

        if (settings.reviewBeforePublish) {
          // Held for approval. Recorded as an item so the merchant can find it,
          // but nothing reaches the storefront yet.
          items.push({
            jobId: job.id!,
            resourceId: product.id,
            field: "geo.faq.pending",
            before: { value: null } as Prisma.InputJsonValue,
            after: { entries: result.entries } as Prisma.InputJsonValue,
            status: "done",
            reason: "Awaiting your review before it goes live",
          });
          notes.push(`${result.entries.length} FAQ entries awaiting review`);
        } else {
          // The definition must exist and be storefront-readable, or the value
          // is stored but the theme can never render it.
          const definition = await ensureFaqDefinition(shopDomain);
          if (!definition.ok) {
            await skipJob(job.id!, definition.reason);
            return { skipped: true, reason: definition.reason };
          }

          const { data: set } = await shopifyGraphql<{
            metafieldsSet: { metafields: Array<{ id: string }> | null; userErrors: UserError[] };
          }>(
            shopDomain,
            SET_METAFIELDS,
            {
              metafields: [
                {
                  ownerId: product.id,
                  namespace: "shopboost",
                  key: "faq",
                  type: "json",
                  value,
                },
              ],
            },
            "metafieldsSet",
          );

          assertNoUserErrors(set.metafieldsSet.userErrors, "metafieldsSet");

          items.push({
            jobId: job.id!,
            resourceId: product.id,
            field: "geo.faq",
            before: { value: null } as Prisma.InputJsonValue,
            after: { entries: result.entries } as Prisma.InputJsonValue,
            status: "done",
          });
          notes.push(`${result.entries.length} FAQ entries published`);
        }

        if (result.rejected > 0) {
          notes.push(`${result.rejected} rejected as unsupported by the product data`);
        }
      }
    }

    await job.updateProgress(65);

    // ── Specification block ─────────────────────────────────────────────
    if (settings.entityRichDescriptions && description.length < 200) {
      const block = specificationBlock(context);

      if (block && !(product.descriptionHtml ?? "").includes("shopboost-specs")) {
        const updated = `${product.descriptionHtml ?? ""}${block}`;

        const { data: result } = await shopifyGraphql<{
          productUpdate: { product: { id: string } | null; userErrors: UserError[] };
        }>(
          shopDomain,
          UPDATE_PRODUCT_SEO,
          { product: { id: product.id, descriptionHtml: updated } },
          "productUpdate",
        );

        assertNoUserErrors(result.productUpdate.userErrors, "productUpdate");

        items.push({
          jobId: job.id!,
          resourceId: product.id,
          field: "geo.description",
          before: { descriptionHtml: product.descriptionHtml } as Prisma.InputJsonValue,
          after: { descriptionHtml: updated } as Prisma.InputJsonValue,
          status: "done",
        });
        notes.push("specification block appended");
      }
    }

    if (items.length === 0) {
      const reason = notes.join("; ") || "Nothing to add";
      await skipJob(job.id!, reason);
      return { skipped: true, reason };
    }

    await prisma.optimizationItem.createMany({ data: items });
    await finishJob(job.id!);

    console.log(`[geo] ${product.title}: ${notes.join("; ")}`);
    return { changes: items.length, notes };
  } catch (error) {
    await failJob(job.id!, (error as Error).message);
    throw error;
  }
}
