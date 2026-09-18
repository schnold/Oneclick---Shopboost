# Shopboost

One-press shop optimization for Shopify — images, SEO, generative engine
optimization, and speed — with simple knobs, a clean queue, and a before/after
view of what was optimized.

The design document is [`PLAN.md`](./PLAN.md). Conventions and the
Shopify-API findings this codebase depends on are in [`AGENTS.md`](./AGENTS.md).

## Status

**Feature complete.** All four optimization modules, billing, and the
storefront extension are built, deployed to Shopify, and covered by 102
automated checks.

| Module | What it does |
|---|---|
| **Images** | Recompresses in place via `fileUpdate` — same media ID, so product and variant references survive. Fully reversible. |
| **SEO** | Meta titles, descriptions and alt text. Uses an AI model via OpenRouter when a key is set, a deterministic template generator otherwise. Never overwrites merchant copy by default. |
| **GEO** | Product, FAQ and Organization JSON-LD through a theme app extension, plus grounded product FAQs stored in a metafield. |
| **Speed** | PageSpeed Insights measurement plus a storefront scan against Shopify's documented anti-patterns, reported as exact theme edits. |

One **Boost** button runs the enabled modules, tracks live progress, and
produces a measured before/after. Every change is recorded with the original it
replaced and can be undone individually or as a whole boost.

## Requirements

- Node 20.19+ or 22.12+ (developed on 24.x)
- PostgreSQL 14+
- Redis 6+
- A Shopify Partner account and a development store

## Setup

```bash
npm install
cp .env.example .env     # then fill in the values — each key documents itself
npx prisma migrate deploy
npx prisma generate
```

On macOS the two services come from Homebrew:

```bash
brew install postgresql@18 redis
brew services start postgresql@18
brew services start redis
createdb shopboost
```

`DATABASE_URL` then looks like `postgresql://$(whoami)@localhost:5432/shopboost`
and `REDIS_URL` like `redis://127.0.0.1:6379`.

In production Redis is Upstash. Either set `REDIS_URL` to its TCP string, or set
`UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN` — the pair Upstash's
hosting integrations inject — and `app/lib/redis.server.ts` derives the TCP URL
from them. BullMQ speaks the Redis wire protocol and cannot use the REST API, so
the REST variables alone are not enough without that translation.

## Running

Shopboost is **two processes**. Run each in its own terminal:

```bash
npm run dev       # embedded admin app (shopify app dev — tunnels + installs)
npm run worker    # BullMQ worker; does all Shopify writes
```

The Shopify CLI is a project devDependency, so there is nothing to install
globally — but that also means a bare `shopify app dev` will not resolve. Use
`npm run dev`, or `npx shopify ...` for other CLI commands.

**The worker needs credentials of its own.** `shopify app dev` injects them into
the web process only, so run this once:

```bash
npx shopify app env pull   # writes SHOPIFY_API_KEY and SHOPIFY_API_SECRET to .env
```

Without it the worker exits immediately with an explanation.

The first `npm run dev` prompts you to log in to your Partner account, pick or
create the app, and install it on a development store. It injects
`SHOPIFY_API_KEY`, `SHOPIFY_API_SECRET`, and `SHOPIFY_APP_URL` automatically, so
those stay blank in `.env` during development.

Without the worker running, the dashboard loads but no job ever completes.

## Verifying the stack

```bash
curl localhost:3000/health          # Postgres + Redis reachable
curl 'localhost:3000/health?ping=1' # full enqueue → worker → database round-trip
npx tsx worker/smoke-test.ts        # same round-trip from the CLI
npx tsx worker/audit-fixture-test.ts  # parse + score a bulk export, no store needed
npx tsx worker/images-test.ts         # compression pipeline on generated images
npx tsx worker/boost-test.ts          # orchestrator against real Postgres + Redis
npx tsx worker/seo-geo-speed-test.ts  # copy generation, FAQ grounding, speed scanner
npx tsx worker/rollback-test.ts       # undo covers every field a module writes
npx tsx worker/dashboard-test.ts      # loader data + ScoreRing rendering
```

The tests are safe to run while the app is up: `boost-test` redirects BullMQ to
its own Redis namespace (`BULLMQ_PREFIX`), so a running `npm run worker` never
sees its fixture jobs.

`audit-fixture-test` serves a JSONL fixture in the exact shape Shopify's bulk
export produces — including media that arrives before its parent, a non-image
media node, and a malformed line — then asserts the parsed and scored result.
It needs no Shopify credentials, so it is the fastest way to check a change to
the audit engine.

A healthy round-trip returns the worker's result and exits 0:

```
→ enqueued job 2, waiting for worker…
✓ worker returned: { ok: true, note: 'smoke test', latencyMs: 2, shopCount: 0, … }
```

## Layout

```
app/
  components/ScoreRing.tsx   current-vs-potential ring (Polaris has no ring)
  lib/
    audit/
      parse.server.ts        streaming JSONL parser for bulk exports
      score.server.ts        scoring and the module work lists
      types.ts               result shapes, shared with the client
    graphql/audit.ts         validated audit operations
    boost.server.ts          audit enqueueing, dashboard and boost progress
    boost-orchestrator.server.ts  Boost button: fan-out, settling, cancel
    rollback.server.ts       undo, replaying each change's stored `before`
    jobs.server.ts           mirrors queue state into Postgres
    images/
      compress.server.ts     sharp pipeline, format and size rules
      upload.server.ts       staged upload + in-place fileUpdate
    format.ts                display helpers (client-safe)
    queue.server.ts          BullMQ queues, job payload types, deterministic ids
    redis.server.ts          Redis connections (BullMQ-safe settings)
    settings.server.ts       the dashboard knobs: shape, defaults, validation
    shopify-admin.server.ts  Admin GraphQL for workers, with throttle handling
  routes/
    app.tsx                  embedded shell + nav
    app._index.tsx           dashboard: rings, potential, Boost button
    app.settings.tsx         the knobs (uncontrolled forms)
    app.billing.tsx          plans, trial, subscription
    app.faqs.tsx             review queue for generated FAQs
    app.queue.tsx            live job queue
    app.history.tsx          past boosts and scans
    health.tsx               liveness and round-trip check
    webhooks.*.tsx           uninstall, scopes, product updates, compliance
worker/
  index.ts                   worker bootstrap, per-queue concurrency, shutdown
  processors/
    audit.ts                 bulk export → parse → score → snapshot
    images.ts                download → compress → upload → replace in place
    seo.ts                   metas and alt text, AI or template
    geo.ts                   grounded FAQs and structured data
    speed.ts                 PageSpeed + storefront scan
    ping.ts                  infrastructure smoke test
  bootstrap.ts               worker env preflight (must import first)
  smoke-test.ts              queue round-trip check
  audit-fixture-test.ts      audit pipeline check, no Shopify store needed
  dashboard-test.ts          loader data and component rendering check
prisma/schema.prisma         Shop, AuditSnapshot, Boost, OptimizationJob/Item
```

## Scripts

| Command | Does |
|---|---|
| `npm run dev` | Embedded app with tunnel |
| `npm run worker` | Worker with reload on change |
| `npm run worker:start` | Worker, no watch (production) |
| `npm run typecheck` | Route typegen + `tsc --noEmit` |
| `npm run db:migrate` | Create and apply a migration |
| `npm run db:studio` | Browse the database |
| `npm run deploy` | Push app config and extensions to Shopify |

## Optional API keys

The app is fully functional without either key, and degrades honestly:

| Key | Without it |
|---|---|
| `OPEN_ROUTER_API_KEY` | SEO copy comes from a deterministic template generator instead of a model. Product FAQs are skipped entirely rather than invented. |
| `PSI_API_KEY` | PageSpeed Insights still runs at a lower anonymous quota. On a rate limit the speed ring reads "Not measured" and the storefront scan still reports its findings. |

## Dependency audit

`npm audit` reports high-severity advisories that are **not reachable from the
running app**. Before acting on the count, check what actually ships:

```bash
npm audit --omit=dev    # the only number that reflects production
```

What was fixed and what deliberately remains:

| Package | Status |
|---|---|
| `sharp` | **Upgraded to 0.35.4** (libvips 8.18.6). This one was real — sharp decodes merchant-supplied images at runtime, so the libvips/libheif CVEs were genuinely reachable. |
| `@typescript-eslint/*` | **Upgraded to v8**, which drops the vulnerable `minimatch`. |
| `lodash` via `@shopify/api-codegen-preset` | Left as is. Dev-only: it runs during `npm run graphql-codegen` against Shopify's own schema. The advisories (`_.template` injection, prototype pollution) need attacker-controlled input, which never reaches it. |
| `deepmerge-ts` via `prisma` → `@prisma/config` | Left as is. Needs `deepmerge-ts@8`, which no stable Prisma ships yet (only `prisma@8.0.0-rc`). The advisory is stack exhaustion while merging a config file we author ourselves — not attacker-reachable. Revisit when Prisma 8 is stable. |

**Do not run `npm audit fix --force` here.** Its suggested "fixes" for the
remaining advisories are *downgrades* — `prisma@6.12.0` over the installed
6.19.3, and `@shopify/api-codegen-preset@0.0.4` over 2.0.1 — which would break
the build and roll back real fixes.

## Before submitting to the App Store

A compliance pass against Shopify's self-review requirements found **one
blocker** and a handful of things only you can confirm.

### Blocker — the app URL is still a placeholder

The production URL is **https://oneclickshopboost.netlify.app**. It is set in
three places that must agree:

```toml
# shopify.app.toml
application_url = "https://oneclickshopboost.netlify.app"
redirect_urls   = [ "https://oneclickshopboost.netlify.app/auth/callback" ]
```

```bash
# .env on the host (no trailing slash)
SHOPIFY_APP_URL=https://oneclickshopboost.netlify.app
```

`shopify app dev` rewrites the toml URLs to the tunnel URL while developing
(`automatically_update_urls_on_dev = true`) and pushes them to the Dev
Dashboard. After a dev session, restore the production URLs and deploy:

```bash
npm run deploy
```

Then confirm the Dev Dashboard shows the production URL, and that the host
terminates TLS with a valid certificate — the Dockerfile serves plain HTTP on
port 3000 and expects the platform to handle TLS.

### Verify before submitting

| Item | Why |
|---|---|
| `NODE_ENV=production` on the host | Billing falls back to **test charges** otherwise, and nobody is ever billed. `billingIsTestMode()` logs which mode it used on every subscription; `SHOPIFY_BILLING_TEST=false` forces live charges. |
| The listing's privacy section | `customers/data_request` and `customers/redact` only acknowledge, because the app stores no customer data. A reviewer reading just the handlers sees two no-ops — say plainly that no customer PII is stored. |
| AI-content disclosure | SEO copy and FAQs can be model-written. FAQs default to a human review queue, and generated answers are filtered by a grounding check, but merchants can disable the review step. Describe this in the listing. |
| Theme scopes | `read_themes` / `write_themes` are required by the media read paths and by `fileUpdate` on theme-owned image files. The justification is documented in `shopify.app.toml` — reviewers ask. |

### Already clean

No REST Admin API usage, no `localStorage`/`sessionStorage`/`document.cookie`,
none of the five gated scopes, no `ScriptTag` or Asset API writes, reinstall is
handled without an install-once flag, and all three mandatory compliance topics
are subscribed with authenticating handlers.

## Deploying

Web and worker share one image; set `RUN_WORKER=1` on the worker instance and
run `npm run worker:start` as its command. `npm run setup` (migrate + generate)
runs before the web process starts. Everything else is in `.env.example`.
# Oneclick---Shopboost
