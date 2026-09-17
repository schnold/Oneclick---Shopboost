# Shopboost — Development Plan

> **Status: built.** Every phase below is implemented, deployed to Shopify, and
> covered by 125 automated checks. `README.md` describes how to run it and
> `AGENTS.md` records the API findings and constraints that shaped the code —
> several of which contradict what this plan originally assumed. Where they
> differ, AGENTS.md is correct; the notes below mark what changed.

One-press shop optimization for Shopify: images, SEO, generative-engine optimization (GEO), and speed — with a dashboard of simple knobs, a clean job queue, and a before/after view of optimization potential vs. done work.

Every GraphQL operation in this plan has been **validated against the live Shopify Admin schema** (via the Shopify MCP) — field names, argument shapes, and required scopes are confirmed, including two deprecations this plan avoids (`productCreateMedia`, `productDeleteMedia`).

---

## 1. Product shape

**One screen, one button.** The merchant lands on a dashboard showing their shop's *Boost Score* and per-category optimization potential (computed by a background audit). They tweak a few knobs (compression quality, SEO tone, which modules run), press **Boost Shop**, and watch a queue drain while before/after numbers fill in. Every change is recorded and reversible.

Modules (each independently toggleable):

1. **Images** — recompress and modernize product/collection images (WebP/AVIF, max dimensions), in place, with rollback.
2. **SEO** — meta titles/descriptions for products, collections and pages; image alt text; noindex hygiene.
3. **GEO** — structured data (JSON-LD Product/Organization/FAQ) injected via a theme app extension app embed, plus AI-answer-friendly content (FAQ metafields, entity-rich descriptions) so ChatGPT/Perplexity/Google AI Overviews cite the shop.
4. **Speed** — storefront scan against Shopify's official theme performance best practices (lazy-loaded LCP image, missing `fetchpriority`, render-blocking scripts, missing width/height), fixes where an app legally can (app embed hints), and clear guided fixes where only the theme can change; PageSpeed Insights before/after.
5. **Extras (recommended)** — broken-URL redirect manager (`urlRedirectCreate`), sitemap hygiene (`seo.hidden` metafield), alt-text coverage reporting.

---

## 2. Stack & architecture

| Layer | Choice | Why |
|---|---|---|
| App framework | Shopify CLI app template (**React Router**, the successor to the Remix template) | Official, embedded App Bridge auth, Polaris wired in. Shopify's docs now say `@shopify/shopify-app-react-router` "is the recommended path forward". |
| UI | **Polaris** (ships with the template) | Native admin look; user requirement. |
| DB | **Postgres + Prisma** | Sessions (template default), settings, audits, jobs, before/after records. |
| Queue | **BullMQ + Redis** | Clean queue with retries/backoff/concurrency; user requirement. |
| Image processing | **sharp** | WebP/AVIF/mozjpeg, streaming, no third-party API key needed. |
| AI copy | **Anthropic SDK** (`@anthropic-ai/sdk`) | Meta titles/descriptions, alt text, FAQ/GEO content. |
| Speed measurement | **Google PageSpeed Insights API** | Objective before/after Lighthouse + CrUX numbers. |
| Storefront injection | **Theme app extension** (app embed block) | The only App-Store-compliant way to add JSON-LD/hints; no theme-code edits. |
| Hosting | Docker (web + worker) on Railway/Fly/Render — or Vercel for web with the worker split out | BullMQ worker needs a long-lived process. |

### Scaffold (from shopify.dev)

```bash
# Creates the app with the React Router template, Prisma sessions, Polaris:
npm init @shopify/app@latest -- --name shopboost
cd shopboost
npm run dev            # shopify app dev — tunnels, installs on dev store

# Later, generate the storefront extension:
npm run shopify -- app generate extension --type theme_app_extension --name shopboost-storefront
```

### `shopify.app.toml` (key parts)

```toml
name = "shopboost"
embedded = true

[access_scopes]
scopes = "read_products,write_products,read_files,write_files,read_themes,write_themes,read_online_store_pages"

[webhooks]
api_version = "2025-10"

  [[webhooks.subscriptions]]
  topics = ["app/uninstalled"]
  uri = "/webhooks/app/uninstalled"

  [[webhooks.subscriptions]]
  topics = ["app/scopes_update"]
  uri = "/webhooks/app/scopes_update"

  # Keep audits fresh: re-audit a product when the merchant edits it
  [[webhooks.subscriptions]]
  topics = ["products/update"]
  uri = "/webhooks/products/update"

  # Fired when our bulk audit export finishes
  [[webhooks.subscriptions]]
  topics = ["bulk_operations/finish"]
  uri = "/webhooks/bulk-operations/finish"

  # Mandatory compliance topics (public apps)
  [[webhooks.subscriptions]]
  uri = "/webhooks/customers/data_request"
  compliance_topics = ["customers/data_request"]
  [[webhooks.subscriptions]]
  uri = "/webhooks/customers/redact"
  compliance_topics = ["customers/redact"]
  [[webhooks.subscriptions]]
  uri = "/webhooks/shop/redact"
  compliance_topics = ["shop/redact"]
```

Scope notes (from schema validation): `productUpdate` needs `write_products`; `fileUpdate` (alt text + in-place image replacement) needs `write_files` (+ `write_themes` for theme-sourced files); the audit read paths need `read_products`/`read_files`.

### Backend bootstrap (from shopify.dev, React Router package)

```ts
// app/shopify.server.ts
import "@shopify/shopify-app-react-router/adapters/node";
import { ApiVersion, shopifyApp } from "@shopify/shopify-app-react-router/server";
import { PrismaSessionStorage } from "@shopify/shopify-app-session-storage-prisma";
import prisma from "./db.server";

const shopify = shopifyApp({
  apiKey: process.env.SHOPIFY_API_KEY!,
  apiSecretKey: process.env.SHOPIFY_API_SECRET!,
  appUrl: process.env.SHOPIFY_APP_URL!,
  scopes: process.env.SCOPES!.split(","),
  apiVersion: ApiVersion.October25,
  sessionStorage: new PrismaSessionStorage(prisma),
  hooks: {
    afterAuth: async ({ session }) => {
      shopify.registerWebhooks({ session });      // shop-specific fallbacks
      await enqueueAudit(session.shop);           // first audit on install
    },
  },
});
export default shopify;
export const authenticate = shopify.authenticate;
```

---

## 3. Data model (Prisma)

```prisma
model Shop {
  id          String   @id            // my-store.myshopify.com
  settings    Json                     // the knobs, see §7
  installedAt DateTime @default(now())
  audits      AuditSnapshot[]
  jobs        OptimizationJob[]
}

model AuditSnapshot {
  id          String   @id @default(cuid())
  shopId      String
  shop        Shop     @relation(fields: [shopId], references: [id])
  createdAt   DateTime @default(now())
  kind        String   // "before" | "after" | "scheduled"
  boostScore  Int      // 0–100 composite
  imageScore  Int
  seoScore    Int
  geoScore    Int
  speedScore  Int      // from PSI
  totals      Json     // { imageBytes, imagesOverweight, productsMissingMeta, mediaMissingAlt, psi: {...} }
}

model OptimizationJob {
  id         String   @id @default(cuid())   // mirrors BullMQ job id
  shopId     String
  module     String   // "images" | "seo" | "geo" | "speed" | "redirects"
  status     String   // queued | running | done | failed | rolled_back
  createdAt  DateTime @default(now())
  finishedAt DateTime?
  items      OptimizationItem[]
}

model OptimizationItem {
  id         String  @id @default(cuid())
  jobId      String
  job        OptimizationJob @relation(fields: [jobId], references: [id])
  resourceId String  // gid://shopify/MediaImage/… or Product/…
  field      String  // "image" | "seo.title" | "seo.description" | "alt" | …
  before     Json    // e.g. { url, bytes, width } or { title: "old" }
  after      Json
  status     String  // done | skipped | failed | rolled_back
  savedBytes Int?
}
```

`OptimizationItem.before` is the **rollback source and the before/after UI source** — one table powers both.

---

## 4. Audit engine (computes "optimization potential")

Full-catalog export via a **bulk operation** (no pagination, no rate-limit pressure). Validated:

```graphql
mutation ShopboostBulkAudit {
  bulkOperationRunQuery(
    query: """
    {
      products {
        edges {
          node {
            id
            title
            handle
            description
            seo { title description }
            media {
              edges {
                node {
                  id
                  alt
                  ... on MediaImage {
                    image { url width height }
                    originalSource { fileSize }
                  }
                }
              }
            }
          }
        }
      }
    }
    """
  ) {
    bulkOperation { id status }
    userErrors { field message }
  }
}
```

Flow: enqueue `audit` job → run mutation → Shopify pushes `bulk_operations/finish` webhook (subscribed in the toml above; also poll `bulkOperation(id:)` as a fallback since webhook delivery isn't guaranteed — per docs) → download the JSONL from the operation's `url` → stream-parse → score.

Scoring heuristics per category (each 0–100, weighted into the Boost Score):

- **Images**: `fileSize` vs. a bytes-per-megapixel budget; dimension > max knob; legacy format detectable from URL extension. Potential = projected savings at current quality knob.
- **SEO**: `seo.title`/`seo.description` null or out of length bounds (title ≤ 60 chars, description 110–160); media `alt` null/empty; duplicate titles.
- **GEO**: app embed not yet enabled; products missing FAQ metafields; descriptions under an information-density threshold.
- **Speed**: PSI score for home/product/collection URLs + storefront HTML scan findings (see §5D).

For interactive per-product views, the same fields come from a validated paginated query (`products(first: 50, after: $cursor) { … }`).

---

## 5. Optimization modules

### 5A. Image compression — in-place replacement with rollback

**Key schema finding:** `fileUpdate` accepts `originalSource` on an existing `MediaImage`, replacing the image **in place** — same media ID, product/variant references intact, no delete/re-create, no reorder. (The old `productCreateMedia`/`productDeleteMedia` pair is deprecated; validation confirms: *"use productUpdate/productSet"* and *"use fileUpdate"*.)

Pipeline per image (BullMQ `images` queue):

1. Download original from `originalSource.url` (the untransformed upload, not the CDN rendition).
2. `sharp` → resize to max-dimension knob → encode WebP/AVIF/mozjpeg at quality knob.
3. **Skip if savings < 10%** (don't churn already-optimized shops).
4. Stage the compressed file (validated):

```graphql
mutation ShopboostStagedUploads($input: [StagedUploadInput!]!) {
  stagedUploadsCreate(input: $input) {
    stagedTargets { url resourceUrl parameters { name value } }
    userErrors { field message }
  }
}
```

```ts
// variables
{ input: [{ resource: IMAGE, filename: "hero.webp", mimeType: "image/webp",
            fileSize: String(buf.length), httpMethod: POST }] }
// then POST the bytes to target.url as multipart/form-data with target.parameters
```

5. Replace in place (validated; `alt` set in the same call when the SEO module generated one):

```graphql
mutation ShopboostReplaceImage($files: [FileUpdateInput!]!) {
  fileUpdate(files: $files) {
    files { id fileStatus alt }
    userErrors { field message code }
  }
}
```

```ts
{ files: [{ id: "gid://shopify/MediaImage/…", originalSource: stagedTarget.resourceUrl,
            alt: "Hand-thrown ceramic mug, matte sage" }] }
```

6. Record `OptimizationItem` with `before: { url: originalSource.url, bytes }` → **rollback = same `fileUpdate` with the stored original URL.** Poll `fileStatus` until `READY` before marking done.

Knobs: quality (60–90), format (WebP / AVIF / keep), max dimension (2048/4096/original), "skip images under N KB".

### 5B. SEO

**Products** — native SEO fields (validated; note current API uses `product: ProductUpdateInput`, not the legacy `input:`):

```graphql
mutation ShopboostUpdateSeo($product: ProductUpdateInput!) {
  productUpdate(product: $product) {
    product { id seo { title description } }
    userErrors { field message }
  }
}
```

```ts
{ product: { id, seo: { title: "Ceramic Mugs | Handmade in Portland — Kiln & Co.",
                        description: "Hand-thrown ceramic mugs…" } } }
```

**Collections, pages, blogs** — per Shopify's *Optimize storefront SEO* guide, their search-engine listing lives in `global` namespace metafields `title_tag` / `description_tag` (`single_line_text_field`). Validated:

```graphql
mutation ShopboostSetMetafields($metafields: [MetafieldsSetInput!]!) {
  metafieldsSet(metafields: $metafields) {
    metafields { id namespace key value }
    userErrors { field message }
  }
}
```

**Alt text** — `fileUpdate` with `alt` only (validated §5A). **Hide from search engines** (thin/duplicate pages): metafield `namespace: "seo", key: "hidden", value: "1", type: "number_integer"` — documented behavior adds noindex/nofollow and removes from sitemap.

**AI copy generation** (server-side, current Anthropic SDK shape — server-side fallbacks enabled by default so a rare refusal degrades gracefully; drop `betas`/`fallbacks` if you don't want it):

```ts
import Anthropic from "@anthropic-ai/sdk";
const anthropic = new Anthropic(); // ANTHROPIC_API_KEY

const res = await anthropic.beta.messages.create({
  model: "claude-opus-5",
  max_tokens: 1024,
  betas: ["server-side-fallback-2026-07-01"],
  fallbacks: "default",
  system: SEO_SYSTEM_PROMPT, // brand voice knob + hard length rules (title ≤60, desc 110–160)
  messages: [{ role: "user", content: JSON.stringify({ title, description, vendor, productType, tags }) }],
});
if (res.stop_reason === "refusal") return skip(item);
```

Knobs: tone (professional / friendly / luxury / playful), keyword focus (auto from title+type or merchant-supplied), title template (`{title} | {shop}` etc.), "only fill blanks" vs. "rewrite weak" (**default: only fill blanks** — never overwrite merchant copy silently).

### 5C. GEO (generative engine optimization)

Goal: make the shop legible and citable to AI answer engines.

1. **Structured data via theme app extension app embed** (target `head`; per docs app embeds are rendered before `</head>`, work on all OS 2.0 + vintage themes, and require the merchant to activate them — the app deep-links into the theme editor with the embed pre-activated, the documented pattern):

```liquid
{%- comment -%} blocks/shopboost-geo.liquid {%- endcomment -%}
{%- if template contains 'product' and product -%}
<script type="application/ld+json">
{
  "@context": "https://schema.org",
  "@type": "Product",
  "name": {{ product.title | json }},
  "description": {{ product.description | strip_html | truncate: 500 | json }},
  "image": {{ product.featured_image | image_url: width: 1200 | prepend: "https:" | json }},
  "brand": { "@type": "Brand", "name": {{ product.vendor | json }} },
  "offers": {
    "@type": "Offer",
    "price": {{ product.price | divided_by: 100.0 | json }},
    "priceCurrency": {{ cart.currency.iso_code | json }},
    "availability": "https://schema.org/{% if product.available %}InStock{% else %}OutOfStock{% endif %}",
    "url": {{ request.origin | append: product.url | json }}
  }
}
</script>
{%- assign faq = product.metafields.shopboost.faq.value -%}
{%- if faq -%}
<script type="application/ld+json">
{ "@context": "https://schema.org", "@type": "FAQPage", "mainEntity": [
  {%- for qa in faq -%}
  { "@type": "Question", "name": {{ qa.question | json }},
    "acceptedAnswer": { "@type": "Answer", "text": {{ qa.answer | json }} } }{% unless forloop.last %},{% endunless %}
  {%- endfor -%}
] }
</script>
{%- endif -%}
{%- endif -%}
{% schema %}
{ "name": "Shopboost GEO", "target": "head", "settings": [] }
{% endschema %}
```

Deep link to activate: `https://{shop}/admin/themes/current/editor?context=apps&activateAppId={extension-uuid}/shopboost-geo`.

2. **FAQ generation**: Claude drafts 3–5 Q&As per product from title/description/type → stored in a `shopboost.faq` JSON metafield (definition created on install via `metafieldDefinitionCreate`) → rendered as FAQ JSON-LD above. Merchant can review before publish (knob: auto-publish vs. review queue).
3. **Entity-rich descriptions** (opt-in knob, off by default): append a concise, factual spec block (materials, dimensions, use cases) — the content AI engines extract and quote.

### 5D. Speed

An app must not edit theme code, so this module is **measure → fix what an app can → guide the rest**, built on Shopify's official theme performance best-practices doc:

1. **Measure**: PSI API for home / a product / a collection URL, mobile + desktop, stored in `AuditSnapshot.totals.psi`. Re-run after each boost → the before/after speed panel.
2. **Scan**: fetch storefront HTML (public pages) and flag the documented high-impact anti-patterns: LCP image with `loading="lazy"` or `data-src` (lazysizes), missing `fetchpriority="high"` on the LCP image, images without `width`/`height`, render-blocking scripts without `defer`, > 2 `preload` hints, anti-flicker A/B snippets.
3. **Fix via app embed** (safe, reversible): `preconnect` for detected third-party origins; optional `IntersectionObserver` lazy-loader for *below-the-fold* app-injected content only. The app embed stays dependency-free and < 2 KB — the optimizer must not be a slowdown.
4. **Guide**: each remaining finding renders as a Polaris card — what, why (metric impact from the docs), the exact one-line change, deep link to the theme editor.

### 5E. Extras

- **Redirect manager**: crawl for 404s from old handles → `urlRedirectCreate`.
- **Sitemap hygiene**: flag thin/duplicate/hidden-worthy pages → `seo.hidden` metafield (§5B).
- **Coverage reports**: alt-text %, meta %, structured-data % — the numbers that feed the score rings.

---

## 6. Queue design (BullMQ)

```ts
// worker/queues.ts
import { Queue, Worker, QueueEvents } from "bullmq";
const connection = { url: process.env.REDIS_URL! };

export const queues = {
  audit:  new Queue("audit",  { connection }),
  images: new Queue("images", { connection }),
  seo:    new Queue("seo",    { connection }),
  geo:    new Queue("geo",    { connection }),
  speed:  new Queue("speed",  { connection }),
};

// The Boost button = one orchestrator job that fans out per enabled module,
// then a finalizer that runs the "after" audit.
new Worker("images", processImageJob, {
  connection,
  concurrency: 4,
  limiter: { max: 2, duration: 1000 },   // stay under Admin API cost limits
});
```

Rules:

- **Rate-limit aware**: every GraphQL call reads `extensions.cost.throttleStatus`; below 100 points available → delayed re-enqueue (BullMQ `moveToDelayed`), plus exponential backoff (5 attempts) on `THROTTLED` errors.
- **Idempotent**: job ID = `{shop}:{module}:{resourceId}:{settingsHash}` — re-pressing Boost never duplicates work; unchanged settings + unchanged resource = skip.
- **Chunked**: one BullMQ job per resource (not per shop) so progress is granular, retries are cheap, and one bad image can't fail a batch.
- **Observable**: workers write `OptimizationJob`/`OptimizationItem` rows; the Queue page polls a loader every 2s (React Router `useRevalidator`) — no websockets needed inside the Admin iframe.
- **Failure isolation**: after 5 attempts → `failed` with the captured `userErrors`, surfaced in the queue UI with a retry action; job data never stores tokens (workers load offline sessions from Prisma session storage by shop domain).

---

## 7. Dashboard UI (Polaris)

Routes: `app._index` (Dashboard) · `app.queue` · `app.settings` · `app.history` · `app.billing`.

**Dashboard** — the whole product on one page:

- **Boost Score hero**: composite ring + four category rings (Images / SEO / GEO / Speed), each showing *current → potential* (e.g. `62 → 91`).
- **Before/after panel**: after any boost, per-category `before → after` deltas, MB saved (progress bar of image payload), metas written, alt texts added, PSI mobile before → after. Backed entirely by the two `AuditSnapshot`s + `OptimizationItem` aggregates.
- **Knobs** (Polaris `Card` + `RangeSlider`/`Select`/`ChoiceList`, saved to `Shop.settings`): image quality slider, format select, max-dimension select; SEO tone select, title template, only-fill-blanks toggle; GEO auto-FAQ toggle + review-first toggle; per-module on/off.
- **The button**: full-width primary `Button` → `POST /app/boost` → orchestrator job → App Bridge toast → auto-navigates to Queue.

```tsx
// app/routes/app._index.tsx (shape)
export const loader = async ({ request }) => {
  const { session } = await authenticate.admin(request);
  return json(await getDashboardData(session.shop)); // latest audit + settings + last boost
};
export const action = async ({ request }) => {
  const { session } = await authenticate.admin(request);
  const form = await request.formData();
  if (form.get("intent") === "boost") await enqueueBoost(session.shop);
  else await saveSettings(session.shop, form);
  return json({ ok: true });
};
```

**Queue** — `IndexTable`: module badge, resource (thumbnail + title), status `Badge` (`attention`/`info`/`success`/`critical`), savings, timestamp; filter tabs (All / Running / Done / Failed / Skipped); bulk retry; cancel-pending.

**History** — past boosts; each expands to its `OptimizationItem`s with per-item **Undo** (rollback path from §5A/5B) and boost-level "Roll back everything".

Empty/first-run states: "Audit running — potential appears in ~2 minutes" (skeleton rings), GEO card shows "Activate storefront embed" deep link until enabled.

---

## 8. Billing

Shopify App Pricing (managed pricing, Partner Dashboard) is the preferred route for public apps and needs no billing code. If plans need code-level control, the validated Billing API path:

```graphql
mutation ShopboostCreateSubscription($name: String!, $returnUrl: URL!, $trialDays: Int,
                                     $test: Boolean, $lineItems: [AppSubscriptionLineItemInput!]!) {
  appSubscriptionCreate(name: $name, returnUrl: $returnUrl, trialDays: $trialDays,
                        test: $test, lineItems: $lineItems) {
    confirmationUrl
    appSubscription { id status }
    userErrors { field message }
  }
}
```

Suggested plans: **Free** (audit + potential only — the hook), **Growth $19/mo** (all modules, 500 images/mo), **Pro $49/mo** (unlimited + scheduled weekly auto-boost). 7-day trial via `trialDays`. Redirect the merchant to `confirmationUrl`; watch `APP_SUBSCRIPTIONS_UPDATE`; gate the Boost action on active status.

---

## 9. Production-readiness checklist

- [ ] All four compliance webhooks handled (`customers/data_request`, `customers/redact`, `shop/redact`, `app/uninstalled` → purge shop rows, cancel queued jobs).
- [ ] Webhook handlers verify HMAC via `authenticate.webhook(request)` and return 200 fast — heavy work goes to the queue.
- [ ] CSP headers via `shopify.addDocumentResponseHeaders` in `entry.server.tsx` (template default — keep it).
- [ ] Offline access tokens only in Prisma session storage; never in job payloads or logs.
- [ ] Every write path records a `before` and has a working rollback (tested per module).
- [ ] Destructive-feeling settings changes (e.g. AVIF conversion) show a Polaris confirmation modal with projected impact.
- [ ] Rate-limit backoff verified against a 1,000+ product dev store.
- [ ] `fileUpdate` fileStatus polling handles `FAILED` (keep original, mark item failed).
- [ ] Sentry on web + worker; queue depth/failure metrics.
- [ ] App embed inactive-state handled everywhere GEO/speed claims are shown.
- [ ] Run the pre-submission review (shopify-app-store-review checklist) before submitting.
- [ ] Uninstall → reinstall flow works (settings reset, no orphan jobs).

---

## 10. Phases

| Phase | Status | Notes |
|---|---|---|
| **0. Scaffold** | ✅ Done | React Router template, Postgres/Prisma, BullMQ, worker process |
| **1. Audit + Dashboard** | ✅ Done | Bulk audit, scoring, current-vs-potential rings, persisted knobs, live queue |
| **2. Images** | ✅ Done | In-place `fileUpdate`, measured savings, per-item and per-boost undo |
| **3. SEO + GEO** | ✅ Done | Metas/alt text (AI or template), theme extension, grounded FAQs, review queue |
| **4. Speed** | ✅ Done | PageSpeed Insights + storefront scan; reports fixes rather than pretending to apply them |
| **5. Launch** | ◐ Mostly | Billing, compliance webhooks and deploy are done. Remaining: run against a real store, then App Store listing copy and screenshots. |

### What the build changed from this plan

- **AVIF was dropped.** Shopify accepts PNG, GIF, JPEG, WEBP, HEIC only. Its CDN
  already negotiates AVIF delivery, so WebP is the correct upload target.
- **API version is 2026-07**, not 2025-10 — which expires 2026-10-16. The CLI's
  2026-10 default is a release candidate and is not used.
- **The FAQ metafield needs a definition** granting `storefront: PUBLIC_READ`,
  or the theme renders nothing. Not in the original plan; it is the single most
  likely silent failure in the GEO module.
- **The app-embed deep link takes `api_key`**, not the deprecated `uuid`.
- **Polaris is web components**, not the React package, and has no range slider
  or determinate progress bar.
- **Collections and pages SEO** is scoped out for now: products carry the value,
  and adding a second bulk-query connection is a contained follow-on.
- **Redirects and sitemap hygiene** (§5E) are not built.

---

## 11. Go-live

1. `cp .env.example .env` and fill keys (see file — each key documents where to get it).
2. `npx prisma migrate deploy`.
3. Deploy web + worker (single Docker image, `RUN_WORKER=1` on the worker).
4. `npm run shopify -- app deploy` (pushes toml config + theme extension version).
5. Point `SHOPIFY_APP_URL`/app URLs at production, install on a fresh store, run the checklist in §9, submit.
