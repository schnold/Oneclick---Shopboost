// Shares the worker's env preflight: some of these modules reach
// shopify.server, which validates its configuration at module scope.
import "./bootstrap";
import { createServer } from "node:http";
import { parseBulkAudit } from "../app/lib/audit/parse.server";
import {
  scoreCatalog,
  compositeScore,
  potentialScores,
} from "../app/lib/audit/score.server";
import { formatBytes } from "../app/lib/format";
import { DEFAULT_SETTINGS } from "../app/lib/settings.server";

/**
 * Exercises the audit pipeline without a Shopify store: serves a JSONL fixture
 * in the exact shape a bulk export produces, then parses and scores it.
 *
 * The fixture deliberately covers the cases that break naive parsers — media
 * arriving before its parent, a non-image media node, a product with no media,
 * and a malformed line.
 *
 *   npx tsx worker/audit-fixture-test.ts
 */

const MB = 1024 * 1024;

const lines = [
  // A clean product: small WebP image, alt text, good metas.
  {
    id: "gid://shopify/Product/1",
    title: "Kiln-Fired Mug",
    handle: "kiln-fired-mug",
    status: "ACTIVE",
    onlineStoreUrl: "https://example.myshopify.com/products/kiln-fired-mug",
    descriptionHtml:
      "<p>" + "A hand-thrown stoneware mug fired at 1240C. ".repeat(8) + "</p>",
    seo: {
      title: "Kiln-Fired Stoneware Mug | Handmade",
      description:
        "A hand-thrown stoneware mug fired at 1240 degrees, glazed in matte sage. " +
        "Holds 350ml, dishwasher safe, and made to order in our Portland studio.",
    },
    featuredMedia: { id: "gid://shopify/MediaImage/11" },
  },
  {
    id: "gid://shopify/MediaImage/11",
    alt: "Matte sage stoneware mug on a linen cloth",
    mediaContentType: "IMAGE",
    image: { url: "https://cdn.example/mug.webp", width: 1200, height: 1200 },
    originalSource: { fileSize: String(180 * 1024), url: "https://cdn.example/mug.webp" },
    __parentId: "gid://shopify/Product/1",
  },

  // Orphan first: media whose parent line appears later in the file.
  {
    id: "gid://shopify/MediaImage/21",
    alt: null,
    mediaContentType: "IMAGE",
    image: { url: "https://cdn.example/bowl.png", width: 4000, height: 3000 },
    originalSource: { fileSize: String(6 * MB), url: "https://cdn.example/bowl.png" },
    __parentId: "gid://shopify/Product/2",
  },
  // A heavy, oversized PNG with no alt text, and no metas at all.
  {
    id: "gid://shopify/Product/2",
    title: "Serving Bowl",
    handle: "serving-bowl",
    status: "ACTIVE",
    onlineStoreUrl: null,
    descriptionHtml: "<p>A bowl.</p>",
    seo: { title: null, description: null },
    featuredMedia: { id: "gid://shopify/MediaImage/21" },
  },
  // A video attached to the same product — must not be counted as an image.
  {
    id: "gid://shopify/Video/22",
    alt: null,
    mediaContentType: "VIDEO",
    __parentId: "gid://shopify/Product/2",
  },

  // Duplicate meta title against product 4, and an over-long description.
  {
    id: "gid://shopify/Product/3",
    title: "Ceramic Plate",
    handle: "ceramic-plate",
    status: "ACTIVE",
    onlineStoreUrl: null,
    descriptionHtml: "<p>" + "Stoneware dinner plate. ".repeat(20) + "</p>",
    seo: { title: "Ceramic Plate", description: "x".repeat(220) },
    featuredMedia: null,
  },
  {
    id: "gid://shopify/Product/4",
    title: "Ceramic Plate",
    handle: "ceramic-plate-2",
    status: "ACTIVE",
    onlineStoreUrl: null,
    descriptionHtml: "<p>Short.</p>",
    seo: { title: "Ceramic Plate", description: null },
    featuredMedia: null,
  },
];

const body =
  lines.map((l) => JSON.stringify(l)).join("\n") +
  "\n{ this is not valid json }\n" + // must be skipped, not fatal
  "\n";

const server = createServer((_req, res) => {
  res.writeHead(200, { "Content-Type": "application/jsonl" });
  res.end(body);
});

await new Promise<void>((resolve) => server.listen(0, resolve));
const port = (server.address() as { port: number }).port;

let failures = 0;
function check(label: string, actual: unknown, expected: unknown) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures++;
  console.log(`${ok ? "✓" : "✗"} ${label}: ${JSON.stringify(actual)}${ok ? "" : ` (expected ${JSON.stringify(expected)})`}`);
}

try {
  const { products, skippedLines } = await parseBulkAudit(
    `http://127.0.0.1:${port}/results.jsonl`,
  );

  console.log("\n── Parsing ──");
  check("products parsed", products.length, 4);
  check("malformed line skipped", skippedLines, 1);
  check(
    "media attached to product 1",
    products.find((p) => p.id.endsWith("/1"))?.media.length,
    1,
  );
  check(
    "orphan media attached to its later parent",
    products.find((p) => p.id.endsWith("/2"))?.media.length,
    2,
  );
  check(
    "fileSize coerced from string to number",
    products.find((p) => p.id.endsWith("/1"))?.media[0]?.fileSize,
    180 * 1024,
  );

  console.log("\n── Scoring ──");
  const { totals, scores } = scoreCatalog(products, DEFAULT_SETTINGS, skippedLines);

  check("product count", totals.productCount, 4);
  check("images counted (video excluded)", totals.imageCount, 2);
  check("oversized images found", totals.imagesOverweight, 1);
  check("alt text missing", totals.mediaMissingAlt, 1);
  // Only product 2 has a null seo.title. Products 3 and 4 have titles — they
  // are flagged as duplicates of each other, which is a different finding.
  check("products missing seo title", totals.productsMissingSeoTitle, 1);
  check("products missing seo description", totals.productsMissingSeoDescription, 2);
  check("products with any seo issue", totals.productsWithSeoIssues, 3);
  check("thin descriptions", totals.productsThinDescription, 2);

  const duplicates = totals.findings.seo.filter((f) =>
    f.issues.includes("duplicate-title"),
  );
  check("duplicate titles detected", duplicates.length, 2);

  const finding = totals.findings.images[0];
  console.log(
    `  image finding: ${finding.reason}, ${formatBytes(finding.bytes)} → saves ~${formatBytes(finding.estimatedSavings)}`,
  );
  check(
    "savings are a strict subset of original bytes",
    finding.estimatedSavings > 0 && finding.estimatedSavings < finding.bytes,
    true,
  );

  console.log("\n── Scores ──");
  const speedScore = 0;
  const current = {
    boostScore: compositeScore({ ...scores, speedScore }),
    ...scores,
    speedScore,
  };
  const potential = potentialScores(current, false);

  console.log(
    `  images ${current.imageScore} → ${potential.imageScore} · ` +
      `seo ${current.seoScore} → ${potential.seoScore} · ` +
      `geo ${current.geoScore} → ${potential.geoScore}`,
  );
  console.log(`  overall ${current.boostScore} → ${potential.boostScore}`);

  check("every score within 0–100",
    [current.imageScore, current.seoScore, current.geoScore, current.boostScore]
      .every((n) => n >= 0 && n <= 100),
    true,
  );
  check("potential beats current", potential.boostScore > current.boostScore, true);

  // An empty catalog must score 100, not 0 — we never invent a problem.
  const empty = scoreCatalog([], DEFAULT_SETTINGS, 0);
  check("empty catalog scores 100 for images", empty.scores.imageScore, 100);
  check("empty catalog scores 100 for seo", empty.scores.seoScore, 100);

  console.log(
    failures === 0
      ? "\n✓ audit pipeline verified"
      : `\n✗ ${failures} check(s) failed`,
  );
  process.exitCode = failures === 0 ? 0 : 1;
} finally {
  server.close();
}
