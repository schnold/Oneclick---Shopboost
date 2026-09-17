import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import { enqueueAudit } from "../lib/boost.server";

/**
 * A merchant edited a product, so the stored potential is now slightly stale.
 *
 * Bulk exports are single-flight per shop and a busy merchant can fire dozens
 * of these a minute, so this deliberately does not audit per product. It
 * enqueues a debounced "scheduled" audit: the deterministic job id plus the
 * delay means a burst of edits collapses into one re-audit a few minutes later.
 */
const REAUDIT_DEBOUNCE_MS = 5 * 60 * 1_000;

export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, topic } = await authenticate.webhook(request);

  try {
    // dedupe + delay is the debounce: a burst of edits collapses onto one
    // job id, and the delay gives the burst time to finish arriving.
    await enqueueAudit(shop, "scheduled", undefined, {
      dedupe: true,
      delayMs: REAUDIT_DEBOUNCE_MS,
    });
  } catch (error) {
    // Never fail a webhook on our own queueing problem — Shopify would retry
    // the delivery, and the next edit will schedule another audit anyway.
    console.error(`[webhook] ${topic} for ${shop}: could not enqueue re-audit`, error);
  }

  return new Response();
};
