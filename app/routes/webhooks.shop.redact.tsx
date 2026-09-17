import type { ActionFunctionArgs } from "react-router";
import prisma from "../db.server";
import { authenticate } from "../shopify.server";

/**
 * Mandatory compliance topic. Delivered 48 hours after uninstall; erases
 * everything we hold for the shop. Cascades take care of audits, boosts, jobs
 * and items.
 */
export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, topic } = await authenticate.webhook(request);
  console.log(`[webhook] ${topic} for ${shop} — erasing shop data`);

  await prisma.session.deleteMany({ where: { shop } });
  await prisma.boost.deleteMany({ where: { shopDomain: shop } });
  await prisma.shop.deleteMany({ where: { domain: shop } });

  return new Response();
};
