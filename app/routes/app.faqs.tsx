import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { Form, useActionData, useLoaderData, useNavigation } from "react-router";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import {
  shopifyGraphql,
  assertNoUserErrors,
  type UserError,
} from "../lib/shopify-admin.server";
import { SET_METAFIELDS } from "../lib/graphql/seo";
import {
  ensureFaqDefinition,
  FAQ_NAMESPACE,
  FAQ_KEY,
} from "../lib/geo/metafields.server";

/**
 * Review queue for generated product FAQs.
 *
 * `reviewBeforePublish` is on by default, which means FAQs are drafted but
 * never reach the storefront until a merchant approves them here. Without this
 * page the default setting would be a dead end — generated content with no way
 * to publish it.
 */

type FaqEntry = { question: string; answer: string };

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);

  const pending = await prisma.optimizationItem.findMany({
    where: {
      job: { shopDomain: session.shop },
      field: "geo.faq.pending",
      status: "done",
    },
    orderBy: { createdAt: "desc" },
    take: 50,
    include: { job: { select: { label: true } } },
  });

  return {
    pending: pending.map((item) => ({
      id: item.id,
      productId: item.resourceId,
      title: item.job.label ?? item.resourceId,
      entries: ((item.after as { entries?: FaqEntry[] })?.entries ?? []) as FaqEntry[],
      createdAt: item.createdAt.toISOString(),
    })),
  };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const form = await request.formData();
  const intent = form.get("intent");
  const itemId = String(form.get("itemId"));

  const item = await prisma.optimizationItem.findFirst({
    where: { id: itemId, job: { shopDomain: session.shop }, field: "geo.faq.pending" },
  });
  if (!item) return { ok: false, message: "That draft is no longer available." };

  if (intent === "discard") {
    await prisma.optimizationItem.update({
      where: { id: item.id },
      data: { status: "rolled_back", reason: "Discarded during review" },
    });
    return { ok: true, message: "Draft discarded. Nothing was published." };
  }

  if (intent === "publish") {
    const entries = (item.after as { entries?: FaqEntry[] })?.entries ?? [];
    if (entries.length === 0) {
      return { ok: false, message: "That draft has no entries to publish." };
    }

    // The metafield is unreadable from Liquid without a storefront-readable
    // definition, so this has to succeed before the value is worth writing.
    const definition = await ensureFaqDefinition(session.shop);
    if (!definition.ok) return { ok: false, message: definition.reason };

    try {
      const { data } = await shopifyGraphql<{
        metafieldsSet: { metafields: unknown[] | null; userErrors: UserError[] };
      }>(
        session.shop,
        SET_METAFIELDS,
        {
          metafields: [
            {
              ownerId: item.resourceId,
              namespace: FAQ_NAMESPACE,
              key: FAQ_KEY,
              type: "json",
              value: JSON.stringify(entries),
            },
          ],
        },
        "metafieldsSet",
      );
      assertNoUserErrors(data.metafieldsSet.userErrors, "metafieldsSet");
    } catch (error) {
      return { ok: false, message: (error as Error).message };
    }

    // Recorded as a published FAQ so History and Undo treat it like any other
    // change from here on.
    await prisma.optimizationItem.update({
      where: { id: item.id },
      data: { field: "geo.faq", reason: "Published after review" },
    });

    return { ok: true, message: "Published. It will appear in your product's structured data." };
  }

  return { ok: false, message: "Unknown action" };
};

export default function Faqs() {
  const { pending } = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const navigation = useNavigation();
  const working = navigation.state === "submitting";

  return (
    <s-page heading="Review FAQs">
      {actionData?.message && (
        <s-banner tone={actionData.ok ? "success" : "critical"} dismissible>
          {actionData.message}
        </s-banner>
      )}

      {pending.length === 0 ? (
        <s-section heading="Nothing waiting">
          <s-stack direction="block" gap="small">
            <s-text>
              No FAQ drafts are waiting for review.
            </s-text>
            <s-text color="subdued">
              When a boost generates product FAQs, they appear here first. Nothing
              reaches your storefront until you publish it. You can turn that review
              step off in Settings.
            </s-text>
            <s-link href="/app">Back to dashboard</s-link>
          </s-stack>
        </s-section>
      ) : (
        <>
          <s-section>
            <s-text color="subdued">
              {pending.length} product{pending.length === 1 ? "" : "s"} with drafted
              answers. Read them before publishing — they become the answers search
              engines and AI assistants quote.
            </s-text>
          </s-section>

          {pending.map((draft) => (
            <s-section key={draft.id} heading={draft.title}>
              <s-stack direction="block" gap="base">
                {draft.entries.map((entry, index) => (
                  <s-stack key={index} direction="block" gap="small-200">
                    <s-text type="strong">{entry.question}</s-text>
                    <s-text color="subdued">{entry.answer}</s-text>
                  </s-stack>
                ))}

                <s-divider />

                <s-stack direction="inline" gap="small">
                  <Form method="post">
                    <input type="hidden" name="intent" value="publish" />
                    <input type="hidden" name="itemId" value={draft.id} />
                    <s-button type="submit" variant="primary" loading={working}>
                      Publish
                    </s-button>
                  </Form>
                  <Form method="post">
                    <input type="hidden" name="intent" value="discard" />
                    <input type="hidden" name="itemId" value={draft.id} />
                    <s-button type="submit" variant="tertiary" loading={working}>
                      Discard
                    </s-button>
                  </Form>
                </s-stack>
              </s-stack>
            </s-section>
          ))}
        </>
      )}
    </s-page>
  );
}
