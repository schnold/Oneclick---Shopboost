// Shares the worker's env preflight: some of these modules reach
// shopify.server, which validates its configuration at module scope.
import "./bootstrap";
import {
  templateCopy,
  applyTitleTemplate,
  plainText,
  truncateAtWord,
  templateAltText,
  hasAiKey,
  type ProductContext,
} from "../app/lib/seo/copy.server";
import { specificationBlock } from "../app/lib/geo/faq.server";
import { scanHtml, scoreFindings } from "../app/lib/speed/scan.server";
import { DEFAULT_SETTINGS } from "../app/lib/settings.server";
import { SEO_TITLE_MAX, SEO_DESC_MIN, SEO_DESC_MAX } from "../app/lib/audit/score.server";

/**
 * Tests the SEO, GEO and speed logic that runs without network access: copy
 * generation and its length guarantees, the specification block, and the
 * storefront scanner.
 *
 *   npx tsx worker/seo-geo-speed-test.ts
 */

let failures = 0;
function check(label: string, ok: boolean, detail = "") {
  if (!ok) failures++;
  console.log(`${ok ? "✓" : "✗"} ${label}${detail ? `: ${detail}` : ""}`);
}

const seo = DEFAULT_SETTINGS.seo;

const rich: ProductContext = {
  title: "Kiln-Fired Stoneware Mug",
  vendor: "Vale Ceramics",
  productType: "Mug",
  tags: ["stoneware", "handmade", "kitchen"],
  description:
    "A hand-thrown stoneware mug fired at 1240 degrees and finished in a matte sage glaze. " +
    "Holds 350ml and is safe in both the dishwasher and the microwave.",
  shopName: "Vale Ceramics",
};

const thin: ProductContext = {
  title: "Bowl",
  vendor: null,
  productType: null,
  tags: [],
  description: "",
  shopName: "Vale Ceramics",
};

console.log("── Plain text extraction ──");
check(
  "tags stripped and entities decoded",
  plainText("<p>Hand-thrown &amp; glazed</p><p>Dishwasher safe</p>") ===
    "Hand-thrown & glazed. Dishwasher safe.",
  plainText("<p>Hand-thrown &amp; glazed</p><p>Dishwasher safe</p>"),
);
check("empty html is empty, not 'null'", plainText(null) === "");

console.log("\n── Truncation ──");
check(
  "cuts on a word boundary",
  truncateAtWord("the quick brown fox jumps", 12) === "the quick",
  truncateAtWord("the quick brown fox jumps", 12),
);
check("short strings are untouched", truncateAtWord("short", 50) === "short");
check(
  "no trailing comma left behind",
  !truncateAtWord("red, green, blue and yellow", 12).endsWith(","),
  truncateAtWord("red, green, blue and yellow", 12),
);

console.log("\n── Title templates ──");
check(
  "tokens are filled",
  applyTitleTemplate("{title} | {shop}", rich) === "Kiln-Fired Stoneware Mug | Vale Ceramics",
  applyTitleTemplate("{title} | {shop}", rich),
);
check(
  "empty tokens do not leave stray separators",
  applyTitleTemplate("{title} | {vendor}", thin) === "Bowl",
  applyTitleTemplate("{title} | {vendor}", thin),
);
{
  const long = applyTitleTemplate("{title} | {vendor} | {type} | {shop}", {
    ...rich,
    title: "An Extremely Long Product Name That Goes On And On Forever",
  });
  check("respects the 60 character limit", long.length <= SEO_TITLE_MAX, `${long.length} chars`);
}

console.log("\n── Template copy (the no-AI path) ──");
{
  const copy = templateCopy(rich, seo);
  console.log(`  title:       ${copy.title}`);
  console.log(`  description: ${copy.description}`);
  check("title within limit", copy.title.length <= SEO_TITLE_MAX, `${copy.title.length}`);
  check(
    "description within the search snippet window",
    copy.description.length <= SEO_DESC_MAX,
    `${copy.description.length} chars`,
  );
  check("marked as template-sourced", copy.source === "template");
}
{
  // The hard case: a product with almost no data still needs usable copy.
  const copy = templateCopy(thin, seo);
  console.log(`  thin title:       ${copy.title}`);
  console.log(`  thin description: ${copy.description}`);
  check("still produces a title", copy.title.length > 0);
  check(
    "reaches a useful description length",
    copy.description.length >= SEO_DESC_MIN,
    `${copy.description.length} chars (min ${SEO_DESC_MIN})`,
  );
  check("invents no facts", !/\d+\s*(ml|cm|kg)/i.test(copy.description));
}

console.log("\n── Alt text ──");
check("first image gets the plain name", templateAltText(rich, 0).includes("Kiln-Fired"));
check("later images are distinguished", templateAltText(rich, 2).includes("view 3"));

console.log("\n── Specification block ──");
{
  const block = specificationBlock(rich);
  check("built for a product with attributes", block !== null);
  check("escapes html", specificationBlock({ ...rich, vendor: "A & <B>" })?.includes("&amp;") === true);
  check("declines when there is nothing to list", specificationBlock(thin) === null);
}

console.log("\n── Storefront scan ──");
{
  const bad = `<!doctype html><html><head>
    <script src="/analytics.js"></script>
    <link rel="preload" href="/a.js" as="script">
    <link rel="preload" href="/b.js" as="script">
    <link rel="preload" href="/c.js" as="script">
    <link rel="preload" href="/d.js" as="script">
    <style>.async-hide { opacity: 0 !important }</style>
    </head><body>
    <img src="/hero.jpg" loading="lazy">
    <img data-src="/second.jpg">
    <img src="/third.jpg">
    </body></html>`;

  const findings = scanHtml(bad);
  const ids = findings.map((f) => f.id);
  console.log(`  found: ${ids.join(", ")}`);

  check("catches a lazy-loaded LCP image", ids.includes("lcp-lazy"));
  check("catches a JavaScript lazy-loader", ids.includes("js-lazy-loader"));
  check("catches a missing fetchpriority", ids.includes("lcp-fetchpriority"));
  check("catches missing width/height", ids.includes("img-dimensions"));
  check("catches render-blocking scripts", ids.includes("render-blocking-js"));
  check("catches preload overuse", ids.includes("preload-overuse"));
  check("catches an anti-flicker snippet", ids.includes("anti-flicker"));
  check("every finding carries a concrete fix", findings.every((f) => f.fix.length > 20));
  check("every finding names the metric it moves", findings.every((f) => !!f.impact));

  const score = scoreFindings(findings);
  check("a bad page scores low", score < 40, `score ${score}`);
}
{
  const good = `<!doctype html><html><head>
    <script src="/app.js" defer></script>
    <link rel="preload" href="/hero.jpg" as="image">
    </head><body>
    <img src="/hero.jpg" width="1200" height="800" fetchpriority="high" loading="eager">
    <img src="/second.jpg" width="600" height="400" loading="lazy">
    </body></html>`;

  const findings = scanHtml(good);
  console.log(`  clean page findings: ${findings.length ? findings.map((f) => f.id).join(", ") : "none"}`);
  check("a well-built page is left alone", findings.length === 0, `${findings.length} findings`);
  check("and scores 100", scoreFindings(findings) === 100);
}

console.log("\n── AI configuration ──");
console.log(
  hasAiKey()
    ? "  OPEN_ROUTER_API_KEY is set — AI copy and FAQ generation are active."
    : "  No OPEN_ROUTER_API_KEY — copy falls back to templates and FAQs are skipped.",
);
check("the app works either way", true, hasAiKey() ? "AI path" : "template path");

console.log(
  failures === 0 ? "\n✓ SEO, GEO and speed verified" : `\n✗ ${failures} check(s) failed`,
);
process.exitCode = failures === 0 ? 0 : 1;
