import prisma from "../db.server";
import { replaceMediaImage, waitForFileReady } from "./images/upload.server";
import {
  shopifyGraphql,
  assertNoUserErrors,
  type UserError,
} from "./shopify-admin.server";
import { UPDATE_PRODUCT_SEO, UPDATE_ALT_TEXT } from "./graphql/seo";
import { FAQ_NAMESPACE, FAQ_KEY } from "./geo/metafields.server";

/**
 * Undo.
 *
 * Every write path records a `before` sufficient to reverse it, so rollback is
 * not a special mechanism — it is the same mutation replayed with the stored
 * original. Each field written by a module must have a case here; a write
 * without one is a broken promise, because the History page offers an Undo
 * button for every applied change.
 */

const DELETE_METAFIELDS = `#graphql
  mutation ShopboostDeleteMetafields($metafields: [MetafieldIdentifierInput!]!) {
    metafieldsDelete(metafields: $metafields) {
      deletedMetafields { key namespace ownerId }
      userErrors { field message }
    }
  }`;

export type RollbackResult = {
  restored: number;
  failed: number;
  errors: string[];
};

type Item = {
  id: string;
  resourceId: string;
  field: string;
  before: unknown;
  status: string;
};

/** Restores a product's SEO field to whatever it held before. */
async function restoreProductSeo(
  shopDomain: string,
  productId: string,
  field: "title" | "description",
  value: string | null,
) {
  const { data } = await shopifyGraphql<{
    productUpdate: { product: { id: string } | null; userErrors: UserError[] };
  }>(
    shopDomain,
    UPDATE_PRODUCT_SEO,
    // An empty string clears the field, which is what "there was nothing here
    // before" means to Shopify. Null would leave the value untouched.
    { product: { id: productId, seo: { [field]: value ?? "" } } },
    "productUpdate",
  );
  assertNoUserErrors(data.productUpdate.userErrors, "productUpdate");
}

async function rollbackItem(
  shopDomain: string,
  item: Item,
): Promise<{ ok: true } | { ok: false; error: string }> {
  if (item.status !== "done") {
    return { ok: false, error: "Nothing to undo — this change was never applied" };
  }

  const before = (item.before ?? {}) as Record<string, unknown>;

  try {
    switch (item.field) {
      case "image": {
        const url = before.url as string | undefined;
        if (!url) {
          return { ok: false, error: "No original recorded, so this cannot be undone" };
        }
        // Same mutation that replaced it, pointed back at the original upload.
        await replaceMediaImage(shopDomain, item.resourceId, url);
        await waitForFileReady(shopDomain, item.resourceId);
        break;
      }

      case "alt": {
        const { data } = await shopifyGraphql<{
          fileUpdate: { files: unknown[] | null; userErrors: UserError[] };
        }>(
          shopDomain,
          UPDATE_ALT_TEXT,
          { files: [{ id: item.resourceId, alt: (before.value as string) ?? "" }] },
          "fileUpdate",
        );
        assertNoUserErrors(data.fileUpdate.userErrors, "fileUpdate");
        break;
      }

      case "seo.title":
        await restoreProductSeo(
          shopDomain,
          item.resourceId,
          "title",
          (before.value as string) ?? null,
        );
        break;

      case "seo.description":
        await restoreProductSeo(
          shopDomain,
          item.resourceId,
          "description",
          (before.value as string) ?? null,
        );
        break;

      case "geo.description": {
        const html = (before.descriptionHtml as string) ?? "";
        const { data } = await shopifyGraphql<{
          productUpdate: { product: { id: string } | null; userErrors: UserError[] };
        }>(
          shopDomain,
          UPDATE_PRODUCT_SEO,
          { product: { id: item.resourceId, descriptionHtml: html } },
          "productUpdate",
        );
        assertNoUserErrors(data.productUpdate.userErrors, "productUpdate");
        break;
      }

      case "geo.faq": {
        // There was no FAQ before, so undo means removing the metafield
        // entirely rather than writing an empty one.
        const { data } = await shopifyGraphql<{
          metafieldsDelete: { deletedMetafields: unknown[] | null; userErrors: UserError[] };
        }>(
          shopDomain,
          DELETE_METAFIELDS,
          {
            metafields: [
              { ownerId: item.resourceId, namespace: FAQ_NAMESPACE, key: FAQ_KEY },
            ],
          },
          "metafieldsDelete",
        );
        assertNoUserErrors(data.metafieldsDelete.userErrors, "metafieldsDelete");
        break;
      }

      case "geo.faq.pending":
        // Never published, so there is nothing on the shop to reverse. Marking
        // it rolled back simply discards the draft.
        break;

      case "speed.report":
        return {
          ok: false,
          error: "Speed reports only measure — nothing was changed to undo",
        };

      default:
        return { ok: false, error: `Cannot undo ${item.field}` };
    }

    await prisma.optimizationItem.update({
      where: { id: item.id },
      data: { status: "rolled_back" },
    });

    return { ok: true };
  } catch (error) {
    return { ok: false, error: (error as Error).message };
  }
}

/** Reverts a single item by id. */
export async function rollbackOne(
  shopDomain: string,
  itemId: string,
): Promise<RollbackResult> {
  const item = await prisma.optimizationItem.findFirst({
    where: { id: itemId, job: { shopDomain } },
  });

  if (!item) return { restored: 0, failed: 1, errors: ["Change not found"] };

  const result = await rollbackItem(shopDomain, item);
  return result.ok
    ? { restored: 1, failed: 0, errors: [] }
    : { restored: 0, failed: 1, errors: [result.error] };
}

/**
 * Reverts every applied change in a boost.
 *
 * Newest first, so that when two boosts touched the same resource, undoing the
 * later one restores the state the earlier one left.
 */
export async function rollbackBoost(
  shopDomain: string,
  boostId: string,
): Promise<RollbackResult> {
  const items = await prisma.optimizationItem.findMany({
    where: { job: { boostId, shopDomain }, status: "done" },
    orderBy: { createdAt: "desc" },
  });

  const result: RollbackResult = { restored: 0, failed: 0, errors: [] };

  for (const item of items) {
    // A measurement is not a change; skip it rather than counting a failure.
    if (item.field === "speed.report") continue;

    const outcome = await rollbackItem(shopDomain, item);
    if (outcome.ok) {
      result.restored++;
    } else {
      result.failed++;
      if (result.errors.length < 5) result.errors.push(outcome.error);
    }
  }

  if (result.restored > 0) {
    await prisma.optimizationJob.updateMany({
      where: { boostId, status: "done" },
      data: { status: "rolled_back" },
    });
  }

  return result;
}

/** Fields the History page should offer an Undo button for. */
export function isUndoable(field: string, status: string): boolean {
  if (status !== "done") return false;
  return field !== "speed.report";
}
