/**
 * Google PageSpeed Insights.
 *
 * The API works without a key at a low quota, so the key is optional — the
 * module degrades to "not measured" rather than failing a boost. That matters
 * because PSI is also slow and occasionally flaky, and a speed measurement is
 * never worth failing real optimization work over.
 */

export type PsiResult = {
  mobile: number | null;
  desktop: number | null;
  measuredUrl: string;
  measuredAt: string;
  /** Set when a strategy could not be measured, for display rather than retry. */
  note?: string;
};

const PSI_ENDPOINT = "https://www.googleapis.com/pagespeedonline/v5/runPagespeed";
const TIMEOUT_MS = 90_000;

async function runStrategy(
  url: string,
  strategy: "mobile" | "desktop",
): Promise<{ score: number | null; note?: string }> {
  const params = new URLSearchParams({
    url,
    strategy,
    category: "performance",
  });
  const key = process.env.PSI_API_KEY;
  if (key) params.set("key", key);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const response = await fetch(`${PSI_ENDPOINT}?${params}`, {
      signal: controller.signal,
    });

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      // 429 without a key is the common case and is worth naming precisely.
      if (response.status === 429) {
        return {
          score: null,
          note: key
            ? "PageSpeed Insights rate limit reached"
            : "PageSpeed Insights rate limit reached — add PSI_API_KEY for a higher quota",
        };
      }
      return {
        score: null,
        note: `PageSpeed Insights returned ${response.status}${body ? `: ${body.slice(0, 120)}` : ""}`,
      };
    }

    const data = (await response.json()) as {
      lighthouseResult?: { categories?: { performance?: { score?: number } } };
    };

    const raw = data.lighthouseResult?.categories?.performance?.score;
    return typeof raw === "number" ? { score: Math.round(raw * 100) } : { score: null };
  } catch (error) {
    const aborted = (error as Error).name === "AbortError";
    return {
      score: null,
      note: aborted
        ? "PageSpeed Insights timed out"
        : `PageSpeed Insights unavailable: ${(error as Error).message}`,
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Measures one URL on both strategies.
 *
 * Runs sequentially rather than in parallel: PSI rate-limits aggressively, and
 * two concurrent requests from the same origin are the fastest way to get a
 * 429 for both.
 */
export async function measurePageSpeed(url: string): Promise<PsiResult> {
  const mobile = await runStrategy(url, "mobile");
  const desktop = await runStrategy(url, "desktop");

  return {
    mobile: mobile.score,
    desktop: desktop.score,
    measuredUrl: url,
    measuredAt: new Date().toISOString(),
    note: mobile.note ?? desktop.note,
  };
}

export function hasPsiKey(): boolean {
  return Boolean(process.env.PSI_API_KEY);
}
