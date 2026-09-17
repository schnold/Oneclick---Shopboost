/**
 * SEO operations. Validated against the live Admin schema — see AGENTS.md.
 *
 * Products have native `seo { title description }`. Collections, pages and
 * blogs do not: their search listing lives in `global` namespace metafields
 * `title_tag` / `description_tag`, per Shopify's storefront SEO guide.
 */

export const PRODUCT_FOR_SEO = `#graphql
  query ShopboostProductForSeo($id: ID!) {
    product(id: $id) {
      id
      title
      handle
      vendor
      productType
      tags
      descriptionHtml
      seo { title description }
      featuredMedia { id }
      metafield(namespace: "shopboost", key: "faq") { id value }
      media(first: 50) {
        nodes {
          id
          alt
          mediaContentType
          ... on MediaImage { image { url width height } }
        }
      }
    }
  }`;

export const UPDATE_PRODUCT_SEO = `#graphql
  mutation ShopboostUpdateProductSeo($product: ProductUpdateInput!) {
    productUpdate(product: $product) {
      product { id title seo { title description } }
      userErrors { field message }
    }
  }`;

/** Alt text only — the same mutation that replaces image bytes. */
export const UPDATE_ALT_TEXT = `#graphql
  mutation ShopboostUpdateAlt($files: [FileUpdateInput!]!) {
    fileUpdate(files: $files) {
      files { id alt fileStatus }
      userErrors { field message code }
    }
  }`;

export const SET_METAFIELDS = `#graphql
  mutation ShopboostSetMetafields($metafields: [MetafieldsSetInput!]!) {
    metafieldsSet(metafields: $metafields) {
      metafields { id namespace key value ownerType }
      userErrors { field message code }
    }
  }`;

export const CREATE_METAFIELD_DEFINITION = `#graphql
  mutation ShopboostCreateMetafieldDefinition($definition: MetafieldDefinitionInput!) {
    metafieldDefinitionCreate(definition: $definition) {
      createdDefinition { id name namespace key }
      userErrors { field message code }
    }
  }`;

export type ProductForSeo = {
  id: string;
  title: string;
  handle: string;
  vendor: string | null;
  productType: string | null;
  tags: string[];
  descriptionHtml: string | null;
  seo: { title: string | null; description: string | null };
  featuredMedia: { id: string } | null;
  metafield: { id: string; value: string } | null;
  media: {
    nodes: Array<{
      id: string;
      alt: string | null;
      mediaContentType: string | null;
      image?: { url: string | null; width: number | null; height: number | null } | null;
    }>;
  };
};
