import { generateJson, hasAiKey } from "../ai/openrouter.server";
import type { ShopSettings } from "../settings.server";
import {
  SEO_TITLE_MAX,
  SEO_DESC_MIN,
  SEO_DESC_TARGET_MIN,
  SEO_DESC_MAX,
} from "../audit/score.server";

/**
 * Writes search-listing copy for a product.
 *
 * Two generators, same interface:
 *
 *  - **AI** (when OPEN_ROUTER_API_KEY is set) writes copy from the product's own
 *    details in the merchant's chosen voice.
 *  - **Template** is a deterministic fallback used when there is no key, when
 *    the model declines, or when its output fails validation.
 *
 * The app must work without an AI key. Copy is the kind of feature that should
 * degrade to something plain and correct rather than fail the whole boost.
 */

export type ProductContext = {
  title: string;
  vendor: string | null;
  productType: string | null;
  tags: string[];
  description: string;
  shopName: string;
};

export type GeneratedCopy = {
  title: string;
  description: string;
  altTexts: Record<string, string>;
  source: "ai" | "template";
};

export type CopySource = "ai" | "template";

/** Re-exported so the SEO and GEO modules share one definition of "AI is on". */
export { hasAiKey };

/** Collapses HTML into the plain sentence text a search engine would index. */
export function plainText(html: string | null | undefined): string {
  return (html ?? "")
    .replace(/<br\s*\/?>/gi, " ")
    .replace(/<\/(p|div|li|h[1-6])>/gi, ". ")
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\s+/g, " ")
    .replace(/\s*\.\s*\./g, ".")
    .trim();
}

/** Trims to a length without cutting mid-word, and without a dangling comma. */
export function truncateAtWord(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  const lastSpace = cut.lastIndexOf(" ");
  const trimmed = (lastSpace > max * 0.6 ? cut.slice(0, lastSpace) : cut).trimEnd();
  return trimmed.replace(/[,;:\-–—]$/, "");
}

export function applyTitleTemplate(
  template: string,
  ctx: ProductContext,
): string {
  const filled = template
    .replace(/\{title\}/g, ctx.title)
    .replace(/\{vendor\}/g, ctx.vendor ?? "")
    .replace(/\{type\}/g, ctx.productType ?? "")
    .replace(/\{shop\}/g, ctx.shopName)
    // A template whose tokens resolved to nothing leaves stray separators.
    .replace(/\s*\|\s*\|\s*/g, " | ")
    .replace(/^\s*\|\s*|\s*\|\s*$/g, "")
    .replace(/\s+/g, " ")
    .trim();

  return truncateAtWord(filled || ctx.title, SEO_TITLE_MAX);
}

/**
 * Deterministic copy from the product's own facts.
 *
 * Deliberately plain: it states what the thing is rather than inventing
 * selling points. Unverifiable claims in a meta description are worse than a
 * dull one.
 */
export function templateCopy(
  ctx: ProductContext,
  settings: ShopSettings["seo"],
): GeneratedCopy {
  const title = applyTitleTemplate(settings.titleTemplate, ctx);

  const body = plainText(ctx.description);
  const facts: string[] = [];
  const length = () => facts.join(" ").length;

  if (body) facts.push(truncateAtWord(body, SEO_DESC_MAX));

  // Build up from real attributes until the description is long enough to fill
  // a search snippet. Each clause added below is true of every product — none
  // of them asserts anything about the item that we do not know.
  if (length() < SEO_DESC_TARGET_MIN) {
    const bits: string[] = [];
    if (ctx.productType) bits.push(ctx.productType.toLowerCase());
    if (ctx.vendor) bits.push(`by ${ctx.vendor}`);
    facts.unshift(bits.length ? `${ctx.title} — ${bits.join(" ")}.` : `${ctx.title}.`);
  }

  if (length() < SEO_DESC_TARGET_MIN && ctx.tags.length) {
    facts.push(`Also in ${ctx.tags.slice(0, 3).join(", ")}.`);
  }

  if (length() < SEO_DESC_TARGET_MIN) {
    facts.push(`Available now from ${ctx.shopName}.`);
  }

  if (length() < SEO_DESC_TARGET_MIN) {
    facts.push("See full product details, photos and current availability.");
  }

  const description = truncateAtWord(
    facts.join(" ").replace(/\s+/g, " ").trim(),
    SEO_DESC_MAX,
  );

  return { title, description, altTexts: {}, source: "template" };
}

const TONE_GUIDANCE: Record<ShopSettings["seo"]["tone"], string> = {
  professional: "Clear and factual. No exclamation marks, no hype.",
  friendly: "Warm and conversational, like a knowledgeable shopkeeper.",
  luxury: "Restrained and precise. Emphasise materials and craft, never shout.",
  playful: "Light and energetic, but still specific about what the product is.",
};

function systemPrompt(settings: ShopSettings["seo"], shopName: string): string {
  return [
    `You write search-engine listing copy for products in the online store "${shopName}".`,
    "",
    "Rules:",
    `- The title must be at most ${SEO_TITLE_MAX} characters.`,
    `- The description must be between ${SEO_DESC_TARGET_MIN} and ${SEO_DESC_MAX} characters.`,
    "- Use only facts present in the product data you are given. Never invent",
    "  materials, dimensions, origins, certifications, prices or claims.",
    "- If the product data is thin, describe what is actually there rather than",
    "  padding with adjectives.",
    "- Write alt text that describes what is visible in the image for someone",
    "  who cannot see it. No 'image of' or 'photo of' prefixes.",
    "",
    `Tone: ${TONE_GUIDANCE[settings.tone]}`,
    settings.keywordFocus
      ? `Favour these terms where they fit naturally, never forced: ${settings.keywordFocus}`
      : "",
  ]
    .filter(Boolean)
    .join("\n");
}

const COPY_SCHEMA = {
  type: "object" as const,
  properties: {
    title: { type: "string" as const, description: "Search listing title" },
    description: { type: "string" as const, description: "Meta description" },
    altTexts: {
      type: "object" as const,
      description: "Alt text keyed by the media id supplied in the request",
      additionalProperties: { type: "string" as const },
    },
  },
  // Strict structured output requires every property to be listed here, so
  // altTexts is required and comes back as {} when there is nothing to write.
  required: ["title", "description", "altTexts"],
  additionalProperties: false,
};

/**
 * Asks the model for copy, then validates it. Anything that comes back outside
 * the length bounds is repaired by truncation rather than trusted, because
 * these strings go straight onto the storefront.
 */
export async function aiCopy(
  ctx: ProductContext,
  settings: ShopSettings["seo"],
  mediaIds: string[],
): Promise<GeneratedCopy | null> {
  if (!hasAiKey()) return null;

  const parsed = await generateJson<{
    title?: string;
    description?: string;
    altTexts?: Record<string, string>;
  }>({
    system: systemPrompt(settings, ctx.shopName),
    input: {
      title: ctx.title,
      vendor: ctx.vendor,
      productType: ctx.productType,
      tags: ctx.tags.slice(0, 20),
      description: truncateAtWord(ctx.description, 2_000),
      imagesNeedingAltText: mediaIds,
    },
    schemaName: "seo_copy",
    schema: COPY_SCHEMA,
    maxTokens: 2_000,
    logPrefix: "[seo] AI copy unavailable, using template:",
  });

  if (!parsed) return null;

  const title = truncateAtWord((parsed.title ?? "").trim(), SEO_TITLE_MAX);
  const description = truncateAtWord(
    (parsed.description ?? "").trim(),
    SEO_DESC_MAX,
  );

  // Too short is not repairable by truncation; fall back rather than ship a
  // stub description.
  if (title.length < 10 || description.length < SEO_DESC_MIN) return null;

  const altTexts: Record<string, string> = {};
  for (const [id, value] of Object.entries(parsed.altTexts ?? {})) {
    if (typeof value === "string" && value.trim()) {
      altTexts[id] = truncateAtWord(value.trim(), 250);
    }
  }

  return { title, description, altTexts, source: "ai" };
}

/** Alt text from product facts, for the no-AI path. */
export function templateAltText(ctx: ProductContext, index: number): string {
  const bits = [ctx.title];
  if (ctx.vendor) bits.push(`by ${ctx.vendor}`);
  const base = bits.join(" ");
  return truncateAtWord(index === 0 ? base : `${base}, view ${index + 1}`, 250);
}

/** AI when available and valid, template otherwise. */
export async function generateCopy(
  ctx: ProductContext,
  settings: ShopSettings["seo"],
  mediaIds: string[],
): Promise<GeneratedCopy> {
  const ai = await aiCopy(ctx, settings, mediaIds);
  if (ai) return ai;
  return templateCopy(ctx, settings);
}
