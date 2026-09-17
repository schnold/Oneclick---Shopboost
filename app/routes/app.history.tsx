import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { Form, useActionData, useLoaderData, useNavigation } from "react-router";
import { authenticate } from "../shopify.server";
import { rollbackBoost, rollbackOne, isUndoable } from "../lib/rollback.server";
import prisma from "../db.server";
import { formatBytes } from "../lib/format";
import type { AuditTotals } from "../lib/audit/types";

/**
 * Past boosts, each with the before/after snapshots that bracket it, and the
 * changes they made.
 *
 * Undo is the same mutation that made the change, run with the stored `before`
 * value — see rollback.server.ts.
 */
export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const form = await request.formData();
  const intent = form.get("intent");

  if (intent === "undo-boost") {
    const boostId = String(form.get("boostId"));
    const result = await rollbackBoost(session.shop, boostId);
    return {
      ok: result.failed === 0,
      message:
        result.restored === 0 && result.failed === 0
          ? "Nothing left to undo in that boost."
          : `Restored ${result.restored} item${result.restored === 1 ? "" : "s"}` +
            (result.failed > 0
              ? `. ${result.failed} could not be undone: ${result.errors.join("; ")}`
              : "."),
    };
  }

  if (intent === "undo-item") {
    const itemId = String(form.get("itemId"));
    const result = await rollbackOne(session.shop, itemId);
    return {
      ok: result.failed === 0,
      message: result.restored ? "Original restored." : result.errors.join("; "),
    };
  }

  return { ok: false, message: "Unknown action" };
};

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);

  const [boosts, snapshots] = await Promise.all([
    prisma.boost.findMany({
      where: { shopDomain: session.shop },
      orderBy: { createdAt: "desc" },
      take: 25,
      include: { _count: { select: { jobs: true } } },
    }),
    prisma.auditSnapshot.findMany({
      where: { shopDomain: session.shop },
      orderBy: { createdAt: "desc" },
      take: 50,
    }),
  ]);

  const savedBytes = await prisma.optimizationItem.aggregate({
    where: { job: { shopDomain: session.shop }, status: "done" },
    _sum: { savedBytes: true },
  });

  // Individual changes from the most recent boost, which is the one a merchant
  // is realistically going to want to undo.
  const recentItems = boosts[0]
    ? await prisma.optimizationItem.findMany({
        where: { job: { boostId: boosts[0].id } },
        orderBy: { createdAt: "desc" },
        take: 50,
        include: { job: { select: { label: true, module: true } } },
      })
    : [];

  return {
    boosts: boosts.map((boost) => {
      const before = snapshots.find(
        (s) => s.boostId === boost.id && s.kind === "before",
      );
      const after = snapshots.find((s) => s.boostId === boost.id && s.kind === "after");
      return {
        id: boost.id,
        status: boost.status,
        createdAt: boost.createdAt.toISOString(),
        jobCount: boost._count.jobs,
        before: before?.boostScore ?? null,
        after: after?.boostScore ?? null,
        undoable: boost._count.jobs > 0 && boost.status !== "cancelled",
      };
    }),
    scans: snapshots
      .filter((s) => !s.boostId)
      .slice(0, 10)
      .map((s) => ({
        id: s.id,
        createdAt: s.createdAt.toISOString(),
        boostScore: s.boostScore,
        productCount: (s.totals as unknown as AuditTotals)?.productCount ?? 0,
      })),
    totalSavedBytes: savedBytes._sum.savedBytes ?? 0,
    recentItems: recentItems.map((item) => ({
      id: item.id,
      label: item.job.label ?? item.resourceId,
      module: item.job.module,
      field: item.field,
      status: item.status,
      reason: item.reason,
      savedBytes: item.savedBytes,
      undoable: isUndoable(item.field, item.status),
    })),
  };
};

export default function History() {
  const { boosts, scans, totalSavedBytes, recentItems } =
    useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const navigation = useNavigation();
  const working = navigation.state === "submitting";

  return (
    <s-page heading="History">
      {actionData?.message && (
        <s-banner tone={actionData.ok ? "success" : "warning"} dismissible>
          {actionData.message}
        </s-banner>
      )}
      <s-section heading="Boosts">
        {boosts.length === 0 ? (
          <s-stack direction="block" gap="small">
            <s-text type="strong">No boosts yet</s-text>
            <s-text color="subdued">
              Once you run a boost, every change it makes is recorded here and can be
              undone.
            </s-text>
            <s-link href="/app">Go to dashboard</s-link>
          </s-stack>
        ) : (
          <s-table>
            <s-table-header-row>
              <s-table-header>When</s-table-header>
              <s-table-header>Status</s-table-header>
              <s-table-header format="numeric">Jobs</s-table-header>
              <s-table-header>Score</s-table-header>
              <s-table-header>Undo</s-table-header>
            </s-table-header-row>
            <s-table-body>
              {boosts.map((boost) => (
                <s-table-row key={boost.id}>
                  <s-table-cell>
                    {new Date(boost.createdAt).toLocaleString()}
                  </s-table-cell>
                  <s-table-cell>
                    <s-badge
                      tone={
                        boost.status === "done"
                          ? "success"
                          : boost.status === "failed"
                            ? "critical"
                            : "info"
                      }
                    >
                      {boost.status}
                    </s-badge>
                  </s-table-cell>
                  <s-table-cell>{boost.jobCount}</s-table-cell>
                  <s-table-cell>
                    {boost.before !== null && boost.after !== null ? (
                      <s-text>
                        {boost.before} → <s-text type="strong">{boost.after}</s-text>
                      </s-text>
                    ) : (
                      <s-text color="subdued">—</s-text>
                    )}
                  </s-table-cell>
                  <s-table-cell>
                    {boost.undoable ? (
                      <Form method="post">
                        <input type="hidden" name="intent" value="undo-boost" />
                        <input type="hidden" name="boostId" value={boost.id} />
                        <s-button type="submit" variant="tertiary" loading={working}>
                          Undo all
                        </s-button>
                      </Form>
                    ) : (
                      <s-text color="subdued">—</s-text>
                    )}
                  </s-table-cell>
                </s-table-row>
              ))}
            </s-table-body>
          </s-table>
        )}
      </s-section>

      {recentItems.length > 0 && (
        <s-section heading="Changes in the last boost">
          <s-stack direction="block" gap="base">
            <s-text color="subdued">
              Every change is stored with the original it replaced, so any of them
              can be put back.
            </s-text>
            <s-table>
              <s-table-header-row>
                <s-table-header>Item</s-table-header>
                <s-table-header>Change</s-table-header>
                <s-table-header>Status</s-table-header>
                <s-table-header format="numeric">Saved</s-table-header>
                <s-table-header>Undo</s-table-header>
              </s-table-header-row>
              <s-table-body>
                {recentItems.map((item) => (
                  <s-table-row key={item.id}>
                    <s-table-cell>{item.label}</s-table-cell>
                    <s-table-cell>
                      <s-text color="subdued">{fieldLabel(item.field)}</s-text>
                    </s-table-cell>
                    <s-table-cell>
                      <s-badge
                        tone={
                          item.status === "done"
                            ? "success"
                            : item.status === "rolled_back"
                              ? "info"
                              : item.status === "failed"
                                ? "critical"
                                : "auto"
                        }
                      >
                        {itemStatusLabel(item.status)}
                      </s-badge>
                      {item.reason && (
                        <s-text color="subdued"> · {item.reason}</s-text>
                      )}
                    </s-table-cell>
                    <s-table-cell>
                      {item.savedBytes ? formatBytes(item.savedBytes) : ""}
                    </s-table-cell>
                    <s-table-cell>
                      {item.undoable ? (
                        <Form method="post">
                          <input type="hidden" name="intent" value="undo-item" />
                          <input type="hidden" name="itemId" value={item.id} />
                          <s-button type="submit" variant="tertiary" loading={working}>
                            Undo
                          </s-button>
                        </Form>
                      ) : (
                        <s-text color="subdued">—</s-text>
                      )}
                    </s-table-cell>
                  </s-table-row>
                ))}
              </s-table-body>
            </s-table>
          </s-stack>
        </s-section>
      )}

      <s-section heading="Scans">
        {scans.length === 0 ? (
          <s-text color="subdued">No scans recorded yet.</s-text>
        ) : (
          <s-table>
            <s-table-header-row>
              <s-table-header>When</s-table-header>
              <s-table-header format="numeric">Products</s-table-header>
              <s-table-header format="numeric">Score</s-table-header>
            </s-table-header-row>
            <s-table-body>
              {scans.map((scan) => (
                <s-table-row key={scan.id}>
                  <s-table-cell>{new Date(scan.createdAt).toLocaleString()}</s-table-cell>
                  <s-table-cell>{scan.productCount.toLocaleString()}</s-table-cell>
                  <s-table-cell>{scan.boostScore}</s-table-cell>
                </s-table-row>
              ))}
            </s-table-body>
          </s-table>
        )}
      </s-section>

      <s-section slot="aside" heading="Lifetime">
        <s-stack direction="block" gap="small">
          <s-text color="subdued">Image weight removed</s-text>
          <s-heading>{formatBytes(totalSavedBytes)}</s-heading>
        </s-stack>
      </s-section>
    </s-page>
  );
}

function fieldLabel(field: string): string {
  const labels: Record<string, string> = {
    image: "Image recompressed",
    alt: "Alt text written",
    "seo.title": "Search title written",
    "seo.description": "Search description written",
    "geo.faq": "Product FAQ published",
    "geo.faq.pending": "Product FAQ drafted",
    "geo.description": "Specifications added",
    "speed.report": "Storefront measured",
  };
  return labels[field] ?? field;
}

function itemStatusLabel(status: string): string {
  const labels: Record<string, string> = {
    done: "Applied",
    skipped: "Skipped",
    failed: "Failed",
    rolled_back: "Undone",
  };
  return labels[status] ?? status;
}
