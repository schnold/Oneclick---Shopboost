/**
 * Streaming parser for a bulk-operation JSONL export.
 *
 * With `groupObjects: false`, connections are flattened: each product is one
 * line, and each of its media is a separate line carrying `__parentId`. Child
 * lines always appear after their parent, but not necessarily adjacent to it,
 * so children are attached through a map rather than by assuming order.
 *
 * The file is streamed and parsed line by line — a 50,000-product catalog is
 * hundreds of megabytes and must never be read into memory whole.
 */

export type AuditMedia = {
  id: string;
  alt: string | null;
  mediaContentType: string | null;
  url: string | null;
  width: number | null;
  height: number | null;
  /** Bytes of the untransformed upload. Null when Shopify hasn't reported it. */
  fileSize: number | null;
  /** Untransformed upload URL — the recompression source. */
  sourceUrl: string | null;
};

export type AuditProduct = {
  id: string;
  title: string;
  handle: string;
  status: string;
  onlineStoreUrl: string | null;
  descriptionHtml: string | null;
  seoTitle: string | null;
  seoDescription: string | null;
  featuredMediaId: string | null;
  media: AuditMedia[];
};

const PRODUCT_GID = /^gid:\/\/shopify\/Product\//;

/**
 * One JSONL line. The shape is known because we author the query
 * (`AUDIT_PRODUCTS_QUERY`), but every field is optional: a product line and a
 * media line are both lines, and numbers arrive as strings.
 */
type BulkLine = {
  id?: string;
  __parentId?: string;
  // Product fields
  title?: string;
  handle?: string;
  status?: string;
  onlineStoreUrl?: string | null;
  descriptionHtml?: string | null;
  seo?: { title?: string | null; description?: string | null } | null;
  featuredMedia?: { id?: string } | null;
  // Media fields
  alt?: string | null;
  mediaContentType?: string | null;
  image?: {
    url?: string | null;
    width?: number | string | null;
    height?: number | string | null;
  } | null;
  originalSource?: { fileSize?: number | string | null; url?: string | null } | null;
};

function toNumber(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}

function toProduct(line: BulkLine): AuditProduct {
  return {
    id: line.id!,
    title: line.title ?? "",
    handle: line.handle ?? "",
    status: line.status ?? "ACTIVE",
    onlineStoreUrl: line.onlineStoreUrl ?? null,
    descriptionHtml: line.descriptionHtml ?? null,
    seoTitle: line.seo?.title ?? null,
    seoDescription: line.seo?.description ?? null,
    featuredMediaId: line.featuredMedia?.id ?? null,
    media: [],
  };
}

function toMedia(line: BulkLine): AuditMedia {
  return {
    id: line.id!,
    alt: line.alt ?? null,
    mediaContentType: line.mediaContentType ?? null,
    url: line.image?.url ?? null,
    width: toNumber(line.image?.width),
    height: toNumber(line.image?.height),
    // fileSize arrives as a string in JSONL.
    fileSize: toNumber(line.originalSource?.fileSize),
    sourceUrl: line.originalSource?.url ?? null,
  };
}

/**
 * Splits a byte stream into lines without buffering the whole file. Handles a
 * final line that has no trailing newline.
 */
async function* streamLines(body: ReadableStream<Uint8Array>) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      let newlineIndex: number;
      while ((newlineIndex = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, newlineIndex).trim();
        buffer = buffer.slice(newlineIndex + 1);
        if (line) yield line;
      }
    }
    const tail = (buffer + decoder.decode()).trim();
    if (tail) yield tail;
  } finally {
    reader.releaseLock();
  }
}

/**
 * Downloads and parses a bulk export into products with their media attached.
 *
 * Returns products in file order. Lines that fail to parse are counted rather
 * than thrown — one malformed line should not discard an entire catalog audit.
 */
export async function parseBulkAudit(url: string): Promise<{
  products: AuditProduct[];
  skippedLines: number;
}> {
  const response = await fetch(url);
  if (!response.ok || !response.body) {
    throw new Error(
      `Failed to download bulk audit results: ${response.status} ${response.statusText}`,
    );
  }

  const byId = new Map<string, AuditProduct>();
  // Media whose parent line has not been seen yet. Should stay empty given
  // Shopify's ordering guarantee, but attaching defensively costs nothing.
  const orphans = new Map<string, AuditMedia[]>();
  let skippedLines = 0;

  for await (const line of streamLines(response.body)) {
    let parsed: BulkLine;
    try {
      parsed = JSON.parse(line) as BulkLine;
    } catch {
      skippedLines++;
      continue;
    }

    const parentId = parsed.__parentId;

    if (!parentId) {
      if (typeof parsed.id === "string" && PRODUCT_GID.test(parsed.id)) {
        const product = toProduct(parsed);
        const waiting = orphans.get(product.id);
        if (waiting) {
          product.media.push(...waiting);
          orphans.delete(product.id);
        }
        byId.set(product.id, product);
      } else {
        skippedLines++;
      }
      continue;
    }

    const media = toMedia(parsed);
    const parent = byId.get(parentId);
    if (parent) {
      parent.media.push(media);
    } else {
      const bucket = orphans.get(parentId);
      if (bucket) bucket.push(media);
      else orphans.set(parentId, [media]);
    }
  }

  return { products: [...byId.values()], skippedLines };
}
