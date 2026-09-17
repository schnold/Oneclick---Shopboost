import {
  shopifyGraphql,
  assertNoUserErrors,
  type UserError,
} from "../shopify-admin.server";
import {
  STAGED_UPLOADS_CREATE,
  FILE_UPDATE,
  FILE_STATUS,
  type StagedTarget,
  type MediaImageNode,
} from "../graphql/images";

/**
 * Two-step upload: reserve a target, PUT the bytes there, then point the
 * existing MediaImage at the result.
 */

/**
 * Sends the bytes to Shopify's storage.
 *
 * The signed policy requires every returned parameter as a form field **before**
 * the file field — the storage backend validates the signature against the
 * fields in order and rejects the upload if `file` appears first.
 */
export async function uploadToStagedTarget(
  target: StagedTarget,
  buffer: Buffer,
  filename: string,
  mimeType: string,
): Promise<void> {
  const form = new FormData();
  for (const { name, value } of target.parameters) {
    form.append(name, value);
  }
  form.append("file", new Blob([new Uint8Array(buffer)], { type: mimeType }), filename);

  const response = await fetch(target.url, { method: "POST", body: form });

  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(
      `Staged upload failed: ${response.status} ${response.statusText}${
        detail ? ` — ${detail.slice(0, 200)}` : ""
      }`,
    );
  }
}

/** Reserves one upload target for an image. */
export async function createStagedTarget(
  shopDomain: string,
  filename: string,
  mimeType: string,
  fileSize: number,
): Promise<StagedTarget> {
  const { data } = await shopifyGraphql<{
    stagedUploadsCreate: {
      stagedTargets: StagedTarget[] | null;
      userErrors: UserError[];
    };
  }>(
    shopDomain,
    STAGED_UPLOADS_CREATE,
    {
      input: [
        {
          resource: "IMAGE",
          filename,
          mimeType,
          // Required for IMAGE, and a string rather than a number.
          fileSize: String(fileSize),
          httpMethod: "POST",
        },
      ],
    },
    "stagedUploadsCreate",
  );

  assertNoUserErrors(data.stagedUploadsCreate.userErrors, "stagedUploadsCreate");

  const target = data.stagedUploadsCreate.stagedTargets?.[0];
  if (!target) throw new Error("stagedUploadsCreate returned no target");
  return target;
}

/**
 * Points an existing MediaImage at a new source, replacing it in place.
 * `alt` is optional so this doubles as the alt-text write path.
 */
export async function replaceMediaImage(
  shopDomain: string,
  mediaId: string,
  originalSource: string,
  alt?: string,
): Promise<MediaImageNode> {
  const { data } = await shopifyGraphql<{
    fileUpdate: { files: MediaImageNode[] | null; userErrors: UserError[] };
  }>(
    shopDomain,
    FILE_UPDATE,
    {
      files: [
        {
          id: mediaId,
          originalSource,
          ...(alt !== undefined ? { alt } : {}),
        },
      ],
    },
    "fileUpdate",
  );

  assertNoUserErrors(data.fileUpdate.userErrors, "fileUpdate");

  const file = data.fileUpdate.files?.[0];
  if (!file) throw new Error("fileUpdate returned no file");
  return file;
}

/**
 * A currently-valid download URL for a media image's untransformed original.
 *
 * `originalSource.url` is a pre-signed Google Cloud Storage link that Shopify
 * mints on read with `X-Goog-Expires=300` — it dies five minutes after the
 * query that produced it. The audit stores its findings for as long as the
 * merchant takes to press Boost, so the URL captured at scan time is expired
 * by the time the job runs and the download returns 400 ExpiredToken. The URL
 * has to be re-minted here, immediately before it is used.
 */
export async function freshOriginalSourceUrl(
  shopDomain: string,
  mediaId: string,
): Promise<string> {
  const { data } = await shopifyGraphql<{ nodes: (MediaImageNode | null)[] }>(
    shopDomain,
    FILE_STATUS,
    { ids: [mediaId] },
    "fileStatus",
  );

  const node = data.nodes?.[0];
  if (!node) throw new Error(`Media ${mediaId} no longer exists`);

  const url = node.originalSource?.url;
  if (!url) {
    throw new Error(`Media ${mediaId} has no original source to recompress`);
  }
  return url;
}

/**
 * Waits for Shopify to finish processing an image.
 *
 * Processing is asynchronous and can fail after the mutation succeeded, so a
 * replacement is not "done" until this returns READY. A FAILED status means the
 * original is still live and the job should be recorded as failed.
 */
export async function waitForFileReady(
  shopDomain: string,
  mediaId: string,
  { timeoutMs = 90_000, intervalMs = 2_000 } = {},
): Promise<MediaImageNode> {
  const deadline = Date.now() + timeoutMs;

  for (;;) {
    const { data } = await shopifyGraphql<{ nodes: (MediaImageNode | null)[] }>(
      shopDomain,
      FILE_STATUS,
      { ids: [mediaId] },
      "fileStatus",
    );

    const node = data.nodes?.[0];
    if (!node) throw new Error(`Media ${mediaId} not found after update`);

    if (node.fileStatus === "READY") return node;

    if (node.fileStatus === "FAILED") {
      const detail = node.fileErrors?.map((e) => e.message).join("; ");
      throw new Error(
        `Shopify rejected the processed image${detail ? `: ${detail}` : ""}`,
      );
    }

    if (Date.now() >= deadline) {
      throw new Error(
        `Image still ${node.fileStatus} after ${Math.round(timeoutMs / 1000)}s`,
      );
    }

    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}
