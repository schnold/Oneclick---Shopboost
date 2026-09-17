// Shares the worker's env preflight: some of these modules reach
// shopify.server, which validates its configuration at module scope.
import "./bootstrap";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import prisma from "../app/db.server";
import { getDashboardData } from "../app/lib/boost.server";
import { ScoreRing } from "../app/components/ScoreRing";
import { formatBytes } from "../app/lib/format";

/**
 * Verifies the dashboard's data layer and its one custom component.
 *
 * The route itself needs a Shopify session, so rather than fake authentication
 * this exercises everything the route does after `authenticate.admin` returns:
 * the loader's data shape, and that ScoreRing renders real markup.
 *
 *   npx tsx worker/dashboard-test.ts
 */

const SHOP = "shopboost-dev.myshopify.com";

let failures = 0;
function check(label: string, ok: boolean, detail = "") {
  if (!ok) failures++;
  console.log(`${ok ? "✓" : "✗"} ${label}${detail ? `: ${detail}` : ""}`);
}

try {
  console.log("── Loader data ──");
  const data = await getDashboardData(SHOP);

  check("audit present", data.hasAudit);
  check("current scores returned", data.current !== null);
  check("potential scores returned", data.potential !== null);
  check("totals returned", data.totals !== null);
  check(
    "speed reported as unmeasured",
    data.speedMeasured === false,
    "renders as “Not measured”, not a zero",
  );

  const { current, potential, totals } = data;
  console.log(
    `  overall ${current!.boostScore} → ${potential!.boostScore} · ` +
      `images ${current!.imageScore} → ${potential!.imageScore} · ` +
      `seo ${current!.seoScore} → ${potential!.seoScore}`,
  );
  console.log(
    `  ${totals!.imagesOverweight} images to compress, ` +
      `${formatBytes(totals!.recoverableBytes)} recoverable of ${formatBytes(totals!.imageBytes)}`,
  );

  check(
    "potential exceeds current",
    potential!.boostScore > current!.boostScore,
    `${current!.boostScore} → ${potential!.boostScore}`,
  );
  check(
    "findings back the headline numbers",
    totals!.findings.images.length === totals!.imagesOverweight &&
      totals!.findings.seo.length === totals!.productsWithSeoIssues,
    "every deduction maps to an actionable finding",
  );

  console.log("\n── Component rendering ──");

  const withPotential = renderToStaticMarkup(
    createElement(ScoreRing, {
      label: "Images",
      score: current!.imageScore,
      potential: potential!.imageScore,
    }),
  );
  check("renders an svg", withPotential.includes("<svg"));
  check("shows the current score", withPotential.includes(`>${current!.imageScore}<`));
  check("shows the gain arrow", withPotential.includes("→"));
  check(
    "labels for screen readers",
    withPotential.includes('role="img"') && withPotential.includes("aria-label"),
  );

  const unmeasured = renderToStaticMarkup(
    createElement(ScoreRing, { label: "Speed", score: null }),
  );
  check("unmeasured renders an em dash, not 0", unmeasured.includes(">—<"));
  check("unmeasured says so", unmeasured.includes("Not measured"));

  const perfect = renderToStaticMarkup(
    createElement(ScoreRing, { label: "SEO", score: 100, potential: 100 }),
  );
  check("a perfect score reads as finished", perfect.includes("Fully optimized"));

  console.log(
    failures === 0 ? "\n✓ dashboard verified" : `\n✗ ${failures} check(s) failed`,
  );
  process.exitCode = failures === 0 ? 0 : 1;
} finally {
  await prisma.$disconnect();
}
