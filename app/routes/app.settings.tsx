import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { Form, useActionData, useLoaderData, useNavigation } from "react-router";
import { authenticate } from "../shopify.server";
import { getSettings, saveSettings } from "../lib/settings.server";

/**
 * The knobs.
 *
 * Every control is uncontrolled and read from formData on submit. React 18's
 * synthetic events do not reliably reach custom elements' change events, so
 * binding these to state would silently drop edits — see AGENTS.md.
 */

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  return { settings: await getSettings(session.shop) };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const form = await request.formData();

  // Checkboxes are absent from formData when unchecked, so every boolean is
  // read as "is this present", never as a truthy value lookup.
  const on = (name: string) => form.get(name) !== null;
  const str = (name: string) => (form.get(name) as string | null) ?? undefined;

  const saved = await saveSettings(session.shop, {
    modules: {
      images: on("modules.images"),
      seo: on("modules.seo"),
      geo: on("modules.geo"),
      speed: on("modules.speed"),
    },
    images: {
      quality: str("images.quality"),
      format: str("images.format"),
      maxDimension: str("images.maxDimension"),
      skipUnderKb: str("images.skipUnderKb"),
      minSavingsPercent: str("images.minSavingsPercent"),
    },
    seo: {
      tone: str("seo.tone"),
      titleTemplate: str("seo.titleTemplate"),
      keywordFocus: str("seo.keywordFocus"),
      onlyFillBlanks: on("seo.onlyFillBlanks"),
      writeAltText: on("seo.writeAltText"),
    },
    geo: {
      productSchema: on("geo.productSchema"),
      generateFaq: on("geo.generateFaq"),
      reviewBeforePublish: on("geo.reviewBeforePublish"),
      entityRichDescriptions: on("geo.entityRichDescriptions"),
    },
    speed: {
      runPageSpeed: on("speed.runPageSpeed"),
      scanStorefront: on("speed.scanStorefront"),
      preconnectHints: on("speed.preconnectHints"),
    },
  });

  return { saved: true, settings: saved };
};

export default function Settings() {
  const { settings } = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const navigation = useNavigation();
  const saving = navigation.state === "submitting";

  // Re-render defaults from whatever the server last accepted, so a clamped
  // value (say quality 200 → 95) is visibly corrected rather than silently kept.
  const s = actionData?.settings ?? settings;

  return (
    <s-page heading="Settings">
      <Form method="post">
        {actionData?.saved && (
          <s-banner tone="success" dismissible>
            Settings saved. They apply to your next boost.
          </s-banner>
        )}

        <s-section heading="Modules">
          <s-stack direction="block" gap="small">
            <s-text color="subdued">
              Turn off anything you would rather handle yourself. Off modules are
              skipped entirely — they are not scored and never write to your shop.
            </s-text>
            <s-checkbox name="modules.images" defaultChecked={s.modules.images || undefined} label="Compress images" />
            <s-checkbox name="modules.seo" defaultChecked={s.modules.seo || undefined} label="Write SEO titles, descriptions and alt text" />
            <s-checkbox name="modules.geo" defaultChecked={s.modules.geo || undefined} label="Add structured data and AI-answer content" />
            <s-checkbox name="modules.speed" defaultChecked={s.modules.speed || undefined} label="Measure and improve storefront speed" />
          </s-stack>
        </s-section>

        <s-section heading="Images">
          <s-stack direction="block" gap="base">
            <s-number-field
              name="images.quality"
              label="Quality"
              details="60 is smallest, 95 is closest to the original. 82 suits most product photography."
              min={60}
              max={95}
              step={1}
              defaultValue={String(s.images.quality)}
            />
            <s-select
              name="images.format"
              label="Format"
              details="WebP is smaller than JPEG or PNG at the same quality. Shopify serves newer formats like AVIF automatically where a shopper's browser supports them."
              value={s.images.format}
            >
              <option value="webp">Convert to WebP</option>
              <option value="keep">Keep original format</option>
            </s-select>
            <s-select
              name="images.maxDimension"
              label="Maximum size"
              details="Longest edge. Images already smaller are never enlarged. Shopify's own ceiling is 4472 px."
              value={String(s.images.maxDimension)}
            >
              <option value="2048">2048 px</option>
              <option value="4096">4096 px</option>
              <option value="0">Leave dimensions alone</option>
            </s-select>
            <s-number-field
              name="images.skipUnderKb"
              label="Skip images under (KB)"
              details="Small images rarely repay the work."
              min={0}
              max={2000}
              step={10}
              defaultValue={String(s.images.skipUnderKb)}
            />
            <s-number-field
              name="images.minSavingsPercent"
              label="Minimum savings to accept (%)"
              details="If a recompressed image is not at least this much smaller, the original is kept."
              min={1}
              max={90}
              step={1}
              defaultValue={String(s.images.minSavingsPercent)}
            />
          </s-stack>
        </s-section>

        <s-section heading="SEO">
          <s-stack direction="block" gap="base">
            <s-select name="seo.tone" label="Writing tone" value={s.seo.tone}>
              <option value="professional">Professional</option>
              <option value="friendly">Friendly</option>
              <option value="luxury">Luxury</option>
              <option value="playful">Playful</option>
            </s-select>
            <s-text-field
              name="seo.titleTemplate"
              label="Title template"
              details="Available tokens: {title} {vendor} {type} {shop}"
              defaultValue={s.seo.titleTemplate}
            />
            <s-text-field
              name="seo.keywordFocus"
              label="Keyword focus"
              details="Optional. Terms to favour when they fit naturally."
              defaultValue={s.seo.keywordFocus}
            />
            <s-checkbox name="seo.onlyFillBlanks" defaultChecked={s.seo.onlyFillBlanks || undefined} label="Only fill in blanks — never replace copy you wrote" />
            <s-checkbox name="seo.writeAltText" defaultChecked={s.seo.writeAltText || undefined} label="Write alt text for images that have none" />
          </s-stack>
        </s-section>

        <s-section heading="Generative engine optimization">
          <s-stack direction="block" gap="base">
            <s-text color="subdued">
              Helps ChatGPT, Perplexity and AI Overviews describe and cite your products
              accurately.
            </s-text>
            <s-checkbox name="geo.productSchema" defaultChecked={s.geo.productSchema || undefined} label="Add Product structured data to your storefront" />
            <s-checkbox name="geo.generateFaq" defaultChecked={s.geo.generateFaq || undefined} label="Generate product FAQs" />
            <s-checkbox name="geo.reviewBeforePublish" defaultChecked={s.geo.reviewBeforePublish || undefined} label="Let me review generated FAQs before they go live" />
            <s-checkbox name="geo.entityRichDescriptions" defaultChecked={s.geo.entityRichDescriptions || undefined} label="Append a factual specification block to thin descriptions" />
          </s-stack>
        </s-section>

        <s-section heading="Speed">
          <s-stack direction="block" gap="base">
            <s-checkbox name="speed.runPageSpeed" defaultChecked={s.speed.runPageSpeed || undefined} label="Measure with PageSpeed Insights before and after" />
            <s-checkbox name="speed.scanStorefront" defaultChecked={s.speed.scanStorefront || undefined} label="Scan the storefront for known performance problems" />
            <s-checkbox name="speed.preconnectHints" defaultChecked={s.speed.preconnectHints || undefined} label="Add preconnect hints for third-party scripts" />
          </s-stack>
        </s-section>

        <s-section>
          <s-stack direction="inline" gap="small">
            <s-button type="submit" variant="primary" loading={saving}>
              Save settings
            </s-button>
            <s-link href="/app">Back to dashboard</s-link>
          </s-stack>
        </s-section>
      </Form>
    </s-page>
  );
}
