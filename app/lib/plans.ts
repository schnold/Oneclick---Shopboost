/**
 * The plan catalogue.
 *
 * Plain data, deliberately not a `.server` module: the billing page renders
 * these in the browser, and React Router refuses to bundle server modules into
 * the client. Anything that talks to Shopify lives in `billing.server.ts`.
 */

export const PLANS = {
  free: {
    id: "free",
    name: "Free",
    price: 0,
    monthlyImageLimit: 0,
    description: "Scan your shop and see exactly what could be improved.",
    features: [
      "Full catalog scan",
      "Optimization potential across images, SEO, GEO and speed",
      "Storefront performance report",
    ],
  },
  growth: {
    id: "growth",
    name: "Growth",
    price: 19,
    monthlyImageLimit: 500,
    description: "Optimize a working catalog, with everything reversible.",
    features: [
      "Everything in Free",
      "Image compression, up to 500 images a month",
      "SEO titles, descriptions and alt text",
      "Structured data and product FAQs",
      "One-click undo for any change",
    ],
  },
  pro: {
    id: "pro",
    name: "Pro",
    price: 49,
    monthlyImageLimit: Number.POSITIVE_INFINITY,
    description: "For large catalogs that change often.",
    features: [
      "Everything in Growth",
      "Unlimited images",
      "Automatic re-optimization when products change",
      "Priority processing",
    ],
  },
} as const;

export type PlanId = keyof typeof PLANS;

export const TRIAL_DAYS = 7;
