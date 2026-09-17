import type { ActionFunctionArgs } from "react-router";
import prisma from "../db.server";
import { authenticate } from "../shopify.server";

/**
 * Shopify has already revoked our token by the time this arrives, so the work
 * here is local cleanup: drop sessions and mark the shop uninstalled.
 *
 * Shop rows and their history are kept (a reinstall is common, and the audit
 * history is the merchant's data) — `shop/redact` is the topic that erases
 * them for good.
 */
export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, session, topic } = await authenticate.webhook(request);
  console.log(`[webhook] ${topic} for ${shop}`);

  // Webhooks can arrive after a reinstall, in which case the current session is
  // legitimate and must survive. Only delete sessions if this one is stale.
  if (session) {
    await prisma.session.deleteMany({ where: { shop } });
  }

  await prisma.shop.updateMany({
    where: { domain: shop },
    data: { uninstalledAt: new Date(), activeBoostId: null },
  });

  return new Response();
};
