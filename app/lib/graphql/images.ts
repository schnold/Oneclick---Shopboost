/**
 * Image operations. Validated against the live Admin schema — see AGENTS.md.
 *
 * Shopify's MediaImage limits (from the manage-media guide):
 *   formats  PNG, GIF, JPEG, WEBP, HEIC — **not AVIF**
 *   size     20 MB
 *   pixels   4472 × 4472 (20 MP)
 */

export const SUPPORTED_UPLOAD_MIME = [
  "image/png",
  "image/gif",
  "image/jpeg",
  "image/webp",
  "image/heic",
] as const;

export const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;
export const MAX_EDGE_PX = 4472;

export const STAGED_UPLOADS_CREATE = `#graphql
  mutation ShopboostStagedUploads($input: [StagedUploadInput!]!) {
    stagedUploadsCreate(input: $input) {
      stagedTargets {
        url
        resourceUrl
        parameters { name value }
      }
      userErrors { field message }
    }
  }`;

/**
 * Replaces an image in place.
 *
 * Passing `originalSource` for an existing MediaImage swaps the bytes while
 * keeping the same media id, so product and variant references survive and
 * nothing needs reordering. Rollback is this same mutation with the stored
 * original URL.
 *
 * `productCreateMedia` / `productDeleteMedia` are deprecated and must not be
 * used for this.
 */
export const FILE_UPDATE = `#graphql
  mutation ShopboostReplaceImage($files: [FileUpdateInput!]!) {
    fileUpdate(files: $files) {
      files {
        id
        fileStatus
        alt
        ... on MediaImage {
          image { url width height }
          originalSource { fileSize }
        }
      }
      userErrors { field message code }
    }
  }`;

/** Processing is asynchronous, so the result must be polled to READY/FAILED. */
export const FILE_STATUS = `#graphql
  query ShopboostFileStatus($ids: [ID!]!) {
    nodes(ids: $ids) {
      ... on MediaImage {
        id
        fileStatus
        alt
        fileErrors { code details message }
        image { url width height }
        originalSource { fileSize url }
      }
    }
  }`;

export type FileStatus = "UPLOADED" | "PROCESSING" | "READY" | "FAILED";

export type StagedTarget = {
  url: string;
  resourceUrl: string;
  parameters: Array<{ name: string; value: string }>;
};

export type MediaImageNode = {
  id: string;
  fileStatus: FileStatus;
  alt: string | null;
  fileErrors?: Array<{ code: string; details: string | null; message: string }>;
  image: { url: string | null; width: number | null; height: number | null } | null;
  originalSource: { fileSize: number | null; url: string | null } | null;
};
