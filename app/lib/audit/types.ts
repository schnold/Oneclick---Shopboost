/**
 * Audit result shapes, shared between the scoring engine (server) and the
 * dashboard (client).
 *
 * Kept out of `score.server.ts` so routes can import them without dragging a
 * server module into the client bundle. Types alone would be erased, but
 * keeping them here makes the boundary explicit rather than accidental.
 */

export type ImageFinding = {
  productId: string;
  productTitle: string;
  mediaId: string;
  sourceUrl: string;
  bytes: number;
  width: number | null;
  height: number | null;
  /** Bytes we expect to reclaim. Deliberately conservative. */
  estimatedSavings: number;
  reason: "oversized-bytes" | "oversized-dimensions" | "legacy-format";
};

export type SeoIssue =
  | "missing-title"
  | "title-too-long"
  | "missing-description"
  | "description-too-short"
  | "description-too-long"
  | "duplicate-title";

export type SeoFinding = {
  productId: string;
  productTitle: string;
  issues: SeoIssue[];
};

export type AltFinding = {
  productId: string;
  productTitle: string;
  mediaId: string;
};

export type GeoFinding = {
  productId: string;
  productTitle: string;
  issues: Array<"thin-description" | "no-faq">;
};

export type AuditTotals = {
  productCount: number;
  imageCount: number;
  imageBytes: number;
  /** Bytes believed recoverable at the current settings. */
  recoverableBytes: number;
  imagesOverweight: number;
  mediaMissingAlt: number;
  productsMissingSeoTitle: number;
  productsMissingSeoDescription: number;
  productsWithSeoIssues: number;
  productsThinDescription: number;
  skippedLines: number;
  /** The module work lists. Potential and actual work can never drift apart. */
  findings: {
    images: ImageFinding[];
    seo: SeoFinding[];
    alt: AltFinding[];
    geo: GeoFinding[];
  };
  /** Present once the speed module has run; absent on a catalog-only audit. */
  psi?: {
    mobile: number | null;
    desktop: number | null;
    measuredUrl: string | null;
    measuredAt: string;
  };
};

export type AuditScores = {
  boostScore: number;
  imageScore: number;
  seoScore: number;
  geoScore: number;
  speedScore: number;
};
