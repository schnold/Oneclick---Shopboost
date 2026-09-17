import { Prisma } from "@prisma/client";
import prisma from "../db.server";

/**
 * The dashboard knobs. This shape is the contract between the settings UI, the
 * `Shop.settings` JSON column, and every job payload — change it here and
 * `normalizeSettings` keeps existing shops working.
 */
export type ShopSettings = {
  modules: {
    images: boolean;
    seo: boolean;
    geo: boolean;
    speed: boolean;
  };
  images: {
    /** Encoder quality. Below ~60 artifacts become visible on product photos. */
    quality: number;
    /**
     * Shopify accepts PNG, GIF, JPEG, WEBP and HEIC only — AVIF uploads are
     * rejected. Uploading WebP is the right call regardless: Shopify's CDN
     * already negotiates AVIF delivery to clients that support it.
     */
    format: "webp" | "keep";
    /** Longest edge in px; images already smaller are never upscaled. */
    maxDimension: 2048 | 4096 | 0;
    /** Don't touch images under this size — the win isn't worth an API call. */
    skipUnderKb: number;
    /** Reject a recompression that saves less than this share of the bytes. */
    minSavingsPercent: number;
  };
  seo: {
    tone: "professional" | "friendly" | "luxury" | "playful";
    /** Tokens: {title} {vendor} {type} {shop} */
    titleTemplate: string;
    /** When true, never overwrite copy the merchant already wrote. */
    onlyFillBlanks: boolean;
    writeAltText: boolean;
    keywordFocus: string;
  };
  geo: {
    productSchema: boolean;
    generateFaq: boolean;
    /** Hold generated FAQs for merchant approval instead of publishing. */
    reviewBeforePublish: boolean;
    entityRichDescriptions: boolean;
  };
  speed: {
    runPageSpeed: boolean;
    scanStorefront: boolean;
    /** Emit preconnect hints for detected third-party origins. */
    preconnectHints: boolean;
  };
};

export const DEFAULT_SETTINGS: ShopSettings = {
  modules: { images: true, seo: true, geo: true, speed: true },
  images: {
    quality: 82,
    format: "webp",
    maxDimension: 2048,
    skipUnderKb: 50,
    minSavingsPercent: 10,
  },
  seo: {
    tone: "professional",
    titleTemplate: "{title} | {shop}",
    // Defaults are deliberately conservative: a merchant's own copy is never
    // overwritten until they opt in.
    onlyFillBlanks: true,
    writeAltText: true,
    keywordFocus: "",
  },
  geo: {
    productSchema: true,
    generateFaq: true,
    reviewBeforePublish: true,
    entityRichDescriptions: false,
  },
  speed: { runPageSpeed: true, scanStorefront: true, preconnectHints: true },
};

const clamp = (n: number, lo: number, hi: number) =>
  Math.min(hi, Math.max(lo, Math.round(n)));

/** Returns `value` only if it is one of `allowed`, else the fallback. */
const pick = <T extends string | number>(
  value: unknown,
  allowed: readonly T[],
  fallback: T,
): T => (allowed.includes(value as T) ? (value as T) : fallback);

/**
 * Settings as they arrive: from a form (all strings), from the JSON column, or
 * from a job payload. Every leaf is `unknown` because none of it is trusted —
 * `normalizeSettings` coerces and clamps each field.
 */
type SettingsInput = {
  modules?: Record<string, unknown>;
  images?: Record<string, unknown>;
  seo?: Record<string, unknown>;
  geo?: Record<string, unknown>;
  speed?: Record<string, unknown>;
};

/**
 * Merges stored settings over the defaults and clamps everything into range.
 * Values arriving from a form are strings, so each field is coerced here rather
 * than trusted.
 */
export function normalizeSettings(raw: unknown): ShopSettings {
  const input = (raw ?? {}) as SettingsInput;
  const d = DEFAULT_SETTINGS;
  const bool = (v: unknown, fallback: boolean) =>
    typeof v === "boolean" ? v : v === "true" ? true : v === "false" ? false : fallback;

  return {
    modules: {
      images: bool(input.modules?.images, d.modules.images),
      seo: bool(input.modules?.seo, d.modules.seo),
      geo: bool(input.modules?.geo, d.modules.geo),
      speed: bool(input.modules?.speed, d.modules.speed),
    },
    images: {
      quality: clamp(Number(input.images?.quality ?? d.images.quality), 60, 95),
      // A stored "avif" from an older version falls back to the default here.
      format: pick(input.images?.format, ["webp", "keep"] as const, d.images.format),
      // 0 means "leave dimensions alone"; a form sends these as strings.
      maxDimension: pick(
        Number(input.images?.maxDimension),
        [2048, 4096, 0] as const,
        d.images.maxDimension,
      ),
      skipUnderKb: clamp(Number(input.images?.skipUnderKb ?? d.images.skipUnderKb), 0, 2_000),
      minSavingsPercent: clamp(
        Number(input.images?.minSavingsPercent ?? d.images.minSavingsPercent),
        1,
        90,
      ),
    },
    seo: {
      tone: pick(
        input.seo?.tone,
        ["professional", "friendly", "luxury", "playful"] as const,
        d.seo.tone,
      ),
      titleTemplate:
        typeof input.seo?.titleTemplate === "string" && input.seo.titleTemplate.trim()
          ? input.seo.titleTemplate.slice(0, 120)
          : d.seo.titleTemplate,
      onlyFillBlanks: bool(input.seo?.onlyFillBlanks, d.seo.onlyFillBlanks),
      writeAltText: bool(input.seo?.writeAltText, d.seo.writeAltText),
      keywordFocus:
        typeof input.seo?.keywordFocus === "string"
          ? input.seo.keywordFocus.slice(0, 200)
          : d.seo.keywordFocus,
    },
    geo: {
      productSchema: bool(input.geo?.productSchema, d.geo.productSchema),
      generateFaq: bool(input.geo?.generateFaq, d.geo.generateFaq),
      reviewBeforePublish: bool(input.geo?.reviewBeforePublish, d.geo.reviewBeforePublish),
      entityRichDescriptions: bool(
        input.geo?.entityRichDescriptions,
        d.geo.entityRichDescriptions,
      ),
    },
    speed: {
      runPageSpeed: bool(input.speed?.runPageSpeed, d.speed.runPageSpeed),
      scanStorefront: bool(input.speed?.scanStorefront, d.speed.scanStorefront),
      preconnectHints: bool(input.speed?.preconnectHints, d.speed.preconnectHints),
    },
  };
}

/** Stable hash of the knobs — part of every job id, so changed settings
 *  produce new jobs while unchanged settings dedupe away. */
export function settingsHash(settings: ShopSettings): string {
  const json = JSON.stringify(settings);
  let h = 5381;
  for (let i = 0; i < json.length; i++) h = ((h << 5) + h + json.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

export async function getShop(domain: string) {
  return prisma.shop.upsert({
    where: { domain },
    create: { domain, settings: DEFAULT_SETTINGS as unknown as Prisma.InputJsonValue },
    update: {},
  });
}

export async function getSettings(domain: string): Promise<ShopSettings> {
  const shop = await getShop(domain);
  return normalizeSettings(shop.settings);
}

export async function saveSettings(
  domain: string,
  patch: unknown,
): Promise<ShopSettings> {
  const settings = normalizeSettings(patch);
  await prisma.shop.upsert({
    where: { domain },
    create: { domain, settings: settings as unknown as Prisma.InputJsonValue },
    update: { settings: settings as unknown as Prisma.InputJsonValue },
  });
  return settings;
}
