import { shopifyGraphql, type UserError } from "../shopify-admin.server";

/**
 * The `shopboost.faq` metafield definition.
 *
 * This is load-bearing, not bookkeeping: a metafield is only readable from
 * Liquid when its definition grants `access: { storefront: PUBLIC_READ }`.
 * Without it, `metafieldsSet` succeeds, the value is stored, and the theme app
 * extension renders nothing — a silent failure of the whole GEO feature.
 */

export const FAQ_NAMESPACE = "shopboost";
export const FAQ_KEY = "faq";

const CREATE_DEFINITION = `#graphql
  mutation ShopboostCreateFaqDefinition($definition: MetafieldDefinitionInput!) {
    metafieldDefinitionCreate(definition: $definition) {
      createdDefinition { id name namespace key }
      userErrors { field message code }
    }
  }`;

const FIND_DEFINITION = `#graphql
  query ShopboostFaqDefinition($namespace: String!, $key: String!) {
    metafieldDefinitions(first: 1, ownerType: PRODUCT, namespace: $namespace, key: $key) {
      nodes { id name namespace key access { storefront } }
    }
  }`;

/** Shops whose definition this process has already confirmed. */
const confirmed = new Set<string>();

export type DefinitionState =
  | { ok: true; created: boolean }
  | { ok: false; reason: string };

/**
 * Ensures the definition exists, creating it if not.
 *
 * Idempotent and cached per process: every GEO job calls this, and after the
 * first one it is free. An existing definition is a success, not a conflict.
 */
export async function ensureFaqDefinition(shopDomain: string): Promise<DefinitionState> {
  if (confirmed.has(shopDomain)) return { ok: true, created: false };

  try {
    const { data: existing } = await shopifyGraphql<{
      metafieldDefinitions: {
        nodes: Array<{ id: string; access: { storefront: string | null } }>;
      };
    }>(
      shopDomain,
      FIND_DEFINITION,
      { namespace: FAQ_NAMESPACE, key: FAQ_KEY },
      "metafieldDefinitions",
    );

    const found = existing.metafieldDefinitions.nodes[0];
    if (found) {
      // A definition that exists but is not storefront-readable would make the
      // theme extension render nothing, so say so rather than assume success.
      if (found.access?.storefront !== "PUBLIC_READ") {
        return {
          ok: false,
          reason:
            "The shopboost.faq metafield exists but is not readable by your theme. Delete it in Settings > Custom data and run a boost again.",
        };
      }
      confirmed.add(shopDomain);
      return { ok: true, created: false };
    }

    const { data } = await shopifyGraphql<{
      metafieldDefinitionCreate: {
        createdDefinition: { id: string } | null;
        userErrors: UserError[];
      };
    }>(
      shopDomain,
      CREATE_DEFINITION,
      {
        definition: {
          name: "Shopboost FAQ",
          namespace: FAQ_NAMESPACE,
          key: FAQ_KEY,
          description:
            "Questions and answers Shopboost generated, rendered as FAQPage structured data.",
          type: "json",
          ownerType: "PRODUCT",
          access: { storefront: "PUBLIC_READ" },
        },
      },
      "metafieldDefinitionCreate",
    );

    const errors = data.metafieldDefinitionCreate.userErrors ?? [];

    // Losing a race with another worker is a success.
    if (errors.length > 0) {
      const taken = errors.some((e) =>
        /taken|already exists|in use/i.test(e.message),
      );
      if (!taken) {
        return {
          ok: false,
          reason: errors.map((e) => e.message).join("; "),
        };
      }
    }

    confirmed.add(shopDomain);
    return { ok: true, created: errors.length === 0 };
  } catch (error) {
    return { ok: false, reason: (error as Error).message };
  }
}

/** Test seam — the cache would otherwise leak between runs. */
export function resetDefinitionCache() {
  confirmed.clear();
}
