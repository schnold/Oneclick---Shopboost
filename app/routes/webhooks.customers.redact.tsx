import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";

/**
 * Mandatory compliance topic. Nothing to erase — Shopboost holds no customer
 * records — but the endpoint must exist and acknowledge.
 */
export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, topic } = await authenticate.webhook(request);
  console.log(`[webhook] ${topic} for ${shop} — no customer data held`);
  return new Response();
};
