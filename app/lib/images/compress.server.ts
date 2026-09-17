import sharp from "sharp";
import type { ShopSettings } from "../settings.server";
import { MAX_EDGE_PX, MAX_UPLOAD_BYTES } from "../graphql/images";

/**
 * Recompresses one image.
 *
 * The source must be the **untransformed upload** (`originalSource.url`), never
 * a CDN rendition — re-encoding an already-lossy rendition compounds artifacts.
 */

export type CompressResult =
  | {
      ok: true;
      buffer: Buffer;
      bytes: number;
      width: number;
      height: number;
      mimeType: string;
      extension: string;
      savedBytes: number;
      savedPercent: number;
    }
  | { ok: false; reason: string };

/** Formats Shopify will accept back. Anything else is re-encoded to WebP. */
const PASSTHROUGH_FORMATS = new Set(["jpeg", "png", "webp", "gif"]);

const MIME_BY_FORMAT: Record<string, string> = {
  jpeg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
  gif: "image/gif",
};

const EXTENSION_BY_FORMAT: Record<string, string> = {
  jpeg: "jpg",
  png: "png",
  webp: "webp",
  gif: "gif",
};

export async function downloadImage(
  url: string,
  maxBytes = MAX_UPLOAD_BYTES,
): Promise<Buffer> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Download failed: ${response.status} ${response.statusText}`);
  }

  // Guard before buffering: a malformed URL should not be able to exhaust the
  // worker's memory.
  const declared = Number(response.headers.get("content-length") ?? 0);
  if (declared > maxBytes) {
    throw new Error(`Image is ${Math.round(declared / 1024 / 1024)} MB, over the limit`);
  }

  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.byteLength > maxBytes) {
    throw new Error(`Image is over the ${Math.round(maxBytes / 1024 / 1024)} MB limit`);
  }
  return buffer;
}

/**
 * Compresses a buffer according to the merchant's settings.
 *
 * Returns `ok: false` with a reason rather than throwing whenever the right
 * answer is "leave this image alone" — the caller records those as skipped,
 * which is a normal outcome and not a failure.
 */
export async function compressImage(
  input: Buffer,
  settings: ShopSettings["images"],
): Promise<CompressResult> {
  const originalBytes = input.byteLength;

  let image = sharp(input, { failOn: "none" });
  const metadata = await image.metadata();

  if (!metadata.width || !metadata.height) {
    return { ok: false, reason: "Could not read image dimensions" };
  }

  // Animated GIFs lose their animation through this pipeline, so they are left
  // untouched rather than silently turned into a still frame.
  if (metadata.format === "gif" && (metadata.pages ?? 1) > 1) {
    return { ok: false, reason: "Animated GIF left unchanged" };
  }

  // Decide the output format. "keep" re-encodes in place; anything Shopify
  // won't accept back (HEIC, TIFF, AVIF sources) becomes WebP regardless.
  // sharp reports JPEG as "jpeg", never "jpg", so no aliasing is needed here.
  const sourceFormat = metadata.format ?? "";
  const targetFormat =
    settings.format === "webp" || !PASSTHROUGH_FORMATS.has(sourceFormat)
      ? "webp"
      : sourceFormat;

  // Shopify rejects anything over 4472px, so that ceiling applies even when the
  // merchant chose to leave dimensions alone.
  const longestEdge = Math.max(metadata.width, metadata.height);
  const targetEdge = Math.min(
    settings.maxDimension > 0 ? settings.maxDimension : longestEdge,
    MAX_EDGE_PX,
  );

  if (longestEdge > targetEdge) {
    image = image.resize({
      width: metadata.width >= metadata.height ? targetEdge : undefined,
      height: metadata.height > metadata.width ? targetEdge : undefined,
      withoutEnlargement: true,
      fit: "inside",
    });
  }

  // Strip EXIF and colour-profile bulk, but keep orientation applied so the
  // image does not end up rotated once the metadata is gone.
  image = image.rotate();

  switch (targetFormat) {
    case "webp":
      image = image.webp({ quality: settings.quality, effort: 4 });
      break;
    case "jpeg":
      image = image.jpeg({ quality: settings.quality, mozjpeg: true, progressive: true });
      break;
    case "png":
      image = image.png({ compressionLevel: 9, palette: true });
      break;
    case "gif":
      image = image.gif();
      break;
    default:
      return { ok: false, reason: `Unsupported source format: ${sourceFormat}` };
  }

  const { data, info } = await image.toBuffer({ resolveWithObject: true });

  const savedBytes = originalBytes - info.size;
  const savedPercent = (savedBytes / originalBytes) * 100;

  if (savedPercent < settings.minSavingsPercent) {
    return {
      ok: false,
      reason:
        savedBytes <= 0
          ? "Already well optimized — recompressing would make it larger"
          : `Only ${savedPercent.toFixed(1)}% smaller, below the ${settings.minSavingsPercent}% threshold`,
    };
  }

  if (info.size > MAX_UPLOAD_BYTES) {
    return { ok: false, reason: "Compressed image still exceeds Shopify's 20 MB limit" };
  }

  return {
    ok: true,
    buffer: data,
    bytes: info.size,
    width: info.width,
    height: info.height,
    mimeType: MIME_BY_FORMAT[targetFormat] ?? "image/webp",
    extension: EXTENSION_BY_FORMAT[targetFormat] ?? "webp",
    savedBytes,
    savedPercent,
  };
}

/**
 * Builds the filename for the recompressed upload, preserving the original stem
 * so merchants can still recognize the file in their Files list.
 */
export function outputFilename(sourceUrl: string, extension: string): string {
  const path = sourceUrl.split("?")[0];
  const base = path.slice(path.lastIndexOf("/") + 1) || "image";
  const stem = base.includes(".") ? base.slice(0, base.lastIndexOf(".")) : base;
  const safe = stem.replace(/[^a-zA-Z0-9._-]/g, "-").slice(0, 80) || "image";
  return `${safe}.${extension}`;
}
