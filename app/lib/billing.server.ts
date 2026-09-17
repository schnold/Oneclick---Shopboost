import prisma from "../db.server";
import { shopifyGraphql, assertNoUserErrors, type UserError } from "./shopify-admin.server";
import { PLANS, TRIAL_DAYS, type PlanId } from "./plans";

/**
 * Billing.
 *
 * Shopify's preferred route for public apps is **managed pricing**: plans are
 * configured in the Dev Dashboard and Shopify handles the approval flow with no
 * billing code at all. This module is the Billing API fallback, for when plans
 * need programmatic control.
 *
 * The free plan is deliberately generous about *seeing* value — a merchant can
 * scan and view their full optimization potential without paying. Payment gates
 * the act of changing the shop, which is the part that costs us money to run.
 */

export { PLANS, TRIAL_DAYS, type PlanId } from "./plans";

const CREATE_SUBSCRIPTION = `#graphql
  mutation ShopboostCreateSubscription(
    $name: String!
    $returnUrl: URL!
    $trialDays: Int
    $test: Boolean
    $lineItems: [AppSubscriptionLineItemInput!]!
  ) {
    appSubscriptionCreate(
      name: $name
      returnUrl: $returnUrl
      trialDays: $trialDays
      test: $test
      lineItems: $lineItems
    ) {
      confirmationUrl
      appSubscription { id status }
      userErrors { field message }
    }
  }`;

const ACTIVE_SUBSCRIPTIONS = `#graphql
  query ShopboostActiveSubscriptions {
    currentAppInstallation {
      activeSubscriptions {
        id
        name
        status
        test
        trialDays
        currentPeriodEnd
        lineItems {
          plan {
            pricingDetails {
              ... on AppRecurringPricing {
                price { amount currencyCode }
                interval
              }
            }
          }
        }
      }
    }
  }`;

const CANCEL_SUBSCRIPTION = `#graphql
  mutation ShopboostCancelSubscription($id: ID!) {
    appSubscriptionCancel(id: $id) {
      appSubscription { id status }
      userErrors { field message }
    }
  }`;

export type ActiveSubscription = {
  id: string;
  name: string;
  status: string;
  test: boolean;
  currentPeriodEnd: string | null;
  price: number | null;
};

/** The shop's current subscription, or null when they are on the free plan. */
export async function getActiveSubscription(
  shopDomain: string,
): Promise<ActiveSubscription | null> {
  try {
    const { data } = await shopifyGraphql<{
      currentAppInstallation: {
        activeSubscriptions: Array<{
          id: string;
          name: string;
          status: string;
          test: boolean;
          currentPeriodEnd: string | null;
          lineItems: Array<{
            plan: {
              pricingDetails: { price?: { amount: string; currencyCode: string } };
            };
          }>;
        }>;
      };
    }>(shopDomain, ACTIVE_SUBSCRIPTIONS, undefined, "activeSubscriptions");

    const active = data.currentAppInstallation?.activeSubscriptions?.find(
      (s) => s.status === "ACTIVE",
    );
    if (!active) return null;

    const amount = active.lineItems?.[0]?.plan?.pricingDetails?.price?.amount;

    return {
      id: active.id,
      name: active.name,
      status: active.status,
      test: active.test,
      currentPeriodEnd: active.currentPeriodEnd,
      price: amount ? Number(amount) : null,
    };
  } catch (error) {
    // Billing must never take the dashboard down. An unknown subscription
    // state degrades to the free plan, which is the safe direction: the
    // merchant keeps read-only access rather than losing the app.
    console.error(`[billing] could not read subscription for ${shopDomain}:`, error);
    return null;
  }
}

/** Resolves the subscription to one of our plans by price. */
export function planFromSubscription(
  subscription: ActiveSubscription | null,
): PlanId {
  if (!subscription) return "free";
  if (subscription.price !== null) {
    if (subscription.price >= PLANS.pro.price) return "pro";
    if (subscription.price >= PLANS.growth.price) return "growth";
  }
  const name = subscription.name.toLowerCase();
  if (name.includes("pro")) return "pro";
  if (name.includes("growth")) return "growth";
  return "free";
}

/**
 * Whether charges are created as test charges.
 *
 * Explicit rather than inferred: a test charge never bills anyone, so getting
 * this wrong in production means the app earns nothing and nobody notices. It
 * is derived from NODE_ENV and can be forced with SHOPIFY_BILLING_TEST, and
 * the resolved value is logged on every subscription so it is visible in
 * production logs rather than a silent assumption.
 */
export function billingIsTestMode(): boolean {
  const override = process.env.SHOPIFY_BILLING_TEST;
  if (override === "true" || override === "1") return true;
  if (override === "false" || override === "0") return false;
  return process.env.NODE_ENV !== "production";
}

/**
 * Starts a subscription and returns the URL the merchant must visit to approve
 * the charge. Nothing is billed until they approve.
 */
export async function createSubscription(
  shopDomain: string,
  planId: Exclude<PlanId, "free">,
  returnUrl: string,
  { test = billingIsTestMode() } = {},
): Promise<string> {
  const plan = PLANS[planId];

  console.log(
    `[billing] ${shopDomain}: creating ${plan.name} subscription ` +
      `(${test ? "TEST charge — nobody is billed" : "live charge"})`,
  );

  const { data } = await shopifyGraphql<{
    appSubscriptionCreate: {
      confirmationUrl: string | null;
      appSubscription: { id: string; status: string } | null;
      userErrors: UserError[];
    };
  }>(
    shopDomain,
    CREATE_SUBSCRIPTION,
    {
      name: `Shopboost ${plan.name}`,
      returnUrl,
      trialDays: TRIAL_DAYS,
      test,
      lineItems: [
        {
          plan: {
            appRecurringPricingDetails: {
              price: { amount: plan.price, currencyCode: "USD" },
              interval: "EVERY_30_DAYS",
            },
          },
        },
      ],
    },
    "appSubscriptionCreate",
  );

  assertNoUserErrors(data.appSubscriptionCreate.userErrors, "appSubscriptionCreate");

  const url = data.appSubscriptionCreate.confirmationUrl;
  if (!url) throw new Error("Shopify did not return a confirmation URL");
  return url;
}

export async function cancelSubscription(shopDomain: string, id: string) {
  const { data } = await shopifyGraphql<{
    appSubscriptionCancel: {
      appSubscription: { id: string; status: string } | null;
      userErrors: UserError[];
    };
  }>(shopDomain, CANCEL_SUBSCRIPTION, { id }, "appSubscriptionCancel");

  assertNoUserErrors(data.appSubscriptionCancel.userErrors, "appSubscriptionCancel");
  return data.appSubscriptionCancel.appSubscription;
}

/**
 * Images already written this billing period, used to enforce the plan limit.
 * Counts real changes, never skips — a merchant is not charged quota for an
 * image we decided to leave alone.
 */
export async function imagesUsedThisPeriod(shopDomain: string): Promise<number> {
  const since = new Date();
  since.setDate(since.getDate() - 30);

  return prisma.optimizationItem.count({
    where: {
      job: { shopDomain },
      field: "image",
      status: "done",
      createdAt: { gte: since },
    },
  });
}

export type Entitlement = {
  plan: PlanId;
  planName: string;
  canBoost: boolean;
  imagesUsed: number;
  imageLimit: number;
  imagesRemaining: number;
  /** Set when boosting is blocked, explaining what to do about it. */
  blockedReason: string | null;
  subscription: ActiveSubscription | null;
};

export async function getEntitlement(shopDomain: string): Promise<Entitlement> {
  const subscription = await getActiveSubscription(shopDomain);
  const plan = planFromSubscription(subscription);
  const definition = PLANS[plan];
  const imagesUsed = await imagesUsedThisPeriod(shopDomain);
  const imageLimit = definition.monthlyImageLimit;
  const remaining = Math.max(0, imageLimit - imagesUsed);

  let blockedReason: string | null = null;
  if (plan === "free") {
    blockedReason =
      "The free plan includes the full scan. Choose a plan to start optimizing.";
  } else if (remaining === 0 && Number.isFinite(imageLimit)) {
    blockedReason = `You have used all ${imageLimit} images in this billing period. Upgrade to Pro for unlimited images.`;
  }

  return {
    plan,
    planName: definition.name,
    canBoost: blockedReason === null,
    imagesUsed,
    imageLimit,
    imagesRemaining: remaining,
    blockedReason,
    subscription,
  };
}
