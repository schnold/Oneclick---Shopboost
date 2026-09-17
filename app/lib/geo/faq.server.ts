import Anthropic from "@anthropic-ai/sdk";
import { hasAiKey, truncateAtWord, type ProductContext } from "../seo/copy.server";

/**
 * Generative engine optimization content.
 *
 * The goal is to give answer engines something accurate to quote. That makes
 * fabrication the main risk, not blandness: a confidently invented material or
 * dimension is worse than no FAQ at all, because it becomes the answer a
 * shopper is given. Everything here is constrained to facts already present in
 * the product, and there is no template fallback for FAQs — without an AI key
 * the module writes nothing rather than inventing questions.
 */

export type FaqEntry = { question: string; answer: string };

const MAX_ENTRIES = 5;
const MAX_QUESTION = 160;
const MAX_ANSWER = 600;

const FAQ_SCHEMA = {
  type: "object" as const,
  properties: {
    entries: {
      type: "array" as const,
      items: {
        type: "object" as const,
        properties: {
          question: { type: "string" as const },
          answer: { type: "string" as const },
        },
        required: ["question", "answer"],
        additionalProperties: false,
      },
    },
  },
  required: ["entries"],
  additionalProperties: false,
};

const SYSTEM = [
  "You write FAQ entries for e-commerce product pages. They are published as",
  "schema.org FAQPage structured data, so search engines and AI assistants will",
  "quote them directly as fact.",
  "",
  "Hard rules:",
  "- Use ONLY information present in the product data provided.",
  "- Never invent materials, dimensions, weights, origin, care instructions,",
  "  certifications, compatibility, shipping times, prices or return policies.",
  "- If the product data does not support a useful question, return fewer",
  "  entries. Returning an empty list is correct and expected for thin data.",
  "- Questions must be ones a real shopper would type. Answers must be",
  "  self-contained and specific.",
  "- Never mention the store's policies unless they appear in the data.",
  "",
  `Return at most ${MAX_ENTRIES} entries.`,
].join("\n");

/**
 * Drops anything that reads as fabricated. A model instructed not to invent
 * still can, so this is a second gate rather than a formality.
 */
function isGrounded(entry: FaqEntry, sourceText: string): boolean {
  const answer = entry.answer.toLowerCase();

  // Claims that carry a number the source never mentions are the most common
  // and most damaging fabrication.
  const numbers = answer.match(/\b\d+(?:\.\d+)?\s*(?:cm|mm|in|inch|inches|kg|g|lb|lbs|oz|ml|l|"|')\b/g);
  if (numbers) {
    const source = sourceText.toLowerCase();
    for (const measurement of numbers) {
      const value = measurement.match(/\d+(?:\.\d+)?/)?.[0];
      if (value && !source.includes(value)) return false;
    }
  }

  // Policy and logistics promises we have no way to verify.
  const unverifiable = [
    "free shipping",
    "money-back",
    "money back guarantee",
    "lifetime warranty",
    "ships within",
    "delivered within",
    "30-day",
    "return it within",
    "certified organic",
    "fda approved",
  ];
  if (unverifiable.some((phrase) => answer.includes(phrase) && !sourceText.toLowerCase().includes(phrase))) {
    return false;
  }

  return true;
}

export async function generateFaq(
  ctx: ProductContext,
): Promise<{ entries: FaqEntry[]; rejected: number } | null> {
  if (!hasAiKey()) return null;

  // Nothing to ground answers in — better to write nothing than to guess.
  const source = [ctx.title, ctx.productType, ctx.vendor, ctx.tags.join(" "), ctx.description]
    .filter(Boolean)
    .join(" ");
  if (ctx.description.trim().length < 40) {
    return { entries: [], rejected: 0 };
  }

  const anthropic = new Anthropic();

  try {
    const response = await anthropic.messages.create({
      model: "claude-opus-5",
      max_tokens: 4_000,
      system: SYSTEM,
      output_config: { format: { type: "json_schema", schema: FAQ_SCHEMA } },
      messages: [
        {
          role: "user",
          content: JSON.stringify({
            title: ctx.title,
            vendor: ctx.vendor,
            productType: ctx.productType,
            tags: ctx.tags.slice(0, 20),
            description: truncateAtWord(ctx.description, 4_000),
          }),
        },
      ],
    });

    if (response.stop_reason === "refusal") return null;

    const block = response.content.find((c) => c.type === "text");
    if (!block || block.type !== "text") return null;

    const parsed = JSON.parse(block.text) as { entries?: FaqEntry[] };
    const raw = Array.isArray(parsed.entries) ? parsed.entries : [];

    const entries: FaqEntry[] = [];
    let rejected = 0;

    for (const entry of raw.slice(0, MAX_ENTRIES)) {
      const question = truncateAtWord(String(entry.question ?? "").trim(), MAX_QUESTION);
      const answer = truncateAtWord(String(entry.answer ?? "").trim(), MAX_ANSWER);
      if (question.length < 8 || answer.length < 20) {
        rejected++;
        continue;
      }
      if (!isGrounded({ question, answer }, source)) {
        rejected++;
        continue;
      }
      entries.push({ question, answer });
    }

    return { entries, rejected };
  } catch (error) {
    console.warn(`[geo] FAQ generation unavailable: ${(error as Error).message}`);
    return null;
  }
}

/**
 * A short, factual specification block appended to a thin description.
 * Built from attributes the product already has — no model involved, so there
 * is nothing to fabricate.
 */
export function specificationBlock(ctx: ProductContext): string | null {
  const rows: Array<[string, string]> = [];
  if (ctx.productType) rows.push(["Type", ctx.productType]);
  if (ctx.vendor) rows.push(["Brand", ctx.vendor]);
  if (ctx.tags.length) rows.push(["Categories", ctx.tags.slice(0, 6).join(", ")]);

  if (rows.length < 2) return null;

  const items = rows
    .map(([label, value]) => `<li><strong>${escapeHtml(label)}:</strong> ${escapeHtml(value)}</li>`)
    .join("");

  return `<div class="shopboost-specs"><h3>Specifications</h3><ul>${items}</ul></div>`;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
