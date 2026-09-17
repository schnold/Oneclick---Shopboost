import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { Form, useActionData, useLoaderData, useNavigation } from "react-router";
import { authenticate } from "../shopify.server";
import {
  getEntitlement,
  createSubscription,
  cancelSubscription,
} from "../lib/billing.server";
import { PLANS, TRIAL_DAYS, type PlanId } from "../lib/plans";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  return { entitlement: await getEntitlement(session.shop) };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const form = await request.formData();
  const intent = form.get("intent");

  if (intent === "subscribe") {
    const planId = String(form.get("plan")) as Exclude<PlanId, "free">;
    if (planId !== "growth" && planId !== "pro") {
      return { ok: false, message: "Unknown plan" };
    }

    const url = new URL(request.url);
    const returnUrl = `${url.origin}/app/billing?upgraded=1`;

    try {
      const confirmationUrl = await createSubscription(session.shop, planId, returnUrl);
      // The merchant approves the charge in the Shopify admin, outside our
      // iframe, so this has to be a top-level redirect rather than a fetch.
      return { ok: true, confirmationUrl, message: null };
    } catch (error) {
      return { ok: false, message: (error as Error).message, confirmationUrl: null };
    }
  }

  if (intent === "cancel") {
    const id = String(form.get("subscriptionId"));
    try {
      await cancelSubscription(session.shop, id);
      return { ok: true, message: "Your plan was cancelled.", confirmationUrl: null };
    } catch (error) {
      return { ok: false, message: (error as Error).message, confirmationUrl: null };
    }
  }

  return { ok: false, message: "Unknown action", confirmationUrl: null };
};

export default function Billing() {
  const { entitlement } = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const navigation = useNavigation();
  const working = navigation.state === "submitting";

  return (
    <s-page heading="Plan">
      {actionData?.confirmationUrl && (
        <s-banner tone="info">
          <s-stack direction="block" gap="small">
            <s-text>Approve the charge in your Shopify admin to activate the plan.</s-text>
            <s-link href={actionData.confirmationUrl} target="_top">
              Continue to approval
            </s-link>
          </s-stack>
        </s-banner>
      )}

      {actionData?.message && (
        <s-banner tone={actionData.ok ? "success" : "critical"} dismissible>
          {actionData.message}
        </s-banner>
      )}

      <s-section heading="Your plan">
        <s-stack direction="block" gap="base">
          <s-stack direction="inline" gap="small" alignItems="center">
            <s-badge tone={entitlement.plan === "free" ? "auto" : "success"}>
              {entitlement.planName}
            </s-badge>
            {entitlement.subscription?.test && <s-badge tone="warning">Test charge</s-badge>}
          </s-stack>

          {entitlement.plan === "free" ? (
            <s-text color="subdued">
              You can scan your shop and see the full optimization potential for free.
              Choose a plan below when you want to apply the changes.
            </s-text>
          ) : (
            <s-text color="subdued">
              {Number.isFinite(entitlement.imageLimit)
                ? `${entitlement.imagesUsed.toLocaleString()} of ${entitlement.imageLimit.toLocaleString()} images used in this billing period.`
                : `${entitlement.imagesUsed.toLocaleString()} images optimized in this billing period. No limit on your plan.`}
            </s-text>
          )}

          {entitlement.blockedReason && (
            <s-banner tone="info">{entitlement.blockedReason}</s-banner>
          )}
        </s-stack>
      </s-section>

      {(["free", "growth", "pro"] as const).map((id) => {
        const plan = PLANS[id];
        const current = entitlement.plan === id;

        return (
          <s-section
            key={id}
            heading={`${plan.name}${plan.price ? ` — $${plan.price}/month` : " — free"}`}
          >
            <s-stack direction="block" gap="base">
              <s-text color="subdued">{plan.description}</s-text>

              <s-stack direction="block" gap="small-200">
                {plan.features.map((feature) => (
                  <s-text key={feature}>• {feature}</s-text>
                ))}
              </s-stack>

              {current ? (
                <s-badge tone="success">Current plan</s-badge>
              ) : id === "free" ? (
                entitlement.subscription ? (
                  <Form method="post">
                    <input type="hidden" name="intent" value="cancel" />
                    <input
                      type="hidden"
                      name="subscriptionId"
                      value={entitlement.subscription.id}
                    />
                    <s-button type="submit" variant="tertiary" loading={working}>
                      Downgrade to Free
                    </s-button>
                  </Form>
                ) : null
              ) : (
                <Form method="post">
                  <input type="hidden" name="intent" value="subscribe" />
                  <input type="hidden" name="plan" value={id} />
                  <s-button type="submit" variant="primary" loading={working}>
                    {entitlement.plan === "free"
                      ? `Start ${TRIAL_DAYS}-day free trial`
                      : `Switch to ${plan.name}`}
                  </s-button>
                </Form>
              )}
            </s-stack>
          </s-section>
        );
      })}

      <s-section slot="aside" heading="Billing">
        <s-stack direction="block" gap="small">
          <s-text color="subdued">
            Charges appear on your Shopify invoice. Every paid plan starts with a{" "}
            {TRIAL_DAYS}-day free trial, and you are not charged until it ends.
          </s-text>
          <s-text color="subdued">
            Cancelling keeps every optimization already applied. Your history and undo
            controls stay available on the free plan.
          </s-text>
        </s-stack>
      </s-section>
    </s-page>
  );
}
