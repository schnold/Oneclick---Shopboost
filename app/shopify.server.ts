import "@shopify/shopify-app-react-router/adapters/node";
import {
  ApiVersion,
  AppDistribution,
  shopifyApp,
} from "@shopify/shopify-app-react-router/server";
import { PrismaSessionStorage } from "@shopify/shopify-app-session-storage-prisma";
import prisma from "./db.server";

const shopify = shopifyApp({
  apiKey: process.env.SHOPIFY_API_KEY,
  apiSecretKey: process.env.SHOPIFY_API_SECRET || "",
  // Latest stable. 2025-10 stops being accessible on 2026-10-16, and
  // 2026-10 is only a release candidate. Keep in sync with [webhooks]
  // api_version in shopify.app.toml.
  apiVersion: ApiVersion.July26,
  scopes: process.env.SCOPES?.split(","),
  // A trailing slash would build "//auth/callback", which fails the
  // redirect_urls match in shopify.app.toml.
  appUrl: (process.env.SHOPIFY_APP_URL || "").replace(/\/+$/, ""),
  authPathPrefix: "/auth",
  sessionStorage: new PrismaSessionStorage(prisma),
  distribution: AppDistribution.AppStore,
  future: {
    expiringOfflineAccessTokens: true,
  },
  hooks: {
    afterAuth: async ({ session }) => {
      shopify.registerWebhooks({ session });

      // Audit on install so the merchant's first view of the dashboard shows
      // real numbers rather than an invitation to press a button. Enqueueing
      // must never block the OAuth redirect.
      const { enqueueAudit } = await import("./lib/boost.server");
      enqueueAudit(session.shop, "initial").catch((error) => {
        console.error(`[afterAuth] could not enqueue audit for ${session.shop}`, error);
      });
    },
  },
  ...(process.env.SHOP_CUSTOM_DOMAIN
    ? { customShopDomains: [process.env.SHOP_CUSTOM_DOMAIN] }
    : {}),
});

export default shopify;
export const apiVersion = ApiVersion.July26;
export const addDocumentResponseHeaders = shopify.addDocumentResponseHeaders;
export const authenticate = shopify.authenticate;
export const unauthenticated = shopify.unauthenticated;
export const login = shopify.login;
export const registerWebhooks = shopify.registerWebhooks;
export const sessionStorage = shopify.sessionStorage;
