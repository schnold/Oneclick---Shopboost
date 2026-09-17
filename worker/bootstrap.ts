import "dotenv/config";

/**
 * Worker environment preflight.
 *
 * Imported first by `worker/index.ts`, before anything that reads
 * `process.env` at module scope. ES modules evaluate imports in order, so the
 * checks and defaults here are applied before `shopify.server.ts` constructs
 * its client.
 *
 * Without this the worker dies on a raw "Detected an empty appUrl
 * configuration" from deep inside the Shopify library, which says nothing
 * about the actual problem: `shopify app dev` injects credentials into the web
 * process only, and the worker is a separate process that never sees them.
 */

const REQUIRED = [
  ["DATABASE_URL", "Postgres connection string"],
  ["REDIS_URL", "Redis connection string"],
  ["SHOPIFY_API_KEY", "app client ID"],
  ["SHOPIFY_API_SECRET", "app client secret"],
] as const;

const missing = REQUIRED.filter(([name]) => !process.env[name]);

if (missing.length > 0) {
  console.error(
    [
      "",
      "The worker cannot start — missing environment variables:",
      ...missing.map(([name, what]) => `  ${name}  (${what})`),
      "",
      "The Shopify CLI injects credentials into `npm run dev` only, so the",
      "worker needs them written to .env:",
      "",
      "  npx shopify app env pull",
      "",
      "Then copy .env.example's remaining keys (DATABASE_URL, REDIS_URL) if",
      "they are not set yet.",
      "",
    ].join("\n"),
  );
  process.exit(1);
}

/**
 * The worker authenticates with stored offline tokens and never runs an OAuth
 * redirect, so `appUrl` is unused here — but `shopifyApp()` rejects an empty
 * one at construction. In development the tunnel URL also changes on every
 * `shopify app dev`, so requiring a real value would mean re-pulling env vars
 * constantly for a field nothing reads.
 */
if (!process.env.SHOPIFY_APP_URL) {
  process.env.SHOPIFY_APP_URL = "https://shopboost.invalid";
}

export const WORKER_ENV_READY = true;
