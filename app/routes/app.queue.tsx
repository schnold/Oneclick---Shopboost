import type { LoaderFunctionArgs } from "react-router";
import { useLoaderData, useRevalidator, useSearchParams } from "react-router";
import { useEffect } from "react";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";

/**
 * Live view of the work queue. Polls its own loader rather than opening a
 * websocket — the admin runs this page in an iframe, and a 2-second loader
 * poll is both simpler and sufficient.
 */

const FILTERS = ["all", "running", "done", "failed"] as const;
type Filter = (typeof FILTERS)[number];

const STATUS_FOR_FILTER: Record<Exclude<Filter, "all">, string[]> = {
  running: ["queued", "running"],
  done: ["done", "skipped"],
  failed: ["failed"],
};

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const url = new URL(request.url);
  const filter = (url.searchParams.get("filter") ?? "all") as Filter;

  const where = {
    shopDomain: session.shop,
    ...(filter !== "all" && FILTERS.includes(filter)
      ? { status: { in: STATUS_FOR_FILTER[filter as Exclude<Filter, "all">] } }
      : {}),
  };

  const [jobs, counts] = await Promise.all([
    prisma.optimizationJob.findMany({
      where,
      orderBy: { createdAt: "desc" },
      take: 100,
      include: { _count: { select: { items: true } } },
    }),
    prisma.optimizationJob.groupBy({
      by: ["status"],
      where: { shopDomain: session.shop },
      _count: true,
    }),
  ]);

  const byStatus = Object.fromEntries(counts.map((c) => [c.status, c._count]));

  return {
    filter,
    jobs: jobs.map((job) => ({
      id: job.id,
      module: job.module,
      status: job.status,
      label: job.label,
      error: job.error,
      itemCount: job._count.items,
      createdAt: job.createdAt.toISOString(),
      finishedAt: job.finishedAt?.toISOString() ?? null,
    })),
    active: (byStatus.queued ?? 0) + (byStatus.running ?? 0),
  };
};

export default function Queue() {
  const { jobs, active, filter } = useLoaderData<typeof loader>();
  const revalidator = useRevalidator();
  const [, setSearchParams] = useSearchParams();

  // Poll only while there is work in flight; a settled queue stops polling.
  useEffect(() => {
    if (active === 0) return;
    const id = setInterval(() => {
      if (revalidator.state === "idle") revalidator.revalidate();
    }, 2000);
    return () => clearInterval(id);
  }, [active, revalidator]);

  return (
    <s-page heading="Queue">
      <s-section>
        <s-stack direction="block" gap="base">
          <s-stack direction="inline" gap="small" alignItems="center">
            {FILTERS.map((f) => (
              <s-button
                key={f}
                variant={f === filter ? "primary" : "tertiary"}
                onClick={() => setSearchParams(f === "all" ? {} : { filter: f })}
              >
                {f[0].toUpperCase() + f.slice(1)}
              </s-button>
            ))}
            {active > 0 && (
              <s-stack direction="inline" gap="small-200" alignItems="center">
                <s-spinner />
                <s-text color="subdued">{active} in progress</s-text>
              </s-stack>
            )}
          </s-stack>

          {jobs.length === 0 ? (
            <s-stack direction="block" gap="small">
              <s-text type="strong">Nothing in the queue</s-text>
              <s-text color="subdued">
                {filter === "all"
                  ? "Press Boost shop on the dashboard to start optimizing."
                  : "No jobs match this filter."}
              </s-text>
              <s-link href="/app">Go to dashboard</s-link>
            </s-stack>
          ) : (
            <s-table>
              <s-table-header-row>
                <s-table-header>Module</s-table-header>
                <s-table-header>Item</s-table-header>
                <s-table-header>Status</s-table-header>
                <s-table-header format="numeric">Changes</s-table-header>
                <s-table-header>Started</s-table-header>
              </s-table-header-row>
              <s-table-body>
                {jobs.map((job) => (
                  <s-table-row key={job.id}>
                    <s-table-cell>{moduleLabel(job.module)}</s-table-cell>
                    <s-table-cell>
                      {job.label ?? <s-text color="subdued">—</s-text>}
                      {job.error && (
                        <s-text color="subdued"> · {truncate(job.error, 80)}</s-text>
                      )}
                    </s-table-cell>
                    <s-table-cell>
                      <s-badge tone={toneForStatus(job.status)}>
                        {statusLabel(job.status)}
                      </s-badge>
                    </s-table-cell>
                    <s-table-cell>{job.itemCount || ""}</s-table-cell>
                    <s-table-cell>
                      <s-text color="subdued">
                        {new Date(job.createdAt).toLocaleTimeString()}
                      </s-text>
                    </s-table-cell>
                  </s-table-row>
                ))}
              </s-table-body>
            </s-table>
          )}
        </s-stack>
      </s-section>
    </s-page>
  );
}

function moduleLabel(module: string): string {
  const labels: Record<string, string> = {
    audit: "Scan",
    images: "Images",
    seo: "SEO",
    geo: "GEO",
    speed: "Speed",
    orchestrator: "Boost",
  };
  return labels[module] ?? module;
}

function statusLabel(status: string): string {
  const labels: Record<string, string> = {
    queued: "Waiting",
    running: "Running",
    done: "Done",
    skipped: "Skipped",
    failed: "Failed",
    rolled_back: "Undone",
  };
  return labels[status] ?? status;
}

/** Badge tones are a closed set — see @shopify/polaris-types. */
type BadgeTone = "auto" | "neutral" | "info" | "success" | "caution" | "warning" | "critical";

function toneForStatus(status: string): BadgeTone {
  switch (status) {
    case "done":
      return "success";
    case "failed":
      return "critical";
    case "running":
      return "info";
    case "skipped":
    case "rolled_back":
      return "auto";
    default:
      return "caution";
  }
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}
