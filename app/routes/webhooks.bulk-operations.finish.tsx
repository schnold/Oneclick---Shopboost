import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";

/**
 * Shopify finished a bulk export.
 *
 * The audit job polls for completion on its own, because webhook delivery is
 * not guaranteed and an audit that only reacted to this would hang whenever a
 * delivery was dropped. This handler therefore exists to log and acknowledge —
 * it is the fast-path signal, not the mechanism.
 *
 * Kept as a subscription because the payload is the earliest notice that an
 * export failed, which is worth surfacing in logs ahead of the poll.
 */
export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, topic, payload } = await authenticate.webhook(request);

  const body = payload as {
    admin_graphql_api_id?: string;
    status?: string;
    error_code?: string | null;
  };

  if (body?.error_code) {
    console.error(
      `[webhook] ${topic} for ${shop}: ${body.admin_graphql_api_id} ${body.status} — ${body.error_code}`,
    );
  } else {
    console.log(
      `[webhook] ${topic} for ${shop}: ${body?.admin_graphql_api_id} ${body?.status}`,
    );
  }

  return new Response();
};
