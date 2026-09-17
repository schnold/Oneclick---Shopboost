import type { AuditProduct } from "./parse.server";
import type { ShopSettings } from "../settings.server";
import type {
  ImageFinding,
  SeoFinding,
  AltFinding,
  GeoFinding,
  AuditTotals,
  AuditScores,
} from "./types";

export type * from "./types";

/**
 * Turns a parsed catalog into scores and a work list.
 *
 * Two rules shape everything here:
 *
 *  1. A score is "how much of what we could fix is already right", so a shop
 *     with nothing to fix scores 100 and the potential bar sits empty. Scores
 *     are never invented from thin air — if there is no evidence for a
 *     category, it scores 100 rather than 0, so we never claim a problem we
 *     cannot name.
 *  2. Every deduction must correspond to a finding we could act on. The
 *     findings are the module work lists, so "potential" and "what the boost
 *     will do" can never drift apart.
 */

/**
 * SEO meta length bounds.
 *
 * Two different minimums, deliberately:
 *
 *  - `SEO_DESC_MIN` (70) is the audit's "genuinely too thin to be useful"
 *    threshold. Anything above it is acceptable, so a product with almost no
 *    data can still reach a passing state.
 *  - `SEO_DESC_TARGET_MIN` (120) is what we aim for when *writing* copy, since
 *    search engines display around 155 characters.
 *
 * Collapsing these into one number was a bug: with a single 110-char minimum,
 * the template generator could not reach it honestly for a data-less product,
 * so the audit flagged its own output forever and the score never converged.
 * The fix is a lower bar for passing than for writing — not filler text.
 */
export const SEO_TITLE_MAX = 60;
export const SEO_DESC_MIN = 70;
export const SEO_DESC_TARGET_MIN = 120;
export const SEO_DESC_MAX = 160;

/**
 * Byte budget per megapixel. A well-compressed WebP product photo lands around
 * 150 KB/MP; anything past this is carrying recoverable weight.
 */
const BYTES_PER_MEGAPIXEL_BUDGET = 150 * 1024;

/** Descriptions shorter than this give answer engines nothing to quote. */
const THIN_DESCRIPTION_CHARS = 200;

const pct = (good: number, total: number) =>
  total === 0 ? 100 : Math.round((good / total) * 100);

const clamp01to100 = (n: number) => Math.max(0, Math.min(100, Math.round(n)));

function isLegacyFormat(url: string | null): boolean {
  if (!url) return false;
  // CDN URLs carry query strings; compare against the path only.
  const path = url.split("?")[0].toLowerCase();
  return /\.(png|jpe?g|bmp|tiff?)$/.test(path);
}

/**
 * Conservative estimate of recoverable bytes for one image.
 *
 * Deliberately under-promises: the dashboard shows this as potential, and a
 * boost that beats its own estimate is a better experience than one that
 * misses it. Actual savings are measured after the fact from real output.
 */
function estimateSavings(
  bytes: number,
  width: number | null,
  height: number | null,
  settings: ShopSettings["images"],
): number {
  if (bytes <= 0) return 0;

  let projected = bytes;

  // Downscaling saves roughly in proportion to pixel-count reduction.
  if (settings.maxDimension > 0 && width && height) {
    const longestEdge = Math.max(width, height);
    if (longestEdge > settings.maxDimension) {
      const scale = settings.maxDimension / longestEdge;
      projected *= scale * scale;
    }
  }

  // Re-encoding gain by target format, for typical product photography rather
  // than best-case synthetic images. "keep" still gains from re-encoding at a
  // sane quality, just less.
  const encodingGain = settings.format === "webp" ? 0.3 : 0.12;

  // Quality below the default buys a little more; above it, a little less.
  const qualityFactor = 1 + (82 - settings.quality) / 200;

  projected *= 1 - encodingGain * qualityFactor;

  const savings = bytes - projected;
  return savings > 0 ? Math.round(savings) : 0;
}

export function scoreCatalog(
  products: AuditProduct[],
  settings: ShopSettings,
  skippedLines = 0,
): { totals: AuditTotals; scores: Omit<AuditScores, "speedScore" | "boostScore"> } {
  const images: ImageFinding[] = [];
  const seo: SeoFinding[] = [];
  const alt: AltFinding[] = [];
  const geo: GeoFinding[] = [];

  let imageCount = 0;
  let imageBytes = 0;
  let recoverableBytes = 0;
  let mediaMissingAlt = 0;
  let productsMissingSeoTitle = 0;
  let productsMissingSeoDescription = 0;
  let productsThinDescription = 0;

  // Duplicate meta titles compete with each other in search results.
  const titleCounts = new Map<string, number>();
  for (const product of products) {
    const key = (product.seoTitle ?? product.title).trim().toLowerCase();
    if (key) titleCounts.set(key, (titleCounts.get(key) ?? 0) + 1);
  }

  const skipUnderBytes = settings.images.skipUnderKb * 1024;

  for (const product of products) {
    // ── Images ──────────────────────────────────────────────────────────
    for (const media of product.media) {
      if (media.mediaContentType && media.mediaContentType !== "IMAGE") continue;
      imageCount++;

      const bytes = media.fileSize ?? 0;
      imageBytes += bytes;

      if (!media.sourceUrl || bytes <= 0 || bytes < skipUnderBytes) continue;

      const megapixels =
        media.width && media.height ? (media.width * media.height) / 1_000_000 : null;
      const overBytes =
        megapixels !== null && bytes > megapixels * BYTES_PER_MEGAPIXEL_BUDGET;
      const overDimensions =
        settings.images.maxDimension > 0 &&
        !!media.width &&
        !!media.height &&
        Math.max(media.width, media.height) > settings.images.maxDimension;
      const legacy = settings.images.format !== "keep" && isLegacyFormat(media.sourceUrl);

      if (!overBytes && !overDimensions && !legacy) continue;

      const estimatedSavings = estimateSavings(
        bytes,
        media.width,
        media.height,
        settings.images,
      );

      // Respect the merchant's own threshold: if we can't beat it, it isn't a
      // finding, and the boost would skip it anyway.
      if (estimatedSavings / bytes < settings.images.minSavingsPercent / 100) continue;

      recoverableBytes += estimatedSavings;
      images.push({
        productId: product.id,
        productTitle: product.title,
        mediaId: media.id,
        sourceUrl: media.sourceUrl,
        bytes,
        width: media.width,
        height: media.height,
        estimatedSavings,
        reason: overDimensions
          ? "oversized-dimensions"
          : overBytes
            ? "oversized-bytes"
            : "legacy-format",
      });
    }

    // ── Alt text ────────────────────────────────────────────────────────
    for (const media of product.media) {
      if (media.mediaContentType && media.mediaContentType !== "IMAGE") continue;
      if (!media.alt || !media.alt.trim()) {
        mediaMissingAlt++;
        alt.push({
          productId: product.id,
          productTitle: product.title,
          mediaId: media.id,
        });
      }
    }

    // ── SEO ─────────────────────────────────────────────────────────────
    const issues: SeoFinding["issues"] = [];
    const seoTitle = product.seoTitle?.trim();
    const seoDescription = product.seoDescription?.trim();

    if (!seoTitle) {
      issues.push("missing-title");
      productsMissingSeoTitle++;
    } else if (seoTitle.length > SEO_TITLE_MAX) {
      issues.push("title-too-long");
    }

    if (!seoDescription) {
      issues.push("missing-description");
      productsMissingSeoDescription++;
    } else if (seoDescription.length < SEO_DESC_MIN) {
      issues.push("description-too-short");
    } else if (seoDescription.length > SEO_DESC_MAX) {
      issues.push("description-too-long");
    }

    const titleKey = (product.seoTitle ?? product.title).trim().toLowerCase();
    if (titleKey && (titleCounts.get(titleKey) ?? 0) > 1) {
      issues.push("duplicate-title");
    }

    if (issues.length > 0) {
      seo.push({ productId: product.id, productTitle: product.title, issues });
    }

    // ── GEO ─────────────────────────────────────────────────────────────
    const plainDescription = (product.descriptionHtml ?? "")
      .replace(/<[^>]*>/g, " ")
      .replace(/\s+/g, " ")
      .trim();

    const geoIssues: GeoFinding["issues"] = [];
    if (plainDescription.length < THIN_DESCRIPTION_CHARS) {
      geoIssues.push("thin-description");
      productsThinDescription++;
    }
    // Phase 3 reads real FAQ metafields; until then every product is a
    // candidate, which is also true.
    geoIssues.push("no-faq");

    geo.push({ productId: product.id, productTitle: product.title, issues: geoIssues });
  }

  const totals: AuditTotals = {
    productCount: products.length,
    imageCount,
    imageBytes,
    recoverableBytes,
    imagesOverweight: images.length,
    mediaMissingAlt,
    productsMissingSeoTitle,
    productsMissingSeoDescription,
    productsWithSeoIssues: seo.length,
    productsThinDescription,
    skippedLines,
    findings: { images, seo, alt, geo },
  };

  // Image score: share of image bytes that are not recoverable waste.
  const imageScore =
    imageBytes === 0
      ? 100
      : clamp01to100(100 - (recoverableBytes / imageBytes) * 100);

  // SEO score: products with clean metas, and images with alt text, weighted
  // 70/30 — metas move rankings more than alt text does.
  const seoMetaScore = pct(products.length - seo.length, products.length);
  const altScore = pct(imageCount - mediaMissingAlt, imageCount);
  const seoScore = clamp01to100(seoMetaScore * 0.7 + altScore * 0.3);

  // GEO score before the storefront embed is checked. The embed is worth half
  // the category — without it there is no structured data at all — and the
  // caller folds that in via applyGeoEmbedPenalty.
  const geoContentScore = pct(
    products.length - productsThinDescription,
    products.length,
  );

  return {
    totals,
    scores: {
      imageScore,
      seoScore,
      geoScore: clamp01to100(geoContentScore),
    },
  };
}

/**
 * The storefront app embed is half the GEO story: without it, no JSON-LD
 * reaches the page no matter how good the content is.
 */
export function applyGeoEmbedPenalty(geoScore: number, embedActive: boolean): number {
  return embedActive ? geoScore : clamp01to100(geoScore * 0.5);
}

/**
 * Composite score. Images and SEO carry the most weight because they are what
 * the app can actually fix end to end; speed is weighted lowest because most
 * remaining speed work belongs to the theme, not to us.
 */
export function compositeScore(scores: {
  imageScore: number;
  seoScore: number;
  geoScore: number;
  speedScore: number;
}): number {
  return clamp01to100(
    scores.imageScore * 0.3 +
      scores.seoScore * 0.3 +
      scores.geoScore * 0.2 +
      scores.speedScore * 0.2,
  );
}

/**
 * What the shop would score if every finding were fixed. Images and SEO reach
 * 100 because the boost addresses them completely; GEO reaches 100 only once
 * the embed is active, and speed gains are estimated conservatively since
 * theme-side fixes need the merchant.
 */
export function potentialScores(
  current: AuditScores,
  embedActive: boolean,
): AuditScores {
  const imageScore = 100;
  const seoScore = 100;
  const geoScore = embedActive ? 100 : 90;
  const speedScore = clamp01to100(Math.max(current.speedScore, current.speedScore + 12));

  return {
    imageScore,
    seoScore,
    geoScore,
    speedScore,
    boostScore: compositeScore({ imageScore, seoScore, geoScore, speedScore }),
  };
}
