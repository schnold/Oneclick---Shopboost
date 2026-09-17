import { shopifyGraphql } from "./shopify-admin.server";
import { SHOP_INFO } from "./graphql/audit";

/**
 * Shop name and storefront URL, cached per process.
 *
 * Every SEO job wants the shop name for its title template, and every speed
 * scan wants the storefront URL. Neither changes during a boost, so fetching
 * them once per worker saves hundreds of identical API calls on a large
 * catalog.
 */

type ShopInfo = {
  name: string;
  primaryDomainUrl: string | null;
  myshopifyDomain: string;
  currencyCode: string;
  fetchedAt: number;
};

const CACHE_TTL_MS = 30 * 60 * 1_000;
const cache = new Map<string, ShopInfo>();

export async function getShopInfo(shopDomain: string): Promise<ShopInfo> {
  const cached = cache.get(shopDomain);
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) return cached;

  try {
    const { data } = await shopifyGraphql<{
      shop: {
        name: string;
        myshopifyDomain: string;
        primaryDomain: { url: string; host: string } | null;
        currencyCode: string;
      };
    }>(shopDomain, SHOP_INFO, undefined, "shop");

    const info: ShopInfo = {
      name: data.shop.name,
      primaryDomainUrl: data.shop.primaryDomain?.url ?? null,
      myshopifyDomain: data.shop.myshopifyDomain,
      currencyCode: data.shop.currencyCode,
      fetchedAt: Date.now(),
    };
    cache.set(shopDomain, info);
    return info;
  } catch (error) {
    // The shop name is cosmetic in a title template; failing the whole job over
    // it would be disproportionate. Derive a readable fallback from the domain.
    console.warn(`[shop-info] falling back for ${shopDomain}: ${(error as Error).message}`);
    const fallback: ShopInfo = {
      name: shopDomain.replace(/\.myshopify\.com$/, "").replace(/-/g, " "),
      primaryDomainUrl: `https://${shopDomain}`,
      myshopifyDomain: shopDomain,
      currencyCode: "USD",
      fetchedAt: Date.now(),
    };
    return fallback;
  }
}

export async function getShopName(shopDomain: string): Promise<string> {
  return (await getShopInfo(shopDomain)).name;
}

export async function getStorefrontUrl(shopDomain: string): Promise<string> {
  const info = await getShopInfo(shopDomain);
  return info.primaryDomainUrl ?? `https://${info.myshopifyDomain}`;
}
