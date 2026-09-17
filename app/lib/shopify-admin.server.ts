import { unauthenticated } from "../shopify.server";

/**
 * Shopify's GraphQL cost extension. Every response carries it; the worker reads
 * it to decide whether the next call should wait.
 */
export type ThrottleStatus = {
  maximumAvailable: number;
  currentlyAvailable: number;
  restoreRate: number;
};

export class ThrottledError extends Error {
  constructor(
    message: string,
    readonly throttleStatus?: ThrottleStatus,
  ) {
    super(message);
    this.name = "ThrottledError";
  }
}

/** A `userErrors` entry from a mutation payload — a failure Shopify reports
 *  with HTTP 200, so it must be checked explicitly, never assumed absent. */
export type UserError = { field?: string[] | null; message: string };

export class UserErrorsError extends Error {
  constructor(
    readonly userErrors: UserError[],
    operation: string,
  ) {
    super(`${operation}: ${userErrors.map((e) => e.message).join("; ")}`);
    this.name = "UserErrorsError";
  }
}

/**
 * Points below which we stop and let the bucket refill rather than burning an
 * attempt on a throttled call. A product mutation costs ~10 points.
 */
const LOW_WATER_MARK = 100;

export type GraphqlResult<T> = {
  data: T;
  throttleStatus?: ThrottleStatus;
};

/** The envelope every Admin GraphQL response arrives in. */
type GraphqlEnvelope<T> = {
  data?: T;
  errors?: Array<{ message: string; extensions?: { code?: string } }>;
  extensions?: { cost?: { throttleStatus?: ThrottleStatus } };
};

/**
 * Runs an Admin GraphQL operation against a shop using its stored offline
 * session. Used by worker processors, which have no request to authenticate.
 *
 * Throws ThrottledError when Shopify rejects the call for rate limiting, so the
 * caller can re-enqueue with a delay instead of consuming a retry attempt.
 */
export async function shopifyGraphql<T = unknown>(
  shopDomain: string,
  query: string,
  variables?: Record<string, unknown>,
  operationName = "graphql",
): Promise<GraphqlResult<T>> {
  const { admin } = await unauthenticated.admin(shopDomain);

  const response = await admin.graphql(query, variables ? { variables } : undefined);
  const body = (await response.json()) as GraphqlEnvelope<T>;

  const throttleStatus: ThrottleStatus | undefined =
    body?.extensions?.cost?.throttleStatus;

  if (body?.errors?.length) {
    const throttled = body.errors.some((e) => e?.extensions?.code === "THROTTLED");
    const message = body.errors.map((e) => e.message).join("; ");
    if (throttled) throw new ThrottledError(message, throttleStatus);
    throw new Error(`${operationName}: ${message}`);
  }

  return { data: body.data as T, throttleStatus };
}

/**
 * Milliseconds to wait before the next call, or 0 if there is headroom.
 * Derived from the bucket's own restore rate rather than a fixed sleep.
 */
export function throttleDelayMs(status?: ThrottleStatus): number {
  if (!status) return 0;
  if (status.currentlyAvailable >= LOW_WATER_MARK) return 0;
  const deficit = LOW_WATER_MARK - status.currentlyAvailable;
  const seconds = deficit / Math.max(status.restoreRate, 1);
  return Math.ceil(seconds * 1000);
}

/** Throws if a mutation payload reported userErrors. */
export function assertNoUserErrors(
  userErrors: UserError[] | null | undefined,
  operation: string,
) {
  if (userErrors && userErrors.length > 0) {
    throw new UserErrorsError(userErrors, operation);
  }
}
