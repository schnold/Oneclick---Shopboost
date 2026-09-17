/**
 * Storefront performance scan.
 *
 * Checks the documented, high-impact anti-patterns from Shopify's theme
 * performance best practices. An app may not edit theme code, so most findings
 * here are guidance the merchant applies — which means each one has to carry
 * the exact change, not just a complaint.
 *
 * The parsing is deliberately regex-based over the raw HTML: we only need to
 * see what the browser's preload scanner sees, and pulling in a DOM parser to
 * read the first few hundred lines of markup would cost more than it returns.
 */

export type SpeedFinding = {
  id: string;
  title: string;
  /** Why it matters, in terms of the metric it moves. */
  impact: "LCP" | "INP" | "CLS" | "TTFB" | "FCP";
  severity: "high" | "medium" | "low";
  detail: string;
  /** The specific change to make. */
  fix: string;
  /** How many places this was seen. */
  count: number;
};

const HEAD_WINDOW = 120_000;

function headOf(html: string): string {
  const end = html.search(/<\/head>/i);
  return end === -1 ? html.slice(0, HEAD_WINDOW) : html.slice(0, end);
}

/** The markup before the fold, where the LCP element almost always lives. */
function aboveFold(html: string): string {
  const bodyStart = html.search(/<body[^>]*>/i);
  const from = bodyStart === -1 ? 0 : bodyStart;
  return html.slice(from, from + 60_000);
}

function imgTags(html: string): string[] {
  return html.match(/<img\b[^>]*>/gi) ?? [];
}

export function scanHtml(html: string): SpeedFinding[] {
  const findings: SpeedFinding[] = [];
  const head = headOf(html);
  const fold = aboveFold(html);
  const images = imgTags(fold);

  // ── The LCP image ───────────────────────────────────────────────────
  // Shopify: "Never lazy-load the LCP image" — the single most common and
  // damaging anti-pattern in themes.
  //
  // Only the *first* image is checked. Lazy-loading later images is the
  // correct thing to do, and flagging it would tell merchants to break working
  // markup.
  const firstImage = images[0];
  if (firstImage && /loading=["']?lazy/i.test(firstImage)) {
    findings.push({
      id: "lcp-lazy",
      title: "The first image on the page is lazy-loaded",
      impact: "LCP",
      severity: "high",
      detail:
        'loading="lazy" on the largest image defers it until after layout, which delays the Largest Contentful Paint directly.',
      fix: 'Set loading="eager" on the hero or first product image. Keep loading="lazy" for images below the fold — that part is correct.',
      count: 1,
    });
  }

  // JavaScript lazy-loaders hide the URL from the preload scanner entirely.
  const jsLazy = images.filter((tag) => /\bdata-src(?:set)?=/i.test(tag));
  if (jsLazy.length > 0) {
    findings.push({
      id: "js-lazy-loader",
      title: "Images are loaded by JavaScript instead of the browser",
      impact: "LCP",
      severity: "high",
      detail:
        "data-src hides the image URL from the browser's preload scanner until JavaScript runs, so the download starts much later than it needs to.",
      fix: "Replace data-src with src, add loading=\"lazy\" to below-the-fold images, and remove the lazy-loading library (lazysizes, lozad, vanilla-lazyload).",
      count: jsLazy.length,
    });
  }

  const hasFetchPriority = images.slice(0, 3).some((tag) => /fetchpriority=["']?high/i.test(tag));
  if (images.length > 0 && !hasFetchPriority) {
    findings.push({
      id: "lcp-fetchpriority",
      title: "The main image is not marked as high priority",
      impact: "LCP",
      severity: "medium",
      detail:
        "fetchpriority=\"high\" tells the browser to fetch the LCP image ahead of other resources. It is a one-attribute change with measurable effect.",
      fix: 'Add fetchpriority="high" to the hero or first product image.',
      count: 1,
    });
  }

  // ── Layout stability ────────────────────────────────────────────────
  const noDimensions = images.filter(
    (tag) => !/\bwidth=/i.test(tag) || !/\bheight=/i.test(tag),
  );
  if (noDimensions.length > 0) {
    findings.push({
      id: "img-dimensions",
      title: "Images are missing width and height",
      impact: "CLS",
      severity: "medium",
      detail:
        "Without dimensions the browser cannot reserve space, so content jumps as each image arrives.",
      fix: "Use Shopify's image_tag filter, which adds width and height automatically, or set both attributes explicitly.",
      count: noDimensions.length,
    });
  }

  // ── Render-blocking scripts ─────────────────────────────────────────
  const scripts = head.match(/<script\b[^>]*>/gi) ?? [];
  const blocking = scripts.filter(
    (tag) =>
      /\bsrc=/i.test(tag) &&
      !/\b(?:async|defer|type=["']module["'])/i.test(tag) &&
      !/type=["']application\/(?:ld\+json|json)["']/i.test(tag),
  );
  if (blocking.length > 0) {
    findings.push({
      id: "render-blocking-js",
      title: "Scripts in the head block rendering",
      impact: "LCP",
      severity: "high",
      detail:
        "A script without defer or async pauses HTML parsing until it has downloaded and run, delaying everything the shopper sees.",
      fix: "Add defer to your own scripts. Use async only for independent third-party tags where execution order does not matter.",
      count: blocking.length,
    });
  }

  // ── Resource hints ──────────────────────────────────────────────────
  const preloads = head.match(/<link\b[^>]*rel=["']?preload/gi) ?? [];
  if (preloads.length > 3) {
    findings.push({
      id: "preload-overuse",
      title: `${preloads.length} preload hints compete with each other`,
      impact: "LCP",
      severity: "medium",
      detail:
        "Shopify's guidance is to reserve preload for one or two resources the browser would otherwise discover late. Beyond that it fights the browser's own prioritisation.",
      fix: "Keep preload for the LCP image and the primary font. Remove the rest.",
      count: preloads.length,
    });
  }

  // ── A/B test anti-flicker ───────────────────────────────────────────
  if (/anti-?flicker|\.async-hide|optimize\.js/i.test(head)) {
    findings.push({
      id: "anti-flicker",
      title: "An A/B testing anti-flicker snippet is active",
      impact: "LCP",
      severity: "high",
      detail:
        "Anti-flicker snippets hide the page until the testing script loads, or until a timeout expires. If no test is running, that delay buys nothing.",
      fix: "Remove the anti-flicker snippet when no experiment is live, and end finished experiments promptly.",
      count: 1,
    });
  }

  // ── Fonts ───────────────────────────────────────────────────────────
  const fontFaces = head.match(/@font-face/gi) ?? [];
  if (fontFaces.length > 0 && !/font-display\s*:/i.test(head)) {
    findings.push({
      id: "font-display",
      title: "Custom fonts have no font-display setting",
      impact: "FCP",
      severity: "low",
      detail:
        "Without font-display: swap the browser may hide text while a font downloads, leaving the page blank longer than necessary.",
      fix: "Add font-display: swap to each @font-face rule.",
      count: fontFaces.length,
    });
  }

  return findings;
}

/** 0–100 from the findings, weighted by severity. */
export function scoreFindings(findings: SpeedFinding[]): number {
  const weights = { high: 18, medium: 8, low: 3 };
  const penalty = findings.reduce((sum, f) => sum + weights[f.severity], 0);
  return Math.max(0, Math.min(100, 100 - penalty));
}
