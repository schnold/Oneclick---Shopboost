import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";

/**
 * Mandatory compliance topic. Shopboost optimizes catalog content only — it
 * never stores customer records — so there is no personal data to return.
 * The endpoint must still exist and acknowledge, or the app fails review.
 */
export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, topic } = await authenticate.webhook(request);
  console.log(`[webhook] ${topic} for ${shop} — no customer data held`);
  return new Response();
};
