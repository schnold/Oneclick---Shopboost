# Shopboost — working notes

One-press shop optimization for Shopify. The full design lives in `PLAN.md`;
this file records the conventions and constraints that are easy to get wrong.

Use the [Shopify AI Toolkit](https://shopify.dev/docs/apps/build/ai-toolkit) for
Shopify API and platform work.

## Processes

The app is two processes that share Postgres and Redis:

| Process | Command | Notes |
|---|---|---|
| Web (embedded admin UI) | `npm run dev` | `shopify app dev` — tunnels and injects Shopify credentials |
| Worker (BullMQ) | `npm run worker` | Separate terminal. Does every Shopify write. |

`npm run dev` alone gives you a dashboard whose jobs never run. Both must be up.

Health check: `GET /health` (Postgres + Redis) or `GET /health?ping=1` (full
enqueue → worker → database round-trip). `npx tsx worker/smoke-test.ts` does the
same from the CLI.

## Verify GraphQL before writing it

Every Admin API operation must be validated against the live schema before it
ships — field names, input shapes, and deprecations change between versions.
Use the Shopify MCP `validate_graphql_codeblocks` tool, or `shopify app graphql`.

Findings already baked into this codebase, which contradict most tutorials:

- **`fileUpdate` replaces an image in place.** Pass a new `originalSource` on an
  existing `MediaImage` and the bytes swap under the same media ID — product and
  variant references survive, and rollback is the same call with the stored
  original URL. Do **not** use `productCreateMedia` / `productDeleteMedia`; both
  are deprecated.
- **`productUpdate` takes `product: ProductUpdateInput`**, not the legacy
  `input:` argument.
- **Collection, page, and blog SEO is not a field** — it lives in `global`
  namespace metafields `title_tag` / `description_tag`, written via
  `metafieldsSet`. Only products have native `seo { title description }`.
- **`seo.hidden = 1`** (a `number_integer` metafield) is the documented way to
  add noindex/nofollow and drop a resource from the sitemap.

## UI: Polaris web components, not Polaris React

This template uses Polaris **web components** (`<s-page>`, `<s-section>`,
`<s-button>`) loaded by `AppProvider`, which injects `polaris.js` and
`app-bridge.js`. There is no `@shopify/polaris` React package here, and
`root.tsx` needs no script tag.

Confirmed elements: `s-page` (slots `primary-action`, `aside`), `s-section`,
`s-stack`, `s-box`, `s-grid`, `s-divider`, `s-heading`/`s-text`/`s-paragraph`,
`s-badge` (tones `auto|info|success|caution|warning|critical` — there is no
`attention`), `s-button` (`variant`, `tone`, `loading`, `disabled`), `s-select`,
`s-text-field`, `s-number-field`, `s-checkbox`, `s-switch`, `s-choice-list`,
`s-table` (+ `s-table-header-row`/`s-table-header`/`s-table-body`/`s-table-row`/
`s-table-cell`), `s-spinner`, `s-banner`, `s-link`, `s-app-nav`.

Two gaps to design around:

- **No range slider.** Use `s-number-field` with `min`/`max`/`step`.
- **No determinate progress bar.** Only `s-spinner` (indeterminate); render
  progress as text plus a badge, or build one.

Prop names that differ from what you would guess (all verified against
`@shopify/polaris-types`):

- `s-checkbox` takes a **`label` prop**, not children, and `defaultChecked` for
  the uncontrolled case.
- `s-select` **has no `defaultValue`** — it is explicitly omitted from the type.
  Set the initial selection with `value`.
- `s-text-field` and `s-number-field` **do** have `defaultValue`.
- `s-badge` tones are exactly `auto | neutral | info | success | caution |
  warning | critical`. Type any helper that returns one, or `tone` silently
  widens to `string` and fails the build.

App Bridge components (`s-app-nav`, `s-title-bar`) are typed in a *different*
package, `@shopify/app-bridge-types`. `app/globals.d.ts` loads it with a
triple-slash reference that must stay on line 1 — a directive after any
statement is ignored, and `s-app-nav` drops out of `JSX.IntrinsicElements`.

### React 18 + custom elements

React here is **18.3.1**, whose synthetic event system only delegates standard
bubbling DOM events to custom elements. `onClick` works (the template relies on
it); `onChange` on `s-select` / `s-text-field` is **not** reliable, because
React 18's change plugin only handles native `input`/`select`/`textarea`.

So: **submit settings as uncontrolled forms.** Wrap knobs in a React Router
`<Form method="post">`, name every field, and read them from `formData` in the
action. Do not build controlled inputs bound to `onChange` state. This is also
the idiomatic React Router pattern, so it costs nothing.

## Image rules

- **Shopify accepts PNG, GIF, JPEG, WEBP and HEIC — not AVIF.** Max 20 MB, max
  4472 x 4472 px. Uploading WebP is the right target anyway: Shopify's CDN
  already negotiates AVIF delivery to browsers that support it.
- Recompress from `originalSource.url` (the untransformed upload), never
  `image.url` (a CDN rendition) — re-encoding a rendition compounds artifacts.
- Animated GIFs are left alone. This pipeline would flatten them to a single
  frame, and no byte saving is worth silently destroying an animation.
- The 4472 px ceiling is enforced even when the merchant turned resizing off,
  because Shopify would reject the upload otherwise.
- After `fileUpdate`, poll to `READY`. Processing is asynchronous and can fail
  *after* the mutation succeeded; a `FAILED` status means the original is still
  live and the job should be recorded as failed, not done.
- Post the staged upload as multipart form-data with every returned parameter
  **before** the `file` field — the signed policy is validated in field order.

## Queue conventions

- Job ids are deterministic and **scoped to their boost**:
  `{shop}__{module}__{boostId}__{resourceId}`. Never put a timestamp or random
  value in one.
- **BullMQ rejects a custom job id containing `:`** — it namespaces its own
  Redis keys with colons. That rules out the obvious separator *and* raw
  Shopify gids, so `jobId()` joins with `__` and strips colons.
- Scope module job ids to the boost. Keyed only on settings, a second boost
  collides with the first boost's completed jobs: BullMQ drops the duplicates,
  `skipDuplicates` leaves the rows pointing at the old boost, and the new boost
  has nothing to wait for and never settles.
- **A deduped job id is not free.** BullMQ keeps completed jobs for an hour and
  silently drops a new job whose id matches one still present. Dedupe only
  where collapsing a burst is the goal (the `products/update` webhook);
  user-initiated actions like Rescan must take a generated id or the button
  appears to do nothing.
- Read `extensions.cost.throttleStatus` on every Admin API response;
  `throttleDelayMs()` turns it into a re-enqueue delay. A `ThrottledError`
  should be re-enqueued, not burn a retry attempt.
- One job per resource, not per shop: granular progress, cheap retries, and one
  bad image cannot fail a batch.
- **Upstash's REST API cannot back the queue.** BullMQ speaks the Redis wire
  protocol and a Worker holds a blocking command open for its whole lifetime,
  so `@upstash/redis` over HTTP is not an option. The REST token doubles as the
  TCP password on the same host, so `redisUrl()` derives
  `rediss://default:<token>@<host>:6379` from `UPSTASH_REDIS_REST_URL` /
  `UPSTASH_REDIS_REST_TOKEN` when `REDIS_URL` is unset. Every connection goes
  through that one function — do not call `new IORedis` anywhere else.
- Job payloads must never contain access tokens. Workers load offline sessions
  from Prisma by shop domain (`shopifyGraphql(shopDomain, …)`).

## Tests and a running worker

`worker/test-prefix.ts` sets `BULLMQ_PREFIX` to a test-only namespace and must
be the **first import** in any test that enqueues. Without it, a test run while
`npm run worker` is up hands fixture jobs for a non-existent shop to the real
worker — the test then fails for reasons unrelated to the code, and the worker
logs a flurry of Shopify errors.

## Server modules and the client bundle

React Router strips `*.server.ts` from the client bundle, and the build **fails**
if a component imports one. Anything a component needs — display helpers, shared
types — belongs in a plain module. Hence `app/lib/format.ts` (formatting) and
`app/lib/audit/types.ts` (result shapes) sitting beside the `.server` files that
produce them.

## Bulk operations

- Pass `groupObjects: false` explicitly. It defaults to `true` on 2025-10 and
  Shopify recommends disabling it; it is also the 2026-01 default, so the flat
  `__parentId` parser stays correct across an API bump.
- Bulk queries may not carry pagination arguments — no `first:` on any
  connection.
- Only one bulk query per app per shop runs at a time before 2026-01. A job that
  loses the race adopts the running operation instead of failing.
- Poll with `node(id:)` + an inline `... on BulkOperation` fragment. It works on
  every API version, unlike `currentBulkOperation` (deprecated) and
  `bulkOperation(id:)` (2026-01+).
- Webhook delivery is not guaranteed, so `bulk_operations/finish` is a
  fast-path signal only — the audit job polls regardless and must never depend
  on the webhook arriving.

## Writes are reversible

Every mutation records an `OptimizationItem` with a `before` value. That column
is both the rollback source and what the before/after UI renders — a write path
without a captured `before` is a bug, not an optimization.

Undo is not a separate mechanism: it is the same mutation replayed with the
stored `before`. For images that is `fileUpdate` pointed back at the original
upload URL, which restores the bytes under the same media id.

"Skipped" is a normal outcome, not a failure. An image that is already well
optimized gets a recorded item explaining why it was left alone — the merchant
should be able to see that we looked at it and made a decision.

## Shopify app config

`shopify app config link` and `shopify app dev` **overwrite `shopify.app.toml`
from the Dev Dashboard**, and will silently drop every
`[[webhooks.subscriptions]]` block if the remote app has none. After running
either, check that the webhook section survived, then `npm run deploy` to push
it back up. The mandatory compliance topics live there — losing them fails App
Store review.

Do not set `handle` in the toml unless you know the value is free: it must be
globally unique across all Shopify apps, and a taken one fails deploy with
"app_handle: App handle must be unique". Omitted, Shopify assigns one.

**API version: 2026-07** (latest stable), pinned in two places that must agree —
`[webhooks] api_version` in the toml and `apiVersion` in `app/shopify.server.ts`.
The CLI defaults the toml to 2026-10, which is a *release candidate*; Shopify
advises against release candidates in production and the installed
`@shopify/shopify-api` has no `October26` enum to match it. 2025-10 is not an
option either — it stops being accessible on 2026-10-16.

## The worker's environment

`shopify app dev` injects Shopify credentials into the **web process only**. The
worker is a separate process and sees none of them, so it reads `.env`:

    npx shopify app env pull      # writes SHOPIFY_API_KEY and SHOPIFY_API_SECRET

`worker/bootstrap.ts` checks this and fails with an actionable message instead of
the Shopify library's opaque "Detected an empty appUrl configuration". It must
stay the **first import** in `worker/index.ts` and in every test script, because
`shopify.server.ts` validates its configuration at module scope.

## Dependencies

- The Shopify CLI is a **devDependency**, not a global install. `npm run dev`
  works; a bare `shopify` command does not.
- `npm audit` counts are dominated by dev-only tooling. `npm audit --omit=dev`
  is the number that matters. Never run `npm audit fix --force` — its
  suggestions for the remaining advisories are downgrades.
- `sharp` is pinned to `^0.35.4` or newer: it decodes untrusted merchant images
  at runtime, so its libvips CVEs are the one class of advisory here that is
  genuinely reachable. Upgrade it promptly; treat the dev-only ones on merit.
- sharp reports JPEG as `"jpeg"`, never `"jpg"` — its 0.35 types make a `"jpg"`
  comparison a compile error.

## What each module may and may not do

- **Images** rewrite bytes in place and are fully reversible.
- **SEO** never overwrites merchant copy unless `onlyFillBlanks` is turned off.
- **GEO** writes a `shopboost.faq` metafield. That metafield is only readable
  from Liquid if its **definition grants `access: { storefront: PUBLIC_READ }`**
  — see `app/lib/geo/metafields.server.ts`. Without the definition,
  `metafieldsSet` succeeds, the value is stored, and the theme renders nothing.
  This is the failure mode to check first if structured data does not appear.
- **GEO FAQs have no template fallback.** Without an AI key the module writes
  nothing, and generated answers are filtered by a grounding check that drops
  any measurement or policy claim the product data does not support. A
  fabricated answer becomes the answer an AI assistant gives a shopper, so
  silence is the correct failure mode.
- **Every AI call goes through `app/lib/ai/openrouter.server.ts`.** OpenRouter's
  chat-completions endpoint is OpenAI-shaped and fronts every provider, so there
  is no vendor SDK and changing model means changing `OPEN_ROUTER_MODEL`. The
  model must support structured outputs — check `supported_parameters` at
  `https://openrouter.ai/api/v1/models` lists `structured_outputs`, or every
  generation silently falls back. Under strict mode **every** property must be
  listed in the schema's `required`, including optional-looking ones like
  `altTexts`.
- **Reasoning tokens are spent from `max_tokens`.** On a reasoning model
  (Gemini 3.x, o-series) a default-effort call can spend the entire budget
  thinking and return an empty completion — which surfaces as
  `finish_reason: "length"`, not an error. Hence `reasoning: { effort: "low" }`
  on every request; these tasks are given their facts and need no deliberation.
- **Speed writes nothing to Shopify.** An app cannot edit theme code, so the
  module measures, scans, and hands back exact changes. Do not add a "fix"
  that only pretends to work.

An app also **cannot activate its own theme app embed** — merchants must do it.
`app/lib/geo/embed.server.ts` builds the documented deep link, which takes
`api_key` (the client_id); the `uuid` parameter is deprecated.

## Database

Postgres via Prisma. The `Session` model's shape is fixed by
`@shopify/shopify-app-session-storage-prisma`; do not edit its fields.
After changing `schema.prisma`: `npm run db:migrate`.
