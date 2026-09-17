/**
 * Audit operations. Every document here has been validated against the live
 * Admin schema — see AGENTS.md before editing.
 */

/**
 * The catalog export. Bulk queries may not carry pagination arguments, so there
 * is deliberately no `first:` on either connection.
 *
 * `originalSource.url` is the untransformed upload — the only correct source
 * for recompression. `image.url` is a CDN rendition and re-encoding it would
 * compound artifacts.
 */
export const AUDIT_PRODUCTS_QUERY = `
{
  products {
    edges {
      node {
        id
        title
        handle
        status
        onlineStoreUrl
        descriptionHtml
        seo { title description }
        featuredMedia { id }
        media {
          edges {
            node {
              id
              alt
              mediaContentType
              ... on MediaImage {
                image { url width height }
                originalSource { fileSize url }
              }
            }
          }
        }
      }
    }
  }
}`;

/**
 * `groupObjects: false` is explicit: it defaults to true on 2025-10, and
 * Shopify recommends disabling it because grouping is slower and more
 * timeout-prone. It also matches the 2026-01+ default, so the parser we write
 * against the flat `__parentId` format stays correct after an upgrade.
 */
export const START_BULK_AUDIT = `#graphql
  mutation ShopboostStartAudit($query: String!) {
    bulkOperationRunQuery(query: $query, groupObjects: false) {
      bulkOperation { id status }
      userErrors { field message }
    }
  }`;

/**
 * Polls one operation by id. `node(id:)` is used rather than
 * `currentBulkOperation` (deprecated) or `bulkOperation(id:)` (2026-01+ only)
 * because it is correct on every API version.
 */
export const POLL_BULK_OPERATION = `#graphql
  query ShopboostBulkOperation($id: ID!) {
    node(id: $id) {
      ... on BulkOperation {
        id
        status
        errorCode
        objectCount
        fileSize
        url
        partialDataUrl
      }
    }
  }`;

/**
 * Looks up this app's in-flight bulk queries for the shop, so a job that loses
 * the race to start one can attach to it instead of failing.
 *
 * Uses `bulkOperations` with a status filter rather than `currentBulkOperation`,
 * which is deprecated. Available from 2026-01; this app targets 2026-07. From
 * that version an app may also run several bulk queries at once, so this asks
 * for a list rather than assuming a single current operation.
 */
export const RUNNING_BULK_OPERATIONS = `#graphql
  query ShopboostRunningBulkOperations {
    bulkOperations(first: 5, query: "status:running OR status:created", reverse: true) {
      nodes {
        id
        status
        errorCode
        objectCount
        fileSize
        url
        partialDataUrl
      }
    }
  }`;

export const CANCEL_BULK_OPERATION = `#graphql
  mutation ShopboostCancelBulk($id: ID!) {
    bulkOperationCancel(id: $id) {
      bulkOperation { id status }
      userErrors { field message }
    }
  }`;

export const SHOP_INFO = `#graphql
  query ShopboostShopInfo {
    shop {
      name
      myshopifyDomain
      primaryDomain { url host }
      currencyCode
    }
  }`;

export type BulkOperationStatus =
  | "CREATED"
  | "RUNNING"
  | "COMPLETED"
  | "FAILED"
  | "CANCELING"
  | "CANCELED"
  | "EXPIRED";

export type BulkOperationNode = {
  id: string;
  status: BulkOperationStatus;
  errorCode: string | null;
  objectCount: string | null;
  fileSize: string | null;
  url: string | null;
  partialDataUrl: string | null;
};
