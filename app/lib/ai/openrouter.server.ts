/**
 * The app's only AI client.
 *
 * Copy and FAQ generation both go through OpenRouter, which speaks the
 * OpenAI-compatible chat-completions shape in front of every provider it
 * fronts. That is why there is no vendor SDK here: swapping `OPEN_ROUTER_MODEL`
 * is the whole model-change procedure, and a raw `fetch` has no SDK version to
 * keep in step with whichever provider the model happens to belong to.
 *
 * Every caller treats `null` as "no AI available" and falls back, so nothing in
 * here throws: a missing key, a refusal, a rate limit and malformed JSON are
 * all the same outcome to a boost that must finish either way.
 */

const ENDPOINT = "https://openrouter.ai/api/v1/chat/completions";

/** Not a hot path — product copy is generated per resource inside a job. */
const TIMEOUT_MS = 60_000;

export const DEFAULT_MODEL = "google/gemini-3.8-flash";

export function hasAiKey(): boolean {
  return Boolean(process.env.OPEN_ROUTER_API_KEY);
}

export function aiModel(): string {
  return process.env.OPEN_ROUTER_MODEL || DEFAULT_MODEL;
}

export type JsonRequest = {
  /** Instructions that shape the output — sent as the system message. */
  system: string;
  /** The payload the model reasons over. Serialized as the user message. */
  input: unknown;
  /** Name for the schema. Some providers surface it in errors. */
  schemaName: string;
  /** JSON Schema the response must satisfy. */
  schema: Record<string, unknown>;
  maxTokens: number;
  /** Prefix for the warning logged when a call fails. */
  logPrefix: string;
};

type ChatCompletion = {
  choices?: Array<{
    finish_reason?: string;
    native_finish_reason?: string;
    message?: { content?: string | null; refusal?: string | null };
    error?: { message?: string };
  }>;
  error?: { message?: string; code?: number };
};

/**
 * Strips a ``` fence if one survives structured output. Gemini complies with
 * `json_schema` in practice, but a fence would otherwise turn a good response
 * into a parse failure and silently drop the whole product to the template.
 */
function unfence(text: string): string {
  const fenced = text.trim().match(/^```(?:json)?\s*\n([\s\S]*?)\n?```$/);
  return (fenced ? fenced[1] : text).trim();
}

/**
 * Asks for a JSON object matching `schema`, or returns null.
 *
 * Callers still validate what comes back. A schema constrains shape, not
 * truthfulness or length, and both of those matter downstream.
 */
export async function generateJson<T>({
  system,
  input,
  schemaName,
  schema,
  maxTokens,
  logPrefix,
}: JsonRequest): Promise<T | null> {
  const apiKey = process.env.OPEN_ROUTER_API_KEY;
  if (!apiKey) return null;

  try {
    const response = await fetch(ENDPOINT, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        // Optional attribution headers: they name the app on OpenRouter's
        // dashboards and rankings, and are ignored if absent.
        ...(process.env.SHOPIFY_APP_URL
          ? { "HTTP-Referer": process.env.SHOPIFY_APP_URL }
          : {}),
        "X-Title": "Shopboost",
      },
      body: JSON.stringify({
        model: aiModel(),
        max_tokens: maxTokens,
        // Reasoning tokens are billed against max_tokens, and a reasoning model
        // left on its default effort can spend the whole budget thinking and
        // return nothing — which is how this arrives as a truncation, not an
        // error. None of these tasks need deliberation: the facts are supplied
        // and the rules are in the system prompt. Ignored by non-reasoning
        // models.
        reasoning: { effort: "low" },
        messages: [
          { role: "system", content: system },
          { role: "user", content: JSON.stringify(input) },
        ],
        response_format: {
          type: "json_schema",
          json_schema: { name: schemaName, strict: true, schema },
        },
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });

    if (!response.ok) {
      // The body carries the actual reason (bad model id, no credit, rate
      // limit). A bare status code would send someone hunting in the wrong place.
      const detail = (await response.text()).slice(0, 300);
      throw new Error(`OpenRouter ${response.status}: ${detail}`);
    }

    const payload = (await response.json()) as ChatCompletion;

    // OpenRouter reports upstream provider failures in a 200 body.
    const error = payload.error ?? payload.choices?.[0]?.error;
    if (error) throw new Error(`OpenRouter: ${error.message ?? "unknown error"}`);

    const choice = payload.choices?.[0];
    if (!choice) return null;

    // A safety refusal is a normal outcome, not an error — fall back quietly.
    if (choice.message?.refusal) return null;
    if (choice.finish_reason === "content_filter") return null;

    // Truncated output is unparseable JSON at best and half a description at
    // worst; the template fallback is the better answer.
    if (choice.finish_reason === "length") {
      console.warn(`${logPrefix} model hit max_tokens, using fallback`);
      return null;
    }

    const content = choice.message?.content;
    if (!content) return null;

    return JSON.parse(unfence(content)) as T;
  } catch (caught) {
    // Rate limits, network failures, timeouts, malformed JSON — none of these
    // should fail a boost.
    const error = caught as Error;
    const reason =
      error.name === "TimeoutError"
        ? `no response in ${TIMEOUT_MS / 1_000}s`
        : error.message;
    console.warn(`${logPrefix} ${reason}`);
    return null;
  }
}
