import { getShopInfo } from "../shop-info.server";

/**
 * The storefront app embed.
 *
 * App embed blocks are inactive until a merchant turns them on, and an app
 * **cannot** activate one on their behalf — so until they do, no structured
 * data reaches the storefront no matter what we wrote to metafields. The
 * honest handling is to say so plainly and hand them a deep link.
 */

/** The Liquid filename of the block, which is its handle in the deep link. */
export const EMBED_HANDLE = "shopboost-geo";

/**
 * Deep link that opens the theme editor with our embed already activated, for
 * the merchant to preview and save.
 *
 * The documented format takes `api_key` — the app's client_id. The older
 * `uuid` parameter (the theme extension id) is deprecated.
 */
export async function embedActivationUrl(shopDomain: string): Promise<string | null> {
  const apiKey = process.env.SHOPIFY_API_KEY;
  if (!apiKey) return null;

  const info = await getShopInfo(shopDomain);
  const params = new URLSearchParams({
    context: "apps",
    template: "product",
    activateAppId: `${apiKey}/${EMBED_HANDLE}`,
  });

  return `https://${info.myshopifyDomain}/admin/themes/current/editor?${params}`;
}
